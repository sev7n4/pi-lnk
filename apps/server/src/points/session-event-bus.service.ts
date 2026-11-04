import { Injectable } from '@nestjs/common'
import { EventEmitter } from 'events'
import type { CreditTxEvent } from '@lnkpi/shared'

export type CreditTxListener = (ev: CreditTxEvent['data']) => void

/**
 * turn_settled 总线事件（2026-11-04 实时补桥）：`streamConversation` 结算块在
 * drain 模式（flag `STREAM_MAIN_FROM_PIRUNTIME=on`）下 yield 帧被后台 drain 丢弃
 * （仅保留落库副作用）⇒ 前端经 /runs/events 收不到实时结算。本总线把结算块
 * emit 的权威值路由到 `runEventStream` 的订阅队列（与 credit_tx Epic 1 Task 5
 * 同款接线）。字段与 turn_settled 流事件 data 相同 + 路由用的 sessionId。
 */
export type TurnSettledBusEvent = {
  sessionId?: string
  holdId: string
  credits?: number
  ruleVersion?: string
  model?: string
  degraded?: boolean
  released?: boolean
}

export type TurnSettledListener = (ev: TurnSettledBusEvent) => void

/**
 * turn_ack 总线事件（P3 G1，multi-device spec §5.2 D4）：streamConversation 在
 * drain 模式（flag `STREAM_MAIN_FROM_PIRUNTIME=on`）下 yield 帧被后台 drain 丢弃
 * ⇒ 服务端已裁定的回合归属（run/steer/followup）前端经 /runs/events 收不到。
 * 字段与 turn_ack 流事件 data 相同 + 路由用的 sessionId。
 */
export type TurnAckBusEvent = {
  sessionId?: string
  runId?: string
  mode: 'run' | 'steer' | 'followup'
  reason?: 'not_idle' | 'not_steerable'
  messageId?: string
}

/**
 * turn_not_submitted 总线事件（P3 G1）：409 转 steer/followUp 的结构化拒绝告知帧。
 * ⚠️ 受众面变化（flag-off 下只有提交者自己的 POST 流可见）：桥接进 /runs/events
 * 后观察者也会收到 —— web 端必须圈定 own-turn 作用域（fut.ts 派发层转发不收口 +
 * AgentSideRail ownTurnViaObserver gate），观察者路径忽略（P3 计划 Review Focus 1）。
 */
export type TurnNotSubmittedBusEvent = {
  sessionId?: string
  reason: 'not_idle' | 'not_steerable'
}

export type TurnAckListener = (ev: TurnAckBusEvent) => void
export type TurnNotSubmittedListener = (ev: TurnNotSubmittedBusEvent) => void

/**
 * 迟到订阅回放窗口（2026-11-04 结算实时性根治，机制 A 防御）：
 * 仅回放保留时刻距今不超过该窗口的最近一笔 turn_settled。
 *
 * 窗口取值依据：/runs/events 的 bus 订阅在 runEventStream 生成器启动时**同步**建立
 * （agent.service.ts 订阅先于 streamEvents），丢失窗口 ≈ SSE 握手 + 控制器前置开销
 * （移动端实测可到秒级）。15s 覆盖重挂握手绰绰有余；同时刻意取短——窗口越长，
 * 「紧邻回合」场景下旧结算被回放到新回合时间线的暂态误标窗口越长（web 端按
 * lastAssistant 落点，新回合自身结算到达后覆盖自愈）。
 */
export const TURN_SETTLED_REPLAY_MS = 15_000

/** 保留表容量上限：Map 迭代按插入序，超限淘汰最旧会话（防长驻进程无界增长）。 */
const TURN_SETTLED_RETAIN_CAP = 1000

/**
 * Epic 1（spec 2026-11-03-credit-consumption-display-design §5.1）：会话级积分变动事件总线。
 *
 * 职责单一：把 `PointsService` 在计费事务提交后发出的 `credit_tx` 领域事件，路由到
 * - 指定会话的在飞 SSE 流（`sessionEmitters`，用于对话内实时累计）
 * - 该用户所有打开的会话/标签（`userEmitters`，用于余额跨标签同步，Epic 2 预备）
 *
 * 2026-11-04 增设 turn_settled 通道（实时补桥，见 TurnSettledBusEvent 注释）。
 *
 * ⚠️ 不直接依赖会话层 / SSE 生成器：它只提供订阅与发射原语，`streamConversation`
 * 负责在流建立时订阅、流结束时退订（防 emitter 泄漏，R1）。退化语义（CREDIT_TX=off）
 * 由调用方控制，本服务无 flag 概念。
 */
@Injectable()
export class SessionEventBus {
  private readonly sessionEmitters = new Map<string, EventEmitter>()
  private readonly userEmitters = new Map<string, EventEmitter>()
  private readonly turnSettledEmitters = new Map<string, EventEmitter>()
  /** turn_ack 与 turn_not_submitted 共用注册表（两者同源于 streamConversation 的裁定块）。 */
  private readonly turnAckEmitters = new Map<string, EventEmitter>()

  /**
   * 迟到订阅回放（2026-11-04 结算实时性根治，机制 A 防御）：按会话保留最近一笔
   * turn_settled。emit 无条件保留（与 emitter 生命周期**解耦**——退订会清空 emitter，
   * 但保留值延续，重开的订阅仍能补投）。
   *
   * 背景：flag-on 下每条 own-turn 消息都会 abort 常驻连接 → ack → 重挂 /runs/events
   * （AgentSideRail `listenFollowUpTail`）；重挂握手窗口内 emit 的结算没有任何订阅者
   * ⇒ 静默丢失，摘要「已结算 -N 积分」只在刷新重放后出现（会话 cmw1oyqww 实测）。
   * web 端 reducer 对 turn_settled 是覆盖写、重放幂等（turnTimeline `case 'turn_settled'`）
   * ⇒ 重复投递无害；新回合自身的结算到达后覆盖自愈。
   */
  private readonly lastTurnSettled = new Map<string, { ev: TurnSettledBusEvent; ts: number }>()

  /** PointsService 在 pointTransaction.create 事务提交后调用。失败不抛（调用方已 try/warn）。 */
  emitCreditTx(ev: CreditTxEvent['data']): void {
    const sessionEmitter = ev.sessionId ? this.sessionEmitters.get(ev.sessionId) : undefined
    if (sessionEmitter) sessionEmitter.emit('credit_tx', ev)
    // 始终同步推给该用户所有打开的会话（C2 多标签 / Epic 2 预备）
    this.userEmitters.get(ev.userId)?.emit('credit_tx', ev)
  }

  /** streamConversation 结算块在 drain 模式下调用；无 sessionId（异常形态）静默丢弃。 */
  emitTurnSettled(ev: TurnSettledBusEvent): void {
    if (!ev.sessionId) return
    this.rememberTurnSettled(ev)
    this.turnSettledEmitters.get(ev.sessionId)?.emit('turn_settled', ev)
  }

  /** 保留最近一笔（last-wins 覆盖写，与 web reducer 幂等语义同构）；超限淘汰最旧会话。 */
  private rememberTurnSettled(ev: TurnSettledBusEvent): void {
    const key = ev.sessionId as string
    // delete+set 刷新插入序：最新会话恒排尾，淘汰恒打头
    this.lastTurnSettled.delete(key)
    if (this.lastTurnSettled.size >= TURN_SETTLED_RETAIN_CAP) {
      const oldest = this.lastTurnSettled.keys().next().value
      if (oldest !== undefined) this.lastTurnSettled.delete(oldest)
    }
    this.lastTurnSettled.set(key, { ev, ts: Date.now() })
  }

  /** streamConversation 在流建立时订阅本会话；结束时调用返回函数退订。 */
  subscribeSession(sessionId: string, fn: CreditTxListener): () => void {
    return this.subscribe(this.sessionEmitters, sessionId, 'credit_tx', fn)
  }

  /** 任意会话流订阅本用户广播（余额跨标签同步）；结束时退订。 */
  subscribeUser(userId: string, fn: CreditTxListener): () => void {
    return this.subscribe(this.userEmitters, userId, 'credit_tx', fn)
  }

  /** runEventStream 订阅本会话的 turn_settled 补桥；结束时退订。 */
  subscribeSessionTurnSettled(sessionId: string, fn: TurnSettledListener): () => void {
    const unsub = this.subscribe(this.turnSettledEmitters, sessionId, 'turn_settled', fn)
    // 迟到回放：向新订阅者补投保留窗口内的最近一笔（同步调用——runEventStream 的
    // 回调只做 queue.push + notify，无重入风险；notify 此时尚为 null，主循环先排干
    // queue 再阻塞，回放帧因此成为该连接的**首帧**，先于 pi 事件）。
    const retained = this.lastTurnSettled.get(sessionId)
    if (retained && Date.now() - retained.ts <= TURN_SETTLED_REPLAY_MS) {
      fn(retained.ev)
    }
    return unsub
  }

  /** streamConversation 在 drain 模式下与 turn_ack yield 同点调用；无 sessionId 静默丢弃。 */
  emitTurnAck(ev: TurnAckBusEvent): void {
    if (!ev.sessionId) return
    // ⭐ 刻意无保留表（与 turn_settled 不同）：turn_ack 是回合裁定语义，迟到回放会把
    // 新回合误标「已并入」⇒ 只投订阅在飞的连接（session-event-bus.turn-ack.test.ts N）。
    this.turnAckEmitters.get(ev.sessionId)?.emit('turn_ack', ev)
  }

  /** streamConversation 在 drain 模式下与 turn_not_submitted yield 同点调用；无 sessionId 静默丢弃。 */
  emitTurnNotSubmitted(ev: TurnNotSubmittedBusEvent): void {
    if (!ev.sessionId) return
    this.turnAckEmitters.get(ev.sessionId)?.emit('turn_not_submitted', ev)
  }

  /**
   * runEventStream 订阅本会话的 turn_ack 补桥；结束时退订。
   * ⭐ 刻意**无迟到回放**（与 turn_settled 的 15s replay 不同）：turn_settled 是
   * 幂等覆盖写、回放自愈无害；turn_ack 是回合**裁定**语义，重挂后的新订阅回放
   * 旧 ack 会把新回合误标「已并入」⇒ 只投订阅在飞的连接。
   */
  subscribeSessionTurnAck(sessionId: string, fn: TurnAckListener): () => void {
    return this.subscribe(this.turnAckEmitters, sessionId, 'turn_ack', fn)
  }

  /** runEventStream 订阅本会话的 turn_not_submitted 补桥；结束时退订。同样无回放。 */
  subscribeSessionTurnNotSubmitted(sessionId: string, fn: TurnNotSubmittedListener): () => void {
    return this.subscribe(this.turnAckEmitters, sessionId, 'turn_not_submitted', fn)
  }

  private subscribe(
    registry: Map<string, EventEmitter>,
    key: string,
    event: 'credit_tx' | 'turn_settled' | 'turn_ack' | 'turn_not_submitted',
    fn: CreditTxListener | TurnSettledListener | TurnAckListener | TurnNotSubmittedListener,
  ): () => void {
    let emitter = registry.get(key)
    if (!emitter) {
      emitter = new EventEmitter()
      // 允许任意多订户（多设备 / 多标签同时打开）
      emitter.setMaxListeners(0)
      registry.set(key, emitter)
    }
    // 去重：同一 fn 重复订阅只计一次（防双通道同流重复计数）
    if (!emitter.listeners(event).includes(fn)) {
      emitter.on(event, fn)
    }
    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true
      emitter!.removeListener(event, fn)
      if (emitter!.listenerCount(event) === 0) {
        registry.delete(key)
      }
    }
  }
}
