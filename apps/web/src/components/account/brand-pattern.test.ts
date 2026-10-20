import { describe, expect, it } from 'vitest'
import { brandPattern } from './brand-pattern'

describe('brandPattern', () => {
  it('同 seed 永远产出同图案（确定性）', () => {
    expect(brandPattern('user_1')).toEqual(brandPattern('user_1'))
    // 反例：不同 seed 若也产出同图案，说明哈希没起作用（退化成常量）
    expect(brandPattern('user_1')).not.toEqual(brandPattern('user_2'))
  })

  it('产出 3 个落在画布内的墨点，参数都在约定区间', () => {
    const { dots } = brandPattern('any-seed-42')
    expect(dots).toHaveLength(3)
    for (const d of dots) {
      expect(d.x).toBeGreaterThanOrEqual(0)
      expect(d.x).toBeLessThanOrEqual(100)
      expect(d.y).toBeGreaterThanOrEqual(0)
      expect(d.y).toBeLessThanOrEqual(100)
      expect(d.r).toBeGreaterThanOrEqual(6)
      expect(d.r).toBeLessThanOrEqual(18)
      expect(d.alpha).toBeGreaterThanOrEqual(0.18)
      expect(d.alpha).toBeLessThanOrEqual(0.32)
    }
  })

  it('空 seed 不抛错（退化为固定图案）', () => {
    expect(() => brandPattern('')).not.toThrow()
    expect(brandPattern('').dots).toHaveLength(3)
  })

  it('不随调用次数漂移（无内部可变状态泄漏）', () => {
    const first = JSON.stringify(brandPattern('stable'))
    for (let i = 0; i < 5; i++) brandPattern(`other-${i}`)
    expect(JSON.stringify(brandPattern('stable'))).toBe(first)
  })
})
