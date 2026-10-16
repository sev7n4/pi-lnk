import { describe, expect, it } from 'vitest'
import { barShape, classifyGesture, COMPOSER_HOLD_MS } from './mobileBarLayout'

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

describe('classifyGesture (P1-5.3 bar-level tap vs hold)', () => {
  it('tap below threshold, hold at/above threshold', () => {
    expect(classifyGesture(0)).toBe('tap')
    expect(classifyGesture(COMPOSER_HOLD_MS - 1)).toBe('tap')
    expect(classifyGesture(COMPOSER_HOLD_MS)).toBe('hold')
    expect(classifyGesture(1200)).toBe('hold')
  })
  it('threshold is the 300ms inline constant reserved for Task 13 (ASR wiring)', () => {
    expect(COMPOSER_HOLD_MS).toBe(300)
  })
})
