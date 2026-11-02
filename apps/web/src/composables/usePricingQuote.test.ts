import { describe, expect, it, vi, beforeEach } from 'vitest'
import { usePricingQuote } from './usePricingQuote'
import { fetchPriceQuote } from '@/services/pricing-api'

vi.mock('@/services/pricing-api')

/** vitest 不导出 flushPromises（在 @vue/test-utils）——自带实现：宏任务边界冲刷全部微任务。 */
const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('usePricingQuote', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('初始同步显示 fallback，端点返回后翻为权威值（无闪烁）', async () => {
    const f = vi.fn().mockResolvedValue({ credits: 33, ruleVersion: 'v2-launch', degraded: false })
    ;(fetchPriceQuote as unknown as ReturnType<typeof vi.fn>).mockImplementation(f)
    const { credits, isFallback } = usePricingQuote(
      () => ({ capability: 'image', count: 1, resolution: '1K' }),
      () => 10,
    )
    expect(credits.value).toBe(10) // 初始回落
    expect(isFallback.value).toBe(true)
    await flushPromises()
    expect(credits.value).toBe(33)
    expect(isFallback.value).toBe(false)
  })

  it('fetch 失败回落 fallback 且 isFallback=true', async () => {
    ;(fetchPriceQuote as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('net'))
    const { credits, isFallback } = usePricingQuote(() => ({ capability: 'image' }), () => 10)
    await flushPromises()
    expect(credits.value).toBe(10)
    expect(isFallback.value).toBe(true)
  })

  it('同 query 只请求一次（模块级缓存命中）', async () => {
    const f = vi.fn().mockResolvedValue({ credits: 33, ruleVersion: 'v2-launch', degraded: false })
    ;(fetchPriceQuote as unknown as ReturnType<typeof vi.fn>).mockImplementation(f)
    const q = () => ({ capability: 'image', resolution: '1K' })
    const a = usePricingQuote(q, () => 10)
    await flushPromises()
    expect(a.credits.value).toBe(33)
    const b = usePricingQuote(q, () => 10) // 首个已缓存，应命中
    await flushPromises()
    expect(b.credits.value).toBe(33)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('degraded（价目表缺失）时 isFallback=true 但仍返回常量兜底值', async () => {
    const f = vi.fn().mockResolvedValue({ credits: 10, ruleVersion: 'constants-fallback', degraded: true })
    ;(fetchPriceQuote as unknown as ReturnType<typeof vi.fn>).mockImplementation(f)
    const { credits, isFallback } = usePricingQuote(() => ({ capability: 'image' }), () => 99)
    await flushPromises()
    expect(credits.value).toBe(10)
    expect(isFallback.value).toBe(true)
  })
})
