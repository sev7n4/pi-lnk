import { describe, expect, it } from 'vitest'
import { estimateAudioCredits, estimateVideoCredits } from './credits'
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
