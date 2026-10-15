import { describe, expect, it } from 'vitest'
import {
  TEXT_TOKEN_MODELS,
  buildMatchKey,
  buildTextTokenMatchKey,
  legacyPriceOf,
} from './pricing.core'
import {
  enumerateAliasCases,
  enumerateOutOfSpaceCases,
  enumeratePricingSpace,
  enumerateTextTokenRows,
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

describe('enumerateTextTokenRows（P2 T4：文本 token 反比率行）', () => {
  const rows = enumerateTextTokenRows()
  const keys = rows.map((r) => buildTextTokenMatchKey(r.modelKey, r.spec))

  it('TEXT_TOKEN_MODELS 逐字锚（Task 6 消费签名）', () => {
    expect([...TEXT_TOKEN_MODELS]).toEqual([
      'step-3.5-flash',
      'step-3.7-flash',
      'step-2-16k',
      'step-5-preview',
      'minimax-m2.7',
    ])
  })

  it('5 模型 × in/out 全量 + cache 4 行 = 14 行（step-2-16k 上游未公布 cache，不枚举）', () => {
    expect(rows.length).toBe(14)
    for (const modelKey of TEXT_TOKEN_MODELS) {
      expect(keys, modelKey).toContain(buildTextTokenMatchKey(modelKey, 'in'))
      expect(keys, modelKey).toContain(buildTextTokenMatchKey(modelKey, 'out'))
    }
    expect(keys).toContain('text:step-3.5-flash:cache')
    expect(keys).toContain('text:step-3.7-flash:cache')
    expect(keys).toContain('text:step-5-preview:cache')
    expect(keys).toContain('text:minimax-m2.7:cache')
    expect(keys).not.toContain('text:step-2-16k:cache')
  })

  it('匹配键唯一且形态 text:<modelKey>:<spec>', () => {
    expect(new Set(keys).size).toBe(keys.length)
    expect(buildTextTokenMatchKey('step-3.5-flash', 'in')).toBe('text:step-3.5-flash:in')
    expect(buildTextTokenMatchKey('step-3.5-flash', 'cache')).toBe('text:step-3.5-flash:cache')
    expect(buildTextTokenMatchKey('step-3.5-flash', 'out')).toBe('text:step-3.5-flash:out')
  })

  it('v1 等价断言不涉新行：enumeratePricingSpace 无任何 text: 前缀 token 键（v1 隔离锚）', () => {
    const spaceKeys = enumeratePricingSpace().map(buildMatchKey)
    expect(spaceKeys.filter((k) => k.startsWith('text:'))).toEqual([])
    expect(spaceKeys).toContain('text') // text 单行仍在 v1 空间（studio 直生 5 分不动）
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
