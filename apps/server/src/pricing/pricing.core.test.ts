// apps/server/src/pricing/pricing.core.test.ts
import { describe, expect, it } from 'vitest'
import {
  buildMatchKey,
  canonicalImageCount,
  canonicalImageResolution,
  canonicalVideoResolution,
  computeCreditsFromCost,
  legacyPriceOf,
  videoPriceFamily,
  type PricingQuery,
} from './pricing.core'

describe('videoPriceFamily（与 videoCreditsForModel 的分支逐字对齐）', () => {
  it.each([
    ['minimax-h3', 'minimax-h3'],
    ['MINIMAX-H3', 'minimax-h3'],
    ['minimax-h3-max', 'h3-max'],
    ['h3-max', 'h3-max'],
    ['h3-max-turbo', 'h3-max-turbo'],
    ['H3-MAX-TURBO', 'h3-max-turbo'],
    ['seedance-2.0', 'default'],
    ['ch1::sora', 'default'],
    [undefined, 'default'],
  ])('modelKey %s → %s', (key, expected) => {
    expect(videoPriceFamily(key)).toBe(expected)
  })
})

describe('canonicalVideoResolution', () => {
  it.each([
    [undefined, '768p'],
    ['480P', '480p'],
    ['480p', '480p'],
    ['720p', '768p'],
    ['1080p', '768p'],
    ['2K', '2k'],
    ['2k', '2k'],
    ['weird', '768p'],
  ])('%s → %s', (input, expected) => {
    expect(canonicalVideoResolution(input)).toBe(expected)
  })
})

describe('canonicalImageResolution / Count（大小写敏感，镜像 FACTORS 查找）', () => {
  it.each([
    [undefined, '1K'],
    ['1K', '1K'],
    ['2K', '2K'],
    ['4K', '4K'],
    ['2k', '1K'],   // 小写不是 FACTORS 键 ⇒ legacy 回落 factor 1，规范化必须同果
    ['weird', '1K'],
  ])('image %s → %s', (input, expected) => {
    expect(canonicalImageResolution(input)).toBe(expected)
  })
  it.each([
    [undefined, 1],
    [0, 1],
    [-3, 1],
    [2.7, 2],
    [9, 4],
    [NaN, 1],
  ])('count %s → %s', (input, expected) => {
    expect(canonicalImageCount(input)).toBe(expected)
  })
})

describe('legacyPriceOf（= 现行常量，逐档钉死）', () => {
  it.each<PricingQuery>([
    { capability: 'text' },
    { capability: 'image', count: 1, resolution: '1K' },
    { capability: 'image', count: 3, resolution: '2K' },
    { capability: 'image', count: 2, resolution: '4K' },
    { capability: 'image', count: 1, resolution: '2k' }, // 小写 ⇒ 10（quirk 锁定）
    { capability: 'image_variant' },
    { capability: 'image_edit', modelKey: 'image2' },
    { capability: 'image_edit', modelKey: 'ch9::gpt-image-2' },
    { capability: 'image_edit' },
    { capability: 'audio', audioKind: 'voice' },
    { capability: 'audio', audioKind: 'music' },
    { capability: 'audio' },
    { capability: 'video', modelKey: 'seedance-2.0', duration: 5 },
    { capability: 'video', modelKey: 'h3-max-turbo', duration: 5, resolution: '480p' },
    { capability: 'video', modelKey: 'h3-max-turbo', duration: 5 },
    { capability: 'video', modelKey: 'h3-max', duration: 5, resolution: '480p' },
    { capability: 'video', modelKey: 'h3-max', duration: 5, resolution: '768p' },
    { capability: 'video', modelKey: 'minimax-h3', duration: 5, resolution: '768p' },
    { capability: 'video', modelKey: 'minimax-h3', duration: 5, resolution: '2K' },
    { capability: 'video', modelKey: 'minimax-h3', duration: 15, resolution: '768p' },
    { capability: 'video', modelKey: 'minimax-h3', duration: 4 },
    // H3 参考图加价：免费 5 张，超出的每张 +5；参考视频每个 +15
    { capability: 'video', modelKey: 'minimax-h3', duration: 5, resolution: '768p', videoMode: 'reference_to_video', referenceImageCount: 4 },
    { capability: 'video', modelKey: 'minimax-h3', duration: 5, resolution: '768p', videoMode: 'reference_to_video', referenceImageCount: 5 },
    { capability: 'video', modelKey: 'minimax-h3', duration: 5, resolution: '768p', videoMode: 'reference_to_video', referenceImageCount: 6, referenceVideoCount: 1 },
    // 非 reference 模式下 ri/rv 不参与加价
    { capability: 'video', modelKey: 'minimax-h3', duration: 5, resolution: '768p', videoMode: 'image_to_video', referenceImageCount: 3 },
  ])('case %j', (q) => {
    const expected: Record<string, number> = {
      '{"capability":"text"}': 5,
      '{"capability":"image","count":1,"resolution":"1K"}': 10,
      '{"capability":"image","count":3,"resolution":"2K"}': 45,
      '{"capability":"image","count":2,"resolution":"4K"}': 40,
      '{"capability":"image","count":1,"resolution":"2k"}': 10,
      '{"capability":"image_variant"}': 10,
      '{"capability":"image_edit","modelKey":"image2"}': 10,
      '{"capability":"image_edit","modelKey":"ch9::gpt-image-2"}': 10,
      '{"capability":"image_edit"}': 10,
      '{"capability":"audio","audioKind":"voice"}': 5,
      '{"capability":"audio","audioKind":"music"}': 15,
      '{"capability":"audio"}': 5,
      '{"capability":"video","modelKey":"seedance-2.0","duration":5}': 30,
      '{"capability":"video","modelKey":"h3-max-turbo","duration":5,"resolution":"480p"}': 30,
      '{"capability":"video","modelKey":"h3-max-turbo","duration":5}': 36,
      '{"capability":"video","modelKey":"h3-max","duration":5,"resolution":"480p"}': 36,
      '{"capability":"video","modelKey":"h3-max","duration":5,"resolution":"768p"}': 45,
      '{"capability":"video","modelKey":"minimax-h3","duration":5,"resolution":"768p"}': 36,
      '{"capability":"video","modelKey":"minimax-h3","duration":5,"resolution":"2K"}': 54,
      '{"capability":"video","modelKey":"minimax-h3","duration":15,"resolution":"768p"}': 84,
      '{"capability":"video","modelKey":"minimax-h3","duration":4}': 36, // 短时长 base 30 × 官方 H3 默认 768p 系数 1.2 = 36（以现行 videoCreditsForModel 为准，brief 原值 30 漏乘家族系数）
      '{"capability":"video","modelKey":"minimax-h3","duration":5,"resolution":"768p","videoMode":"reference_to_video","referenceImageCount":4}': 36,
      '{"capability":"video","modelKey":"minimax-h3","duration":5,"resolution":"768p","videoMode":"reference_to_video","referenceImageCount":5}': 36,
      '{"capability":"video","modelKey":"minimax-h3","duration":5,"resolution":"768p","videoMode":"reference_to_video","referenceImageCount":6,"referenceVideoCount":1}': 56,
      '{"capability":"video","modelKey":"minimax-h3","duration":5,"resolution":"768p","videoMode":"image_to_video","referenceImageCount":3}': 36,
    }
    expect(legacyPriceOf(q)).toBe(expected[JSON.stringify(q)])
  })
})

describe('buildMatchKey', () => {
  it.each([
    [{ capability: 'text' } as PricingQuery, 'text'],
    [{ capability: 'image', count: 2, resolution: '2K' } as PricingQuery, 'image:2K:2'],
    [{ capability: 'image', count: 1 } as PricingQuery, 'image:1K:1'],
    [{ capability: 'image_variant' } as PricingQuery, 'image_variant'],
    [{ capability: 'image_edit', modelKey: 'image2' } as PricingQuery, 'image_edit:image2'],
    [{ capability: 'image_edit' } as PricingQuery, 'image_edit:image2'],
    [{ capability: 'audio', audioKind: 'music' } as PricingQuery, 'audio:music'],
    [{ capability: 'audio' } as PricingQuery, 'audio:voice'],
    [{ capability: 'video', modelKey: 'seedance-2.0', duration: 5 } as PricingQuery, 'video:default:768p:5:-:ri0:rv0'],
    [{ capability: 'video', modelKey: 'h3-max', duration: 5, resolution: '1080p' } as PricingQuery, 'video:h3-max:768p:5:-:ri0:rv0'],
    [{ capability: 'video', modelKey: 'minimax-h3', duration: 5, videoMode: 'reference_to_video', referenceImageCount: 6, referenceVideoCount: 1 } as PricingQuery, 'video:minimax-h3:768p:5:ref:ri6:rv1'],
    [{ capability: 'video', modelKey: 'minimax-h3', duration: 5, videoMode: 'image_to_video', referenceImageCount: 6 } as PricingQuery, 'video:minimax-h3:768p:5:-:ri0:rv0'],
  ])('case %j → %s', (q, expected) => {
    expect(buildMatchKey(q)).toBe(expected)
  })
})

describe('computeCreditsFromCost（1 分 = ¥0.01；marginBp 11000 = 1.10×）', () => {
  it.each([
    [0.3, 11000, 33],
    [0.6, 11000, 66],
    [2.86, 11000, 315],
    [4.65, 11000, 512],
    [0.072, 11000, 8],
    [0.0025, 11000, 1],
    [0.3, 25000, 75],
    [0.3, 35000, 105],
    // 0.12×110=13.2 ⇒ ceil 14（spec §6.1 的 13 是 floor 口径；P1 重定价以本函数为准并回改 spec）
    [0.12, 11000, 14],
  ])('cost %s × marginBp %s → %s', (cost, bp, expected) => {
    expect(computeCreditsFromCost(cost, bp)).toBe(expected)
  })
})
