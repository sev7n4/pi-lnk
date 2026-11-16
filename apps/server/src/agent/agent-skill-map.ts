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

/**
 * M1-3：用户技能名 pass-through 兜底。内置映射优先（保持 P1 语义），
 * 否则当 skillId 命中当前用户已装技能名时原样放行（runtime lane.skill 从 getResources 解析，
 * 未知名由 UnknownSkill fail-closed）。两者都不命中 → undefined（P1 fail-soft 原文发送）。
 * 内置技能可发现（本刀）：第三参 `runtimeNames` = pi-runtime /skills 实名列表——命中运行时名
 * 的 skillId（如 drama-script-writing）同样 pass-through，经 resolveForceSkills 的 known 白名单
 * 校验后注入 forceSkills。优先级：内置映射 → 用户名 → 运行时名。
 */
export function resolveDockSkillTarget(
  uiSkillId: string | undefined,
  userSkillNames: string[],
  runtimeNames?: string[],
): string | undefined {
  const mapped = mapUiSkillId(uiSkillId)
  if (mapped) return mapped
  if (uiSkillId && userSkillNames.includes(uiSkillId)) return uiSkillId
  if (uiSkillId && runtimeNames?.includes(uiSkillId)) return uiSkillId
  return undefined
}

/** M1-3：把用户技能名并入 resolveForceSkills 的 known 白名单（去重，内置保持在前）。 */
export function withUserSkillNames(
  builtin: Array<{ name: string }>,
  userSkillNames: string[],
): Array<{ name: string }> {
  if (!userSkillNames.length) return builtin
  const seen = new Set(builtin.map((s) => s.name))
  const merged = [...builtin]
  for (const name of userSkillNames) {
    if (seen.has(name)) continue
    seen.add(name)
    merged.push({ name })
  }
  return merged
}
