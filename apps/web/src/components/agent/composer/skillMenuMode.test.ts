// P2-5.1 技能降级：≤3 个技能 → chip 直选；≥4 → 菜单
import { expect, it } from 'vitest'
import { skillMenuMode } from './skillMenuMode'

it('≤3 skills degrade to chip (P2-5.1)', () => {
  expect(skillMenuMode(1)).toBe('chip')
  expect(skillMenuMode(3)).toBe('chip')
  expect(skillMenuMode(4)).toBe('menu')
})
