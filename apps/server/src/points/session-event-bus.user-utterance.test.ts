/**
 * SessionEventBus userUtterance 通道（2026-11-11 插话气泡实时化 + 消费终态）。
 *
 * 三类用户发言领域事件共用一张注册表；语义与 turn_ack 同族（回合/发言裁定，
 * 刻意无迟到回放 —— queued 晚回放会让重挂端与历史 hydration 竞态出双气泡）。
 * 变异自检：去掉 listenerCount 清理 ⇒ 泄漏用例红；回放误加 ⇒ 「无迟到回放」红。
 */
import { describe, expect, it, vi } from 'vitest'
import { SessionEventBus, type UserUtteranceBusEvent } from './session-event-bus.service'

function ev(over: Partial<UserUtteranceBusEvent> = {}): UserUtteranceBusEvent {
  return {
    sessionId: 't1',
    threadId: 't1',
    entryId: 'E1',
    kind: 'queued',
    content: '加一只猫',
    ts: '2026-11-11T00:00:00.000Z',
    ...over,
  }
}

describe('SessionEventBus userUtterance 通道', () => {
  it('emit → 同 key 订阅者收到；不同 key 不串台', () => {
    const bus = new SessionEventBus()
    const a = vi.fn()
    const b = vi.fn()
    bus.subscribeSessionUserUtterance('t1', a)
    bus.subscribeSessionUserUtterance('t2', b)
    bus.emitUserUtterance(ev())
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
    expect(a.mock.calls[0]![0]).toMatchObject({ entryId: 'E1', kind: 'queued', threadId: 't1' })
  })

  it('无路由键 emit 静默丢弃；三类 kind 均可投递', () => {
    const bus = new SessionEventBus()
    const fn = vi.fn()
    bus.subscribeSessionUserUtterance('t1', fn)
    bus.emitUserUtterance(ev({ sessionId: undefined }))
    expect(fn).not.toHaveBeenCalled()
    bus.emitUserUtterance(ev({ kind: 'consumed' }))
    bus.emitUserUtterance(ev({ kind: 'stuck' }))
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('退订后不再收到；全部退订后注册表清空（防泄漏）', () => {
    const bus = new SessionEventBus()
    const fn = vi.fn()
    const unsub = bus.subscribeSessionUserUtterance('t1', fn)
    unsub()
    bus.emitUserUtterance(ev())
    expect(fn).not.toHaveBeenCalled()
    // 泄漏防线：listener 清空后 emitter 应被移除（同 turnAck 的 subscribe 清理语义）
    // 经私有注册表断言（类型断言进内部，测试专用）。
    expect((bus as unknown as { userUtteranceEmitters: Map<string, unknown> }).userUtteranceEmitters.size).toBe(0)
  })

  it('同一 fn 重复订阅只计一次（与既有通道同款去重）', () => {
    const bus = new SessionEventBus()
    const fn = vi.fn()
    const u1 = bus.subscribeSessionUserUtterance('t1', fn)
    const u2 = bus.subscribeSessionUserUtterance('t1', fn)
    bus.emitUserUtterance(ev())
    expect(fn).toHaveBeenCalledTimes(1)
    // 去重共享一次注册：单次退订即完全移除
    u1()
    u2()
    expect((bus as unknown as { userUtteranceEmitters: Map<string, unknown> }).userUtteranceEmitters.size).toBe(0)
  })

  it('刻意无迟到回放：emit 后新订阅者不补投旧事件（与 turn_ack 同理由）', () => {
    const bus = new SessionEventBus()
    const late = vi.fn()
    bus.emitUserUtterance(ev()) // 无订阅者，事件即丢（权威源是 DB，非总线回放）
    bus.subscribeSessionUserUtterance('t1', late)
    expect(late).not.toHaveBeenCalled()
  })
})
