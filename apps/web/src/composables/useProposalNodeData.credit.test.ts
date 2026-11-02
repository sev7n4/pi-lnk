import { describe, expect, it, vi, afterEach } from 'vitest'

/**
 * v2 单一真相源修复（续 2026-11-02-points-display-single-source）：
 * 提议生成卡 / artifact 卡积分 pill 权威取数。
 *
 * 事故：#674 卡片积分兜底走 estimateImageCredits 旧常量（10），计费读价目表（33）
 * ⇒ 展示 10 / 实扣 33。修复后优先级：服务端 creditCost > 价目表 quote > 本地常量。
 * quote 端点与计费同源同表 ⇒ 改价只改管理后台价目表，展示与计费同时生效。
 */

// fetchPriceQuote 必须先于被测模块 import 被 mock（vi.mock 提升）
vi.mock('@/services/pricing-api', () => ({
  fetchPriceQuote: vi.fn(),
}))

import { resolveProposalNodeData, type ProposalCanvasNode } from './useProposalNodeData'

const imageNode: ProposalCanvasNode = {
  id: 'n1',
  type: 'image',
  data: {
    label: '蓝色老虎',
    prompt: '写实蓝色老虎',
    imageModel: 'realism-v2',
    imageAspect: '1:1',
    imageResolution: '1K',
    imageCount: 1,
  },
}

/**
 * 每个用例拿全新模块实例（模块级 quoteMap/inflight 互不串扰）。
 * 注意：resetModules 会重建 mock 工厂 ⇒ mock 引用必须与被测模块同步重取，
 * 不能用顶层 import 的 fetchPriceQuote（会拿到重建前的旧实例）。
 */
async function fresh() {
  vi.resetModules()
  const mod = await import('./useProposalNodeData')
  const api = await import('@/services/pricing-api')
  return { mod, mockQuote: vi.mocked(api.fetchPriceQuote) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('proposalCreditCost — 价目表权威取数', () => {
  it('image：首帧同步返回旧常量兜底（10，防闪烁），quote 返回后翻价目表权威值（33）', async () => {
    const { mod, mockQuote } = await fresh()
    const d = resolveProposalNodeData('n1', [imageNode])!
    mockQuote.mockResolvedValue({ credits: 33, ruleVersion: 'v2-launch', degraded: false })

    expect(mod.proposalCreditCost(d)).toBe(10) // 同步兜底，与 dock 同策略
    await vi.waitFor(() => expect(mod.proposalCreditCost(d)).toBe(33)) // 响应式写回
    expect(mockQuote).toHaveBeenCalledWith({
      capability: 'image',
      count: 1,
      resolution: '1K',
    })
  })

  it('同参数只发一次 quote（inflight+缓存去重，N 张卡片共享同一报价）', async () => {
    const { mod, mockQuote } = await fresh()
    const d = resolveProposalNodeData('n1', [imageNode])!
    mockQuote.mockResolvedValue({ credits: 33, ruleVersion: 'v2-launch', degraded: false })

    mod.proposalCreditCost(d)
    mod.proposalCreditCost(d)
    mod.proposalCreditCost(d)
    await vi.waitFor(() => expect(mod.proposalCreditCost(d)).toBe(33))
    expect(mockQuote).toHaveBeenCalledTimes(1)
  })

  it('count/分辨率联动：不同 query 各自权威值（2 张 2K ≠ 1 张 1K）', async () => {
    const { mod, mockQuote } = await fresh()
    const one = resolveProposalNodeData('n1', [imageNode])!
    const two = resolveProposalNodeData('n2', [
      { id: 'n2', type: 'image', data: { ...imageNode.data, imageCount: 2, imageResolution: '2K' } },
    ])!
    mockQuote.mockImplementation((q) =>
      Promise.resolve(
        q.count === 2
          ? { credits: 66, ruleVersion: 'v2-launch', degraded: false }
          : { credits: 33, ruleVersion: 'v2-launch', degraded: false },
      ),
    )

    expect(mod.proposalCreditCost(two)).toBeDefined()
    await vi.waitFor(() => {
      expect(mod.proposalCreditCost(one)).toBe(33)
      expect(mod.proposalCreditCost(two)).toBe(66)
    })
    expect(mockQuote).toHaveBeenCalledWith({ capability: 'image', count: 2, resolution: '2K' })
  })

  it('video：quote 未返回前 undefined（宁可不显示，绝不显示假数字），返回后显权威值', async () => {
    const { mod, mockQuote } = await fresh()
    const v = resolveProposalNodeData('v1', [
      {
        id: 'v1',
        type: 'video',
        data: { label: '短片', prompt: 'p', videoModel: 'gen-v2', videoSettings: { duration: 5 } },
      },
    ])!
    mockQuote.mockResolvedValue({ credits: 30, ruleVersion: 'v2-launch', degraded: false })

    expect(mod.proposalCreditCost(v)).toBeUndefined()
    await vi.waitFor(() => expect(mod.proposalCreditCost(v)).toBe(30))
    expect(mockQuote).toHaveBeenCalledWith({ capability: 'video', duration: 5 })
  })

  it('服务端 creditCost 权威优先：直接返回，不发 quote 请求', async () => {
    const { mod, mockQuote } = await fresh()
    const d = resolveProposalNodeData('n5', [
      { id: 'n5', type: 'image', data: { ...imageNode.data, creditCost: 99 } },
    ])!

    expect(mod.proposalCreditCost(d)).toBe(99)
    expect(mockQuote).not.toHaveBeenCalled()
  })

  it('quote 失败 fail-soft：保留本地兜底（10），不抛错不置空', async () => {
    const { mod, mockQuote } = await fresh()
    const d = resolveProposalNodeData('n1', [imageNode])!
    mockQuote.mockRejectedValue(new Error('network down'))

    expect(mod.proposalCreditCost(d)).toBe(10)
    await new Promise((r) => setTimeout(r, 0))
    expect(mod.proposalCreditCost(d)).toBe(10)
  })

  it('null 数据降级：返回 undefined 不崩', async () => {
    const { mod } = await fresh()
    expect(mod.proposalCreditCost(null)).toBeUndefined()
    expect(mod.proposalCreditCost(undefined)).toBeUndefined()
  })
})
