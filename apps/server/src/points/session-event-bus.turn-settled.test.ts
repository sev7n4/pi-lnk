/**
 * 2026-11-04 实时补桥：SessionEventBus turn_settled 通道。
 *
 * 背景：flag `STREAM_MAIN_FROM_PIRUNTIME=on` 下，streamConversation 的 yield 帧被
 * 后台 drain 丢弃（仅保留落库副作用）⇒ turn_settled 经 /runs/events 收不到，前端
 * 实时摘要缺结算段（刷新重放才见）。本通道把结算块 emit 的权威值路由到
 * runEventStream 订阅队列（与 credit_tx Epic 1 Task 5 同款接线）。
 *
 * 钉住：A 会话路由正确（emit 带 sessionId 才投递）；B 退订后不再投递 + emitter 回收；
 * R 迟到订阅回放（2026-11-04 结算实时性根治机制 A）：重挂 /runs/events 的握手窗口内
 * emit 的结算没有订阅者 ⇒ 静默丢失 —— 保留最近一笔并对新订阅者补投（窗口内）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionEventBus, TURN_SETTLED_REPLAY_MS } from './session-event-bus.service'

const sampleSettled = (sessionId?: string, overrides?: { credits?: number }) => ({
  holdId: 'hold-1',
  credits: overrides?.credits ?? 3,
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

    // 异常形态：无 sessionId（理论上结算块恒有）⇒ 不投递不炸、不保留
    expect(() => bus.emitTurnSettled(sampleSettled())).not.toThrow()
    expect(s1).toHaveBeenCalledTimes(1)
    // 新订阅者收到的是**此前那笔 s1 emit 的合法回放**（last-wins 保留语义），
    // 且恰好 1 次——无 sessionId 的 emit 不得新增保留（否则会 >1）。
    const late = vi.fn()
    bus.subscribeSessionTurnSettled('s1', late)
    expect(late).toHaveBeenCalledTimes(1)
    expect(late).toHaveBeenCalledWith(expect.objectContaining({ holdId: 'hold-1', credits: 3 }))
  })

  it('B：退订后不再投递；emitter 回收后重新订阅能收到新 emit（+ 窗口内回放）', () => {
    const bus = new SessionEventBus()
    const fn = vi.fn()
    const unsub = bus.subscribeSessionTurnSettled('s1', fn)

    bus.emitTurnSettled(sampleSettled('s1'))
    expect(fn).toHaveBeenCalledTimes(1)

    unsub()
    bus.emitTurnSettled(sampleSettled('s1', { credits: 5 }))
    expect(fn).toHaveBeenCalledTimes(1)

    // 幂等退订：二次调用不抛
    expect(() => unsub()).not.toThrow()

    // emitter 回收后重新订阅：① 先收到窗口内保留值的**回放**（credits=5，退订期 emit 的那笔）
    // ② 再收到此后新 emit 的 live 投递。旧订阅者 fn 不受回放影响。
    const fn2 = vi.fn()
    bus.subscribeSessionTurnSettled('s1', fn2)
    expect(fn2).toHaveBeenCalledTimes(1)
    expect(fn2).toHaveBeenCalledWith(expect.objectContaining({ holdId: 'hold-1', credits: 5 }))

    bus.emitTurnSettled(sampleSettled('s1', { credits: 7 }))
    expect(fn2).toHaveBeenCalledTimes(2)
    expect(fn2).toHaveBeenLastCalledWith(expect.objectContaining({ credits: 7 }))
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('SessionEventBus turn_settled 迟到订阅回放（机制 A：重挂握手窗口丢失防御）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z').getTime())
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('R1：无订阅者时 emit ⇒ 新订阅者**同步**收到回放（首帧语义）', () => {
    const bus = new SessionEventBus()
    const fn = vi.fn()
    // 结算先于订阅到达（重挂窗口内 emit）——当前生产丢失形态
    bus.emitTurnSettled(sampleSettled('s1'))
    expect(fn).not.toHaveBeenCalled()

    bus.subscribeSessionTurnSettled('s1', fn)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ holdId: 'hold-1', credits: 3 }))
  })

  it('R2：last-wins——窗口内多次 emit 只回放最新一笔（覆盖写幂等语义）', () => {
    const bus = new SessionEventBus()
    bus.emitTurnSettled(sampleSettled('s1', { credits: 3 }))
    bus.emitTurnSettled(sampleSettled('s1', { credits: 9 }))

    const fn = vi.fn()
    bus.subscribeSessionTurnSettled('s1', fn)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ credits: 9 }))
  })

  it('R3：超出回放窗口的保留值不回放（防旧结算误标到新回合时间线）', () => {
    const bus = new SessionEventBus()
    bus.emitTurnSettled(sampleSettled('s1'))

    // 推进系统时钟越过窗口（fake timers 下 Date.now 同步推进）
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z').getTime() + TURN_SETTLED_REPLAY_MS + 1)

    const fn = vi.fn()
    bus.subscribeSessionTurnSettled('s1', fn)
    expect(fn).not.toHaveBeenCalled()
  })

  it('R4：窗口边界——恰好 ts+窗口 仍回放，超过 1ms 不回放', () => {
    const bus = new SessionEventBus()
    bus.emitTurnSettled(sampleSettled('s1'))
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z').getTime() + TURN_SETTLED_REPLAY_MS)
    const fnEdge = vi.fn()
    bus.subscribeSessionTurnSettled('s1', fnEdge)
    expect(fnEdge).toHaveBeenCalledTimes(1)

    // 超窗口 1ms：换新 bus 重演（保留 ts 取自 emit 当下的 fake 时钟 ⇒ 推进必须相对当下）
    const bus2 = new SessionEventBus()
    bus2.emitTurnSettled(sampleSettled('s1'))
    vi.setSystemTime(Date.now() + TURN_SETTLED_REPLAY_MS + 1)
    const fnOver = vi.fn()
    bus2.subscribeSessionTurnSettled('s1', fnOver)
    expect(fnOver).not.toHaveBeenCalled()
  })

  it('R5：在册订阅者不受回放影响（回放只发生在 subscribe 时刻，live 投递不重复）', () => {
    const bus = new SessionEventBus()
    const fn = vi.fn()
    bus.subscribeSessionTurnSettled('s1', fn)
    // 无保留值 ⇒ 订阅时不回放
    expect(fn).not.toHaveBeenCalled()

    bus.emitTurnSettled(sampleSettled('s1'))
    // live 恰好一次，不叠加回放
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('R6：会话隔离——s1 的保留值不回放给 s2 的订阅者（M4 会话归属）', () => {
    const bus = new SessionEventBus()
    bus.emitTurnSettled(sampleSettled('s1'))
    const fnS2 = vi.fn()
    bus.subscribeSessionTurnSettled('s2', fnS2)
    expect(fnS2).not.toHaveBeenCalled()
  })

  it('R7：保留表有界——超限淘汰最旧会话（防长驻进程无界增长）', () => {
    const bus = new SessionEventBus()
    // 行为级等价断言：为 CAP+1 个会话各 emit 一笔（容量 1000），最旧会话（s-0）的
    // 保留被淘汰 ⇒ 其订阅者不回放；最新会话（s-1000）仍在窗口内 ⇒ 回放。
    for (let i = 0; i <= 1000; i += 1) {
      bus.emitTurnSettled(sampleSettled(`s-${i}`))
    }
    const fnOldest = vi.fn()
    bus.subscribeSessionTurnSettled('s-0', fnOldest)
    expect(fnOldest, '最旧会话保留值必须被淘汰').not.toHaveBeenCalled()

    const fnNewest = vi.fn()
    bus.subscribeSessionTurnSettled('s-1000', fnNewest)
    expect(fnNewest, '最新会话保留值必须仍在').toHaveBeenCalledTimes(1)
  })
})
