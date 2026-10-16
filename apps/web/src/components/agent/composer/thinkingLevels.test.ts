// P1-2.1 思考档位（Task 7）：['标准','深入','极限'] 与 chip 标签
import { it, expect } from 'vitest'
import { THINKING_LEVELS, levelLabel } from './thinkingLevels'

it('levels localized & labeled', () => {
  expect(THINKING_LEVELS).toEqual(['标准', '深入', '极限'])
  expect(levelLabel('标准')).toBe('思考·标准')
})
