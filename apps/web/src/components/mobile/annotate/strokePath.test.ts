import { describe, it, expect } from 'vitest'
import { strokeMarkPath } from './strokePath'

/**
 * 共享描边（W-26/W-27 修复抽出）：预览覆盖层与合成图共用同一支笔画函数。
 * mock ctx 断言路径几何 —— 环境无关（不依赖真实 canvas 渲染，jsdom / CI canvas 包两态同过）。
 */
describe('strokeMarkPath（共享描边：平滑 + 单点退化）', () => {
  function mockCtx() {
    const calls: { op: string; args: unknown[] }[] = []
    const ctx = {
      beginPath: () => calls.push({ op: 'beginPath', args: [] }),
      moveTo: (...args: unknown[]) => calls.push({ op: 'moveTo', args }),
      lineTo: (...args: unknown[]) => calls.push({ op: 'lineTo', args }),
      quadraticCurveTo: (...args: unknown[]) => calls.push({ op: 'quadraticCurveTo', args }),
      stroke: () => calls.push({ op: 'stroke', args: [] }),
      arc: (...args: unknown[]) => calls.push({ op: 'arc', args }),
      fill: () => calls.push({ op: 'fill', args: [] }),
      fillStyle: '' as string,
    }
    return { calls, ctx: ctx as unknown as CanvasRenderingContext2D }
  }

  it('空点集 ⇒ 不落任何路径调用', () => {
    const { calls, ctx } = mockCtx()
    strokeMarkPath(ctx, [])
    expect(calls).toHaveLength(0)
  })

  it('单点 ⇒ arc + fill 实心圆点（不 stroke）', () => {
    const { calls, ctx } = mockCtx()
    strokeMarkPath(ctx, [{ x: 7, y: 8 }], { dotRadius: 6, dotFill: 'rgba(255,64,64,0.18)' })
    expect(calls.filter((c) => c.op === 'arc')).toHaveLength(1)
    expect(calls.filter((c) => c.op === 'fill')).toHaveLength(1)
    expect(calls.filter((c) => c.op === 'stroke')).toHaveLength(0)
    expect(ctx.fillStyle).toBe('rgba(255,64,64,0.18)')
  })

  it('两点 ⇒ 直线（moveTo + lineTo + stroke），不引入贝塞尔', () => {
    const { calls, ctx } = mockCtx()
    strokeMarkPath(ctx, [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ])
    expect(calls.filter((c) => c.op === 'moveTo')).toHaveLength(1)
    expect(calls.filter((c) => c.op === 'lineTo')).toHaveLength(1)
    expect(calls.filter((c) => c.op === 'quadraticCurveTo')).toHaveLength(0)
    expect(calls.filter((c) => c.op === 'stroke')).toHaveLength(1)
  })

  it('⭐ ≥3 点 ⇒ 中点二次贝塞尔平滑：控制点 = 中间点，端点 = 相邻中点，末点 lineTo 收笔', () => {
    const { calls, ctx } = mockCtx()
    strokeMarkPath(ctx, [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 0 },
      { x: 30, y: 10 },
    ])
    expect(calls.filter((c) => c.op === 'moveTo')).toHaveLength(1)
    const quads = calls.filter((c) => c.op === 'quadraticCurveTo')
    expect(quads).toHaveLength(2) // n−2
    // 第一段：控制点 p1=(10,10)，端点 = mid(p1,p2) = (15,5)
    expect(quads[0]!.args).toEqual([10, 10, 15, 5])
    // 第二段：控制点 p2=(20,0)，端点 = mid(p2,p3) = (25,5)
    expect(quads[1]!.args).toEqual([20, 0, 25, 5])
    // 末点直线收笔 + 单次 stroke
    expect(calls.filter((c) => c.op === 'lineTo')).toHaveLength(1)
    expect(calls.filter((c) => c.op === 'stroke')).toHaveLength(1)
  })
})
