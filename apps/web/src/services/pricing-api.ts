/** 展示层报价取数（修复规格 2026-11-02-points-display-single-source）：与计费同源读价目表。 */

import { apiUrl } from './api-base'

export interface PriceQuoteQuery {
  capability: string
  count?: number
  resolution?: string
  modelKey?: string
  audioKind?: string
  duration?: number
  videoMode?: string
  referenceImageCount?: number
  referenceVideoCount?: number
}

export interface PriceQuoteResult {
  credits: number
  ruleVersion: string
  /** 价目表缺失/降级时为 true（落常量兜底），前端据此标注「预估」；仍与计费同值。 */
  degraded: boolean
}

/**
 * 调 `GET /api/pricing/quote`，复用计费引擎 `pricing.quote()` 读 active 价目表。
 * 管理后台价目表是唯一真相源：改价只改表，展示值与计费值同时生效。
 * 非 2xx 或信封 `code!==0` 抛错，由调用方（usePricingQuote）捕获回落本地估算。
 */
export async function fetchPriceQuote(q: PriceQuoteQuery): Promise<PriceQuoteResult> {
  const p = new URLSearchParams()
  p.set('capability', q.capability)
  if (q.count != null) p.set('count', String(q.count))
  if (q.resolution) p.set('resolution', q.resolution)
  if (q.modelKey) p.set('modelKey', q.modelKey)
  if (q.audioKind) p.set('audioKind', q.audioKind)
  if (q.duration != null) p.set('duration', String(q.duration))
  if (q.videoMode) p.set('videoMode', q.videoMode)
  if (q.referenceImageCount != null) p.set('referenceImageCount', String(q.referenceImageCount))
  if (q.referenceVideoCount != null) p.set('referenceVideoCount', String(q.referenceVideoCount))
  const res = await fetch(apiUrl(`/pricing/quote?${p.toString()}`))
  if (!res.ok) throw new Error(`pricing quote failed: ${res.status}`)
  const body = (await res.json()) as { code: number; data: PriceQuoteResult }
  if (body.code !== 0) throw new Error(`pricing quote error: ${body.code}`)
  return body.data
}

/* ---- 文本模型倍率（2026-11-21 模型卡 R2）----
 * GET /api/pricing/active 的 multipliers map（active 价目表 text:in 行
 * profitBpSnapshot → (10000+bp)/10000）。会话级单飞缓存：模型卡 PC/移动两处
 * composable 实例共用一次取数。失败回落空 map（展示层据此省略倍率，禁造数），
 * 不重试（价目表 30s 服务端 TTL，下次会话自然刷新）。 */

let multipliersCache: Promise<Record<string, number>> | null = null

export function fetchActivePricingMultipliers(): Promise<Record<string, number>> {
  multipliersCache ??= (async () => {
    try {
      const res = await fetch(apiUrl('/pricing/active'), { cache: 'no-store' })
      if (!res.ok) throw new Error(`pricing active failed: ${res.status}`)
      const body = (await res.json()) as { code: number; data: { multipliers?: Record<string, number> } }
      if (body.code !== 0) throw new Error(`pricing active error: ${body.code}`)
      return body.data.multipliers ?? {}
    } catch (err) {
      console.warn('[pricing] 倍率取数失败 — 不展示倍率：', err instanceof Error ? err.message : err)
      return {}
    }
  })()
  return multipliersCache
}

/** 测试专用：清空会话级倍率缓存。 */
export function resetActivePricingCacheForTests(): void {
  multipliersCache = null
}
