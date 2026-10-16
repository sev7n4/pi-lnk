// P1-2.2 模型/技能语义去重（Task 7）：
// 技能选中（含「自动」路由）时，编排语义已由技能菜单表达，模型 chip 不再重复暴露；
// 无技能 = 纯模型选择，chip 可见。
export function shouldShowModelChip(selectedSkillId: string | null): boolean {
  return selectedSkillId == null
}

/**
 * P2-6.1 模型 chip 文案本地化截断：超长取 `slice(0, max) + '…'`，
 * 完整名由调用方放进 `title` tooltip。
 */
export function friendlyModelName(raw: string, max = 12): string {
  return raw.length > max ? `${raw.slice(0, max)}…` : raw
}
