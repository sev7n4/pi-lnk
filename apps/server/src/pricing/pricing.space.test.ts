import { describe, expect, it } from 'vitest'
import { buildMatchKey, legacyPriceOf } from './pricing.core'
import {
  enumerateAliasCases,
  enumerateOutOfSpaceCases,
  enumeratePricingSpace,
} from './pricing.space'

describe('enumeratePricingSpace', () => {
  const space = enumeratePricingSpace()

  it('非空且规模符合预期（空集假绿防线）', () => {
    expect(space.length).toBeGreaterThan(300)
  })

  it('每个 case 的 legacy 价格都是正整数', () => {
    for (const q of space) {
      const credits = legacyPriceOf(q)
      expect(Number.isInteger(credits), `${buildMatchKey(q)} → ${credits}`).toBe(true)
      expect(credits).toBeGreaterThan(0)
    }
  })

  it('匹配键唯一（否则种子 upsert 会静默合并行）', () => {
    const keys = space.map(buildMatchKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('覆盖全部能力与 H3 参考图维度', () => {
    const keys = new Set(space.map(buildMatchKey))
    expect(keys.has('text')).toBe(true)
    expect(keys.has('image:1K:1')).toBe(true)
    expect(keys.has('image:4K:4')).toBe(true)
    expect(keys.has('image_variant')).toBe(true)
    expect(keys.has('image_edit:image2')).toBe(true)
    expect(keys.has('image_edit:*')).toBe(true)
    expect(keys.has('audio:voice')).toBe(true)
    expect(keys.has('audio:music')).toBe(true)
    expect(keys.has('video:default:768p:5:-:ri0:rv0')).toBe(true)
    expect(keys.has('video:minimax-h3:2k:15:ref:ri6:rv2')).toBe(true)
  })
})

describe('enumerateAliasCases / enumerateOutOfSpaceCases', () => {
  it('别名 case 全部可求值且键命中某条种子行（或 capability 默认行）', () => {
    const seedKeys = new Set(enumeratePricingSpace().map(buildMatchKey))
    for (const q of enumerateAliasCases()) {
      const key = buildMatchKey(q)
      const ok = seedKeys.has(key) || seedKeys.has(`${q.capability}:*`)
      expect(ok, key).toBe(true)
    }
  })
  it('表外 case 的键不在种子行里（必须走 fallback）', () => {
    const seedKeys = new Set(enumeratePricingSpace().map(buildMatchKey))
    for (const q of enumerateOutOfSpaceCases()) {
      expect(seedKeys.has(buildMatchKey(q)), buildMatchKey(q)).toBe(false)
    }
  })
})
