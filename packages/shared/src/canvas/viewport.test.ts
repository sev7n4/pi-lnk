import { describe, expect, it } from 'vitest'
import { clampViewport, isViewportUsable } from './viewport'

describe('视口原语（SP-C）', () => {
  it('zoom 越界收敛到 [0.1, 2]（N5）', () => {
    expect(clampViewport({ x: 10, y: 20, zoom: 0.01 })?.zoom).toBe(0.1)
    expect(clampViewport({ x: 10, y: 20, zoom: 9 })?.zoom).toBe(2)
  })

  it('合法视口原样返回（x/y 不动）', () => {
    expect(clampViewport({ x: -120, y: 33, zoom: 1.25 })).toEqual({ x: -120, y: 33, zoom: 1.25 })
  })

  it('平移量超限 / 非有限 ⇒ 判否（⇒ 回落默认 fitView，防千万级坐标）', () => {
    expect(isViewportUsable({ x: 8574349, y: 23, zoom: 0.77 })).toBe(false)
    expect(isViewportUsable({ x: -768, y: -393934, zoom: 0.1 })).toBe(false)
    expect(isViewportUsable({ x: Number.POSITIVE_INFINITY, y: 0, zoom: 1 })).toBe(false)
    expect(clampViewport({ x: 8574349, y: 23, zoom: 0.77 })).toBeNull()
    expect(clampViewport({ x: -768, y: -393934, zoom: 0.1 })).toBeNull()
  })

  it('边界内平移量保持逐字不动（含边界值）', () => {
    expect(isViewportUsable({ x: 100000, y: -100000, zoom: 1 })).toBe(true)
    expect(isViewportUsable({ x: 100001, y: 0, zoom: 1 })).toBe(false)
  })

  it('脏值/缺字段一律判否（⇒ 回落默认 fitView，fail-open）', () => {
    expect(isViewportUsable(undefined)).toBe(false)
    expect(isViewportUsable({ x: NaN, y: 0, zoom: 1 })).toBe(false)
    expect(isViewportUsable({ x: 0, y: 0, zoom: 'x' as unknown as number })).toBe(false)
    expect(isViewportUsable({ x: 0, y: 0, zoom: 1 })).toBe(true)
  })

  it('脏值 ⇒ clampViewport 返回 null（不得拿半截视口去 setViewport）', () => {
    expect(clampViewport(undefined)).toBeNull()
    expect(clampViewport({ x: 0, y: 0 } as never)).toBeNull()
    expect(clampViewport({ x: 1, y: 2, zoom: Number.POSITIVE_INFINITY })).toBeNull()
  })
})
