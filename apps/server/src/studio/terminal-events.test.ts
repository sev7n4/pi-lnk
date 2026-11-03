import { describe, it, expect, vi } from 'vitest'
import { TerminalEventBus, TERMINATION_EVENT, terminalEventBus } from './terminal-events'

describe('TerminalEventBus', () => {
  it('onTerminalized 收到 emitTerminalized 一次', () => {
    const bus = new TerminalEventBus()
    const cb = vi.fn()
    bus.onTerminalized(cb)
    bus.emitTerminalized()
    expect(cb).toHaveBeenCalledTimes(1)
  })
  it('offTerminalized 后不再收到', () => {
    const bus = new TerminalEventBus()
    const cb = vi.fn()
    bus.onTerminalized(cb)
    bus.offTerminalized(cb)
    bus.emitTerminalized()
    expect(cb).not.toHaveBeenCalled()
  })
  it('事件名常量稳定', () => {
    expect(TERMINATION_EVENT).toBe('generation-record:terminalized')
  })
  it('模块级单例可被订阅', () => {
    const cb = vi.fn()
    terminalEventBus.onTerminalized(cb)
    terminalEventBus.emitTerminalized()
    terminalEventBus.offTerminalized(cb)
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
