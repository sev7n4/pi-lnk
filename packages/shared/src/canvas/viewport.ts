// SP-C（2026-10-23）：视口恢复 —— 视口原语（可用性判定 + 缩放收敛）。
// 视口是用户的状态：落库前 sanitize、恢复前 clamp，任何脏值都回落「默认 fitView」（fail-open）。
// type-only：CanvasData 定义在 barrel（index.ts），仅类型引用，编译后擦除，不产生运行时循环
import type { CanvasData } from '../index'

/** 视口三值；与 `CanvasData['viewport']` 同源派生，不重复定义（规格 N2）。 */
export type CanvasViewport = NonNullable<CanvasData['viewport']>

/**
 * 缩放合法区间：与 `CanvasPage.zoomViewport` 既有的 clamp
 * （`Math.min(2, Math.max(0.1, zoom * delta))`）逐字对齐，避免恢复出一个
 * 界面上永远滚不到的视口（越界 ⇒ 画面看起来「空白」）。
 */
export const VIEWPORT_ZOOM_MIN = 0.1
export const VIEWPORT_ZOOM_MAX = 2

/**
 * 视口是否可用（三值齐备且为有限数）。
 * 判否一律回落默认 fitView（fail-open）——宁可不恢复，也不恢复出一个错视口。
 */
export function isViewportUsable(vp: unknown): vp is CanvasViewport {
  if (!vp || typeof vp !== 'object') return false
  const v = vp as Record<string, unknown>
  return (
    typeof v.x === 'number' &&
    Number.isFinite(v.x) &&
    typeof v.y === 'number' &&
    Number.isFinite(v.y) &&
    typeof v.zoom === 'number' &&
    Number.isFinite(v.zoom)
  )
}

/**
 * 收敛视口（只动 zoom，x/y 原样保留）；脏值/缺字段 ⇒ null。
 * 返回 null 时调用方应走默认 fitView，不得拿半截视口去 setViewport。
 */
export function clampViewport(vp: unknown): CanvasViewport | null {
  if (!isViewportUsable(vp)) return null
  const zoom = Math.min(VIEWPORT_ZOOM_MAX, Math.max(VIEWPORT_ZOOM_MIN, vp.zoom))
  return { x: vp.x, y: vp.y, zoom }
}
