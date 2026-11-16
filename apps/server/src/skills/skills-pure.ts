// 文件：apps/server/src/skills/skills-pure.ts
// M1-1 六个纯函数（规格 v2 §8 保留/改写清单；每个判据都有 §10 行为级对应，纯函数单测不替代端点验收）。
// 纪律：判据体与实现体分离；禁 as never；函数不碰 Prisma/HTTP。

import type { ParsedSkillPackage } from './skills-parse.js'

// ─── evaluateCompatibility（§4.2 兼容分级 C0–C3 + F25/F27 声明-实际差异）──────────

export interface CompatibilityResult {
  profile: 'C0' | 'C1' | 'C2' | 'C3'
  /** 可映射动作数 / 声明动作数。C0/C3 恒为 1 或 0。 */
  score: number
  mappedActions: string[]
  unmappedActions: string[]
}

/** 声明动作（frontmatter capabilities）里平台可映射的能力名。 */
export const MAPPABLE_CAPABILITIES = new Set([
  'file-read',
  'file-write',
  'canvas-node',
  'propose_generation',
  'image-generation',
  'video-generation',
  'audio-generation',
  'text-generation',
  'web-search',
])

/** C3 拒绝模式：宿主机权限/安装依赖/出网执行/凭据读取（正文扫描，注入也逃不掉 §4.4 第 2 条）。 */
const C3_PATTERNS: Array<[RegExp, string]> = [
  [/sudo|apt-get|brew install|npm install -g|pip install/i, '安装系统依赖或全局包'],
  [/\b(curl|wget)\b[^`]*\|\s*(bash|sh|zsh)/i, '下载并执行远程脚本'],
  [/AWS_ACCESS_KEY|SECRET_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|credentials/i, '读取宿主机凭据'],
  [/chmod|\/etc\/|~\/\.ssh|rm -rf\s+\/(?!tmp)/i, '修改宿主机系统路径'],
]

/** C2 执行模式：要求脚本/CLI/外部模型 API/付费任务。 */
const C2_PATTERNS: Array<[RegExp, string]> = [
  [/\b(python|node|bash|sh|zsh)\s+\S+\.(py|js|sh|ts)\b/i, '运行脚本文件'],
  [/\b(curl|wget)\s+https?:\/\//i, '命令行访问外部 API'],
  [/gpt-|claude-|gemini|midjourney|stable-diffusion/i, '调用外部模型 API'],
]

/** C1 产物模式：声明创作状态路径。 */
const C1_PATTERN =
  /(?:^|[\s`(])((?:[\w.-]+\/)+[\w.-]*\.(?:md|json|yaml|yml|txt|html|csv|mp4|mp3|png|jpg|jpeg|webp))|(?:^|[\s`(])((?:[\w.-]+\/){1,}[\w-]*\/?)(?=[\s)`.,]|$)/

function scanActions(body: string): { c3: string[]; c2: string[]; c1: string[] } {
  const c3: string[] = []
  const c2: string[] = []
  const c1: string[] = []
  for (const [re, label] of C3_PATTERNS) if (re.test(body)) c3.push(label)
  for (const [re, label] of C2_PATTERNS) if (re.test(body)) c2.push(label)
  const c1Matches = body.match(new RegExp(C1_PATTERN.source, 'gm'))
  if (c1Matches) for (const m of c1Matches.slice(0, 10)) c1.push(m.trim())
  return { c3, c2, c1 }
}

/**
 * 兼容评估：先扫描正文实际要求（C3 短路 → C2 → C1 → C0），再与 frontmatter
 * capabilities 声明对账（F25/F27：声明与实际不一致要暴露在 unmapped/mapped 里）。
 */
export function evaluateCompatibility(pkg: {
  body: string
  frontmatter: Record<string, unknown>
}): CompatibilityResult {
  const { c3, c2, c1 } = scanActions(pkg.body)
  if (c3.length > 0) {
    return { profile: 'C3', score: 0, mappedActions: [], unmappedActions: c3 }
  }
  const declared = Array.isArray(pkg.frontmatter.capabilities)
    ? (pkg.frontmatter.capabilities as string[]).filter((c) => typeof c === 'string')
    : []
  const declaredMapped = declared.filter((c) => MAPPABLE_CAPABILITIES.has(c))
  const declaredUnmapped = declared.filter((c) => !MAPPABLE_CAPABILITIES.has(c))

  if (c2.length > 0) {
    // C2：脚本/CLI 类动作在 M1 阶段无适配器（M2 才落地）⇒ 全部记 unmapped 更诚实；
    // 声明了可映射能力名的除外（能力适配器契约已定）。
    const mapped = [...declaredMapped]
    const unmapped = [...declaredUnmapped, ...c2]
    const total = mapped.length + unmapped.length
    return {
      profile: 'C2',
      score: total === 0 ? 0 : Math.round((mapped.length / total) * 100) / 100,
      mappedActions: mapped,
      unmappedActions: unmapped,
    }
  }
  if (c1.length > 0 || declaredMapped.includes('canvas-node') || declaredMapped.includes('file-write')) {
    return {
      profile: 'C1',
      score: 1,
      mappedActions: ['canvas-node', ...declaredMapped.filter((c) => c !== 'canvas-node')],
      unmappedActions: declaredUnmapped,
    }
  }
  // C0：纯知识。声明了能力但正文没有对应动作 ⇒ F27 差异暴露。
  return {
    profile: 'C0',
    score: declared.length === 0 ? 1 : declaredMapped.length / declared.length,
    mappedActions: declaredMapped,
    unmappedActions: declaredUnmapped,
  }
}

// ─── verifyImport（§4.4 P0 硬约束；七类样本逐类可独立转红，M1-N5）────────────────

export interface ImportContext {
  /** 内容寻址层是否已存在同 publisher+skill 但不同 hash 的版本（同名不同 publisher 覆盖检查用）。 */
  sameSkillExistingPublishers?: string[]
  /** 当前导入的 publisher。 */
  publisher: string
  /** 平台已审来源（catalog 目录项）自动放行部分规则；未审来源一律从严（P4）。 */
  reviewedSource: boolean
}

export interface ImportVerdict {
  ok: boolean
  /** 用户可见拒绝理由（每条独立可判；全部命中即全部列出）。 */
  reasons: string[]
  /** 命中的高风险规则名（审计 after 字段用）。 */
  triggeredRules: string[]
}

const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/ignore (all )?(previous|prior|above) (instructions|prompts?)/i, '指令覆盖注入（ignore previous instructions）'],
  [/you are now|system:\s*|disregard .{0,20}(rules|instructions)/i, '角色伪装注入'],
  [/<\|?(im_start|system|endoftext)\|?>/i, '特殊标记注入'],
]

export function verifyImport(
  pkg: ParsedSkillPackage & { sourceText: string },
  ctx: ImportContext,
): ImportVerdict {
  const reasons: string[] = []
  const triggeredRules: string[] = []
  const body = pkg.body
  const source = pkg.sourceText

  // 1. scripts/ 目录或脚本执行块
  if (/(^|\n)\s*#{0,4}\s*(scripts?\/|```\s*sh\b|```\s*bash\b)/i.test(source)) {
    reasons.push('包含 scripts/ 目录或 shell 代码块：本平台禁止执行脚本（§4.4 第 2 条）')
    triggeredRules.push('scripts')
  }
  // 2. 前置命令文本诱导（「安装前请先运行…」）
  if (/(?:安装|运行|先|首先)[^\n]{0,20}(?:npm install|pip install|brew|apt-get|curl|node |python )/i.test(source)) {
    reasons.push('包含前置命令诱导文本：agent 不执行 SKILL.md 前置步骤（F22）')
    triggeredRules.push('preflight-command')
  }
  // 3. 外链资源自动加载
  if (/https?:\/\/[^\s)]+\.(?:js|css|sh|py|bin)/i.test(source)) {
    reasons.push('引用外部可执行/样式资源：禁止外链资源自动加载（§4.4 第 2 条）')
    triggeredRules.push('external-resource')
  }
  // 4. 无许可证（社区内容不进公开精选目录；自定义也要求声明来源）
  if (!pkg.frontmatter.license && !ctx.reviewedSource) {
    reasons.push('frontmatter 缺 license 字段：无许可证的社区内容不得进入平台（§4.4 第 7 条）')
    triggeredRules.push('no-license')
  }
  // 5. 同名不同 publisher 覆盖
  const conflicting = (ctx.sameSkillExistingPublishers ?? []).filter((p) => p !== ctx.publisher)
  if (conflicting.length > 0) {
    reasons.push(`技能名已被其他发布者占用（${conflicting.join(', ')}）：显式冲突拒绝而非覆盖（F26）`)
    triggeredRules.push('name-conflict')
  }
  // 6. 注入模式（扫正文全量，非仅代码块）
  for (const [re, label] of INJECTION_PATTERNS) {
    if (re.test(body)) {
      reasons.push(`命中注入模式：${label}`)
      triggeredRules.push('prompt-injection')
      break
    }
  }
  // 7. 体积（parse 阶段已拦 4MB；这里兜底防直接构造绕过）
  if (Buffer.byteLength(pkg.body, 'utf8') > MAX_IMPORT_BYTES) {
    reasons.push(`正文超过 ${MAX_IMPORT_BYTES} 字节上限`)
    triggeredRules.push('body-size')
  }
  return { ok: reasons.length === 0, reasons, triggeredRules }
}

export const MAX_IMPORT_BYTES = 4 * 1024 * 1024

// ─── resolveInvocationMode（P10/P11/P12/P17）────────────────────────────────────

export type InvocationIntent = 'implicit' | 'explicit' | 'routed'
export type InvocationMode = 'implicit' | 'explicit' | 'denied'

export interface InvocationSubject {
  disableModelInvocation: boolean
  userInvocable: boolean
  /** 用户态：软删除后两种意图都拒绝。 */
  uninstalled: boolean
  /** 未审（trustLevel=unreviewed）技能显式点名拒绝（P17 平台取严）。 */
  reviewed: boolean
  enabled: boolean
}

export function resolveInvocationMode(subject: InvocationSubject, intent: InvocationIntent): InvocationMode {
  if (subject.uninstalled) return 'denied'
  if (intent === 'implicit') {
    // disableModelInvocation=true：不进语义 index 但显式必达（上游 formatter 过滤 + 此处双保险）。
    return subject.disableModelInvocation || !subject.enabled ? 'denied' : 'implicit'
  }
  if (intent === 'routed') {
    // 平台路由触发：userInvocable=false 不作为用户命令出现，但路由必达（P12/F54）。
    return !subject.reviewed && !subject.enabled ? 'denied' : 'explicit'
  }
  // 显式（用户点选/斜杠/指令点名）：已关闭技能可被点名（P17 D 级口径的开关部分），
  // 但 user-invocable:false 不进用户点选列表，未审/已卸载一律拒绝。
  if (!subject.userInvocable || (!subject.reviewed && !subject.enabled)) return 'denied'
  return 'explicit'
}

// ─── applySkillOverride（F47/F50：覆盖不改正文；幂等）────────────────────────────

export interface SkillOverride {
  enabled?: boolean
  allowAuto?: boolean
  userInvocable?: boolean
}

export function applySkillOverride(current: SkillOverride, intent: SkillOverride): SkillOverride {
  const next: SkillOverride = { ...current }
  if (intent.enabled !== undefined) next.enabled = intent.enabled
  if (intent.allowAuto !== undefined) next.allowAuto = intent.allowAuto
  if (intent.userInvocable !== undefined) next.userInvocable = intent.userInvocable
  return next
}

// ─── assertUninstallGuard（P5/P8：agent 不能自主卸载；无确认必拒）────────────────

export type UninstallSource = 'user-ui' | 'agent-tool'

export interface UninstallRequest {
  source: UninstallSource
  /** 二次确认标记（用户 UI 传 true；agent 永远无法通过）。 */
  confirmed: boolean
  targets: string[]
}

export interface UninstallGuardResult {
  allowed: boolean
  reason?: string
  /** 每个目标一条审计事件（批量逐项审计，M1-A8）。 */
  auditTargets: string[]
}

export function assertUninstallGuard(req: UninstallRequest): UninstallGuardResult {
  const auditTargets = [...req.targets]
  if (req.source === 'agent-tool') {
    return { allowed: false, reason: 'agent 不能自主卸载技能：该操作只属于用户 UI（P5/F45）', auditTargets }
  }
  if (!req.confirmed) {
    return { allowed: false, reason: '卸载需要二次确认标记', auditTargets }
  }
  if (req.targets.length === 0) {
    return { allowed: false, reason: '卸载目标为空', auditTargets }
  }
  return { allowed: true, auditTargets }
}

// ─── rankCatalog（P2：四维排序；热度只影响排序不影响 trustLevel）─────────────────

export type CatalogSort = 'comprehensive' | 'usage' | 'installs' | 'updated'

export interface CatalogRow {
  packageHash: string
  rankScore: number
  usageCount: number
  installCount: number
  updatedAt: Date | string
  featured: boolean
}

export function rankCatalog<T extends CatalogRow>(rows: T[], sort: CatalogSort): T[] {
  const t = (r: CatalogRow) => new Date(r.updatedAt).getTime()
  const cmp = {
    comprehensive: (a: T, b: T) =>
      Number(b.featured) - Number(a.featured) || b.rankScore - a.rankScore || b.installCount - a.installCount,
    usage: (a: T, b: T) => b.usageCount - a.usageCount || b.rankScore - a.rankScore,
    installs: (a: T, b: T) => b.installCount - a.installCount || b.rankScore - a.rankScore,
    updated: (a: T, b: T) => t(b) - t(a),
  }[sort]
  return [...rows].sort(cmp)
}
