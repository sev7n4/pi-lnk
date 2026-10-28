import type { AnnotateMark } from './composeAnnotatedImage'

/**
 * 圈选标记坐标系逆映射（2026-10-28 真机走查反馈②：「标记位置漂移」）。
 *
 * 根因：marks 记录在 **ink 画布的 CSS 屏幕空间**（viewport 像素），而
 * composeAnnotatedImage 按**原图自然尺寸**绘制 —— 中间隔着两层显示变换：
 *   ① `object-fit: contain` 的等比缩放 + 留白（元素盒 ≠ 渲染内容盒）；
 *   ② W-5 双指缩放的 CSS transform（translate + scale）。
 * 不做逆映射 ⇒ 笔迹整体漂移/缩放错位。
 *
 * 逆映射公式（contain + transform 一步到位）：
 *   elRect = el.getBoundingClientRect()   —— 已含 transform 的元素盒
 *   s      = elRect.width / el.offsetWidth —— 总缩放（zoom × 1）
 *   fit    = min(layoutW / naturalW, layoutH / naturalH) —— contain 缩放（布局空间）
 *   内容盒 = 以 elRect 中心为中心、尺寸 (naturalW×fit×s, naturalH×fit×s) 的矩形
 *   natural = (client - 内容盒左上) / (fit × s)
 *
 * 纯函数：输入全是普通几何对象（jsdom 可测）；任何输入不完整 ⇒ 返回 null
 * （调用方诚实降级为纯文字，⛔ 不静默错位 —— 漂移的截图比没有截图更有害）。
 */
export interface MarkSpaceGeometry {
  /** 媒体元素 getBoundingClientRect()（已含 W-5 transform） */
  elRect: { left: number; top: number; width: number; height: number }
  /** 媒体元素布局尺寸（offsetWidth/Height，未含 transform） */
  elWidth: number
  elHeight: number
  /** 底图自然尺寸（img.naturalWidth / video.videoWidth / 画布 w×h） */
  naturalWidth: number
  naturalHeight: number
  /** ink 画布 rect（marks 坐标的参照系 ⇒ 先还原为 client 坐标） */
  inkRect: { left: number; top: number }
}

export function mapMarksToImageSpace(
  marks: AnnotateMark[],
  g: MarkSpaceGeometry,
): AnnotateMark[] | null {
  const { elRect, elWidth, elHeight, naturalWidth, naturalHeight, inkRect } = g
  if (!elRect.width || !elRect.height || !elWidth || !elHeight) return null
  if (!naturalWidth || !naturalHeight) return null

  const s = elRect.width / elWidth
  const fit = Math.min(elWidth / naturalWidth, elHeight / naturalHeight)
  const total = fit * s
  if (!Number.isFinite(total) || total <= 0) return null

  // 内容盒（真实渲染出的图像区域）：中心 = 元素盒中心（transform 围绕中心，中心不动）
  const contentW = naturalWidth * total
  const contentH = naturalHeight * total
  const centerX = elRect.left + elRect.width / 2
  const centerY = elRect.top + elRect.height / 2
  const left = centerX - contentW / 2
  const top = centerY - contentH / 2

  return marks.map((m) => ({
    ...m,
    points: m.points.map((p) => {
      // 画布空间 → client 空间 → 图像自然空间
      const cx = p.x + inkRect.left
      const cy = p.y + inkRect.top
      return {
        x: Math.round((cx - left) / total),
        y: Math.round((cy - top) / total),
      }
    }),
  }))
}
