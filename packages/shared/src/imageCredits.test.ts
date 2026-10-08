import { describe, expect, it } from 'vitest'
import { IMAGE_RESOLUTION_CREDIT_FACTORS, imageGenerationCredits } from './imageCredits'

describe('imageGenerationCredits 分级定价（诊断 B4）', () => {
  it('1K 保持存量默认：10 分/张', () => {
    expect(imageGenerationCredits({ count: 1, resolution: '1K' })).toBe(10)
    expect(imageGenerationCredits({ count: 2, resolution: '1K' })).toBe(20)
  })

  it('2K/4K 按档位放大且向上取整', () => {
    expect(imageGenerationCredits({ count: 1, resolution: '2K' })).toBe(15)
    expect(imageGenerationCredits({ count: 2, resolution: '2K' })).toBe(30)
    expect(imageGenerationCredits({ count: 1, resolution: '4K' })).toBe(20)
    expect(imageGenerationCredits({ count: 4, resolution: '4K' })).toBe(80)
  })

  it('未知分辨率回退 1K 档（不抛错）', () => {
    expect(imageGenerationCredits({ count: 1, resolution: '8K' })).toBe(10)
    expect(imageGenerationCredits({ count: 1 })).toBe(10)
  })

  it('非法 count 夹逼到 1..4', () => {
    expect(imageGenerationCredits({ count: 0, resolution: '1K' })).toBe(10)
    expect(imageGenerationCredits({ count: 99, resolution: '1K' })).toBe(40)
    expect(imageGenerationCredits({ count: Number.NaN, resolution: '1K' })).toBe(10)
  })

  it('因子表自检：1/1.5/2', () => {
    expect(IMAGE_RESOLUTION_CREDIT_FACTORS).toEqual({ '1K': 1, '2K': 1.5, '4K': 2 })
  })
})
