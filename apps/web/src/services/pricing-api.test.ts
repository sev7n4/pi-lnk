import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fetchPriceQuote } from './pricing-api'

describe('fetchPriceQuote', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('拼 querystring 并解析信封（image 1K）', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, data: { credits: 33, ruleVersion: 'v2-launch', degraded: false } }),
    } as Response)
    const r = await fetchPriceQuote({ capability: 'image', count: 1, resolution: '1K' })
    expect(r.credits).toBe(33)
    expect(r.degraded).toBe(false)
    const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(calledUrl).toContain('/pricing/quote?')
    expect(calledUrl).toContain('capability=image')
    expect(calledUrl).toContain('resolution=1K')
    expect(calledUrl).toContain('count=1')
  })

  it('非 2xx 抛错（交由 composable 回落）', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response)
    await expect(fetchPriceQuote({ capability: 'image' })).rejects.toThrow('pricing quote failed: 500')
  })

  it('信封 code!==0 抛错', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 1, data: null }),
    } as Response)
    await expect(fetchPriceQuote({ capability: 'image' })).rejects.toThrow('pricing quote error: 1')
  })
})
