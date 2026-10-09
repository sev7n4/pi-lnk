/**
 * S0-3 上游模型对账纯函数（docs/superpowers/specs/2026-10-09-mph-s03-smoke-probe-design.md §3）。
 *
 * 幽灵模型 = 目录有（按路由表归到该上游）而上游 /v1/models 无 ⇒ 用户可选必挂
 * （2026-10-09 事故：deepseek-v4 等 3 个幽灵文本模型，取证见总体规格 §2.4）。
 *
 * ⛔ 零 IO、零依赖、零内部 import：ops/probe-upstream-models.mjs 用
 * `--experimental-strip-types` 直接动态 import 本文件源码，任何运行时 import
 * 都会在 Node 的严格 ESM 解析下炸掉（无扩展名 specifier 不解析）。
 * B1-1 定时对账器将直接 import 本模块 —— 禁止在任何地方重写第二套 diff 逻辑。
 */

/** 上游 id，与探针脚本的 env 前缀一一对应。 */
export type UpstreamId = 'agnes' | 'apimart' | 'fal' | 'minimax' | 'stepfun'

/**
 * 未命中任何路由规则的目录条目兜底归到这里 —— 与 platformCredentials 的
 * resolver 链一致（step/minimax-h3/h3-max/apimart-image 之外全部走
 * gateway-openai-compat 网关，即 agnes hub）。
 */
export const DEFAULT_UPSTREAM: UpstreamId = 'agnes'

export interface UpstreamRouteRule {
  /** 目录条目归属的上游 id */
  readonly upstream: string
  /**
   * 命中条目的 modelKey 或 gatewayModelId 即归该上游（大小写写在正则自身 flags 上）。
   * ⚠️ 不要用 /g 标志（lastIndex 有状态，重复 test 会漂移）。
   */
  readonly pattern: RegExp
}

/**
 * family→upstream 路由表：**与 platformCredentials.ts 保持一致，S2-2 路由表落地后改为 import**。
 * 有序数组，首个命中生效；未命中归 DEFAULT_UPSTREAM。
 */
export type UpstreamRoutingMap = readonly UpstreamRouteRule[]

/** 目录条目的最小结构（StudioModelEntry 天然满足；额外字段一律忽略 → diff 与无关字段无关）。 */
export interface CatalogEntryLike {
  modelKey?: string | null
  gatewayModelId?: string | null
}

export interface UpstreamDiff {
  /** 目录有而上游无 —— 报 modelKey（面向目录/用户），已排序 */
  ghosts: string[]
  /** 上游有而目录无 —— 报上游清单里的原始 id（上架机会），已排序去重 */
  missing: string[]
  /** 交集 —— 报 modelKey，已排序 */
  matched: string[]
}

export interface DiffOptions {
  /**
   * 本次对账的目标上游。缺省 'agnes'（openai-compat 网关兜底，与 resolver 链一致）。
   * 探针脚本按上游逐次调用并显式传 targetUpstream。
   */
  targetUpstream?: string
}

function normalizeId(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

/**
 * 按路由表判定目录条目归属的上游。首个命中生效；未命中归 defaultUpstream。
 * 同时匹配 modelKey 与 gatewayModelId（如 minimax-h3 条目的 gatewayModelId 是
 * `MiniMax-H3`，fal 条目的是 `minimax/h3-max-turbo` —— 上游 id 空间与目录 key 空间不同名）。
 */
export function routeCatalogEntry(
  entry: CatalogEntryLike,
  routingMap: UpstreamRoutingMap,
  defaultUpstream: string = DEFAULT_UPSTREAM,
): string {
  const modelKey = entry.modelKey ?? ''
  const gatewayModelId = entry.gatewayModelId ?? ''
  for (const rule of routingMap) {
    if (
      (modelKey !== '' && rule.pattern.test(modelKey)) ||
      (gatewayModelId !== '' && rule.pattern.test(gatewayModelId))
    ) {
      return rule.upstream
    }
  }
  return defaultUpstream
}

/**
 * 目录 ↔ 单个上游 /v1/models 清单的集合对账。
 *
 * - 只对「按路由表归到 targetUpstream」的目录条目做 diff；归属其他上游的条目
 *   既不是 ghost 也不是 matched（例如 step-tts-* 对 agnes hub 不产生幽灵）。
 * - 比较用 gatewayModelId（实际发往上游的 id，大小写不敏感）；ghost/matched
 *   报 modelKey（面向目录），missing 报上游原始 id。
 * - 集合比较、结果已排序 ⇒ 不依赖任何输入顺序。
 * - **上游不可达不在函数签名内表达**：调用方传 `upstreamModelIds: null` 表示
 *   unavailable ⇒ 返回全空（ghosts=[]，绝不把不可达当幽灵）；不可达的 reason
 *   由脚本层记录（A3 判据：上游 402/403/超时 ≠ 模型幽灵）。
 */
export function diffCatalogAgainstUpstream(
  catalogEntries: readonly CatalogEntryLike[],
  upstreamModelIds: readonly string[] | null,
  routingMap: UpstreamRoutingMap,
  options: DiffOptions = {},
): UpstreamDiff {
  if (upstreamModelIds === null) {
    return { ghosts: [], missing: [], matched: [] }
  }

  const target = options.targetUpstream ?? DEFAULT_UPSTREAM
  const upstreamSet = new Set<string>()
  for (const id of upstreamModelIds) {
    const normalized = normalizeId(id)
    if (normalized !== '') upstreamSet.add(normalized)
  }

  const expected: Array<{ reportId: string; wireId: string }> = []
  for (const entry of catalogEntries) {
    if (routeCatalogEntry(entry, routingMap) !== target) continue
    const reportId = (entry.modelKey ?? entry.gatewayModelId ?? '').trim()
    const wireId = normalizeId(entry.gatewayModelId ?? entry.modelKey)
    if (reportId === '' || wireId === '') continue
    expected.push({ reportId, wireId })
  }
  const expectedWireIds = new Set(expected.map((e) => e.wireId))

  const ghosts: string[] = []
  const matched: string[] = []
  for (const { reportId, wireId } of expected) {
    if (upstreamSet.has(wireId)) matched.push(reportId)
    else ghosts.push(reportId)
  }

  const missing = [...new Set(upstreamModelIds.map((id) => (id ?? '').trim()).filter((id) => id !== '' && !expectedWireIds.has(normalizeId(id))))]

  // 排序 ⇒ 纯集合语义，输入顺序不影响结果（A2）
  ghosts.sort()
  matched.sort()
  missing.sort()
  return { ghosts, missing, matched }
}
