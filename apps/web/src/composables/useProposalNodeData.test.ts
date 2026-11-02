import { describe, it, expect } from 'vitest'
import { resolveProposalNodeData, type ProposalCanvasNode } from './useProposalNodeData'

const base = (id: string, data: Record<string, unknown>): ProposalCanvasNode => ({
  id,
  type: 'image',
  data,
})

const n1 = base('n1', {
  label: '产品主图',
  prompt: '极简电竞耳机主图',
  imageModel: 'realism-v2',
  imageAspect: '1:1',
  imageResolution: '1K',
  imageCount: 1,
  style: '写实',
})

describe('resolveProposalNodeData', () => {
  it('解析 image 节点返回完整数据（标题取节点名而非提示词）', () => {
    const r = resolveProposalNodeData('n1', [n1])
    expect(r).not.toBeNull()
    expect(r!.title).toBe('产品主图')
    expect(r!.prompt).toBe('极简电竞耳机主图')
    expect(r!.modelId).toBe('realism-v2')
    expect(r!.aspectRatio).toBe('1:1')
    expect(r!.imageResolution).toBe('1K')
    expect(r!.imageCount).toBe(1)
    expect(r!.style).toBe('写实')
    expect(r!.creditCost).toBeGreaterThan(0) // A-now：estimateImageCredits(count,res)
    expect(r!.creditFromServer).toBe(false)
  })

  it('节点不存在 / nodes 为空时降级返回 null（不崩）', () => {
    expect(resolveProposalNodeData('ghost', [n1])).toBeNull()
    expect(resolveProposalNodeData('n1', null)).toBeNull()
    expect(resolveProposalNodeData('n1', [])).toBeNull()
  })

  it('imageCount 倍数联动积分（仅 count×resolution，与 model 无关）', () => {
    const one = resolveProposalNodeData('n1', [n1])!.creditCost
    const four = resolveProposalNodeData('n4', [base('n4', { ...n1.data, imageCount: 4 })])!
      .creditCost
    expect(four).toBe(one * 4)
  })

  it('服务端下发 creditCost 优先（C-later 接管位）', () => {
    const r = resolveProposalNodeData('n5', [base('n5', { ...n1.data, creditCost: 99 })])!
    expect(r.creditCost).toBe(99)
    expect(r.creditFromServer).toBe(true)
  })

  it('video 节点用 videoModel 也能解析 modelId', () => {
    const v: ProposalCanvasNode = {
      id: 'v1',
      type: 'video',
      data: { label: '短片', prompt: 'p', videoModel: 'gen-v2', imageAspect: '16:9', imageResolution: '1K', imageCount: 1 },
    }
    const r = resolveProposalNodeData('v1', [v])!
    expect(r.modelId).toBe('gen-v2')
    expect(r.nodeType).toBe('video')
  })
})
