import { describe, expect, it } from 'vitest'
import { recommendRetryModel, type RetryModelCandidate } from './retryRecommendation'

const PLATFORM_REF = (name: string) => `platform::${name}`

function candidates(
  rows: Array<[name: string, availability: RetryModelCandidate['availability'], successRate: number | null]>,
): RetryModelCandidate[] {
  return rows.map(([name, availability, successRate]) => ({
    modelKey: PLATFORM_REF(name),
    availability,
    successRate,
  }))
}

describe('recommendRetryModel', () => {
  it('A2: 排除失败模型自身（裸名失败模型 vs platform ref 候选池）', () => {
    const rec = recommendRetryModel({
      failedModelKey: 'agnes-image-2.1-flash',
      capability: 'image',
      candidates: candidates([
        ['agnes-image-2.1-flash', 'available', 0.9],
        ['seedream-5.0-pro', 'available', 0.8],
      ]),
    })
    expect(rec).toEqual({ modelKey: PLATFORM_REF('seedream-5.0-pro'), reason: '同渠道成功率 80%' })
  })

  it('A2: 排除失败模型自身（ref 形态 vs ref 形态）', () => {
    const rec = recommendRetryModel({
      failedModelKey: PLATFORM_REF('seedream-5.0-pro'),
      capability: 'image',
      candidates: candidates([
        ['seedream-5.0-pro', 'available', 1],
        ['agnes-image-2.1-flash', 'available', 0.5],
      ]),
    })
    expect(rec?.modelKey).toBe(PLATFORM_REF('agnes-image-2.1-flash'))
  })

  it('A2/A4: 排除探活 unavailable 候选（不会被推到又一个必挂模型）', () => {
    const rec = recommendRetryModel({
      failedModelKey: PLATFORM_REF('a'),
      capability: 'image',
      candidates: candidates([
        ['b', 'unavailable', 0.99],
        ['c', 'unknown', 0.1],
      ]),
    })
    expect(rec?.modelKey).toBe(PLATFORM_REF('c'))
  })

  it('A2: 全部候选 unavailable → null', () => {
    const rec = recommendRetryModel({
      failedModelKey: PLATFORM_REF('a'),
      capability: 'image',
      candidates: candidates([
        ['b', 'unavailable', 0.9],
        ['c', 'unavailable', 0.8],
      ]),
    })
    expect(rec).toBeNull()
  })

  it('A2: successRate 降序、null 排可用组末位', () => {
    const rec = recommendRetryModel({
      failedModelKey: PLATFORM_REF('a'),
      capability: 'image',
      candidates: candidates([
        ['low', 'available', 0.2],
        ['none', 'available', null],
        ['high', 'available', 0.95],
      ]),
    })
    expect(rec?.modelKey).toBe(PLATFORM_REF('high'))
  })

  it('A2: 全候选 successRate=null（冷启动）→ 仍给出确定性推荐（modelKey 字典序）', () => {
    const rec = recommendRetryModel({
      failedModelKey: PLATFORM_REF('a'),
      capability: 'image',
      candidates: candidates([
        ['zeta', 'available', null],
        ['alpha', 'unknown', null],
        ['mid', 'available', null],
      ]),
    })
    // null 不淘汰（首版上线真实数据就是零流量），取字典序首个可用候选
    expect(rec).toEqual({ modelKey: PLATFORM_REF('alpha'), reason: '同渠道可用（暂无成功率数据）' })
  })

  it('A2: 候选池为空 → null（不渲染重试按钮）', () => {
    expect(
      recommendRetryModel({ failedModelKey: PLATFORM_REF('a'), capability: 'image', candidates: [] }),
    ).toBeNull()
  })

  it('A2: 失败模型 key 为空 → null', () => {
    expect(
      recommendRetryModel({
        failedModelKey: '  ',
        capability: 'image',
        candidates: candidates([['b', 'available', 1]]),
      }),
    ).toBeNull()
  })

  it('同渠道判定：跨渠道候选被排除（BYOK 失败 → 平台候选不参选）', () => {
    const rec = recommendRetryModel({
      failedModelKey: 'ch_user::my-model',
      capability: 'image',
      candidates: [
        { modelKey: PLATFORM_REF('platform-model'), availability: 'available', successRate: 0.9 },
        { modelKey: 'ch_user::other-model', availability: 'available', successRate: 0.5 },
      ],
    })
    expect(rec?.modelKey).toBe('ch_user::other-model')
  })

  it('同渠道判定：平台失败模型（裸名归一为 platform）不推荐 BYOK 候选', () => {
    const rec = recommendRetryModel({
      failedModelKey: 'agnes-image-2.1-flash',
      capability: 'image',
      candidates: [{ modelKey: 'ch_user::other', availability: 'available', successRate: 0.9 }],
    })
    expect(rec).toBeNull()
  })

  it('capability：候选自带模态标签时按 capability 过滤', () => {
    const rec = recommendRetryModel({
      failedModelKey: PLATFORM_REF('a'),
      capability: 'image',
      candidates: [
        { modelKey: PLATFORM_REF('text-model'), availability: 'available', successRate: 0.9, capability: 'text' },
        { modelKey: PLATFORM_REF('image-model'), availability: 'available', successRate: 0.5, capability: 'image' },
      ],
    })
    expect(rec?.modelKey).toBe(PLATFORM_REF('image-model'))
  })

  it('同分并列按 modelKey 字典序（确定性）', () => {
    const rec = recommendRetryModel({
      failedModelKey: PLATFORM_REF('a'),
      capability: 'image',
      candidates: candidates([
        ['beta', 'available', 0.7],
        ['alpha', 'available', 0.7],
      ]),
    })
    expect(rec?.modelKey).toBe(PLATFORM_REF('alpha'))
  })
})
