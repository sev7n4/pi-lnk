/**
 * S2-2a 上游路由表 server 端播种/读取包装器（spec:
 * docs/superpowers/specs/2026-10-09-mph-s22-routing-table-design.md）。
 *
 * 分层（同 S2-1a model-catalog-store 惯例）：
 * - shared `resolveUpstreamRoute(rows, modelKey, capability)` 是纯函数（无 DB）；
 * - 本模块负责：①种子播种（`UPSTREAM_ROUTE_SEEDS` → `UpstreamRoute` 表，
 *   **insert-if-absent 只插不改**，存在即跳过——人工/后台改动永不被覆盖）；
 *   ②DB 行 → shared 行形状的白名单映射（脏行跳过，不毒化解析）；
 *   ③进程内缓存（5s TTL 惰性刷新，同 T1 形态；T3b 接 routesVersion 失效）。
 *
 * 播种接线（两选项中选定并记录）：**复用 ModelCatalogSeedService 同款形态**——
 * `UpstreamRouteSeedService.onModuleInit` 在 Nest bootstrap 阶段注册 prisma 并
 * **非阻塞**触发播种+装载（fire-and-forget，失败不阻断启动、日志落盘）。
 *
 * 本任务（S2-2a）不动 resolver 消费层（provider-resolver 查表化归 T3b）；
 * 缓存装载先行，为 T3b 提供与 shared 纯函数对接的 rows 来源。
 */

import { Inject, Injectable, OnModuleInit } from '@nestjs/common'
import type { Prisma, PrismaClient } from '@prisma/client'
import {
  assertRoutePatternSafe,
  UPSTREAM_ROUTE_SEEDS,
  type UpstreamRouteCapability,
  type UpstreamRouteMatchType,
  type UpstreamRouteRow,
  type UpstreamId,
} from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'

/** 进程内缓存 TTL（毫秒）。与 model-catalog-store 同值；S2-2b 运营写端点显式刷新后此值仅兜底（跨实例 5s 内生效）。 */
export const UPSTREAM_ROUTE_CACHE_TTL_MS = 5_000

const VALID_MATCH_TYPES: readonly UpstreamRouteMatchType[] = ['prefix', 'exact', 'regex', 'default']
const VALID_UPSTREAMS: readonly UpstreamId[] = ['agnes_hub', 'apimart', 'stepfun', 'minimax', 'fal']
const VALID_CAPABILITIES: readonly UpstreamRouteCapability[] = ['*', 'text', 'image', 'video', 'audio']

/** DB 行的最小形状（列名与 Prisma 逐字一致，见 model-catalog-sync 的注释教训）。 */
export interface UpstreamRouteDbRow {
  id: string
  matchType: string
  pattern: string | null
  capability: string
  upstream: string
  priority: number
  enabled: boolean
  fallbackApiKeyEnvName: string | null
}

/**
 * DB 行 → shared 路由行。matchType/upstream/capability 白名单校验，
 * 脏行返回 null（跳过，避免一条坏行毒化整个路由解析）；正常播种路径不会有脏行。
 */
export function upstreamRouteRowFromDb(row: UpstreamRouteDbRow): UpstreamRouteRow | null {
  if (!(VALID_MATCH_TYPES as readonly string[]).includes(row.matchType)) return null
  if (!(VALID_UPSTREAMS as readonly string[]).includes(row.upstream)) return null
  if (!(VALID_CAPABILITIES as readonly string[]).includes(row.capability)) return null
  if (!Number.isFinite(row.priority)) return null
  if (row.matchType !== 'default') {
    if (row.pattern == null || row.pattern.trim().length === 0) return null
    if (row.matchType === 'regex') {
      try {
        assertRoutePatternSafe(row.pattern)
      } catch {
        return null
      }
    }
  }
  return {
    id: row.id,
    matchType: row.matchType as UpstreamRouteMatchType,
    pattern: row.pattern,
    capability: row.capability as UpstreamRouteCapability,
    upstream: row.upstream as UpstreamId,
    priority: row.priority,
    enabled: row.enabled,
    fallbackApiKeyEnvName: row.fallbackApiKeyEnvName,
  }
}

/** 播种幂等键：同一 (matchType, pattern, capability, upstream) 只播一次。 */
function seedKey(matchType: string, pattern: string | null, capability: string, upstream: string): string {
  return [matchType, pattern ?? '', capability, upstream].join('\u0000')
}

/**
 * 种子播种：`UPSTREAM_ROUTE_SEEDS` → `UpstreamRoute`，**insert-if-absent**
 * （存在即跳过，绝不 UPDATE——人工/后台改动存活）。播种前先对 regex 种子过
 * `assertRoutePatternSafe`（防御纵深；种子常量在 shared 测试另有静态断言）。
 * 返回本次新插行数（幂等验证用：稳定态第二次调用恒为 0）。
 */
export async function seedUpstreamRoutes(prisma: PrismaClient): Promise<number> {
  const existing = await prisma.upstreamRoute.findMany({
    select: { matchType: true, pattern: true, capability: true, upstream: true },
  })
  const known = new Set(existing.map((r) => seedKey(r.matchType, r.pattern, r.capability, r.upstream)))
  let inserted = 0
  for (const seed of UPSTREAM_ROUTE_SEEDS) {
    if (seed.matchType === 'regex' && seed.pattern) assertRoutePatternSafe(seed.pattern)
    if (known.has(seedKey(seed.matchType, seed.pattern, seed.capability, seed.upstream))) continue
    await prisma.upstreamRoute.create({
      data: {
        matchType: seed.matchType,
        pattern: seed.pattern,
        capability: seed.capability,
        upstream: seed.upstream,
        priority: seed.priority,
        enabled: seed.enabled,
        fallbackApiKeyEnvName: seed.fallbackApiKeyEnvName ?? null,
      },
    })
    inserted++
  }
  return inserted
}

/**
 * 装载当前路由行（enabled 与否都装载——解析纯函数按 enabled 过滤，探活器
 * 需要全量行做分组决策）。确定性排序：priority 降序 → id 升序，
 * 保证多 default 行时「谁兜底」跨进程一致。
 */
export async function loadUpstreamRouteRows(prisma: PrismaClient): Promise<UpstreamRouteRow[]> {
  const rows = await prisma.upstreamRoute.findMany({
    orderBy: [{ priority: 'desc' }, { id: 'asc' }],
  })
  const out: UpstreamRouteRow[] = []
  for (const row of rows) {
    const mapped = upstreamRouteRowFromDb(row)
    if (mapped) out.push(mapped)
  }
  return out
}

// ── 进程内缓存（同 T1 形态；T3b 加 routesVersion 失效） ──

let cachedRows: UpstreamRouteRow[] = []
let cachedAt = 0
let registeredPrisma: PrismaClient | null = null
let refreshInFlight: Promise<void> | null = null

/**
 * bootstrap = 播种 + 装载 + 刷新缓存。由 UpstreamRouteSeedService.onModuleInit
 * 触发（非阻塞）；也可被 TTL 惰性刷新复用。失败向上抛给调用方处理（保旧缓存）。
 */
export async function refreshUpstreamRouteCache(prisma: PrismaClient): Promise<void> {
  await seedUpstreamRoutes(prisma)
  const rows = await loadUpstreamRouteRows(prisma)
  cachedRows = rows
  cachedAt = Date.now()
}

/** 当前生效路由行（同步、缓存优先）：T3b 的 resolver 查表/探活分组消费。 */
export function currentUpstreamRoutes(): UpstreamRouteRow[] {
  maybeRefresh()
  return cachedRows
}

/** TTL 过期且无在途刷新时，异步触发一次刷新（fire-and-forget，失败吞掉保旧值）。 */
function maybeRefresh(): void {
  if (!registeredPrisma) return
  if (refreshInFlight) return
  if (cachedAt > 0 && Date.now() - cachedAt <= UPSTREAM_ROUTE_CACHE_TTL_MS) return
  const prisma = registeredPrisma
  refreshInFlight = refreshUpstreamRouteCache(prisma)
    .catch((err) => {
      console.error('[upstream-route-store] 路由缓存刷新失败，沿用旧缓存：', err)
    })
    .finally(() => {
      refreshInFlight = null
    })
}

// ── bootstrap 落定信号（B3 热修：startup 探活等待路由就绪，消除空表竞态） ──

let bootstrapped = false
let bootstrapReadyResolve: (() => void) | null = null
let bootstrapReadyPromise: Promise<void> | null = null

/**
 * 路由表首次 bootstrap（播种+装载）**落定即 resolve —— 成功与失败都算落定**：
 * 失败时缓存保持空数组，继续等待不会改善结果，消费方（探活 startup 首轮）应按
 * 当前缓存执行并自行告警（与「空表 → 组内跳过/确定性抛错」语义一致，不静默回落）。
 *
 * 背景（B2 生产复测实证）：SeedService.onModuleInit 与探活 startup 首轮同为
 * fire-and-forget，探活先于装载完成执行 → 首轮必见空路由表 → 全量 unroutable
 * 跳过，ghost 检测空转到下个周期轮。本信号让 startup 首轮有序化（仍不阻塞 bootstrap）。
 */
export function whenUpstreamRoutesBootstrapped(): Promise<void> {
  if (bootstrapped) return Promise.resolve()
  if (!bootstrapReadyPromise) {
    bootstrapReadyPromise = new Promise<void>((resolve) => {
      bootstrapReadyResolve = resolve
    })
  }
  return bootstrapReadyPromise
}

/** bootstrap 落定标记：SeedService 的 refresh settle（成功或失败）后调用；测试可直调。 */
export function markUpstreamRoutesBootstrapped(): void {
  if (bootstrapped) return
  bootstrapped = true
  bootstrapReadyResolve?.()
}

// ── 测试钩子（仅测试使用；生产路径不可达） ──

/** 测试专用：重置模块级缓存/句柄（vitest isolate per file，无需跨文件协调）。 */
export function __resetUpstreamRouteStoreForTests(): void {
  cachedRows = []
  cachedAt = 0
  registeredPrisma = null
  refreshInFlight = null
  bootstrapped = false
  bootstrapReadyResolve = null
  bootstrapReadyPromise = null
}

/** 测试专用：注入 prisma 句柄（模拟 UpstreamRouteSeedService 的注册动作）。 */
export function __registerUpstreamRoutePrismaForTests(prisma: PrismaClient): void {
  registeredPrisma = prisma
}

/** 测试专用：观察在途刷新（同步触发后 await 它再断言新值）。 */
export function __upstreamRouteRefreshInFlightForTests(): Promise<void> | null {
  return refreshInFlight
}

/** 测试专用：把缓存标记为刚过期（下一次 currentUpstreamRoutes 触发刷新）。 */
export function __expireUpstreamRouteCacheForTests(): void {
  cachedAt = 0
}

/** 测试专用：直接注入缓存路由行（单测无 DB 场景；不影响 registeredPrisma/TTL 状态）。 */
export function __setCachedUpstreamRoutesForTests(rows: readonly UpstreamRouteRow[]): void {
  cachedRows = [...rows]
  cachedAt = Date.now()
}

// ── routesVersion（S2-2b：运营端点写 bump；与 catalogVersion 同表分域） ──

/**
 * routesVersion 单行的固定主键。存储落点裁定（T2 ModelCatalogVersion **同表加第二行**，
 * 不建新表）：`ModelCatalogVersion` 实际是「按 id 分域的单行版本计数表」（id 为自由
 * 主键、upsert increment 同型），加 `id='routes'` 行即可复用同一套原子 +1 语义——
 * 零 DDL/零迁移、竞态回归锁（T2 集成测试）同源；`catalog` 行查询走 findUnique(id)
 * 互不干扰。schema 注释已同步（仅注释，免迁移）。
 */
export const ROUTES_VERSION_ROW_ID = 'routes'

/** 读当前路由版本号。版本行不存在（未写过）视作 0。 */
export async function readUpstreamRoutesVersion(prisma: PrismaClient): Promise<number> {
  const row = await prisma.modelCatalogVersion.findUnique({ where: { id: ROUTES_VERSION_ROW_ID } })
  return row?.version ?? 0
}

/**
 * 路由版本号原子 +1 并返回新值（单调递增、last-write-win）。
 * SQL 层 `increment`（同 bumpModelCatalogVersion）：并发两写各自完整 +1，不丢计数。
 */
export async function bumpUpstreamRoutesVersion(
  prisma: PrismaClient | Prisma.TransactionClient,
): Promise<number> {
  const row = await prisma.modelCatalogVersion.upsert({
    where: { id: ROUTES_VERSION_ROW_ID },
    update: { version: { increment: 1 } },
    create: { id: ROUTES_VERSION_ROW_ID, version: 1 },
  })
  return row.version
}

/**
 * S2-2a 播种接线：Nest bootstrap 阶段注册 prisma 并**非阻塞**触发播种+装载。
 * 失败不阻断启动（缓存保持空数组，T3b 消费方须对空表走「无 default → 抛错」
 * 的确定性路径，不静默回落）。
 */
@Injectable()
export class UpstreamRouteSeedService implements OnModuleInit {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    registeredPrisma = this.prisma
    void refreshUpstreamRouteCache(this.prisma)
      .catch((err) => {
        console.error('[upstream-route-store] bootstrap 播种/装载失败（缓存为空，T3b 消费方走确定性抛错路径）：', err)
      })
      // B3 热修：成败都算「落定」——等待方（探活 startup 首轮）按当前缓存执行，
      // 绝不让一次 DB 故障把 startup 首轮悬挂到超时。
      .finally(() => markUpstreamRoutesBootstrapped())
  }
}
