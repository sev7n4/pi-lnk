// apps/server/src/pricing/pricing-unit-cost.test.ts
import { describe, expect, it } from 'vitest'
import { resolveUnitCost } from './pricing-unit-cost'

const rate = (o: Partial<any> = {}) => ({
  id: 'r1', channel: 'platform', modelKey: 'seedream-5.0-pro', spec: '1K', unit: 'per_image',
  unitQuantity: 1, costYuan: 0.3, source: 'official_list', provisional: false,
  effectiveFrom: null, effectiveTo: null, ...o,
})

describe('unit normalization', () => {
  it('图片 count=3 ⇒ costYuanPerRequest = 3 × 单价', () => {
    const c = resolveUnitCost({ capability: 'image', modelKey: 'seedream-5.0-pro', spec: '1K:3', upstream: 'apimart', billableUnit: 'image_count', unitsPerRequest: 3 }, [rate()], new Date())
    expect(c?.costYuanPerRequest).toBeCloseTo(0.9)
  })
  it('视频 per_second + duration=10 ⇒ 10 × 秒价', () => {
    const c = resolveUnitCost({ capability: 'video', modelKey: 'minimax-h3', spec: '768p:10s', upstream: 'minimax', billableUnit: 'video_second', unitsPerRequest: 10 }, [rate({ unit: 'per_second', unitQuantity: 1, costYuan: 0.572, modelKey: 'minimax-h3', spec: '768p' })], new Date())
    expect(c?.costYuanPerRequest).toBeCloseTo(5.72)
  })
  it('缺整条行与 per_second ⇒ null，绝不 5s 锚点外推', () => {
    expect(resolveUnitCost({ capability: 'video', modelKey: 'minimax-h3', spec: '768p:10s', upstream: 'minimax', billableUnit: 'video_call', unitsPerRequest: 1 }, [rate({ modelKey: 'minimax-h3', spec: '768p:5s', unit: 'per_video', costYuan: 2.86 })], new Date())).toBeNull()
  })
  it('音频 chars=null / 音乐 costYuan=0 / provisional ⇒ null', () => {
    expect(resolveUnitCost({ capability: 'audio', modelKey: 'step-tts-mini', spec: 'voice', upstream: 'stepfun', billableUnit: 'chars_100', unitsPerRequest: null }, [rate({ spec: 'per_100_chars', unit: 'per_call', unitQuantity: 100, costYuan: 0.009 })], new Date())).toBeNull()
    expect(resolveUnitCost({ capability: 'audio', modelKey: 'stepaudio-3-music', spec: 'music', upstream: 'stepfun', billableUnit: 'song', unitsPerRequest: 1 }, [rate({ spec: 'per_song', costYuan: 0 })], new Date())).toBeNull()
    expect(resolveUnitCost({ capability: 'image', modelKey: 'x', spec: '1K:1', upstream: 'u', billableUnit: 'image_count', unitsPerRequest: 1 }, [rate({ provisional: true })], new Date())).toBeNull()
  })
  it('D5：channel_actual 优先于 official_list', () => {
    const c = resolveUnitCost({ capability: 'image', modelKey: 'seedream-5.0-pro', spec: '1K:1', upstream: 'apimart', billableUnit: 'image_count', unitsPerRequest: 1 }, [rate(), rate({ id: 'r2', source: 'channel_actual', costYuan: 0.21, effectiveFrom: new Date('2026-01-01') })], new Date())
    expect(c?.costRateId).toBe('r2')
  })
})
