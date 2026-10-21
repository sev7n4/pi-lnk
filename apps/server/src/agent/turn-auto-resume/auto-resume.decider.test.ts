import { describe, it, expect } from 'vitest'
import {
  decideAutoResume,
  MAX_AUTO_RESUME_PER_SESSION_PER_HOUR,
  SAME_THREAD_STREAK_DEGRADE,
  shouldTriggerAutoResume,
  type AutoResumeInput,
} from './auto-resume.decider'

const base: AutoResumeInput = {
  failed: true,
  userOnline: false,
  turnAlreadyDispatched: false,
  sessionDispatchCountLastHour: 0,
  sameThreadStreak: 1,
}

describe('decideAutoResume', () => {
  it('失败 + 用户不在场 + 未超限 ⇒ newTurn', () => {
    const d = decideAutoResume(base)
    expect(d.path).toBe('newTurn')
    expect(d.degraded).toBe(false)
  })

  it('⭐ 用户在场 ⇒ skip（别抢他的意图，他会自己说「继续」）', () => {
    const d = decideAutoResume({ ...base, userOnline: true })
    expect(d.path).toBe('skip')
    expect(d.reason).toBe('user-online')
  })

  it('⛔ 用户主动取消（failed=false）⇒ skip', () => {
    const d = decideAutoResume({ ...base, failed: false })
    expect(d.path).toBe('skip')
    expect(d.reason).toBe('not-failed')
  })

  it('幂等：同一轮已派发过 ⇒ skip', () => {
    const d = decideAutoResume({ ...base, turnAlreadyDispatched: true })
    expect(d.path).toBe('skip')
    expect(d.reason).toBe('turn-already-dispatched')
  })

  it('每会话每小时超限 ⇒ skip', () => {
    const d = decideAutoResume({
      ...base,
      sessionDispatchCountLastHour: MAX_AUTO_RESUME_PER_SESSION_PER_HOUR,
    })
    expect(d.path).toBe('skip')
    expect(d.reason).toBe('session-rate-limited')
  })

  it('⭐ 同因连败达阈值 ⇒ skip + degraded（交回用户，不无限重试）', () => {
    const d = decideAutoResume({ ...base, sameThreadStreak: SAME_THREAD_STREAK_DEGRADE })
    expect(d.path).toBe('skip')
    expect(d.degraded).toBe(true)
    expect(d.reason).toBe('same-thread-streak')
  })

  it('⛔ 连败降级不得绕过「用户在场」门（在线仍 skip）', () => {
    const d = decideAutoResume({
      ...base,
      userOnline: true,
      sameThreadStreak: SAME_THREAD_STREAK_DEGRADE,
    })
    expect(d.path).toBe('skip')
    expect(d.degraded).toBe(false)
  })

  it('⭐ 幂等门优先于其余门（已派发时不再看在线/限流）', () => {
    const d = decideAutoResume({
      ...base,
      turnAlreadyDispatched: true,
      userOnline: true,
      sessionDispatchCountLastHour: 99,
    })
    expect(d.reason).toBe('turn-already-dispatched')
  })

  it('⭐ 失败门优先于在线门（非失败时 reason 是 not-failed，不是 user-online）', () => {
    const d = decideAutoResume({ ...base, failed: false, userOnline: true })
    expect(d.reason).toBe('not-failed')
  })
})

describe('shouldTriggerAutoResume（触发点前置判据）', () => {
  const ok = { turnRole: 'owner' as const, promptAccepted: true, runFailed: true, userId: 'u1' }

  it('owner + 接受 + 失败 + 有 userId ⇒ 触发', () => {
    expect(shouldTriggerAutoResume(ok)).toBe(true)
  })

  it('⭐ shadow 流 ⇒ 不触发（否则 owner + shadow 双派发 = 白烧一轮额度）', () => {
    // ⭐ 回归锁：`promptAccepted` 在 409（shadow）时**仍为 true**
    // ⇒ 只看 promptAccepted 会让 shadow 与 owner 都触发 ⇒ 双派发。
    expect(shouldTriggerAutoResume({ ...ok, turnRole: 'shadow' })).toBe(false)
  })

  it('⛔ prompt 未被接受 ⇒ 不触发（那是批次 2 对账自愈的场景，不是新开一轮）', () => {
    expect(shouldTriggerAutoResume({ ...ok, promptAccepted: false })).toBe(false)
  })

  it('⛔ 本轮没失败 ⇒ 不触发', () => {
    expect(shouldTriggerAutoResume({ ...ok, runFailed: false })).toBe(false)
  })

  it('⛔ 缺 userId ⇒ 不触发（piEligible 判定不通过）', () => {
    expect(shouldTriggerAutoResume({ ...ok, userId: undefined })).toBe(false)
    expect(shouldTriggerAutoResume({ ...ok, userId: '' })).toBe(false)
  })
})
