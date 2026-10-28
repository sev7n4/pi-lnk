/**
 * 共享描边渲染（§4.3 一支笔 · 2026-10-28 W-26/W-27 真机修复抽出）。
 *
 * ⭐ **单一样式源**：画笔**实时预览覆盖层**（useInkOverlay）与**合成图**
 *   （composeAnnotatedImage）必须走同一支笔画函数 —— 否则「所见」与「带回」
 *   两套手绘渲染会漂移（本次 bug 的结构性根因之一：两处各自实现，同错同修）。
 *
 * ⭐ **平滑**：中点二次贝塞尔（相邻点中点为曲线端点、中间点为控制点）——
 *   手指采样折线的就地平滑，约 10 行拿到八成观感提升，零第三方依赖。
 *   备选升级路径：vendor `perfect-freehand`（MIT 单文件，压感变宽笔迹），
 *   已记入规格 §4.7.1 —— 仅当真机复测后仍嫌笔迹生硬再引入。
 */

export interface StrokePoint {
  x: number
  y: number
}

export interface StrokeOptions {
  /** 单点（tap）⇒ 实心圆点的半径 */
  dotRadius?: number
  /** 单点圆点填充色 */
  dotFill?: string
}

/**
 * 在 ctx 上画一条标记笔画（不设置 lineWidth/strokeStyle —— 由调用方统一设定，
 * 本函数只负责路径几何：起笔、平滑、收笔、单点退化）。
 */
export function strokeMarkPath(
  ctx: CanvasRenderingContext2D,
  points: StrokePoint[],
  opts?: StrokeOptions,
): void {
  if (!points.length) return
  ctx.beginPath()
  if (points.length === 1) {
    const r = opts?.dotRadius ?? 6
    ctx.arc(points[0]!.x, points[0]!.y, r, 0, Math.PI * 2)
    if (opts?.dotFill) ctx.fillStyle = opts.dotFill
    ctx.fill()
    return
  }
  ctx.moveTo(points[0]!.x, points[0]!.y)
  if (points.length === 2) {
    ctx.lineTo(points[1]!.x, points[1]!.y)
  } else {
    // 中点二次贝塞尔：p0 出发，p[i] 为控制点、mid(p[i], p[i+1]) 为端点，末点直线收笔
    for (let i = 1; i < points.length - 1; i++) {
      const cur = points[i]!
      const next = points[i + 1]!
      ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + next.x) / 2, (cur.y + next.y) / 2)
    }
    const last = points[points.length - 1]!
    ctx.lineTo(last.x, last.y)
  }
  ctx.stroke()
}
