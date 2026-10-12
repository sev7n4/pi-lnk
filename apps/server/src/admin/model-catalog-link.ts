/**
 * 模型目录页【上游端点 + 链路状态】的**纯逻辑**部分（2026-10-12 运营增强）。
 *
 * 职责：给 catalog GET list 的每个条目组装 `ops` 字段——
 * - 上游端点：按路由表解析归属上游（与探活分组/onboard 校验同一 resolveUpstreamRoute
 *   单胜者语义），映射到该上游的 baseUrl（agnes_hub 无静态缺省，由调用方注入
 *   `OPENAI_BASE_URL`；其余取 shared UPSTREAM_REGISTRY 静态缺省）。
 * - 链路状态原料：availability（平台渠道镜像，探活器唯一写入方，name=modelKey）
 *   + 平台侧近 24h 真实流量（modelHealth 聚合行中 channelId='platform' 的子集，
 *   复用 buildHealthSql/rowsToHealth 原语，⛔ 不另写第二套 SQL）。
 *
 * 灯色判定（linkStatusOf）由前端 modelLinkStatus.ts 消费同一组字段；本文件只做
 * 服务端取数与组装。零 IO：IO 全部落在控制器（prisma / env / route-store 缓存）。
 */
import { resolveUpstreamRoute, UPSTREAM_REGISTRY, type UpstreamRouteRow } from '@lnkpi/shared'

/** 平台渠道镜像 models 条目的 availability 三态（与 upstream-probe-logic 同口径）。 */
export type LinkAvailability = 'available' | 'unavailable' | 'unknown'

/** 目录条目运营视角的链路原料（GET /admin/model-catalog 每条目 `ops` 字段）。 */
export interface EntryLinkOps {
  /** 路由解析出的上游 id（routing 空间，如 agnes_hub）；未命中任何行（无 default）⇒ null。 */
  upstream: string | null
  /** 该上游的请求端点（agnes_hub=运行时 OPENAI_BASE_URL；其余=静态缺省）；未知 ⇒ null。 */
  baseUrl: string | null
  /** 平台渠道镜像中的探活 availability；不在镜像（软删/新条目未对齐）⇒ null。 */
  availability: LinkAvailability | null
  /** 平台侧近 24h 真实成功生成次数（GenerationRecord，裸 modelKey 行）。 */
  completed24h: number
  /** 平台侧近 24h 命中 402 文案族的记录数（欠费信号）。 */
  balance40224h: number
}

/** 镜像 models JSON 的最小条目形状（多余字段忽略；畸形条目跳过）。 */
interface MirrorEntryLike {
  name?: unknown
  availability?: unknown
}

/**
 * 平台渠道 models JSON → name → availability 映射。
 * 非法 JSON / 非数组 / 条目缺 name 或 availability 值不合法 ⇒ 跳过该条目（保守不猜）。
 */
export function parseAvailabilityByName(raw: string | null | undefined): Map<string, LinkAvailability> {
  const map = new Map<string, LinkAvailability>()
  if (!raw) return map
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return map
  }
  if (!Array.isArray(parsed)) return map
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const name = (item as MirrorEntryLike).name
    const availability = (item as MirrorEntryLike).availability
    if (typeof name !== 'string' || name === '') continue
    if (availability !== 'available' && availability !== 'unavailable' && availability !== 'unknown') continue
    map.set(name, availability)
  }
  return map
}

/** modelHealth 聚合行中本功能消费的最小子集（channelId='platform' 行）。 */
export interface PlatformTrafficRow {
  model: string
  channelId: string
  completed: number
  balance402Count: number
}

/**
 * modelHealth 聚合行 → modelKey → 平台侧流量。只保留 channelId='platform'
 * （裸 modelKey）行——BYOK（`userId::modelKey`）流量反映用户自己的上游账户，
 * 与平台链路状态无关。同名多行（理论上一行/模型）安全合并。
 */
export function foldPlatformTraffic(
  rows: readonly PlatformTrafficRow[],
): Map<string, { completed24h: number; balance40224h: number }> {
  const map = new Map<string, { completed24h: number; balance40224h: number }>()
  for (const row of rows) {
    if (row.channelId !== 'platform') continue
    if (typeof row.model !== 'string' || row.model === '') continue
    const prev = map.get(row.model) ?? { completed24h: 0, balance40224h: 0 }
    prev.completed24h += row.completed
    prev.balance40224h += row.balance402Count
    map.set(row.model, prev)
  }
  return map
}

/**
 * 单条目端点解析：resolveUpstreamRoute 单胜者（priority 降序、exact > prefix > regex，
 * 与探活分组/onboard 前置校验同一语义）；未命中且无可用 default 行 ⇒ 双 null。
 * agnesHubBaseUrl 由调用方注入（`OPENAI_BASE_URL`，可空串）；其余上游取静态注册表。
 */
export function resolveEntryEndpoint(
  routeRows: readonly UpstreamRouteRow[],
  modelKey: string,
  modality: string,
  agnesHubBaseUrl: string,
): { upstream: string | null; baseUrl: string | null } {
  let upstream: keyof typeof UPSTREAM_REGISTRY
  try {
    // resolveUpstreamRoute 内部排序需可变数组；modality 走 ModelCapability 校验，
    // 目录层取值受控（text/image/video/audio），越界即视为不可解析（双 null）。
    upstream = resolveUpstreamRoute(
      [...routeRows],
      modelKey,
      modality as Parameters<typeof resolveUpstreamRoute>[2],
    ).upstream
  } catch {
    return { upstream: null, baseUrl: null }
  }
  const registry = UPSTREAM_REGISTRY[upstream]
  const baseUrl = registry?.baseUrl ?? (upstream === 'agnes_hub' ? agnesHubBaseUrl : undefined)
  return { upstream, baseUrl: baseUrl && baseUrl.trim() !== '' ? baseUrl : null }
}

/**
 * 单条目 ops 组装（纯函数；list() 逐条调用）。
 * `inMirror` 显式传入而非从 map 推断：`availability` 字段合法缺省（旧格式无字段）
 * 与「不在镜像」必须区分（后者报 null）。
 */
export function buildEntryOps(
  modelKey: string,
  modality: string,
  routeRows: readonly UpstreamRouteRow[],
  agnesHubBaseUrl: string,
  availByName: Map<string, LinkAvailability>,
  hasMirrorEntry: (name: string) => boolean,
  trafficByModel: Map<string, { completed24h: number; balance40224h: number }>,
): EntryLinkOps {
  const endpoint = resolveEntryEndpoint(routeRows, modelKey, modality, agnesHubBaseUrl)
  const traffic = trafficByModel.get(modelKey) ?? { completed24h: 0, balance40224h: 0 }
  return {
    upstream: endpoint.upstream,
    baseUrl: endpoint.baseUrl,
    availability: hasMirrorEntry(modelKey) ? (availByName.get(modelKey) ?? 'unknown') : null,
    completed24h: traffic.completed24h,
    balance40224h: traffic.balance40224h,
  }
}
