// P1-2.2 模型/技能语义去重（Task 7）：技能菜单已表达编排语义时，模型 chip 不再重复暴露
import { it, expect } from 'vitest'
import { friendlyModelName, shouldShowModelChip } from './modelSkillDedup'

it('hides model chip when skill is auto-routed', () => {
  expect(shouldShowModelChip(null)).toBe(true)          // 无技能 = 纯模型选择
  expect(shouldShowModelChip('auto')).toBe(false)       // 自动路由 = 技能菜单已表达
  expect(shouldShowModelChip('product-visual')).toBe(false) // 具体技能锁定编排，模型不重复暴露
})

// P2-6.1 模型 chip 本地化截断：超长取 slice(0, 12) + '…'，完整名进 title tooltip
it('truncates long model names to 12 chars + ellipsis (P2-6.1)', () => {
  expect(friendlyModelName('Step-5-Planning-Alpha')).toBe('Step-5-Plann…')
  expect(friendlyModelName('短模型')).toBe('短模型')            // 不超长原样返回
  expect(friendlyModelName('exactly12chrss')).toBe('exactly12chrss'.slice(0, 12) + '…')
  expect(friendlyModelName('step-5', 4)).toBe('step…')          // 自定义 max
})
