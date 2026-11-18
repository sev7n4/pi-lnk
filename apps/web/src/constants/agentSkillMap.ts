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

/**
 * 用户已装技能的最小形状（来自 /skills/mine，避免 constants 层依赖 service 层类型）。
 *  summary 可选：Nest mine 端点不返回 summary，desc 回退到 skill 名。 */
export interface InstalledSkillLike {
  skill: string
  displayName: string
  summary?: string
  enabled: boolean
  disableModelInvocation: boolean
  /** P12/F54：false 不作为用户点选命令出现（仍可被平台路由触发）。 */
  userInvocable: boolean
}

/** 运行时内置技能最小形状（来自 /skills/runtime，与 pi-runtime GET /skills 对齐）。 */
export interface RuntimeSkillLike {
  name: string
  description: string
}

/**
 * 内置技能可发现（本刀）：运行时技能适配成 InstalledSkillLike 后**复用 mergeAgentSkills**——
 * 去重/过滤/内置兜底逻辑全部白拿，不新造第二套合并（规格 §4.5 吃满上游硬约束）。
 *  - 内置技能默认可点选（userInvocable: true）：控制字段未解析（诚实边界 §5.3），G3 golden
 *    重写后经 Nest 解析收紧；disableModelInvocation=false 同理。
 *  - label/desc 直取运行时 name/description，零硬编码（B7 动态性判据）。
 */
export function runtimeSkillsToInstalled(runtime: RuntimeSkillLike[]): InstalledSkillLike[] {
  return runtime
    .filter((r) => Boolean(r.name))
    .map((r) => ({
      skill: r.name,
      displayName: r.name,
      summary: r.description,
      enabled: true,
      disableModelInvocation: false,
      userInvocable: true,
    }))
}

/**
 * M1-3：内置技能打头 + 用户已启用技能动态并入 dock 下拉。
 *  - enabled=false / disableModelInvocation=true / userInvocable=false 不进（关闭态、隐式拒、不可点选）
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
    if (!s.enabled || s.disableModelInvocation || s.userInvocable === false || !s.skill) continue
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

/**
 * `/` 卡片显示名（零映射表、零造数）：
 *  1) label 已是可读名（含中文 / 非纯 slug）→ 直接用（AGENT_SKILLS 内置项有准确短名，如「实物产品视觉出图」）；
 *  2) label 是 slug（runtime 动态技能，如 `drama-audio-design`）→ 从 desc 首句派生。
 * ⚠️ 派生只按 `。` 切——技能名本身含 `/`（如「短剧/漫剧配音与声音设计」），
 * 按 `/` 或 `，` 切会把显示名砍成「短剧」。无 `。` 时退首个换行；失败回退 label。
 */
export function displayNameFromDesc(label: string, desc: string | undefined): string {
  const fallback = label || '技能'
  // 可读名判据：含 CJK 字符即视为已命名（slug 为纯 ascii/数字/-/_）。
  if (/[\u3400-\u9fff]/.test(label)) return label
  const raw = (desc ?? '').trim()
  if (!raw) return fallback
  const first = raw.split('。', 1)[0]!.split('\n', 1)[0]!.trim()
  const name = first || raw.split('\n', 1)[0]!.trim()
  return name.slice(0, 24) || fallback
}

/** 选中技能后胶囊行已承载技能名，placeholder 只留一句短提示，不再重复技能名 / @ 引导。 */
export const AGENT_INPUT_PLACEHOLDER_WITH_SKILL = '补充描述…'

export const AGENT_INPUT_PLACEHOLDER_AUTO =
  '描述你的想法，或 @ 引用画布节点…'

export function agentInputPlaceholder(skill: AgentSkillDef | undefined): string {
  return skill ? AGENT_INPUT_PLACEHOLDER_WITH_SKILL : AGENT_INPUT_PLACEHOLDER_AUTO
}
