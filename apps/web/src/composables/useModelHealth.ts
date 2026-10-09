import { ref } from 'vue'
import { decodeChannelModel } from '@lnkpi/shared'
import {
  healthDotKind,
  healthDotTitle,
  type HealthDotKind,
  type ModelHealthSummaryRow,
} from '@lnkpi/shared/modelHealth'
import { api } from '@/services/api'
import type { ProviderChannelPublic } from '@/services/provider-api'

/**
 * S1-3 模型健康投影（spec 2026-10-09-mph-s13 §3.1/3.3）。
 *
 * 数据源：`GET /api/model-health/summary?windowHours=24`（用户鉴权，服务端只回
 * 平台行 + 本人 BYOK 行）。**5 分钟客户端缓存**是唯一的缓存层（controller ruling
 * 2026-10-10：服务端不做缓存）——模块级 ref + 时间戳，同一次会话内多个消费组件
 * （UniversalModelSelector / AgentSideRail / ProviderConfigDialog）共享同一份。
 *
 * 查找约定：
 * - availability 只存在于平台渠道镜像条目（`ProviderChannel('platform').models`），
 *   经 provider/bootstrap 透传；缺字段/非法值一律按 unknown（正常渲染，绝不灰显）。
 * - successRate 行按 (channelId, modelName) 命中：平台模型用平台行，BYOK 模型用
 *   本人 BYOK 行（channelId 为 userId，前端只按「非平台行」匹配模型名）。
 */

const HEALTH_CACHE_TTL_MS = 5 * 60 * 1000

export type ModelHealthSummary = {
  generatedAt: string
  windowHours: number
  rows: ModelHealthSummaryRow[]
}

/** 模块级共享状态：缓存 + 在途请求去重（并发组件同时拉取只发一次 HTTP）。 */
let cache: { fetchedAt: number; data: ModelHealthSummary } | null = null
let inflight: Promise<ModelHealthSummary> | null = null
const summary = ref<ModelHealthSummary | null>(null)

/** 测试注入口：直接注入/清空缓存态（不触发 HTTP）。 */
export function setModelHealthSummaryForTests(data: ModelHealthSummary | null) {
  cache = null
  inflight = null
  summary.value = data
}

/** 缓存命中窗口内的直接读取（`now` 可注入，供测试固定时钟）。 */
export function cachedModelHealth(now = Date.now()): ModelHealthSummary | null {
  if (cache && now - cache.fetchedAt < HEALTH_CACHE_TTL_MS) return cache.data
  return null
}

export async function fetchModelHealthSummary(now = Date.now()): Promise<ModelHealthSummary> {
  const hit = cachedModelHealth(now)
  if (hit) return hit
  if (inflight) return inflight
  inflight = api
    .get<{ code: number; message: string; data: ModelHealthSummary }>(
      '/model-health/summary?windowHours=24',
    )
    .then((res) => {
      const data = res.data?.data
      cache = { fetchedAt: Date.now(), data }
      summary.value = data
      return data
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 组件入口：幂等触发一次拉取（失败静默——健康角标是增强信息，不阻断选择器）。 */
export function useModelHealth() {
  void fetchModelHealthSummary().catch(() => {})
  return summary
}

// ── 纯查找函数（组件 computed 消费；可单测）────────────────────────────────

export function availabilityOfModel(
  allChannels: readonly ProviderChannelPublic[],
  modelValue: string,
): 'available' | 'unavailable' | 'unknown' {
  const decoded = decodeChannelModel(modelValue)
  if (!decoded) return 'unknown'
  const channel = allChannels.find((c) => c.id === decoded.channelId)
  // 只有平台渠道镜像条目携带 availability；BYOK 条目（含缺字段旧数据）一律 unknown
  const entry = channel?.models?.find((m) => m.name === decoded.modelName)
  if (entry?.availability === 'available' || entry?.availability === 'unavailable') {
    return entry.availability
  }
  return 'unknown'
}

export type ModelHealthDot = { kind: HealthDotKind; title: string }

/** 健康角标（A4）：successRate 非 null 才有 dot；阈值判定走 shared 纯函数。 */
export function healthDotOfModel(
  rows: readonly ModelHealthSummaryRow[] | null | undefined,
  modelValue: string,
): ModelHealthDot | null {
  if (!rows?.length) return null
  const decoded = decodeChannelModel(modelValue)
  if (!decoded) return null
  const row = rows.find(
    (r) =>
      r.model === decoded.modelName &&
      (decoded.channelId === 'platform' ? r.channelId === 'platform' : r.channelId !== 'platform'),
  )
  if (!row) return null
  const kind = healthDotKind(row.successRate, row.total)
  if (!kind) return null
  return { kind, title: healthDotTitle(row.windowHours, row.completed, row.total) }
}
