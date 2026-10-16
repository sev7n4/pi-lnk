import { describe, expect, it } from 'vitest'
import { barShape } from './mobileBarLayout'

describe('barShape (P1-5 two-layer contract)', () => {
  it('idle: single bar, only ＋ inside', () => {
    expect(barShape({ hasRefs: false, isStreaming: false })).toBe('idle')
  })
  it('refs draft content grows the bar → stacked (chips inside, not floating)', () => {
    expect(barShape({ hasRefs: true, isStreaming: false })).toBe('stacked')
  })
  it('generating: queued placeholder + stop slot', () => {
    expect(barShape({ hasRefs: false, isStreaming: true })).toBe('queued')
    expect(barShape({ hasRefs: true, isStreaming: true })).toBe('stacked')
  })
})

// classifyGesture（tap/hold/cancel）自 Task 13 起由 ./holdGesture 单源提供，
// 测试随之迁移到 holdGesture.test.ts；本文件只守 barShape。
