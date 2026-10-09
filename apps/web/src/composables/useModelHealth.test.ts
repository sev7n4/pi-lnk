import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeChannelModel } from '@lnkpi/shared'
import {
  availabilityOfModel,
  fetchModelHealthSummary,
  healthDotOfModel,
  setModelHealthSummaryForTests,
  type ModelHealthSummary,
} from './useModelHealth'

const getMock = vi.hoisted(() => vi.fn())
vi.mock('@/services/api', () => ({
  api: { get: getMock },
}))

/** 便捷构造一条健康行。 */
function row(overrides: Partial<ModelHealthSummary['rows'][number]> & { model: string; channelId: string }) {
  return {
    windowHours: 24,
    total: 10,
    completed: 4,
    failed: 6,
    fallbackPending: 0,
    refunded: 0,
    successRate: 0.4,
    ...overrides,
  }
}

const summary: ModelHealthSummary = {
  generatedAt: '2026-10-10T02:00:00.000Z',
  windowHours: 24,
  rows: [row({ model: 'agnes-ok', channelId: 'platform' })],
}

describe('useModelHealth 5 分钟客户端缓存', () => {
  beforeEach(() => {
    getMock.mockReset()
    setModelHealthSummaryForTests(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TTL 内二次调用命中缓存，不重发 HTTP（对齐 A6 语义，落在客户端）', async () => {
    getMock.mockResolvedValueOnce({ data: { code: 0, message: 'ok', data: summary } })
    const t0 = Date.now()
    await fetchModelHealthSummary(t0)
    await fetchModelHealthSummary(t0 + 60_000) // 1 分钟后：仍在 5 分钟窗口内
    expect(getMock).toHaveBeenCalledTimes(1)
  })

  it('超过 5 分钟 → 缓存过期，重新拉取', async () => {
    getMock.mockResolvedValueOnce({ data: { code: 0, message: 'ok', data: summary } })
    getMock.mockResolvedValueOnce({ data: { code: 0, message: 'ok', data: summary } })
    const t0 = Date.now()
    await fetchModelHealthSummary(t0)
    await fetchModelHealthSummary(t0 + 5 * 60_000 + 1) // 5 分钟 + 1ms：过期
    expect(getMock).toHaveBeenCalledTimes(2)
  })

  it('并发调用去重：在途请求共享同一 Promise，只发一次 HTTP', async () => {
    let resolveRpc!: (v: unknown) => void
    getMock.mockImplementationOnce(() => new Promise((r) => (resolveRpc = r)))
    const p1 = fetchModelHealthSummary(Date.now())
    const p2 = fetchModelHealthSummary(Date.now())
    resolveRpc({ data: { code: 0, message: 'ok', data: summary } })
    await Promise.all([p1, p2])
    expect(getMock).toHaveBeenCalledTimes(1)
  })

  it('失败不缓存：请求 rejected 后下一次调用重试', async () => {
    getMock.mockRejectedValueOnce(new Error('network down'))
    getMock.mockResolvedValueOnce({ data: { code: 0, message: 'ok', data: summary } })
    await expect(fetchModelHealthSummary(Date.now())).rejects.toThrow('network down')
    await fetchModelHealthSummary(Date.now())
    expect(getMock).toHaveBeenCalledTimes(2)
  })
})

describe('availabilityOfModel（A3 纯函数）', () => {
  const channels = [
    { id: 'platform', models: [
      { name: 'm-un', capability: 'text', availability: 'unavailable' },
      { name: 'm-av', capability: 'text', availability: 'available' },
      { name: 'm-old', capability: 'text' },
      { name: 'm-dirty', capability: 'text', availability: 'whatever' },
    ] },
    { id: 'ch1', models: [{ name: 'byok-m', capability: 'text' }] },
  ] as unknown as Parameters<typeof availabilityOfModel>[0]

  it('unavailable / available 原样返回', () => {
    expect(availabilityOfModel(channels, encodeChannelModel('platform', 'm-un'))).toBe('unavailable')
    expect(availabilityOfModel(channels, encodeChannelModel('platform', 'm-av'))).toBe('available')
  })

  it('缺字段 / 脏值 / BYOK / 解码失败 → unknown（照常可选）', () => {
    expect(availabilityOfModel(channels, encodeChannelModel('platform', 'm-old'))).toBe('unknown')
    expect(availabilityOfModel(channels, encodeChannelModel('platform', 'm-dirty'))).toBe('unknown')
    expect(availabilityOfModel(channels, encodeChannelModel('ch1', 'byok-m'))).toBe('unknown')
    expect(availabilityOfModel(channels, 'no-separator')).toBe('unknown')
  })
})

describe('healthDotOfModel（A4 纯函数抽行）', () => {
  const rows: ModelHealthSummary['rows'] = [
    row({ model: 'm-red', channelId: 'platform', successRate: 0.4, completed: 4 }),
    row({ model: 'm-yellow', channelId: 'platform', successRate: 0.7, completed: 7 }),
    row({ model: 'm-good', channelId: 'platform', successRate: 0.95, completed: 9 }),
    row({ model: 'm-zero', channelId: 'platform', total: 0, completed: 0, successRate: null }),
    row({ model: 'byok-m', channelId: 'u-me', successRate: 0.3, completed: 3 }),
  ]

  it('0.4→red、0.7→yellow、0.95/null→无；title「近24h 成功率 x/x」', () => {
    const ok = encodeChannelModel('platform', 'm-red')
    expect(healthDotOfModel(rows, ok)).toEqual({ kind: 'red', title: '近24h 成功率 4/10' })
    expect(healthDotOfModel(rows, encodeChannelModel('platform', 'm-yellow'))?.kind).toBe('yellow')
    expect(healthDotOfModel(rows, encodeChannelModel('platform', 'm-good'))).toBeNull()
    expect(healthDotOfModel(rows, encodeChannelModel('platform', 'm-zero'))).toBeNull()
  })

  it('BYOK 行按「非平台行」匹配本人；平台行不误挂到 BYOK 模型', () => {
    expect(healthDotOfModel(rows, encodeChannelModel('ch1', 'byok-m'))?.kind).toBe('red')
    // 平台 m-red 行不挂到 BYOK 同名模型
    expect(healthDotOfModel(rows, encodeChannelModel('ch1', 'm-red'))).toBeNull()
  })

  it('无数据 → null', () => {
    expect(healthDotOfModel(null, encodeChannelModel('platform', 'm-red'))).toBeNull()
    expect(healthDotOfModel([], encodeChannelModel('platform', 'm-red'))).toBeNull()
  })
})
