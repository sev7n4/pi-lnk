import { describe, expect, it } from 'vitest'
import {
  normalizeIntent,
  isRegenerationIntent,
  isDedupEligibleIntent,
  INTENT_DEDUP_WINDOW_MS,
} from './intent-dedup'

describe('normalizeIntent（P4 意图归一化）', () => {
  it('去首尾空白 + 折叠内部全/半角空白为单空格', () => {
    expect(normalizeIntent('  生成红色的小汽车  ')).toBe('生成红色的小汽车')
    expect(normalizeIntent('生成　红色　的　小汽车')).toBe('生成 红色 的 小汽车')
    expect(normalizeIntent('生成 红色 的 小汽车')).toBe('生成 红色 的 小汽车')
  })

  it('去首尾标点', () => {
    expect(normalizeIntent('生成一个红色小汽车。')).toBe('生成一个红色小汽车')
    expect(normalizeIntent('，生成一个红色小汽车，')).toBe('生成一个红色小汽车')
    expect(normalizeIntent('生成一个红色小汽车！')).toBe('生成一个红色小汽车')
  })

  it('转小写', () => {
    expect(normalizeIntent('GENERATE A RED CAR')).toBe('generate a red car')
  })

  it('同义变体指纹一致（保守归一：空白/全角空格/标点/大小写折叠，不对中文分词）', () => {
    // 首尾空白变体 → 同一指纹
    expect(normalizeIntent('生成红色小汽车')).toBe(
      normalizeIntent('  生成红色小汽车  '),
    )
    // 全角空格（U+3000）→ 半角空格 折叠（同位置单空格的两种写法等价）
    expect(normalizeIntent('生成　红色小汽车')).toBe(
      normalizeIntent('生成 红色小汽车'),
    )
    // 尾部标点变体 → 同一指纹
    expect(normalizeIntent('生成红色小汽车')).toBe(
      normalizeIntent('生成红色小汽车！'),
    )
    // 大小写 + 空白 + 标点变体 → 同一指纹
    expect(normalizeIntent('  Generate A Red Car. ')).toBe(
      normalizeIntent('generate a red car'),
    )
  })

  it('空串 / 纯空白返回空', () => {
    expect(normalizeIntent('')).toBe('')
    expect(normalizeIntent('   ')).toBe('')
    expect(normalizeIntent('　')).toBe('')
  })

  it('超长截断到 200 字符', () => {
    expect(normalizeIntent('红'.repeat(500)).length).toBe(200)
  })
})

describe('isRegenerationIntent（P4 再生成语义放行）', () => {
  it('含再生成动作词放行', () => {
    expect(isRegenerationIntent('再生成一张')).toBe(true)
    expect(isRegenerationIntent('重新生成')).toBe(true)
    expect(isRegenerationIntent('换一张')).toBe(true)
    expect(isRegenerationIntent('给我第二张')).toBe(true)
    expect(isRegenerationIntent('再来一张另一种风格')).toBe(true)
    expect(isRegenerationIntent('再画一个')).toBe(true)
  })

  it('普通生成请求不放行', () => {
    expect(isRegenerationIntent('生成红色的小汽车')).toBe(false)
    expect(isRegenerationIntent('画一个logo')).toBe(false)
  })

  it('「再想想」等无生成动作词不放行（避免误放行）', () => {
    expect(isRegenerationIntent('再想想方案')).toBe(false)
  })

  it('空串返回 false', () => {
    expect(isRegenerationIntent('')).toBe(false)
  })
})

describe('isDedupEligibleIntent（P5 去重资格：只有生成意图参与近窗去重）', () => {
  it('控制/继续类语句不参与（失败后必须能立即重发）', () => {
    expect(isDedupEligibleIntent('继续推进')).toBe(false)
    expect(isDedupEligibleIntent('继续')).toBe(false)
    expect(isDedupEligibleIntent('下一步')).toBe(false)
    expect(isDedupEligibleIntent('然后呢')).toBe(false)
    expect(isDedupEligibleIntent('重试')).toBe(false)
    expect(isDedupEligibleIntent('再试一次')).toBe(false)
    expect(isDedupEligibleIntent('continue')).toBe(false)
    expect(isDedupEligibleIntent('继续推进EP02分镜生成')).toBe(false)
  })

  it('明确生成/创作动作参与去重（保住红车双图防护面）', () => {
    expect(isDedupEligibleIntent('生成红色的小汽车')).toBe(true)
    expect(isDedupEligibleIntent('画一个logo')).toBe(true)
    expect(isDedupEligibleIntent('制作一条视频')).toBe(true)
    expect(isDedupEligibleIntent('帮我做一张海报')).toBe(true)
    expect(isDedupEligibleIntent('generate a red car')).toBe(true)
  })

  it('再生成语义与闲聊都不参与', () => {
    expect(isDedupEligibleIntent('再生成一张')).toBe(false)
    expect(isDedupEligibleIntent('描述你的想法')).toBe(false)
    expect(isDedupEligibleIntent('你好')).toBe(false)
    expect(isDedupEligibleIntent('')).toBe(false)
  })
})

describe('INTENT_DEDUP_WINDOW_MS', () => {
  it('默认 60s（与规格 §11 R3 一致）', () => {
    expect(INTENT_DEDUP_WINDOW_MS).toBe(60_000)
  })
})
