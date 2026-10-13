import { describe, it, expect } from 'vitest'
import { decideRecoveryDispatch, type DispatchInput } from './recovery-dispatch.decider'

const base: DispatchInput = {
  hasActiveRun: false,
  userOnline: true,
  recordIdDispatchedBefore: false,
  sessionDispatchCountLastHour: 0,
  sameCodeStreak: 1,
}

describe('decideRecoveryDispatch', () => {
  it('空闲 + 在线 + 未超限 → newTurn', () => {
    const d = decideRecoveryDispatch(base)
    expect(d.path).toBe('newTurn')
  })
  it('活跃 run + 在线 → followUp（尾随不打断）', () => {
    const d = decideRecoveryDispatch({ ...base, hasActiveRun: true })
    expect(d.path).toBe('followUp')
  })
  it('离线 → skip（PR1 失败入口兜底）', () => {
    const d = decideRecoveryDispatch({ ...base, userOnline: false })
    expect(d.path).toBe('skip')
  })
  it('同 record 已派发过 → skip（幂等）', () => {
    const d = decideRecoveryDispatch({ ...base, recordIdDispatchedBefore: true })
    expect(d.path).toBe('skip')
  })
  it('session 每小时已 2 次 → skip', () => {
    const d = decideRecoveryDispatch({ ...base, sessionDispatchCountLastHour: 2 })
    expect(d.path).toBe('skip')
  })
  it('同因连败第 2 次（streak=2）→ followUp 且 briefOnly', () => {
    const d = decideRecoveryDispatch({ ...base, hasActiveRun: true, sameCodeStreak: 2 })
    expect(d.path).toBe('followUp')
    expect(d.briefOnly).toBe(true)
  })
  it('离线但同因连败 → 仍 skip（不因降级而破在线门）', () => {
    const d = decideRecoveryDispatch({ ...base, userOnline: false, sameCodeStreak: 2 })
    expect(d.path).toBe('skip')
  })
})
