/**
 * 订阅孤儿态自愈（2026-11-17，spec §4 候选 B）：
 *
 * evaluateConnection 原判定 `if (state === 'idle') start()` 有结构性盲区——
 * 当 allowed=true 但 state 非 idle（connecting/backoff）且**实际无活连接**（liveCount=0）
 * 时不会开连接 ⇒ 永久孤儿态。生产实证：/runs/events 200 后被掐、60s 零重连、
 * sendMessage 重挂也不开连接。
 *
 * 修复判据：allowed 时「idle **或** liveCount===0（孤儿）」都应开连接；
 * liveCount>0（有活轮）时不得重复开（multi-device P0：任何时刻 ≤1 条连接）。
 */
import { describe, expect, it } from 'vitest'
import { needsStart } from './shared-subscription-core'

describe('needsStart：allowed 时的开连接判据（含孤儿态自愈）', () => {
  it('① allowed=false ⇒ 永不自行开连接（follower / 隐藏页不得自建）', () => {
    expect(needsStart({ allowed: false, state: 'idle', liveCount: 0 })).toBe(false)
    expect(needsStart({ allowed: false, state: 'connecting', liveCount: 0 })).toBe(false)
    expect(needsStart({ allowed: false, state: 'streaming', liveCount: 1 })).toBe(false)
  })

  it('② allowed=true + idle → 开连接（既有行为）', () => {
    expect(needsStart({ allowed: true, state: 'idle', liveCount: 0 })).toBe(true)
  })

  it('③ ⭐ allowed=true + state 非 idle 但 liveCount=0（孤儿态）→ 必须开连接', () => {
    expect(needsStart({ allowed: true, state: 'connecting', liveCount: 0 })).toBe(true)
    expect(needsStart({ allowed: true, state: 'backoff', liveCount: 0 })).toBe(true)
    expect(needsStart({ allowed: true, state: 'streaming', liveCount: 0 })).toBe(true)
  })

  it('④ allowed=true + 已有活连接（liveCount≥1）→ 不得重复开（≤1 条连接契约）', () => {
    expect(needsStart({ allowed: true, state: 'connecting', liveCount: 1 })).toBe(false)
    expect(needsStart({ allowed: true, state: 'streaming', liveCount: 1 })).toBe(false)
    expect(needsStart({ allowed: true, state: 'backoff', liveCount: 1 })).toBe(false)
  })
})
