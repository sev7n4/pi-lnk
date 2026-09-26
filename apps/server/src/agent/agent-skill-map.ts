/**
 * UI skill id → Runtime skill_id. Only ids listed in AGENT_SKILLS (web) should appear here.
 * 目标名以 pi-runtime /skills 实际安装列表为事实源；老 runtime 的
 * enterprise-marketing-campaign / ecommerce-product-visual 不迁移，故不再映射。
 */
export const SKILL_UI_TO_RUNTIME: Record<string, string | undefined> = {
  'product-visual': 'ecommerce-product-photo',
}

export function mapUiSkillId(uiSkillId?: string): string | undefined {
  if (!uiSkillId) return undefined
  const mapped = SKILL_UI_TO_RUNTIME[uiSkillId]
  if (mapped) return mapped
  // Allow runtime skill_id pass-through for API / tests.
  if (uiSkillId === 'ecommerce-product-photo') return uiSkillId
  return undefined
}
