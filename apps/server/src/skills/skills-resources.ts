/**
 * M1-3 Nest 发起方：把用户已装且启用的技能组装为上游 `Skill[]`（计划 §2 决策 1 / v2 §5.4）。
 *
 * 纯函数（无 IO、无 Prisma）：service 层查库后把行喂进来，输出直接放进
 * `/sessions` create body 的 `resources.skills`，由 runtime `parseIncomingResources` 校验。
 *
 * 字段形状对齐上游 `Skill` 与 runtime `IncomingSkill`（name/description/content/filePath?/
 * disableModelInvocation?）。逐字透传 body（不 trim）——contentHash 校验在 service 层查库时做。
 *
 * ⚠️ §4.8 禁自建等价物：本模块只做「行的筛选/排序/裁剪/形状映射」，不解析 frontmatter、
 * 不生成 index、不做注入——那些全部是上游原语的职责（M0 已收敛）。
 */
import type { Skill } from '@earendil-works/pi-agent-core'

/** 单用户可向 runtime 注入的技能上限（计划 §2「≤12 裁剪」；runtime 防御上限 24）。 */
export const MAX_ASSEMBLED_SKILLS = 12

/** 组装输入行（service 层从 UserInstalledSkill ⋈ SkillPackage 投影）。 */
export interface SkillResourceRow {
  skill: string
  displayName: string
  summary: string
  /** SKILL.md frontmatter 之后的正文，逐字。 */
  body: string
  disableModelInvocation: boolean
  enabled: boolean
  installedAt: Date
}

/**
 * 已启用技能 → 上游 Skill[]。
 *  - 跳过 enabled=false（关闭态不进 index，§7.2）。
 *  - 同名按 name 去重，installedAt 更新者胜出。
 *  - 按 installedAt 降序取前 MAX_ASSEMBLED_SKILLS 条。
 *  - description = summary || displayName（runtime 要求非空）。
 *  - filePath 用虚拟路径（不落容器文件系统）。
 */
export function assembleSkillResources(rows: SkillResourceRow[]): Skill[] {
  const byName = new Map<string, SkillResourceRow>()
  for (const r of rows) {
    if (!r.enabled) continue
    if (!r.skill) continue
    const prev = byName.get(r.skill)
    if (!prev || new Date(r.installedAt).getTime() > new Date(prev.installedAt).getTime()) {
      byName.set(r.skill, r)
    }
  }
  const ordered = [...byName.values()].sort(
    (a, b) => new Date(b.installedAt).getTime() - new Date(a.installedAt).getTime(),
  )
  return ordered.slice(0, MAX_ASSEMBLED_SKILLS).map((r) => {
    const skill: Skill = {
      name: r.skill,
      description: r.summary || r.displayName || r.skill,
      content: r.body,
      filePath: `<virtual>/${r.skill}/SKILL.md`,
      disableModelInvocation: r.disableModelInvocation,
    }
    return skill
  })
}
