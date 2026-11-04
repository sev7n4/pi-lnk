import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushDeliveryMetrics,
  observeDeliveryCard,
  resetDeliveryMetricsForTest,
} from './deliveryMetrics'

/** E2-a Task 3（规格 §6）：批量缓冲 50 条或 5s flush；失败静默丢弃不重试（零阻塞）。 */

const fetchMock = vi.fn()

beforeEach(() => {
  resetDeliveryMetricsForTest()
  vi.useFakeTimers()
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', fetchMock)
  localStorage.setItem('token', 'test-token')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('deliveryMetrics 批量上报', () => {
  it('单条 observe 不立即发；5s 后 flush 一次且带 Authorization', async () => {
    observeDeliveryCard('impression', { nodeId: 'n1' })
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/agent/metrics/delivery')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token')
    expect(JSON.parse(String(init.body)).events).toEqual([{ type: 'impression', nodeId: 'n1', ts: expect.any(Number) }])
  })

  it('攒满 50 条立即 flush', async () => {
    for (let i = 0; i < 50; i++) observeDeliveryCard('impression')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).events).toHaveLength(50)
  })

  it('fetch 失败静默丢弃不重试、不抛', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    observeDeliveryCard('expand')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('空缓冲 flush 不发请求', async () => {
    await flushDeliveryMetrics()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
