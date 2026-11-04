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
    this.turnSettledEmitters.get(ev.sessionId)?.emit('turn_settled', ev)
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
    return this.subscribe(this.turnSettledEmitters, sessionId, 'turn_settled', fn)
  }

  private subscribe(
    registry: Map<string, EventEmitter>,
    key: string,
    event: 'credit_tx' | 'turn_settled',
    fn: CreditTxListener | TurnSettledListener,
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
