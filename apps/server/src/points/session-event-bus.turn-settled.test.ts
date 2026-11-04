/**
 * 2026-11-04 实时补桥：SessionEventBus turn_settled 通道。
 *
 * 背景：flag `STREAM_MAIN_FROM_PIRUNTIME=on` 下，streamConversation 的 yield 帧被
 * 后台 drain 丢弃（仅保留落库副作用）⇒ turn_settled 经 /runs/events 收不到，前端
 * 实时摘要缺结算段（刷新重放才见）。本通道把结算块 emit 的权威值路由到
 * runEventStream 订阅队列（与 credit_tx Epic 1 Task 5 同款接线）。
 *
 * 钉住：A 会话路由正确（emit 带 sessionId 才投递）；B 退订后不再投递 + emitter 回收。
 */
import { describe, expect, it, vi } from 'vitest'
import { SessionEventBus } from './session-event-bus.service'

const sampleSettled = (sessionId?: string) => ({
  holdId: 'hold-1',
  credits: 3,
  model: 'step-3.5-flash',
  ...(sessionId ? { sessionId } : {}),
})

describe('SessionEventBus turn_settled 通道（实时补桥）', () => {
  it('A：emitTurnSettled 按会话路由到订阅者；无 sessionId 静默丢弃', () => {
    const bus = new SessionEventBus()
    const s1 = vi.fn()
    const s2 = vi.fn()
    bus.subscribeSessionTurnSettled('s1', s1)
    bus.subscribeSessionTurnSettled('s2', s2)

    bus.emitTurnSettled(sampleSettled('s1'))
    expect(s1).toHaveBeenCalledTimes(1)
    expect(s1).toHaveBeenCalledWith(expect.objectContaining({ holdId: 'hold-1', credits: 3 }))
    expect(s2).not.toHaveBeenCalled()

    // 异常形态：无 sessionId（理论上结算块恒有）⇒ 不投递不炸
    expect(() => bus.emitTurnSettled(sampleSettled())).not.toThrow()
    expect(s1).toHaveBeenCalledTimes(1)
  })

  it('B：退订后不再投递；最后一个订阅者退订后 emitter 回收', () => {
    const bus = new SessionEventBus()
    const fn = vi.fn()
    const unsub = bus.subscribeSessionTurnSettled('s1', fn)

    bus.emitTurnSettled(sampleSettled('s1'))
    expect(fn).toHaveBeenCalledTimes(1)

    unsub()
    bus.emitTurnSettled(sampleSettled('s1'))
    expect(fn).toHaveBeenCalledTimes(1)

    // 幂等退订：二次调用不抛
    expect(() => unsub()).not.toThrow()

    // emitter 回收后重新订阅：新订阅者能收到（防 stale emitter 吞事件）
    const fn2 = vi.fn()
    bus.subscribeSessionTurnSettled('s1', fn2)
    bus.emitTurnSettled(sampleSettled('s1'))
    expect(fn2).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
