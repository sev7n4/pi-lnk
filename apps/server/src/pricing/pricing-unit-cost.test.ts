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

describe('audio 按模型精确匹配（修复跨模型误用成本）', () => {
  it('stepaudio-3-tts 不得套用 step-tts-mini 的字符成本', () => {
    const mini = rate({ id: 'mini', modelKey: 'step-tts-mini', spec: 'per_100_chars', unit: 'per_call', unitQuantity: 100, costYuan: 0.009 })
    const c = resolveUnitCost({ capability: 'audio', modelKey: 'stepaudio-3-tts', spec: 'voice', upstream: 'stepfun', billableUnit: 'chars_100', unitsPerRequest: 100 }, [mini], new Date())
    expect(c).toBeNull()
  })
  it('存在同模型成本时精确命中并生效', () => {
    const tts = rate({ id: 'tts', modelKey: 'stepaudio-3-tts', spec: 'per_100_chars', unit: 'per_call', unitQuantity: 100, costYuan: 0.025 })
    const mini = rate({ id: 'mini', modelKey: 'step-tts-mini', spec: 'per_100_chars', unit: 'per_call', unitQuantity: 100, costYuan: 0.009 })
    const c = resolveUnitCost({ capability: 'audio', modelKey: 'stepaudio-3-tts', spec: 'voice', upstream: 'stepfun', billableUnit: 'chars_100', unitsPerRequest: 100 }, [tts, mini], new Date())
    expect(c?.costRateId).toBe('tts')
    expect(c?.costYuanPerRequest).toBeCloseTo(0.025)
  })
})

describe('视频 per_second 粗化行按 模型+分辨率 精确匹配（D-2，修复跨模型/跨分辨率误用）', () => {
  const subject = { capability: 'video', modelKey: 'agnes-video-2.5-flash', spec: '2k:10s', upstream: 'u', billableUnit: 'video_call', unitsPerRequest: 1 }
  it('同模型同分辨率 per_second 精确命中并按 duration 展开', () => {
    const row = rate({ id: 'ps2k', modelKey: 'agnes-video-2.5-flash', spec: '2k', unit: 'per_second', unitQuantity: 1, costYuan: 0.93 })
    const c = resolveUnitCost(subject, [row], new Date())
    expect(c?.costYuanPerRequest).toBeCloseTo(9.3)
  })
  it('跨模型 per_second 不得命中（default family 也不行）', () => {
    const seedance = rate({ id: 'sd', modelKey: 'seedance-2.0-fast', spec: '2k', unit: 'per_second', unitQuantity: 1, costYuan: 0.5 })
    expect(resolveUnitCost(subject, [seedance], new Date())).toBeNull()
  })
  it('同模型跨分辨率 per_second 不得命中（480p 行不供 2k 主体）', () => {
    const row = rate({ id: 'ps480', modelKey: 'agnes-video-2.5-flash', spec: '480p', unit: 'per_second', unitQuantity: 1, costYuan: 0.3 })
    expect(resolveUnitCost(subject, [row], new Date())).toBeNull()
  })
  it('等价金标准：per_video(768p:5s=2.86) 与 per_second(768p=0.572)×5 逐元相等', () => {
    const s = { capability: 'video', modelKey: 'minimax-h3', spec: '768p:5s', upstream: 'minimax', billableUnit: 'video_call', unitsPerRequest: 1 }
    const pv = resolveUnitCost(s, [rate({ id: 'pv', modelKey: 'minimax-h3', spec: '768p:5s', unit: 'per_video', costYuan: 2.86 })], new Date())
    const ps = resolveUnitCost(s, [rate({ id: 'ps', modelKey: 'minimax-h3', spec: '768p', unit: 'per_second', costYuan: 0.572 })], new Date())
    expect(pv?.costYuanPerRequest).toBeCloseTo(ps!.costYuanPerRequest, 10)
  })
})

describe('image_edit / image_variant 复用图像 per_image 锚点（spec="*" 暂按 1K）', () => {
  it('image_edit 命中 1K 锚点', () => {
    const anchor = rate({ id: 'a1k', modelKey: 'seedream-5.0-flash', spec: '1K', unit: 'per_image', costYuan: 0.12 })
    const c = resolveUnitCost({ capability: 'image_edit', modelKey: 'agnes-image-2.5-flash', spec: '*', upstream: 'apimart', billableUnit: 'image_count', unitsPerRequest: 1 }, [anchor], new Date())
    expect(c?.costYuanPerRequest).toBeCloseTo(0.12)
  })
  it('image_variant 命中 1K 锚点', () => {
    const anchor = rate({ id: 'a1k', modelKey: 'seedream-5.0-pro', spec: '1K', unit: 'per_image', costYuan: 0.3 })
    const c = resolveUnitCost({ capability: 'image_variant', modelKey: 'agnes-image-2.0-flash', spec: '*', upstream: 'apimart', billableUnit: 'image_count', unitsPerRequest: 1 }, [anchor], new Date())
    expect(c?.costYuanPerRequest).toBeCloseTo(0.3)
  })
})
