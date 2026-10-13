import { describe, it, expect, beforeEach } from 'vitest'
import { recordSessionSeen, isSessionOnline, __resetPresenceForTest } from './presence'

describe('presence（lastSeenAt 5min 窗口代理）', () => {
  beforeEach(__resetPresenceForTest)
  it('刚见过 → 在线', () => {
    recordSessionSeen('s1', 1_000_000)
    expect(isSessionOnline('s1', 1_000_000 + 60_000)).toBe(true)
  })
  it('超过 5 分钟 → 离线', () => {
    recordSessionSeen('s1', 1_000_000)
    expect(isSessionOnline('s1', 1_000_000 + 5 * 60_000 + 1)).toBe(false)
  })
  it('从未见过 → 离线', () => {
    expect(isSessionOnline('never-seen', 1_000_000)).toBe(false)
  })
  it('边界：恰好 5 分钟 → 仍在线（窗口含端点）', () => {
    recordSessionSeen('s1', 1_000_000)
    expect(isSessionOnline('s1', 1_000_000 + 5 * 60_000)).toBe(true)
  })
})
