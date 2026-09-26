import { describe, expect, it } from 'vitest'
import { mapThinkingLevel } from './thinking-level'

describe('mapThinkingLevel（P1 thinking 透传）', () => {
  it('T1-1: 关闭 → off；开 + high → medium；开 + max → high；开但无 effort → medium', () => {
    expect(mapThinkingLevel(false, 'high')).toBe('off')
    expect(mapThinkingLevel(undefined, undefined)).toBe('off')
    expect(mapThinkingLevel(true, 'high')).toBe('medium')
    expect(mapThinkingLevel(true, 'max')).toBe('high')
    expect(mapThinkingLevel(true, undefined)).toBe('medium')
  })
})
