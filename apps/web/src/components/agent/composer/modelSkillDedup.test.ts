// P1-2.2 模型/技能语义去重（Task 7）：技能菜单已表达编排语义时，模型 chip 不再重复暴露
import { it, expect } from 'vitest'
import { shouldShowModelChip } from './modelSkillDedup'

it('hides model chip when skill is auto-routed', () => {
  expect(shouldShowModelChip(null)).toBe(true)          // 无技能 = 纯模型选择
  expect(shouldShowModelChip('auto')).toBe(false)       // 自动路由 = 技能菜单已表达
  expect(shouldShowModelChip('product-visual')).toBe(false) // 具体技能锁定编排，模型不重复暴露
})
