/**
 * S2-2a 上游路由表（spec: docs/superpowers/specs/2026-10-09-mph-s22-routing-table-design.md）。
 *
 * 「哪个模型走哪个上游」从 resolver if/else 链迁为数据驱动路由表。本模块是 shared
 * 侧纯函数层（无 DB）：
 * - `resolveUpstreamRoute(rows, modelKey, capability)`：查路由行 → `RouteResult`；
 * - `legacyResolveUpstream(modelKey, capability)`：现 resolver 链的**原样对拍副本**
 *   （A1 硬门禁用；台账裁定 T3b 亦不得删本副本，移除须独立裁定）；
 * - `UPSTREAM_ROUTE_SEEDS`：从现 resolver 链逐条翻译的种子行（server 播种用）。
 *
 * ⚠️ 全局约束 4（A4）：`RouteResult` **只回 `apiKeyEnvName`（env 变量名），绝不回
 * 密钥值**——密钥仍由 server 端 `readPlatformCredentialEnv` 取（redact 断言见测试）。
 *
 * ⚠️ 全局约束 5（A3）：路由未命中且无可用 default 行 → **确定性抛错**，禁止回落
 * OpenAI 链——把 platformCredentials 里注释级的「绝不因缺 key 返回 null」防护升级
 * 为类型级（`UpstreamRouteResolutionError`）。
 *
 * apimart 的 openai key 回落语义（legacy `resolveApimartPlatformCredentials` 的
 * `apimartApiKey || openaiApiKey`）以两层字段记录：
 * - `UpstreamRouteRow.fallbackApiKeyEnvName`（DB 列，运营可按行覆写）；
 * - `UPSTREAM_REGISTRY.apimart.fallbackApiKeyEnvName`（shared 静态注册表缺省值）。
 * T3b 的 resolver 取 key 时：`APIMART_API_KEY || fallbackApiKeyEnvName 对应 env`。
 */

import {
  DEFAULT_APIMART_BASE_URL,
  DEFAULT_FAL_BASE_URL,
  DEFAULT_MINIMAX_BASE_URL,
  DEFAULT_STEPFUN_BASE_URL,
  isFalH3MaxPlatformModel,
  isMiniMaxH3PlatformModel,
  isStepFunPlatformModel,
  usesApimartImageGateway,
} from './platformCredentials'
import type { ModelCapability } from './providerChannels'

/** 路由可指向的上游集合（S2-2 spec §3.1）。 */
export type UpstreamId = 'agnes_hub' | 'apimart' | 'stepfun' | 'minimax' | 'fal'

/** 行匹配类型；`default` = 兜底行（pattern 为空，仅在未命中任何普通行时生效）。 */
export type UpstreamRouteMatchType = 'prefix' | 'exact' | 'regex' | 'default'

/**
 * 行的 capability 维度。`'*'` = 通配（legacy 的 fal/minimax/stepfun 判定器
 * 不区分模态，翻译为通配行保持逐条等价）；apimart 在 legacy 链里仅在
 * `modality === 'image'` 分支被检查，翻译为 `image` 行。
 */
export type UpstreamRouteCapability = ModelCapability | '*'

/** 路由行的最小形状（shared 纯函数视角；server DB 行经白名单校验映射到此）。 */
export interface UpstreamRouteRow {
  id?: string
  matchType: UpstreamRouteMatchType
  /** `default` 行为 null；prefix/exact/regex 行必填 */
  pattern: string | null
  capability: UpstreamRouteCapability
  upstream: UpstreamId
  /** 命中优先级：降序，同分按 exact > prefix > regex */
  priority: number
  enabled: boolean
  /** 命中行密钥回落 env 名（apimart → OPENAI_API_KEY；见模块头注释） */
  fallbackApiKeyEnvName?: string | null
}

/**
 * 路由解析结果。**只回 env 名，不回密钥值**（A4）。
 * `baseUrl` 为该上游 env 覆盖前的静态缺省端点；agnes_hub 的 baseUrl 由运行时
 * `OPENAI_BASE_URL` / providerChannel 快照决定、无静态缺省，故缺省缺失该字段。
 */
export interface RouteResult {
  upstream: UpstreamId
  baseUrl?: string
  apiKeyEnvName: string
  /** 命中行密钥回落 env 名（目前仅 apimart 有；缺省缺失） */
  fallbackApiKeyEnvName?: string
}

/** 每上游的静态凭据注册表：缺省 baseUrl + 密钥 env 名（+ 回落 env 名）。 */
export interface UpstreamRegistryEntry {
  baseUrl: string | undefined
  apiKeyEnvName: string
  fallbackApiKeyEnvName?: string
}

export const UPSTREAM_REGISTRY: Record<UpstreamId, UpstreamRegistryEntry> = {
  agnes_hub: {
    // baseUrl 运行时由 OPENAI_BASE_URL / providerChannel 快照决定，无静态缺省。
    baseUrl: undefined,
    apiKeyEnvName: 'OPENAI_API_KEY',
  },
  apimart: {
    baseUrl: DEFAULT_APIMART_BASE_URL,
    apiKeyEnvName: 'APIMART_API_KEY',
    // legacy `resolveApimartPlatformCredentials`：`vars.apimartApiKey || vars.openaiApiKey`。
    fallbackApiKeyEnvName: 'OPENAI_API_KEY',
  },
  stepfun: { baseUrl: DEFAULT_STEPFUN_BASE_URL, apiKeyEnvName: 'STEPFUN_API_KEY' },
  minimax: { baseUrl: DEFAULT_MINIMAX_BASE_URL, apiKeyEnvName: 'MINIMAX_API_KEY' },
  fal: { baseUrl: DEFAULT_FAL_BASE_URL, apiKeyEnvName: 'FAL_KEY' },
}

// ── regex 行 ReDoS 防线（spec §5：pattern 长度上限 + 禁嵌套量词 lint） ──

/** regex pattern 长度上限。现有最长种子 22 字符，128 留 5 倍余量。 */
export const MAX_ROUTE_PATTERN_LENGTH = 128

export class UpstreamRoutePatternError extends Error {}

/**
 * regex 行安全断言（播种/运营写入/解析三条路都过这里）：
 * 1. 长度上限；
 * 2. 禁嵌套量词（经典 ReDoS 形态 `(a+)+`）与相邻双量词——**保守 lint，宁可误报**；
 * 3. 必须能编译（无效 pattern 确定性报错，不静默跳过该行）。
 */
export function assertRoutePatternSafe(pattern: string): void {
  if (pattern.length > MAX_ROUTE_PATTERN_LENGTH) {
    throw new UpstreamRoutePatternError(
      `路由 regex pattern 超长（${pattern.length} > ${MAX_ROUTE_PATTERN_LENGTH}）：${pattern}`,
    )
  }
  // 嵌套量词：量词字符紧跟闭括号、闭括号后又是量词（如 `(a+)+` / `(a{2,3})*`）。
  if (/[*+}]\s*\)\s*[*+?{]/.test(pattern)) {
    throw new UpstreamRoutePatternError(`路由 regex pattern 疑似嵌套量词（ReDoS 防线）：${pattern}`)
  }
  // 相邻双量词（如 `a**` / `a+*`）：无效或危险形态，一律拒绝。
  if (/[*+?]\s*[*+?{]/.test(pattern)) {
    throw new UpstreamRoutePatternError(`路由 regex pattern 疑似相邻双量词（ReDoS 防线）：${pattern}`)
  }
  try {
    void new RegExp(pattern, 'i')
  } catch (err) {
    throw new UpstreamRoutePatternError(
      `路由 regex pattern 无法编译：${pattern}（${err instanceof Error ? err.message : String(err)}）`,
    )
  }
}

function compileRouteRegex(row: UpstreamRouteRow): RegExp {
  const pattern = row.pattern ?? ''
  assertRoutePatternSafe(pattern)
  // 一律 `i` flag：legacy resolver 家族（/h3-max/i、/^minimax-h3$/i、/^step/i）全带 i。
  return new RegExp(pattern, 'i')
}

// ── 行匹配内核 ──

const MATCH_TYPE_RANK: Record<Exclude<UpstreamRouteMatchType, 'default'>, number> = {
  exact: 0,
  prefix: 1,
  regex: 2,
}

function capabilityMatches(row: UpstreamRouteRow, capability: ModelCapability): boolean {
  return row.capability === '*' || row.capability === capability
}

/**
 * 单行是否命中 modelKey。全部大小写不敏感（与 legacy resolver 家族的 `/i` 一致）；
 * prefix/exact 行两侧 trim + 小写比较；regex 行按 `i` flag 测 trim 后的原始串。
 */
function rowMatchesKey(row: UpstreamRouteRow, key: string): boolean {
  const pattern = (row.pattern ?? '').trim()
  switch (row.matchType) {
    case 'exact':
      // 空 pattern 的 exact 行只该出现在 default 行上——普通 exact 行空 pattern 视作配置错误。
      return pattern.length > 0 && key.toLowerCase() === pattern.toLowerCase()
    case 'prefix':
      // 空 pattern 的 prefix 行会匹配一切——视作配置错误，不命中。
      return pattern.length > 0 && key.toLowerCase().startsWith(pattern.toLowerCase())
    case 'regex':
      return compileRouteRegex(row).test(key)
    default:
      return false
  }
}

/**
 * 查普通路由行（不含 default 行）：enabled + capability 命中 + key 命中，
 * 取 priority 降序、同分 exact > prefix > regex 的第一行。未命中返回 **null**
 * （= 兜底前的显式状态；兜底与抛错由 `resolveUpstreamRoute` 负责）。
 */
export function matchUpstreamRoute(
  rows: UpstreamRouteRow[],
  modelKey: string,
  capability: ModelCapability,
): UpstreamRouteRow | null {
  const key = modelKey.trim()
  const candidates = rows
    .filter(
      (row) =>
        row.enabled &&
        row.matchType !== 'default' &&
        capabilityMatches(row, capability) &&
        rowMatchesKey(row, key),
    )
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      const rankA = MATCH_TYPE_RANK[a.matchType as Exclude<UpstreamRouteMatchType, 'default'>]
      const rankB = MATCH_TYPE_RANK[b.matchType as Exclude<UpstreamRouteMatchType, 'default'>]
      return rankA - rankB
    })
  return candidates[0] ?? null
}

/**
 * A3 确定性错误：未命中且无可用 default 行。same inputs → same message，
 * 禁止静默回落 OpenAI 链（全局约束 5 的类型级防线）。
 */
export class UpstreamRouteResolutionError extends Error {}

/**
 * 路由解析：命中 → `RouteResult`；未命中 → enabled 的 default 行（capability
 * 也要匹配）；两者皆无 → **确定性抛错**（绝不回落 OpenAI 链）。
 */
export function resolveUpstreamRoute(
  rows: UpstreamRouteRow[],
  modelKey: string,
  capability: ModelCapability,
): RouteResult {
  const key = modelKey.trim()
  const hit = matchUpstreamRoute(rows, key, capability)
  const row =
    hit ??
    rows.find(
      (r) => r.enabled && r.matchType === 'default' && capabilityMatches(r, capability),
    ) ??
    null
  if (!row) {
    throw new UpstreamRouteResolutionError(
      `上游路由解析失败：modelKey="${key}" capability="${capability}" 未命中任何路由行，且无可用 default 行——禁止回落 OpenAI 链（S2-2 A3）`,
    )
  }
  const registry = UPSTREAM_REGISTRY[row.upstream]
  const fallbackApiKeyEnvName = row.fallbackApiKeyEnvName ?? registry.fallbackApiKeyEnvName
  return {
    upstream: row.upstream,
    ...(registry.baseUrl != null ? { baseUrl: registry.baseUrl } : {}),
    apiKeyEnvName: registry.apiKeyEnvName,
    ...(fallbackApiKeyEnvName ? { fallbackApiKeyEnvName } : {}),
  }
}

// ── legacy 对拍副本（A1 硬门禁） ──

/**
 * ⚠️ 对拍副本——**现 resolver 链的原样保留**，不改原链行为（原链在
 * `platformCredentials.ts` + `provider-resolver.service.ts`，本任务不动）。
 *
 * 逐条复制 provider-resolver.service.ts 平台分支的判定顺序：
 * fal（`/h3-max/i`）→ minimax（`/^minimax-h3$/i`）→ stepfun（`/^step/i`）→
 * apimart（仅 image 模态，经 `usesApimartImageGateway` 的 backed 名单 + 目录耦合）
 * → 兜底 agnes_hub（OpenAI 链）。
 */
export function legacyResolveUpstream(modelKey: string, capability: ModelCapability): UpstreamId {
  if (isFalH3MaxPlatformModel(modelKey)) return 'fal'
  if (isMiniMaxH3PlatformModel(modelKey)) return 'minimax'
  if (isStepFunPlatformModel(modelKey)) return 'stepfun'
  if (capability === 'image' && usesApimartImageGateway(modelKey)) return 'apimart'
  return 'agnes_hub'
}

// ── 种子（从现 resolver 链逐条翻译；server 侧 insert-if-absent 只插不改） ──

export type UpstreamRouteSeed = Omit<UpstreamRouteRow, 'id'>

/**
 * 种子翻译表（逐条来源）：
 *
 * | # | matchType | pattern | capability | upstream | priority | legacy 来源 |
 * |---|---|---|---|---|---|---|
 * | 1 | regex | `h3-max` | * | fal | 40 | `isFalH3MaxPlatformModel` `/h3-max/i` |
 * | 2 | exact | `minimax-h3` | * | minimax | 30 | `isMiniMaxH3PlatformModel` `/^minimax-h3$/i`（exact + 大小写不敏感 ≡ 锚定正则，含 `MiniMax-H3` 别名） |
 * | 3 | prefix | `step` | * | stepfun | 20 | `isStepFunPlatformModel` `/^step/i`（覆盖 step-tts-* / stepaudio-*） |
 * | 4 | exact | `image2` | image | apimart | 10 | `usesApimartImageGateway` → backed 名单（gpt-image-2 目录别名） |
 * | 5 | exact | `seedream-5.0-pro` | image | apimart | 10 | 同上（seedream 目录名） |
 * | 6 | prefix | `doubao-seedream-` | image | apimart | 10 | 同上（seedream gateway id 前缀） |
 * | 7 | prefix | `gpt-image-2` | image | apimart | 10 | 同上（gpt-image-2 gateway id 前缀） |
 * | 8 | regex | `^gemini-3\.[0-9]+-flash$` | image | apimart | 10 | 同上（APIMart 把 image2 更名为 gemini-3.x-flash） |
 * | 9 | regex | `gemini-.*-flash-image` | image | apimart | 10 | 同上（gemini flash-image 形态） |
 * | 10 | default | (null) | * | agnes_hub | 0 | 链尾兜底（OpenAI 链） |
 *
 * fal/minimax/stepfun 行用 capability `'*'`：legacy 判定器不区分模态；
 * apimart 行用 `'image'`：legacy 仅在 `modality === 'image'` 分支检查。
 *
 * apimart 行全部带 `fallbackApiKeyEnvName: 'OPENAI_API_KEY'`，记录
 * `apimartApiKey || openaiApiKey` 回落语义（与 UPSTREAM_REGISTRY 缺省一致，
 * 显式落列让运营在 DB 里可见可改）。
 *
 * ⚠️ 已知边界（A1 对拍范围内等价性成立）：legacy 的目录耦合跳（modelKey 不含
 * backed 特征、但 catalog gatewayModelId 命中 backed 名单）无法用 pattern 行表达。
 * 当前目录所有 backed 条目（image2 / seedream-5.0-pro）的 modelKey 自身命中本表；
 * 未来后台新增「modelKey 无特征、gatewayModelId 命中 backed」的条目时，须同步加
 * 路由行（运营操作项，runbook 记录）。
 */
export const UPSTREAM_ROUTE_SEEDS: UpstreamRouteSeed[] = [
  // legacy 顺序第 1：fal（/h3-max/i，匹配 h3-max / h3-max-turbo）
  { matchType: 'regex', pattern: 'h3-max', capability: '*', upstream: 'fal', priority: 40, enabled: true },
  // legacy 顺序第 2：minimax（/^minimax-h3$/i；exact + 不区分大小写 ≡ 锚定正则）
  { matchType: 'exact', pattern: 'minimax-h3', capability: '*', upstream: 'minimax', priority: 30, enabled: true },
  // legacy 顺序第 3：stepfun（/^step/i，覆盖 step-tts-* / stepaudio-*）
  { matchType: 'prefix', pattern: 'step', capability: '*', upstream: 'stepfun', priority: 20, enabled: true },
  // legacy 顺序第 4（仅 image）：apimart backed 名单。回落语义：APIMART_API_KEY
  // 缺失时回落 OPENAI_API_KEY（resolveApimartPlatformCredentials 的 || 链）。
  { matchType: 'exact', pattern: 'image2', capability: 'image', upstream: 'apimart', priority: 10, enabled: true, fallbackApiKeyEnvName: 'OPENAI_API_KEY' },
  { matchType: 'exact', pattern: 'seedream-5.0-pro', capability: 'image', upstream: 'apimart', priority: 10, enabled: true, fallbackApiKeyEnvName: 'OPENAI_API_KEY' },
  { matchType: 'prefix', pattern: 'doubao-seedream-', capability: 'image', upstream: 'apimart', priority: 10, enabled: true, fallbackApiKeyEnvName: 'OPENAI_API_KEY' },
  { matchType: 'prefix', pattern: 'gpt-image-2', capability: 'image', upstream: 'apimart', priority: 10, enabled: true, fallbackApiKeyEnvName: 'OPENAI_API_KEY' },
  { matchType: 'regex', pattern: '^gemini-3\\.[0-9]+-flash$', capability: 'image', upstream: 'apimart', priority: 10, enabled: true, fallbackApiKeyEnvName: 'OPENAI_API_KEY' },
  { matchType: 'regex', pattern: 'gemini-.*-flash-image', capability: 'image', upstream: 'apimart', priority: 10, enabled: true, fallbackApiKeyEnvName: 'OPENAI_API_KEY' },
  // 链尾兜底：agnes hub（OpenAI 链）
  { matchType: 'default', pattern: null, capability: '*', upstream: 'agnes_hub', priority: 0, enabled: true },
]
