import { describe, it, expect } from 'vitest'
import { NotifyMetrics } from './notify-metrics'

describe('NotifyMetrics', () => {
  it('incrNotified 按 reason 累计已通报记录数', () => {
    const m = new NotifyMetrics()
    m.incrNotified('terminal-write', 3)
    m.incrNotified('terminal-write', 2)
    m.incrNotified('notify-tick', 5)
    expect(m.snapshot().notified).toEqual({ 'terminal-write': 5, 'notify-tick': 5 })
  })
  it('incrNotified(n<=0) 不计入（D-7 口径）', () => {
    const m = new NotifyMetrics()
    m.incrNotified('terminal-write', 0)
    m.incrNotified('terminal-write', -1)
    expect(m.snapshot().notified).toEqual({})
  })
  it('incrScan 独立计数（不参与 G-1 判定）', () => {
    const m = new NotifyMetrics()
    m.incrScan('terminal-write')
    m.incrScan('terminal-write')
    expect(m.snapshot().scans['terminal-write']).toBe(2)
  })
})
