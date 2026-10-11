import { buildHealthSql, rowsToHealth, type RawHealthRow } from '@lnkpi/shared/modelHealth'
import { currentUpstreamRoutes } from '../provider/upstream-route-store'
import { PLATFORM_CHANNEL_ID } from '../provider/provider.service'
import type { PrismaClient } from '@prisma/client'
import type { UpstreamId } from '@lnkpi/shared'

/**
 * model-ops 编排的共享判据材料（Task 2）：offboard 的 dryRun 披露与 onboard 的
 * 冒烟。**禁第二套 SQL**：流量摘要复用 S1-2 的 `buildHealthSql`/`rowsToHealth`
 * 投影（Review Focus 3）；alternatives 复用 Task 1 的判定口径。
 */

/** 同模态在架候选（下架默认模型时的 alternatives，含镜像探活 availability）。 */
export interface DefaultAlternative {
  modelKey: string
  displayName: string
  availability: 'available' | 'unavailable' | 'unknown'
}

export async function listDefaultAlternatives(
  prisma: PrismaClient,
  modality: string,
  excludeModelKey: string,
): Promise<DefaultAlternative[]> {
  const [rows, channel] = await Promise.all([
    prisma.modelCatalogEntry.findMany({
      where: { modality, deletedAt: null, modelKey: { not: excludeModelKey } },
      orderBy: [{ createdAt: 'asc' }, { modelKey: 'asc' }],
    }),
    prisma.providerChannel.findUnique({ where: { id: PLATFORM_CHANNEL_ID } }),
  ])
  let availabilityByName = new Map<string, string>()
  try {
    const models = channel?.models ? (JSON.parse(channel.models) as { name?: unknown; availability?: unknown }[]) : []
    availabilityByName = new Map(
      models
        .filter((m) => typeof m?.name === 'string')
        .map((m) => [m.name as string, typeof m.availability === 'string' ? m.availability : 'unknown']),
    )
  } catch {
    // 镜像脏数据：全部按 unknown 处理（不阻塞 alternatives 展示）
  }
  return rows.map((row) => {
    const availability =
      availabilityByName.get(row.modelKey) ?? availabilityByName.get(row.gatewayModelId) ?? 'unknown'
    return {
      modelKey: row.modelKey,
      displayName: row.displayName,
      availability: (availability === 'available' || availability === 'unavailable'
        ? availability
        : 'unknown') as DefaultAlternative['availability'],
    }
  })
}

/** 近 24h 单模型流量摘要（model×status 聚合）——复用 S1-2 投影 SQL，禁第二套。 */
export interface TrafficSummary {
  modelKeys: string[]
  total: number
  completed: number
  failed: number
  other: number
}

export async function summarizeRecentTraffic(
  prisma: PrismaClient,
  modelKeys: readonly string[],
  windowHours = 24,
): Promise<TrafficSummary | null> {
  // 条目可能以 modelKey 或 gatewayModelId 出现在 GenerationRecord（历史两种都存在）
  const keySet = new Set(modelKeys)
  const { sql, params } = buildHealthSql(windowHours)
  const rawRows = (await prisma.$queryRawUnsafe(sql, ...params)) as RawHealthRow[]
  const rows = rowsToHealth(rawRows, windowHours).filter((r) => keySet.has(r.model))
  if (rows.length === 0) return null
  const total = rows.reduce((acc, r) => acc + r.total, 0)
  const completed = rows.reduce((acc, r) => acc + r.completed, 0)
  const failed = rows.reduce((acc, r) => acc + r.failed, 0)
  return { modelKeys: [...modelKeys], total, completed, failed, other: total - completed - failed }
}

/** 路由影响面：enabled 路由行中按 pattern 命中该 modelKey 的行（exact/prefix；路由与目录解耦）。 */
export function routeImpact(modelKey: string): Array<{ id: string; matchType: string; pattern: string | null; upstream: string; capability: string; priority: number }> {
  return currentUpstreamRoutes()
    .filter(
      (row) =>
        row.enabled &&
        row.pattern != null &&
        (row.matchType === 'exact'
          ? row.pattern === modelKey
          : row.matchType === 'prefix'
            ? modelKey.startsWith(row.pattern)
            : false),
    )
    .map((row) => ({
      id: row.id as string,
      matchType: row.matchType as string,
      pattern: row.pattern as string | null,
      upstream: row.upstream as string,
      capability: row.capability as string,
      priority: row.priority as number,
    }))
}

/** onboard 冒烟结果（steps.smoke 披露形状）。 */
export interface SmokeResult {
  status: 'ok' | 'failed' | 'skipped'
  httpStatus?: number | null
  detail: string
}

/**
 * onboard 冒烟（Task 2 step3）：**最小真实创建请求**，创建即验、不轮询产出、不落生成记录。
 * 首版支持组合（当日实战回放的目标场景）：
 * - video + zhipu：POST {base}/videos/generations（cogvideox 案例同款）；
 * - text + OpenAI-compat 系（chat/completions max_tokens=1）。
 * 其余组合 `skipped`（披露不阻断——冒烟失败/不支持都不改变编排结果，steps 全量披露）。
 * 429 视为 ok（到达上游且鉴权通过，限流是业务态——cogvideox 免费档实证）。
 */
export async function runOnboardSmoke(
  upstream: UpstreamId,
  modality: string,
  modelKey: string,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<SmokeResult> {
  // baseUrl/key 与运行时同源：注册表 env 名（fallback 同链）。
  const registryBase = REGISTRY_BASE_URL[upstream]
  const baseUrl = env[BASE_URL_ENV[upstream] ?? '']?.trim() || registryBase || ''
  const keyEnv = KEY_ENV[upstream]
  const apiKey = (keyEnv && env[keyEnv]?.trim()) || ''
  if (!baseUrl || !apiKey) {
    return { status: 'skipped', detail: `冒烟跳过：${!baseUrl ? `缺 ${BASE_URL_ENV[upstream] ?? 'baseUrl'}` : `缺 ${keyEnv}`}` }
  }

  try {
    if (upstream === 'zhipu' && modality === 'video') {
      const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/videos/generations`, {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: modelKey, prompt: 'model-ops onboard smoke test', duration: 5 }),
      })
      if (res.ok || res.status === 429) {
        return { status: 'ok', httpStatus: res.status, detail: res.status === 429 ? '429（免费档限流）：已到达上游且鉴权通过' : '创建即验通过' }
      }
      return { status: 'failed', httpStatus: res.status, detail: `智谱视频创建请求 HTTP ${res.status}` }
    }
    if (modality === 'text') {
      const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: modelKey, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      })
      if (res.ok) return { status: 'ok', httpStatus: res.status, detail: 'chat/completions 冒烟通过' }
      return { status: 'failed', httpStatus: res.status, detail: `chat/completions HTTP ${res.status}` }
    }
    return { status: 'skipped', detail: `冒烟暂不支持组合 upstream=${upstream} modality=${modality}（披露不阻断）` }
  } catch (err) {
    return { status: 'failed', detail: `冒烟请求异常：${err instanceof Error ? err.message : String(err)}` }
  }
}

const REGISTRY_BASE_URL: Record<UpstreamId, string | undefined> = {
  agnes_hub: undefined,
  apimart: 'https://api.apimart.ai/v1',
  stepfun: 'https://api.stepfun.com/v1',
  minimax: 'https://api.minimax.io',
  fal: 'https://fal.run',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
}

const BASE_URL_ENV: Record<UpstreamId, string | undefined> = {
  agnes_hub: 'OPENAI_BASE_URL',
  apimart: 'APIMART_BASE_URL',
  stepfun: 'STEPFUN_BASE_URL',
  minimax: 'MINIMAX_BASE_URL',
  fal: 'FAL_BASE_URL',
  zhipu: 'ZHIPU_BASE_URL',
}

const KEY_ENV: Record<UpstreamId, string | undefined> = {
  agnes_hub: 'OPENAI_API_KEY',
  apimart: 'APIMART_API_KEY',
  stepfun: 'STEPFUN_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  fal: 'FAL_KEY',
  zhipu: 'ZHIPU_API_KEY',
}
