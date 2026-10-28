import { describe, expect, it } from 'vitest'
import { mapMarksToImageSpace, type MarkSpaceGeometry } from './mapMarksToImageSpace'

/**
 * 圈选标记坐标逆映射（2026-10-28 真机反馈②「标记漂移」）。
 * 纯几何：给元素盒 + 自然尺寸 ⇒ 断言逆映射后的图像空间坐标。
 */

function g(over: Partial<MarkSpaceGeometry> = {}): MarkSpaceGeometry {
  return {
    elRect: { left: 0, top: 0, width: 390, height: 600 },
    elWidth: 390,
    elHeight: 600,
    naturalWidth: 780,
    naturalHeight: 1200,
    inkRect: { left: 0, top: 0 },
    ...over,
  }
}

describe('mapMarksToImageSpace（contain + zoom 逆映射）', () => {
  it('宽幅留白（自然图比元素更「扁」）⇒ 水平居中 letterbox 正确回映', () => {
    // 元素盒 390×600；自然 780×2400（竖长图）⇒ fit = min(0.5, 0.25) = 0.25
    // 内容盒 = 195×600，水平留白各 (390-195)/2 = 97.5
    const marks = [{ points: [{ x: 97.5, y: 0 }, { x: 292.5, y: 600 }] }]
    const out = mapMarksToImageSpace(marks, g({ naturalWidth: 780, naturalHeight: 2400 }))
    expect(out).not.toBeNull()
    // 内容盒左上 (97.5, 0)；scale 0.25 ⇒ client(97.5,0)→(0,0)；client(292.5,600)→(780,2400)
    expect(out![0]!.points[0]).toEqual({ x: 0, y: 0 })
    expect(out![0]!.points[1]).toEqual({ x: 780, y: 2400 })
  })

  it('无留白等比盒 ⇒ 1:1 双倍自然尺寸线性回映', () => {
    // 元素 390×600，自然 780×1200 ⇒ fit = 0.5（两个方向同时取等 ⇒ 无留白）
    const marks = [{ points: [{ x: 100, y: 50 }] }]
    const out = mapMarksToImageSpace(marks, g())
    expect(out![0]!.points[0]).toEqual({ x: 200, y: 100 })
  })

  it('元素盒有偏移（elRect.left/top）⇒ 从 client 原点正确回映', () => {
    // 内容盒起点 = elRect 中心 − 内容半宽：盒 390×600 @ (10,20)，fit 0.5
    // 内容 390×600 恰好填满 ⇒ 内容左上 = (10,20)；client(110,120) ⇒ natural(200,200)
    const out = mapMarksToImageSpace(
      [{ points: [{ x: 110, y: 120 }] }],
      g({ elRect: { left: 10, top: 20, width: 390, height: 600 } }),
    )
    expect(out![0]!.points[0]).toEqual({ x: 200, y: 200 })
  })

  it('W-5 zoom（transform scale）⇒ getBoundingClientRect 已含缩放，映射不二次放大', () => {
    // zoom 2x：rect.width = 390×2 = 780；s = 780/390 = 2；fit = 0.5 ⇒ total 1
    // client(100,50) 相对内容盒（780×1200 @ left 0）⇒ natural(100,50)
    const out = mapMarksToImageSpace(
      [{ points: [{ x: 100, y: 50 }] }],
      g({ elRect: { left: 0, top: 0, width: 780, height: 1200 } }),
    )
    expect(out![0]!.points[0]).toEqual({ x: 100, y: 50 })
  })

  it('ink 画布有偏移（rect 非视口原点）⇒ 先还原 client 再映射', () => {
    // inkRect.left=8,top=44；元素盒从 (0,0) 起。client = (8+100, 44+50) = (108,94) ⇒ natural(216,188)
    const out = mapMarksToImageSpace(
      [{ points: [{ x: 100, y: 50 }] }],
      g({ inkRect: { left: 8, top: 44 } }),
    )
    expect(out![0]!.points[0]).toEqual({ x: 216, y: 188 })
  })

  it('多笔多点多保留 mark 结构（id/其余字段透传）', () => {
    const marks = [
      { points: [{ x: 0, y: 0 }] },
      { points: [{ x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 30 }] },
    ]
    const out = mapMarksToImageSpace(marks, g())
    expect(out).toHaveLength(2)
    expect(out![1]!.points).toHaveLength(3)
  })

  it('非法几何（0 尺寸）⇒ null（调用方诚实降级，⛔ 静默错位）', () => {
    expect(mapMarksToImageSpace([{ points: [{ x: 1, y: 1 }] }], g({ elRect: { left: 0, top: 0, width: 0, height: 0 } }))).toBeNull()
    expect(mapMarksToImageSpace([{ points: [{ x: 1, y: 1 }] }], g({ naturalWidth: 0, naturalHeight: 0 }))).toBeNull()
    expect(mapMarksToImageSpace([{ points: [{ x: 1, y: 1 }] }], g({ elWidth: 0, elHeight: 0 }))).toBeNull()
  })
})
