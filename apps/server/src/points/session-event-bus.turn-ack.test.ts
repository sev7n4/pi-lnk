/**
 * P3 G1（multi-device spec §5.2 D4）：SessionEventBus turn_ack / turn_not_submitted 通道。
 *
 * 背景：flag `STREAM_MAIN_FROM_PIRUNTIME=on` 下，streamConversation 的 yield 帧被
 * 后台 drain 丢弃 ⇒ 服务端已裁定的回合归属（run/steer/followup）与结构化拒绝帧
 * （turn_not_submitted{reason}）前端经 /runs/events 永远收不到。本通道把两个 yield
 * 点的帧路由到 runEventStream 订阅队列（与 turn_settled 2026-11-04 补桥同款接线）。
 *
 * ⭐ 与 turn_settled 的刻意差异：**无迟到回放**——turn_settled 是幂等覆盖写，回放
 * 自愈无害；turn_ack 是回合**裁定**语义，重挂后的新订阅若回放旧 ack 会把「新回合」
 * 误标「已并入」⇒ 只投订阅在飞的连接（计划 Review Focus 1 / 设计决策 1）。
 */
import { describe, expect, it, vi } from 'vitest'
import { SessionEventBus } from './session-event-bus.service'

describe('SessionEventBus turn_ack / turn_not_submitted 通道（P3 G1）', () => {
  it('A：emitTurnAck 按会话路由到订阅者；退订后不再收；无 sessionId 静默丢弃', () => {
    const bus = new SessionEventBus()
    const fn = vi.fn()
    const unsub = bus.subscribeSessionTurnAck('t1', fn)

    bus.emitTurnAck({ sessionId: 't1', mode: 'steer', reason: 'not_idle' })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith({ sessionId: 't1', mode: 'steer', reason: 'not_idle' })

    unsub()
    bus.emitTurnAck({ sessionId: 't1', mode: 'run' })
    expect(fn).toHaveBeenCalledTimes(1)

    // 异常形态：无 sessionId ⇒ 不投递不炸
    expect(() => bus.emitTurnAck({ mode: 'run' })).not.toThrow()
    expect(() => bus.emitTurnAck({ mode: 'run' } as never)).not.toThrow()
  })

  it('B：emitTurnNotSubmitted 按会话路由；无订阅者静默；退订后不再收', () => {
    const bus = new SessionEventBus()
    const fn = vi.fn()
    const unsub = bus.subscribeSessionTurnNotSubmitted('t2', fn)

    // 无订阅者的其他会话：静默
    expect(() =>
      bus.emitTurnNotSubmitted({ sessionId: 't-other', reason: 'not_steerable' }),
    ).not.toThrow()
    expect(fn).not.toHaveBeenCalled()

    bus.emitTurnNotSubmitted({ sessionId: 't2', reason: 'not_steerable' })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith({ sessionId: 't2', reason: 'not_steerable' })

    unsub()
    bus.emitTurnNotSubmitted({ sessionId: 't2', reason: 'not_idle' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('⭐ N：turn_ack 无迟到回放（与 turn_settled 的 replay 刻意不同——裁定语义不得误标新回合）', () => {
    const bus = new SessionEventBus()
    bus.emitTurnAck({ sessionId: 't3', mode: 'run' }) // 无订阅者时 emit
    bus.emitTurnNotSubmitted({ sessionId: 't3', reason: 'not_idle' })

    const fnAck = vi.fn()
    const fnRefused = vi.fn()
    bus.subscribeSessionTurnAck('t3', fnAck) // 迟到订阅
    bus.subscribeSessionTurnNotSubmitted('t3', fnRefused)
    expect(fnAck).not.toHaveBeenCalled() // 不得回放旧裁定
    expect(fnRefused).not.toHaveBeenCalled()
  })

  it('M：同会话双订阅者都收到（多端一致）；通道与 turn_settled 互不串扰', () => {
    const bus = new SessionEventBus()
    const a = vi.fn()
    const b = vi.fn()
    const settled = vi.fn()
    const refusedA = vi.fn()
    bus.subscribeSessionTurnAck('t4', a)
    bus.subscribeSessionTurnAck('t4', b)
    bus.subscribeSessionTurnNotSubmitted('t4', refusedA)
    bus.subscribeSessionTurnSettled('t4', settled)

    bus.emitTurnAck({ sessionId: 't4', mode: 'followup', reason: 'not_idle' })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(refusedA).not.toHaveBeenCalled() // ack 不串进 refused 通道

    bus.emitTurnNotSubmitted({ sessionId: 't4', reason: 'not_steerable' })
    expect(a).toHaveBeenCalledTimes(1) // 只订了 ack 通道 ⇒ 不收 refused
    expect(b).toHaveBeenCalledTimes(1)
    expect(refusedA).toHaveBeenCalledTimes(1)
    expect(settled).not.toHaveBeenCalled() // 独立通道，不串扰

    bus.emitTurnSettled({ sessionId: 't4', holdId: 'h1' })
    expect(a).toHaveBeenCalledTimes(1) // settled 不漏进 ack 通道
    expect(refusedA).toHaveBeenCalledTimes(1)
  })
})
