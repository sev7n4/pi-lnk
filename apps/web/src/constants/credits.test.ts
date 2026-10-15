import { describe, expect, it } from 'vitest'
import { estimateAudioCredits, estimateTextCredits, estimateVideoCredits } from './credits'
import { clampVideoDuration } from '@lnkpi/shared'

describe('estimateVideoCredits tiers', () => {
  it('matches server tiers for intermediate seconds', () => {
    expect(estimateVideoCredits(5)).toBe(30)
    expect(estimateVideoCredits(7)).toBe(30)
    expect(estimateVideoCredits(10)).toBe(50)
    expect(estimateVideoCredits(12)).toBe(50)
    expect(estimateVideoCredits(15)).toBe(70)
  })
})

describe('clampVideoDuration', () => {
  it('clamps and rounds', () => {
    expect(clampVideoDuration(7.4)).toBe(7)
    expect(clampVideoDuration(3)).toBe(4)
    expect(clampVideoDuration(99)).toBe(15)
    expect(clampVideoDuration('x')).toBe(5)
    expect(clampVideoDuration(15, { max: 12 })).toBe(12)
    expect(clampVideoDuration(3, { min: 4, max: 12 })).toBe(4)
  })
})

/**
 * P2 T8 · spec §6.7：文本徽标改「⚡1积分起」后，estimateTextCredits 语义从
 * 「固定 5」改为「floor 1」（token 计费下限）。既有用例无文本锚，此处追加
 * 新语义断言（原「恒 5」无显式回归测试，无需改动）。
 */
describe('estimateTextCredits（P2 T8 · spec §6.7）', () => {
  it('floor 1：token 计费下限，返回 1', () => {
    expect(estimateTextCredits()).toBe(1)
  })
})

describe('estimateAudioCredits 按 kind 分档', () => {
  it('音乐 15 分，其余音频 5 分', () => {
    expect(estimateAudioCredits('music')).toBe(15)
    expect(estimateAudioCredits('design')).toBe(5)
    expect(estimateAudioCredits('voice')).toBe(5)
  })

  it('缺省（存量无参调用）= voice = 5 分', () => {
    expect(estimateAudioCredits()).toBe(5)
  })
})
