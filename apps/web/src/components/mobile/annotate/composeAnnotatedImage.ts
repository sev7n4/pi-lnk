import { strokeMarkPath } from './strokePath'

/**
 * 标注合成：底图 + 手指标记 → 一张**带标记的整图**（规格 §4.3 / 拍板项 L1）。
 *
 * ⭐ **为什么是「整图」而不是「裁切区域」**：
 *   裁切丢上下文 —— agent 看到一小块图，不知道「这是整图哪里」⇒ 整图带标记保留
 *   全部语境，agent 靠识图能力定位（§4.3 核心判据：agent 要的是「图 + 话」，
 *   不是「图 + 坐标」）。
 *
 * ⭐ **纯函数边界**：**不自行加载图片**（加载需同源化，由调用方负责）⇒
 *   本函数可在 node 环境被单测覆盖（注入 canvas 工厂）。
 */
export interface AnnotateMark {
  points: Array<{ x: number; y: number }>
}

/** 画布工厂（测试可注入 OffscreenCanvas / 桩） */
export type CanvasFactory = (width: number, height: number) => HTMLCanvasElement

const defaultCanvasFactory: CanvasFactory = (width, height) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/**
 * 合成「带标记的整图」。
 *
 * @param base 底图（可为 null —— 此时只画标记，尺寸由 baseWidth/baseHeight 决定）
 * @param baseWidth 底图宽（>0）
 * @param baseHeight 底图高（>0）
 * @param marks 手指标记（每条是一串点）
 * @param createCanvas 画布工厂（默认 `document.createElement('canvas')`）
 */
export function composeAnnotatedImage(
  base: CanvasImageSource | null,
  baseWidth: number,
  baseHeight: number,
  marks: AnnotateMark[],
  createCanvas: CanvasFactory = defaultCanvasFactory,
): HTMLCanvasElement {
  if (!(baseWidth > 0) || !(baseHeight > 0)) throw new Error('底图尺寸非法')
  const canvas = createCanvas(baseWidth, baseHeight)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d 不可用')
  if (base) ctx.drawImage(base as CanvasImageSource, 0, 0, baseWidth, baseHeight)

  // 标记：醒目色画笔（视觉锚点，agent 靠它定位）
  ctx.lineWidth = Math.max(4, Math.round(Math.min(baseWidth, baseHeight) / 120))
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgba(255, 64, 64, 0.92)'
  ctx.fillStyle = 'rgba(255, 64, 64, 0.18)'

  for (const mark of marks) {
    if (!mark.points.length) continue
    // ⭐ 与实时预览共享同一支笔画函数（strokePath.ts）——所见即所得，
    //   含中点贝塞尔平滑（2026-10-28 W-26/W-27 修复；此前两处各自 lineTo 折线）。
    strokeMarkPath(ctx, mark.points, {
      // 单点 = 一个点（tap 一下）⇒ 画成实心圆点（半径随线宽）
      dotRadius: ctx.lineWidth,
      dotFill: 'rgba(255, 64, 64, 0.18)',
    })
  }
  return canvas
}
