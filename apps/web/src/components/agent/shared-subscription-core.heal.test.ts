/**
 * S2 行为回归（2026-11-17）：生产实证两处断裂点的可重复复现。
 *
 * 断裂点 A——sendMessage ack 分支重挂不开连接：
 *   失败轮 abort 后 state 停在 non-idle（connecting/backoff）但 liveCount=0，
 *   旧判据 `state === 'idle'` 判 false ⇒ 重挂时零 fetch（生产实证）。
 *   修复后 needsStart 判 liveCount===0 → 自愈开连接。
 *
 * 断裂点 B——页面加载选举中间态误 abort：
 *   abort 后选举定型触发 onLeadership → evaluateConnection → 同样靠 needsStart 自愈。
 *
 * 本测试用真实 follower/leader 判据 + followUpTail 状态机，验证「判据层」自愈闭环。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { needsStart, shouldOpenConnection } from './shared-subscription-core'

describe('S2：evaluateConnection 判据层自愈（生产两处断裂点）', () => {
  beforeEach(() => vi.spyOn(Math, 'random').mockReturnValue(0.5))
  afterEach(() => vi.restoreAllMocks())

  const allowedLeader = shouldOpenConnection({ degraded: false, isLeader: true, visible: true })

  it('A: 失败轮 abort 后 state=connecting + live=0 ⇒ sendMessage 重挂判据判定开连接', () => {
    expect(allowedLeader).toBe(true)
    expect(
      needsStart({ allowed: allowedLeader, state: 'connecting', liveCount: 0 }),
      '旧判据在此返回 false（生产零 fetch），修复后必须 true',
    ).toBe(true)
  })

  it('B: 选举定型后 leader 重估（state=backoff + live=0）⇒ 判据判定开连接', () => {
    expect(needsStart({ allowed: allowedLeader, state: 'backoff', liveCount: 0 })).toBe(true)
  })

  it('护栏: follower 即便 live=0 也绝不自行开连接（不得回到 N 标签页 N 连接）', () => {
    const allowedFollower = shouldOpenConnection({ degraded: false, isLeader: false, visible: true })
    expect(allowedFollower).toBe(false)
    expect(needsStart({ allowed: allowedFollower, state: 'connecting', liveCount: 0 })).toBe(false)
  })

  it('护栏: 已有活连接（live≥1）时重估不得重复开（防双份文本）', () => {
    expect(needsStart({ allowed: allowedLeader, state: 'connecting', liveCount: 1 })).toBe(false)
  })
})
