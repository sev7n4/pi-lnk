// 文件：apps/server/src/skills/skills-parse.ts
// Skills 导入解析（M1-1，规格 v2 §8：parseSkillPackage 自研解析删除，委托上游
// `loadSkills`（pi-agent-core@0.99.2，yaml@2.9.0）——平台只提供「真实临时目录 +
// 上游 NodeExecutionEnv」与白名单校验，不重写 frontmatter 解析器）。
//
// 设计要点：
// - 粘贴文本写进 mkdtemp 临时目录的 SKILL.md，用上游 `loadSkills` 解析 ⇒ name 格式
//   校验、frontmatter 容忍度、多行 description 等边界全部由上游负责（M0 探针同源）。
// - 上游 `Skill` 只回传 name/description/content/disableModelInvocation ⇒
//   license/version/capabilities 等作者声明扩展键从原始 frontmatter 块二次提取
//   （yaml 解析仅 frontmatter 元数据，正文绝不进 yaml）。
// - contentHash = sha256(body.trimEnd()) 全长 hex（内容寻址主键，v1 §4.3）。
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { BACKGROUND_CONTEXT, loadSkills } from '@earendil-works/pi-agent-core'
// ⚠️ 深路径导入：server 是 CJS 构建（moduleResolution=node，不吃 exports map），
// 子路径 `…/node` 解析不到；vendor 是 ESM（Node 22.12+ require(esm) 可加载，生产
// lnkpi-api 实测 node v22.23.5，@lnkpi/agent|shared 同为 ESM 先例）。
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/dist/harness/env/nodejs.js'

/** 导入体积上限：4MB（E-4 判据：正文体积上限理由是 DB 行大小与上下文预算）。 */
export const MAX_SKILL_BYTES = 4 * 1024 * 1024

export interface ParsedSkillPackage {
  skill: string
  displayName: string
  description: string
  body: string
  contentHash: string
  disableModelInvocation: boolean
  /** 原始 frontmatter 对象（作者声明全量键，落 SkillPackage.frontmatter JSON）。 */
  frontmatter: Record<string, unknown>
}

/** 从原文提取 frontmatter 块（首个 `---` 围栏），供上游解析之外的字段提取。 */
export function extractFrontmatterBlock(text: string): { raw: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { raw: null, body: text }
  return { raw: m[1], body: text.slice(m[0].length) }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 解析粘贴/上传的 SKILL.md 原文。
 * 抛 Error（用户可见理由）：体积超限、缺 frontmatter、上游解析失败（含 diagnostics 首条）。
 */
export async function parseSkillPackageText(text: string): Promise<ParsedSkillPackage> {
  if (!text || text.trim().length === 0) throw new Error('SKILL.md 内容为空')
  if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_BYTES) {
    throw new Error(`SKILL.md 超过体积上限 ${MAX_SKILL_BYTES} 字节`)
  }
  const { raw: fmRaw, body } = extractFrontmatterBlock(text)
  if (fmRaw === null) throw new Error('缺少 frontmatter（需以 --- 围栏开头声明 name/description）')

  const dir = mkdtempSync(join(tmpdir(), 'lnkpi-skill-import-'))
  try {
    writeFileSync(join(dir, 'SKILL.md'), text, 'utf8')
    const env = new NodeExecutionEnv({ cwd: dir })
    // loadSkills 遍历目录读 SKILL.md；缺失目录会被跳过，这里目录必然存在。
    const { skills, diagnostics } = await loadSkills(env, [dir], BACKGROUND_CONTEXT)
    const skill = skills[0]
    if (!skill) {
      const diag = diagnostics[0]?.message ?? 'unknown'
      throw new Error(`SKILL.md 解析失败：${diag}`)
    }
    const fm = parseYaml(fmRaw) as Record<string, unknown>
    if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
      throw new Error('frontmatter 必须是 YAML 键值映射')
    }
    // 平台白名单校验（v2 §8）：上游对缺 name 会按文件名派生（tempdir 名不可作技能名），
    // 必须显式拒绝 —— name 是 lane.skill 显式调用的查找键，不可缺省。
    if (typeof fm.name !== 'string' || fm.name.trim().length === 0) {
      throw new Error('frontmatter 缺 name 字段（技能名的查找键，不可派生）')
    }
    // contentHash = sha256(`v1:${skill}:${body.trimEnd()}`)。
    // ⚠️ 对 v1 §4.3 公式（纯 body）的显式勘误：contentHash 是 SkillPackage 主键，
    // 必须包含技能身份——否则「不同技能名、相同正文」哈希碰撞（PK 冲突 + 错误复用包行，
    // 集成测试 A8/A9 实证）。保留性质：正文改一字 ⇒ hash 变（A4 判据）；同名同正文幂等。
    return {
      skill: skill.name,
      displayName: typeof fm.displayName === 'string' ? fm.displayName : skill.name,
      description: skill.description,
      body,
      contentHash: sha256Hex(`v1:${skill.name}:${body.trimEnd()}`),
      disableModelInvocation: skill.disableModelInvocation === true,
      frontmatter: fm,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
