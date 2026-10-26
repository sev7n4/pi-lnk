import { describe, it, expect } from 'vitest'
import { composeAnnotatedImage, type AnnotateMark } from './composeAnnotatedImage'

/**
 * 标注合成（规格 §4.3 / 拍板项 L1）。
 * ⭐ 产出是「**带标记的整图**」—— 不是裁切区域（裁切丢上下文，agent 不知是整图哪里）。
 */
describe('composeAnnotatedImage（整图 + 标记 → 合成）', () => {
  /** 注入 canvas 工厂：断言尺寸与绘制调用，不依赖真实渲染 */
  function stubCanvas() {
    const calls: { op: string; args: unknown[] }[] = []
    const fake = {
      width: 0,
      height: 0,
      getContext: () => ({
        lineWidth: 0,
        lineCap: '',
        lineJoin: '',
        strokeStyle: '',
        fillStyle: '',
        drawImage: (...args: unknown[]) => calls.push({ op: 'drawImage', args }),
        beginPath: () => calls.push({ op: 'beginPath', args: [] }),
        moveTo: (...args: unknown[]) => calls.push({ op: 'moveTo', args }),
        lineTo: (...args: unknown[]) => calls.push({ op: 'lineTo', args }),
        stroke: () => calls.push({ op: 'stroke', args: [] }),
        arc: (...args: unknown[]) => calls.push({ op: 'arc', args }),
        fill: () => calls.push({ op: 'fill', args: [] }),
      }),
    }
    return {
      calls,
      factory: (w: number, h: number) => {
        fake.width = w
        fake.height = h
        return fake as unknown as HTMLCanvasElement
      },
    }
  }

  it('尺寸非法 ⇒ 抛错（⛔ 不静默出空图）', () => {
    const { factory } = stubCanvas()
    expect(() => composeAnnotatedImage(null, 0, 100, [], factory)).toThrow()
    expect(() => composeAnnotatedImage(null, 100, 0, [], factory)).toThrow()
    expect(() => composeAnnotatedImage(null, -1, 100, [], factory)).toThrow()
  })

  it('canvas 2d 不可用 ⇒ 抛错', () => {
    const factory = (w: number, h: number) =>
      ({ width: w, height: h, getContext: () => null }) as unknown as HTMLCanvasElement
    expect(() => composeAnnotatedImage(null, 10, 10, [], factory)).toThrow()
  })

  it('底图被绘制到 (0,0) 且铺满目标尺寸（整图，不是裁切）', () => {
    const { calls, factory } = stubCanvas()
    const base = {} as unknown as CanvasImageSource
    composeAnnotatedImage(base, 320, 240, [], factory)
    const draw = calls.find((c) => c.op === 'drawImage')
    expect(draw).toBeTruthy()
    expect(draw!.args).toEqual([base, 0, 0, 320, 240])
  })

  it('多点标记 ⇒ 画一条折线（moveTo + lineTo… + stroke）', () => {
    const { calls, factory } = stubCanvas()
    const marks: AnnotateMark[] = [{ points: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }] }]
    composeAnnotatedImage(null, 100, 100, marks, factory)
    expect(calls.filter((c) => c.op === 'moveTo')).toHaveLength(1)
    expect(calls.filter((c) => c.op === 'lineTo')).toHaveLength(2)
    expect(calls.filter((c) => c.op === 'stroke')).toHaveLength(1)
  })

  it('单点标记 ⇒ 画实心圆点（arc + fill），不是零长度折线', () => {
    const { calls, factory } = stubCanvas()
    composeAnnotatedImage(null, 100, 100, [{ points: [{ x: 7, y: 8 }] }], factory)
    expect(calls.filter((c) => c.op === 'arc')).toHaveLength(1)
    expect(calls.filter((c) => c.op === 'fill')).toHaveLength(1)
    expect(calls.filter((c) => c.op === 'stroke')).toHaveLength(0)
  })

  it('⭐ 底图为空（null）⇒ 降级：只画标记、**不**画底图（§8 单测要点「底图为空的降级」）', () => {
    const { calls, factory } = stubCanvas()
    // 底图取不到（跨域无 CORS / 视频无帧）⇒ 调用方传 null
    composeAnnotatedImage(null, 100, 100, [{ points: [{ x: 5, y: 6 }] }], factory)
    // ⛔ 不得调用 drawImage（没有底图可画）⇒ 断言「不造假」
    expect(calls.filter((c) => c.op === 'drawImage')).toHaveLength(0)
    // ✅ 但标记仍要画出来（否则等于静默丢标记）
    expect(calls.filter((c) => c.op === 'arc')).toHaveLength(1)
    expect(calls.filter((c) => c.op === 'fill')).toHaveLength(1)
  })

  it('空 marks ⇒ 只画底图，不报错', () => {
    const { calls, factory } = stubCanvas()
    expect(() => composeAnnotatedImage(null, 100, 100, [], factory)).not.toThrow()
    expect(calls.filter((c) => c.op === 'stroke')).toHaveLength(0)
  })
})
