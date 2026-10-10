import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import { STUDIO_MODEL_CATALOG, resolveUpstreamRoute, type ModelCapability, type UpstreamId, type UpstreamRouteRow } from '@lnkpi/shared'
import {
  diffCatalogAgainstUpstream,
  type UpstreamId as ReconciliationUpstreamId,
} from '@lnkpi/shared/upstreamReconciliation'
import { PrismaService } from '../prisma/prisma.service'
import { PLATFORM_CHANNEL_ID } from './provider.service'
import { currentUpstreamRoutes, whenUpstreamRoutesBootstrapped } from './upstream-route-store'
import {
  bumpConsecutiveFailures,
  planAvailabilityWrites,
  type ModelEntryLike,
  type ModelAvailability,
  type ProbeHealthByModel,
  type UpstreamDiffLike,
} from './upstream-probe-logic'

/**
 * S1-1 定时探活对账**服务壳**（纯逻辑在 upstream-probe-logic.ts 与
 * packages/shared/src/upstreamReconciliation.ts，spec:
 * docs/superpowers/specs/2026-10-09-mph-s11-liveness-reconciliation-design.md §3）。
 *
 * 职责：按 env 配置的周期对 5 个上游只读 GET /v1/models（⛔ 任何情况下不发生成请求），
 * 用 shared 的 diffCatalogAgainstUpstream 与平台渠道目录镜像做对账，按 Ruling A
 * （连败 ≥3 且近 24h 零成功才灰显）消费 planAvailabilityWrites 读-改-写镜像，
 * 每次探测整帧落 UpstreamProbeRun，变化时打 `[MPH][probe]` 结构化日志。
 *
 * 纪律（全部绑定）：
 * - 探活 run 整体失败（上游不可达 / 402 / 403 / 非 JSON）⇒ 绝不判 ghost、绝不 bump 连败计数、
 *   绝不改镜像（S0-3 结论：上游不可达 ≠ 模型幽灵）；只落 unavailable(reason) run 记录。
 * - 连败计数是**服务实例内存 Map**（按模型名），进程重启归零；只在 run 真正到达上游时更新。
 * - 本服务是唯一置 `availability: 'unavailable'` 的写入方（经 planAvailabilityWrites 输出）。
 * - try/catch 全包裹：探活器自身故障绝不抛出阻塞启动（reaper 同款纪律）；回滚 = env 置 0。
 */

/** 探测结果（单上游单轮）——fetch/HTTP 层与「是否到达上游」的唯一事实来源。 */
type ProbeOutcome =
  | { kind: 'ok'; httpStatus: number; ids: string[] }
  | { kind: 'noModelsEndpoint'; httpStatus: number; error: string }
  | { kind: 'failed'; httpStatus: number | null; error: string }

/** 探活 fetch 的最小注入接口（真实 fetch 天然满足；测试注入替身）。 */
export interface ProbeFetchResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

export type ProbeFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal; dispatcher?: unknown },
) => Promise<ProbeFetchResponse>

/** 测试注入点：不提供时用全局 fetch。 */
export const UPSTREAM_PROBE_FETCH = Symbol('UPSTREAM_PROBE_FETCH')

/** 探测单上游超时（与 S0-3 脚本 PROBE_TIMEOUT_MS 默认一致）。 */
const PROBE_TIMEOUT_MS = 15_000

/** 探测间隔 env。默认 360 分钟；`0` = 显式禁用（不注册 timer）；缺失/非法回落默认。 */
export const DEFAULT_PROBE_INTERVAL_MINUTES = 360

/**
 * B3 热修：startup 首轮等待路由表 bootstrap 落定的超时上限（毫秒）。
 * 正常情况 SeedService 的播种+装载远快于此（毫秒级）；超时 = DB 故障等异常形态，
 * 此时按当前缓存路由照常执行（可能空表 → 组内跳过 + warn），绝不悬挂、绝不丢失首轮。
 */
export const STARTUP_PROBE_ROUTES_READY_TIMEOUT_MS = 15_000

/** recentSuccesses 统计窗口：近 24h。 */
const RECENT_SUCCESS_WINDOW_MS = 24 * 60 * 60_000

/**
 * GenerationRecord 的「成功」状态集。studio 全链路只写 `completed` 表示成功
 * （`generating` 是进行中、`failed` 是失败、`fallback_pending` 从未产生成功结果）。
 */
const GENERATION_SUCCESS_STATUSES = ['completed']

/** 探活分组的目录条目形状（modality 供路由表 capability 维度判定）。 */
export interface ProbeCatalogEntry {
  readonly modelKey: string
  readonly gatewayModelId: string
  readonly modality: ModelCapability
}

/**
 * routing UpstreamId（路由表，shared upstreamRouting）→ 对账 UpstreamId
 * （shared upstreamReconciliation / 探活 run 记录 / ops 脚本 env 前缀）。
 * ⛔ B1 裁定延续：两套 id 并存且都不改名（路由表 'agnes_hub' vs 对账 'agnes'），
 * 探活接线必须经本**穷举 switch 显式映射**，禁止任何字符串拼接/替换绕过映射。
 */
export function toReconciliationUpstreamId(upstream: UpstreamId): ReconciliationUpstreamId {
  switch (upstream) {
    case 'agnes_hub':
      return 'agnes'
    case 'apimart':
      return 'apimart'
    case 'fal':
      return 'fal'
    case 'minimax':
      return 'minimax'
    case 'stepfun':
      return 'stepfun'
  }
}

/**
 * S2-2b 探活分组：对每个目录条目按路由表解析归属上游（resolveUpstreamRoute 单胜者：
 * priority 降序、同分 exact > prefix > regex —— **同名模型双行配置也只归路由指向的
 * 那一家**，A5），再按对账上游 id 分组。未命中且无可用 default 行的条目（如运营禁用
 * default 行的配置态）不归任何上游：本轮跳过对账并上报，绝不算 ghost。
 */
export function groupCatalogEntriesByUpstream(
  routeRows: readonly UpstreamRouteRow[],
  catalogEntries: readonly ProbeCatalogEntry[],
): { byUpstream: Map<ReconciliationUpstreamId, ProbeCatalogEntry[]>; unroutable: string[] } {
  const byUpstream = new Map<ReconciliationUpstreamId, ProbeCatalogEntry[]>()
  const unroutable: string[] = []
  for (const entry of catalogEntries) {
    let upstream: ReconciliationUpstreamId
    try {
      // resolveUpstreamRoute 内部排序需可变数组：拷贝一份（每轮一次，28 行量级）。
      upstream = toReconciliationUpstreamId(
        resolveUpstreamRoute([...routeRows], entry.modelKey, entry.modality).upstream,
      )
    } catch {
      unroutable.push(entry.modelKey)
      continue
    }
    const bucket = byUpstream.get(upstream)
    if (bucket) bucket.push({ ...entry })
    else byUpstream.set(upstream, [{ ...entry }])
  }
  return { byUpstream, unroutable }
}

interface ProbeUpstream {
  /** 对账上游 id（ReconciliationUpstreamId；与探活 run 记录 / ops 脚本 env 前缀一致）。 */
  readonly id: ReconciliationUpstreamId
  readonly baseUrlEnv: string
  readonly keyEnv: string
  readonly defaultBaseUrl: string
}

const PROBE_UPSTREAMS: readonly ProbeUpstream[] = [
  { id: 'agnes', baseUrlEnv: 'OPENAI_BASE_URL', keyEnv: 'OPENAI_API_KEY', defaultBaseUrl: '' },
  { id: 'apimart', baseUrlEnv: 'APIMART_BASE_URL', keyEnv: 'APIMART_API_KEY', defaultBaseUrl: 'https://api.apimart.ai/v1' },
  { id: 'fal', baseUrlEnv: 'FAL_BASE_URL', keyEnv: 'FAL_KEY', defaultBaseUrl: 'https://fal.run' },
  { id: 'minimax', baseUrlEnv: 'MINIMAX_BASE_URL', keyEnv: 'MINIMAX_API_KEY', defaultBaseUrl: 'https://api.minimax.io' },
  { id: 'stepfun', baseUrlEnv: 'STEPFUN_BASE_URL', keyEnv: 'STEPFUN_API_KEY', defaultBaseUrl: 'https://api.stepfun.com/v1' },
]

/** admin 端点（S1-2/S1-3 与运维 curl）按这组 id 取各上游最近一帧 run。 */
export const PROBE_UPSTREAM_IDS: readonly string[] = PROBE_UPSTREAMS.map((u) => u.id)

/** 解析分钟数 env：缺失/空 → 默认；`0` → 0（禁用）；负数/非数字 → 默认。 */
export function resolveProbeIntervalMinutes(
  raw: string | undefined,
  fallback: number = DEFAULT_PROBE_INTERVAL_MINUTES,
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

/** baseUrl 拼接 /models（S0-3 同款）：base 已含 /v1 后缀则直接接，否则补 /v1。 */
export function probeModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? `${trimmed}/models` : `${trimmed}/v1/models`
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * apimart 跨境需代理 —— 沿用 S0-3 脚本结论：设置了 HTTPS_PROXY 时经 undici
 * ProxyAgent 走代理；undici 不可加载则跳过代理（不阻塞探活）。动态 specifier
 * 避免 undici 成为静态依赖（Node 22 全局 fetch 自带 undici，但 ProxyAgent 只能从包取）。
 */
async function loadProxyDispatcher(): Promise<unknown | undefined> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
  if (!proxy) return undefined
  try {
    const specifier = 'undici'
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      ProxyAgent?: new (uri: string) => unknown
    }
    return mod.ProxyAgent ? new mod.ProxyAgent(proxy) : undefined
  } catch {
    return undefined
  }
}

/** 存量 models JSON → 条目数组（与 provider.service parseModelsJson 同口径）。 */
function parseModelEntries(raw: string | undefined | null): ModelEntryLike[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is ModelEntryLike =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as ModelEntryLike).name === 'string' &&
        typeof (item as ModelEntryLike).capability === 'string',
    )
  } catch {
    return []
  }
}

/** 旧格式/脏值读为 unknown（与 upstream-probe-logic.normalizeAvailability 同口径，仅供 diff 比较）。 */
function normalizeAvailability(value: string | undefined): ModelAvailability {
  return value === 'available' || value === 'unavailable' ? value : 'unknown'
}

@Injectable()
export class UpstreamProbeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UpstreamProbeService.name)
  private timer?: ReturnType<typeof setInterval>
  /** 连败计数：模型名 → 连续被判 ghost 的次数。内存态，进程重启归零（Ruling 3）。 */
  private readonly consecutiveFailures = new Map<string, number>()

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(UPSTREAM_PROBE_FETCH) private readonly probeFetch: ProbeFetch = globalThis.fetch.bind(globalThis),
  ) {}

  onModuleInit(): void {
    // 与 generation-reaper 同款纪律：测试环境不注册真实定时器。
    if (process.env.NODE_ENV === 'test') return
    const minutes = resolveProbeIntervalMinutes(process.env.LNKPI_UPSTREAM_PROBE_INTERVAL_MINUTES)
    if (minutes === 0) {
      this.logger.log('[MPH][probe] LNKPI_UPSTREAM_PROBE_INTERVAL_MINUTES=0，定时探活已禁用')
      return
    }
    this.timer = setInterval(() => void this.probeOnce('periodic'), minutes * 60_000)
    // unref：探活器绝不阻止进程退出（Ruling C：手动 setInterval + unref）。
    this.timer.unref?.()
    this.logger.log(`[MPH][probe] 定时探活已注册：每 ${minutes} 分钟一轮`)
    // B1 登记顺手项（S2-2b 落地）：注册后触发启动首轮 —— 非阻塞（onModuleInit 不 await、
    // probeOnce 整体吞异常）、失败绝不阻断启动；日志来源=startup 与 periodic 区分。
    // B3 热修：先等路由表 bootstrap 落定（成功/失败都算落定，带超时上限防悬挂）再跑，
    // 消除「路由缓存空表 → 全量 unroutable 跳过、ghost 检测空转一个周期」的启动竞态
    // （B2 生产复测实证）。
    this.logger.log('[MPH][probe] 启动首轮探活待路由表就绪后触发（来源=startup）')
    void this.startupProbeWhenRoutesReady()
  }

  /**
   * startup 首轮：等路由表 bootstrap 落定（上限
   * {@link STARTUP_PROBE_ROUTES_READY_TIMEOUT_MS}，unref 计时器——绝不阻止进程退出、
   * 绝不阻塞 bootstrap 主流程）后再触发 probeOnce('startup')。超时路径照常执行
   * （按当前缓存路由，可能空表 → 组内跳过 + warn），绝不静默丢失首轮。
   */
  private async startupProbeWhenRoutesReady(
    timeoutMs: number = STARTUP_PROBE_ROUTES_READY_TIMEOUT_MS,
  ): Promise<void> {
    const waitStartedAt = Date.now()
    await Promise.race([
      whenUpstreamRoutesBootstrapped(),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      }),
    ])
    if (Date.now() - waitStartedAt >= timeoutMs) {
      this.logger.warn(
        `[MPH][probe] 等待路由表就绪超时（${timeoutMs}ms），startup 首轮按当前缓存路由执行`,
      )
    }
    this.logger.log('[MPH][probe] 触发启动首轮探活（来源=startup）')
    await this.probeOnce('startup')
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * 单轮探活：按路由表把目录条目分组到 5 个上游 → 逐一 GET /v1/models → diff →
   * 灰显判定 → 镜像读写 → run 落库。单上游失败不影响其余上游；整轮异常被吞掉
   * （只记日志），绝不向上抛。
   */
  async probeOnce(reason: 'manual' | 'periodic' | 'startup' = 'manual'): Promise<void> {
    try {
      const catalogEntries: ProbeCatalogEntry[] = STUDIO_MODEL_CATALOG.map((entry) => ({
        modelKey: entry.modelKey,
        gatewayModelId: entry.gatewayModelId,
        modality: entry.modality,
      }))
      // S2-2b：路由行取自 upstream-route-store 缓存（运营改路由 → 写端点显式刷新 +
      // 5s TTL 跨实例兜底，探活周期分钟级 ⇒ 下个探活周期必见新路由，不热重启）。
      const { byUpstream, unroutable } = groupCatalogEntriesByUpstream(
        currentUpstreamRoutes(),
        catalogEntries,
      )
      if (unroutable.length > 0) {
        this.logger.warn(
          `[MPH][probe] ${unroutable.length} 个目录条目未命中任何路由行且无可用 default 行，本轮跳过对账（不算 ghost）：${JSON.stringify(unroutable)}`,
        )
      }
      const channel = await this.prisma.providerChannel.findUnique({
        where: { id: PLATFORM_CHANNEL_ID },
      })
      const prevModels = parseModelEntries(channel?.models)
      const dispatcher = await loadProxyDispatcher()

      for (const upstream of PROBE_UPSTREAMS) {
        try {
          await this.probeUpstream(
            upstream,
            prevModels,
            byUpstream.get(upstream.id) ?? [],
            dispatcher,
            reason,
          )
        } catch (err) {
          // 单上游异常（含落库失败）不拖垮其余上游
          this.logger.error(
            `[MPH][probe] 上游 ${upstream.id} 本轮探测异常: ${errMessage(err)}`,
          )
        }
      }
    } catch (err) {
      this.logger.error(`[MPH][probe] 本轮探活（${reason}）异常: ${errMessage(err)}`)
    }
  }

  private async probeUpstream(
    upstream: ProbeUpstream,
    prevModels: readonly ModelEntryLike[],
    entries: readonly ProbeCatalogEntry[],
    dispatcher: unknown,
    reason: 'manual' | 'periodic' | 'startup',
  ): Promise<void> {
    const outcome = await this.fetchUpstreamModels(upstream, dispatcher)

    if (outcome.kind !== 'ok') {
      // ⛔ 未到达上游（或无清单）：不判 ghost、不 bump、不改镜像，只落 run 记录。
      console.log(
        `[MPH][probe] upstream=${upstream.id} outcome=${outcome.kind === 'noModelsEndpoint' ? 'NO_MODELS_ENDPOINT' : 'unavailable'} reason=${JSON.stringify(outcome.error)}`,
      )
      await this.writeRunRecord(upstream.id, outcome, null, null)
      return
    }

    // S2-2b：归属分组已在 probeOnce 由路由表完成（组内条目全数指向本上游）；
    // 这里的单规则 map 只是 diffCatalogAgainstUpstream 的分组直通垫片（⛔ 非第二套路由映射）。
    const diff: UpstreamDiffLike = diffCatalogAgainstUpstream(
      entries,
      outcome.ids,
      [{ upstream: upstream.id, pattern: /.*/ }],
      { targetUpstream: upstream.id },
    )

    // 连败计数在 run 真正到达上游后立即更新（Ruling 3）：matched 归零、ghost +1。
    // 先 bump 再出灰显计划 —— 本轮第 3 次连续失败本身就要触发灰显（A3：连败 2 不变、
    // 第 3 次且零成功 → unavailable），不能等下一轮。
    for (const name of diff.matched) {
      this.consecutiveFailures.set(name, bumpConsecutiveFailures(this.consecutiveFailures.get(name) ?? 0, true))
    }
    for (const name of diff.ghosts) {
      this.consecutiveFailures.set(name, bumpConsecutiveFailures(this.consecutiveFailures.get(name) ?? 0, false))
    }

    // Ruling A 健康快照：只需为本轮 ghost 模型取值（其余条目缺省 {0,0}）。
    const health: ProbeHealthByModel = {}
    for (const name of diff.ghosts) {
      health[name] = {
        consecutiveFailures: this.consecutiveFailures.get(name) ?? 0,
        recentSuccesses: await this.countRecentSuccesses(name),
      }
    }

    const plan = planAvailabilityWrites(prevModels, diff, health)

    const grayed: string[] = []
    const recovered: string[] = []
    const suppressed: string[] = []
    let planChanged = false
    for (let i = 0; i < prevModels.length; i++) {
      const prev = prevModels[i]!
      const entry = plan[i]!
      if (entry.availability !== normalizeAvailability(prev.availability)) planChanged = true
      if (entry.availability === 'unavailable' && normalizeAvailability(prev.availability) !== 'unavailable') {
        grayed.push(entry.name)
      }
      if (entry.availability === 'available' && normalizeAvailability(prev.availability) === 'unavailable') {
        recovered.push(entry.name)
      }
      if (entry.logged) suppressed.push(entry.name)
    }

    if (planChanged && prevModels.length > 0) {
      await this.writeMirror(plan)
    }

    // 连败计数只在 run 真正到达上游时更新（Ruling 3，见 probeUpstream 开头的 bump）。
    const missing = diff.missing ?? []

    if (grayed.length > 0 || recovered.length > 0 || suppressed.length > 0) {
      console.log(
        `[MPH][probe] ${JSON.stringify({
          upstream: upstream.id,
          ghostCount: diff.ghosts.length,
          missingCount: missing.length,
          ...(grayed.length > 0 ? { grayed } : {}),
          ...(recovered.length > 0 ? { recovered } : {}),
          ...(suppressed.length > 0 ? { suppressed } : {}),
        })}`,
      )
    }

    await this.writeRunRecord(upstream.id, outcome, diff.ghosts, missing)
  }

  /** 单上游只读 GET /v1/models。绝不抛出——失败一律折叠为 failed(reason)。 */
  private async fetchUpstreamModels(
    upstream: ProbeUpstream,
    dispatcher: unknown,
  ): Promise<ProbeOutcome> {
    const baseUrl = process.env[upstream.baseUrlEnv]?.trim() || upstream.defaultBaseUrl
    if (!baseUrl) {
      return { kind: 'failed', httpStatus: null, error: `未配置 ${upstream.baseUrlEnv}` }
    }
    const apiKey = process.env[upstream.keyEnv]?.trim()
    if (!apiKey) {
      return { kind: 'failed', httpStatus: null, error: `未配置 ${upstream.keyEnv}` }
    }

    let res: ProbeFetchResponse
    try {
      res = await this.probeFetch(probeModelsUrl(baseUrl), {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        ...(dispatcher ? { dispatcher } : {}),
      })
    } catch (err) {
      const cause = (err as { cause?: { code?: string }; name?: string }) ?? {}
      const code = cause.cause?.code ?? cause.name ?? ''
      const reason =
        cause.name === 'TimeoutError' ? `超时（>${PROBE_TIMEOUT_MS}ms）` : `网络错误（${code || '未知'}）`
      return { kind: 'failed', httpStatus: null, error: reason }
    }

    // 404：该上游无 /models 端点 —— 正常跳过，不视为失败（S0-3 口径）。
    if (res.status === 404) {
      return { kind: 'noModelsEndpoint', httpStatus: 404, error: 'NO_MODELS_ENDPOINT（无 /v1/models 端点，跳过）' }
    }
    // 402=欠费 / 403=鉴权失败：上游断供信号（S0-3 口径），计入失败。
    if (res.status === 402 || res.status === 403) {
      return {
        kind: 'failed',
        httpStatus: res.status,
        error: `HTTP ${res.status}（${res.status === 402 ? '余额不足' : '鉴权失败'}）`,
      }
    }
    if (!res.ok) {
      return { kind: 'failed', httpStatus: res.status, error: `HTTP ${res.status}` }
    }

    let body: unknown
    try {
      body = await res.json()
    } catch {
      return { kind: 'failed', httpStatus: res.status, error: '响应不是合法 JSON' }
    }
    const data = (body as { data?: unknown } | null)?.data
    if (!Array.isArray(data)) {
      return { kind: 'failed', httpStatus: res.status, error: '响应缺少 data 数组（非 OpenAI /models 形状），保守不猜结构' }
    }
    const ids = data
      .map((m) => (m as { id?: unknown } | null)?.id)
      .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    return { kind: 'ok', httpStatus: res.status, ids }
  }

  /**
   * Ruling A 第二半：该模型近 24h 的 GenerationRecord 成功计数。
   * SQLite 注意：createdAt 是 unix-ms 整数列，这里用 Prisma Date 比较（Prisma 自行
   * 处理整数毫秒换算），⛔ 不用 strftime 字符串比较。
   * 查询失败按「至少 1 次成功」处理（宁可漏灰、不可误灰——绝不因探活器自身故障灰显模型）。
   */
  private async countRecentSuccesses(model: string): Promise<number> {
    try {
      return await this.prisma.generationRecord.count({
        where: {
          model,
          status: { in: GENERATION_SUCCESS_STATUSES },
          createdAt: { gte: new Date(Date.now() - RECENT_SUCCESS_WINDOW_MS) },
        },
      })
    } catch (err) {
      this.logger.error(`[MPH][probe] 查询 ${model} 近24h成功记录失败（按有成功背书处理）: ${errMessage(err)}`)
      return 1
    }
  }

  /**
   * 读-改-写镜像（brief 2.2 防竞态）：写入前重读最新 models，再按本轮 plan 的
   * availability 逐名套用 —— 中途 bootstrap 对齐重建镜像也不会把陈旧快照写回去。
   * plan 覆盖全部 prevModels 条目名；fresh 里多出来的条目（新上架）不受影响。
   */
  private async writeMirror(plan: readonly { name: string; availability: ModelAvailability }[]): Promise<void> {
    const fresh = await this.prisma.providerChannel.findUnique({
      where: { id: PLATFORM_CHANNEL_ID },
    })
    const freshModels = parseModelEntries(fresh?.models)
    if (freshModels.length === 0) return
    const planByName = new Map(plan.map((entry) => [entry.name, entry]))
    const next = freshModels.map((entry) => {
      const planned = planByName.get(entry.name)
      return planned ? { ...entry, availability: planned.availability } : entry
    })
    await this.prisma.providerChannel.update({
      where: { id: PLATFORM_CHANNEL_ID },
      data: { models: JSON.stringify(next) },
    })
  }

  private async writeRunRecord(
    upstream: string,
    outcome: Exclude<ProbeOutcome, { kind: 'ok' }> | { kind: 'ok'; httpStatus: number; ids: string[] },
    ghosts: readonly string[] | null,
    missing: readonly string[] | null,
  ): Promise<void> {
    await this.prisma.upstreamProbeRun.create({
      data: {
        upstream,
        httpStatus: outcome.httpStatus,
        modelCount: outcome.kind === 'ok' ? outcome.ids.length : null,
        ghosts: ghosts === null ? null : JSON.stringify(ghosts),
        missing: missing === null ? null : JSON.stringify(missing),
        error: outcome.kind === 'ok' ? null : outcome.error,
      },
    })
  }
}
