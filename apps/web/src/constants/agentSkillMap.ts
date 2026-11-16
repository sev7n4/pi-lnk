/**
 * Agent dock skills — only entries with Nest → Runtime mapping (see agent-skill-map.ts).
 * 只保留 pi-runtime /skills 真实存在的技能（以生产 listSkills 为事实源）：
 * 老 runtime 的 enterprise-marketing-campaign / ecommerce-product-visual 不迁移（不在 pi 侧安装），
 * 因此 dock 不再列出——保留只会静默 fail-soft，用户选了却不生效。
 */

export interface AgentSkillDef {
  id: string
  label: string
  desc: string
  /** Runtime skill directory name (validated by discover_skills). */
  runtimeSkillId: string
}

/** Backend-connected skills shown in the Agent dock 「技能」 menu. */
export const AGENT_SKILLS: AgentSkillDef[] = [
  {
    id: 'product-visual',
    label: '实物产品视觉出图',
    desc: '实拍产品多类型视觉方案与并行出图（ecommerce-product-photo）',
    runtimeSkillId: 'ecommerce-product-photo',
  },
]

export function getAgentSkill(id: string | null | undefined): AgentSkillDef | undefined {
  if (!id) return undefined
  return AGENT_SKILLS.find((s) => s.id === id)
}

/** 用户已装技能的最小形状（来自 /skills/mine，避免 constants 层依赖 service 层类型）。
 *  summary 可选：Nest mine 端点不返回 summary，desc 回退到 skill 名。 */
export interface InstalledSkillLike {
  skill: string
  displayName: string
  summary?: string
  enabled: boolean
  disableModelInvocation: boolean
}

/**
 * M1-3：内置技能打头 + 用户已启用技能动态并入 dock 下拉。
 *  - enabled=false / disableModelInvocation=true 不进（关闭态与隐式拒）
 *  - runtimeSkillId = 技能名本身（dock 选中后 skillId 走 server pass-through → forceSkills）
 *  - 同 runtimeSkillId 去重、保留内置（内置是事实源，防用户装同名内置项把默认顶掉）
 *  - 入参空 ⇒ 原样返回内置（M0 行为逐字节不变）
 */
export function mergeAgentSkills(
  builtin: AgentSkillDef[],
  installed: InstalledSkillLike[],
): AgentSkillDef[] {
  const seen = new Set(builtin.map((s) => s.runtimeSkillId))
  const merged: AgentSkillDef[] = [...builtin]
  for (const s of installed) {
    if (!s.enabled || s.disableModelInvocation || !s.skill) continue
    if (seen.has(s.skill)) continue
    seen.add(s.skill)
    merged.push({
      id: s.skill,
      label: s.displayName || s.skill,
      desc: s.summary || s.skill,
      runtimeSkillId: s.skill,
    })
  }
  return merged
}

export const AGENT_INPUT_PLACEHOLDER_AUTO =
  '描述你的想法，或 @ 引用画布节点…'

export function agentInputPlaceholder(skill: AgentSkillDef | undefined): string {
  if (!skill) return AGENT_INPUT_PLACEHOLDER_AUTO
  return `已选技能「${skill.label}」— 描述编排需求，@ 引用画布节点…`
}
