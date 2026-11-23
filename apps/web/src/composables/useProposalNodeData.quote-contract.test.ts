import { describe, expect, it } from 'vitest'
import { quoteQueryOf, type ProposalNodeData } from './useProposalNodeData'

/**
 * P1.5 展示==扣费参数对齐契约（spec 2026-11-15-pricing-subject-billing-takeover §P1.5）。
 *
 * 服务端对应契约：studio.billing-subject-parity.test.ts 钉死扣费侧 quote 参数；
 * 本文件钉死展示侧（提议生成卡/artifact 卡）的 quote 参数。两侧参数清单逐字段
 * 对齐，缺任一侧即 RED —— 防线目标：P1 主体价接管后「展示 ≠ 扣费」（#674）不复发。
 *
 * modelId 为渠道编码值（`platform::xxx`），服务端 modelOptionName 剥前缀后与
 * PricingSubject.modelKey 归一 —— 两侧同参 ⇒ 命中同一主体行。
 */

function base(overrides: Partial<ProposalNodeData> = {}): ProposalNodeData {
  return {
    label: '测试提议',
    prompt: 'prompt',
    modelId: 'platform::seedream-5.0-pro',
    aspectRatio: '16:9',
    imageResolution: '1K',
    imageCount: 1,
    creditCost: 33,
    generationRecordId: '',
    nodeType: 'image',
    ...overrides,
  } as ProposalNodeData
}

describe('P1.5 展示侧 quote 参数契约（quoteQueryOf）', () => {
  it('image 节点：带 modelKey + count + resolution（与 studio.generateImage 扣费同参）', () => {
    const q = quoteQueryOf(base({ imageCount: 2, imageResolution: '2K' }))
    expect(q).toEqual({
      capability: 'image',
      modelKey: 'platform::seedream-5.0-pro',
      count: 2,
      resolution: '2K',
    })
  })

  it('video 节点：带 modelKey + resolution + duration（与 studio.generateVideo 扣费同参）', () => {
    const q = quoteQueryOf(
      base({
        nodeType: 'video',
        modelId: 'platform::h3-max',
        videoResolution: '768p',
        videoDuration: 10,
      }),
    )
    expect(q).toEqual({
      capability: 'video',
      modelKey: 'platform::h3-max',
      resolution: '768p',
      duration: 10,
    })
  })

  it('video 节点缺分辨率/模型 ⇒ 仍带 duration（回落 legacy，绝不猜主体）', () => {
    const q = quoteQueryOf(base({ nodeType: 'video', modelId: '', videoDuration: 5 }))
    expect(q).toEqual({ capability: 'video', modelKey: undefined, resolution: undefined, duration: 5 })
  })

  it('audio 节点：带 audioKind + modelKey（与 studio.generateAudio 扣费同参，design 不归并）', () => {
    const q = quoteQueryOf(
      base({ nodeType: 'audio', modelId: 'platform::stepaudio-3-gen-preview', audioKind: 'design' }),
    )
    expect(q).toEqual({
      capability: 'audio',
      audioKind: 'design',
      modelKey: 'platform::stepaudio-3-gen-preview',
    })
  })

  it('audio 节点缺 kind ⇒ 不报价（null，与既有行为一致）', () => {
    expect(quoteQueryOf(base({ nodeType: 'audio', audioKind: undefined }))).toBeNull()
  })

  it('text / prompt 等非生成节点 ⇒ 不报价（null，卡片不显示积分徽标）', () => {
    // 回归：生产会话 cmwta4mxl09b2ld014nml823m 的 text 节点（短剧剧本/故事Logline）
    // 曾因「非 video/audio 一律回落 image」被按 image:1K:1 报价 33 积分，卡片误显
    // 「消耗 33 积分」。文本走 agent token 结算（侧栏「已消耗 ◇N 积分」），卡片不该有
    // 生成积分徽标。白名单钉死：只有 image/video/audio 三类才报价。
    expect(quoteQueryOf(base({ nodeType: 'text' as ProposalNodeData['nodeType'] }))).toBeNull()
    expect(quoteQueryOf(base({ nodeType: 'prompt' as ProposalNodeData['nodeType'] }))).toBeNull()
    expect(quoteQueryOf(base({ nodeType: 'group' as ProposalNodeData['nodeType'] }))).toBeNull()
  })
})
