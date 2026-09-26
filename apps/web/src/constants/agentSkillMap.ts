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

export const AGENT_INPUT_PLACEHOLDER_AUTO =
  '描述需求，@ 引用素材，Cmd/Ctrl + Enter 发送…'

export function agentInputPlaceholder(skill: AgentSkillDef | undefined): string {
  if (!skill) return AGENT_INPUT_PLACEHOLDER_AUTO
  return `已选技能「${skill.label}」— 描述编排需求，Cmd/Ctrl + Enter 发送…`
}
