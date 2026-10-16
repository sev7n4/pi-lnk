import { describe, expect, it } from 'vitest'
import { classifyGesture, HOLD_MS, CANCEL_SWIPE_PX } from './holdGesture'

describe('classifyGesture (P2-2.2)', () => {
  it('short press = tap (switch to input, not voice)', () => {
    expect(classifyGesture({ durationMs: 120, dy: 0 })).toBe('tap')
  })
  it(`long press ≥ ${HOLD_MS}ms = hold (voice)`, () => {
    expect(classifyGesture({ durationMs: HOLD_MS, dy: 0 })).toBe('hold')
  })
  it('swipe up beyond threshold = cancel', () => {
    expect(classifyGesture({ durationMs: 1200, dy: -(CANCEL_SWIPE_PX + 1) })).toBe('cancel')
    expect(classifyGesture({ durationMs: 1200, dy: -(CANCEL_SWIPE_PX - 1) })).toBe('hold')
  })
})
