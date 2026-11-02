/**
 * 展示层报价组合式（修复规格 2026-11-02-points-display-single-source）。
 *
 * 单一真相源：任何展示积分值都经 `fetchPriceQuote`（服务端 `pricing.quote` 读 active 价目表）
 * 派生，与计费同源同表 ⇒ 展示值 == 计费值。改价只改管理后台价目表，无需改代码。
 *
 * 设计：初始化即同步显示 fallback（本地估算），避免端点返回前空白闪烁；query 变化
 * （count/resolution/modelKey）经 watch 触发重取，命中写回响应式 credits。模块级缓存
 * 按 query JSON 去重，避免同参数重复请求。fetch 失败时回落 fallback 并标记 isFallback。
 */
import { ref, watch, type Ref } from 'vue'
import { fetchPriceQuote, type PriceQuoteQuery } from '@/services/pricing-api'

interface CachedQuote {
  credits: number
  ruleVersion: string
  degraded: boolean
}

const cache = new Map<string, CachedQuote>()

export function usePricingQuote(
  buildQuery: () => PriceQuoteQuery,
  fallback: () => number,
): { credits: Ref<number>; isFallback: Ref<boolean> } {
  const credits = ref<number>(fallback())
  const isFallback = ref(true)
  let token = 0

  watch(
    buildQuery,
    async () => {
      const my = ++token
      const q = buildQuery()
      const key = JSON.stringify(q)
      try {
        const hit = cache.get(key) ?? (await fetchPriceQuote(q))
        if (!cache.has(key)) cache.set(key, hit)
        if (my !== token) return // 已被更新的 query 取代，丢弃陈旧结果
        credits.value = hit.credits
        isFallback.value = hit.degraded
      } catch {
        if (my !== token) return
        credits.value = fallback()
        isFallback.value = true
      }
    },
    { immediate: true, deep: true },
  )

  return { credits, isFallback }
}
