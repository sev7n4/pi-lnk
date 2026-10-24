// SP-C（2026-10-23）：视口恢复 —— 采集（防抖落库）与恢复（clamp + duration 0）。
//
// 这两件事从 CanvasPage.vue 抽出来，是因为它们必须能被「行为级」测到：
// CanvasPage 是个 5000+ 行、依赖 api/store/路由的页面组件，挂载测不现实；
// 把视口的读写收敛到这里之后，测试可以注入假的 setViewport / 落库回调，
// 断言「有没有被调用、参数是什么、调了几次」这三个可观测出口。
//
// 判据映射：N4 节流（防抖窗口内只落库一次）、N5 缩放 clamp、N6 duration: 0 不闪。
import { clampViewport, type CanvasViewport } from '@lnkpi/shared'

/**
 * 归一化 vue-flow 的 viewportChange 载荷。
 * 事件形状按版本可能是 `{ viewport, prevViewport }` 也可能是裸的 `{ x, y, zoom }`，
 * 这里两路都收 —— 不赌事件签名；非法值一律返回 null（fail-open，不落库）。
 */
export function normalizeViewportPayload(payload: unknown): CanvasViewport | null {
  if (!payload || typeof payload !== 'object') return null
  const raw = (payload as { viewport?: unknown }).viewport ?? payload
  return clampViewport(raw)
}

export type ViewportSink = {
  setViewport?: (vp: CanvasViewport, options?: { duration?: number }) => void
}

/**
 * 恢复视口：可用 ⇒ `setViewport(clamp(vp), { duration: 0 })`；脏值 ⇒ 什么都不做。
 * @returns 是否真的恢复了（false 表示调用方应走默认 fitView）
 */
export function createViewportRestorer(sink: () => ViewportSink | null | undefined) {
  return function restoreViewport(vp: unknown): boolean {
    const clamped = clampViewport(vp)
    if (!clamped) return false
    sink()?.setViewport?.(clamped, { duration: 0 })
    return true
  }
}

export type ViewportTrackerOptions = {
  /** 落库回调（防抖窗口结束时触发一次）。 */
  onPersist: () => void
  /** 防抖窗口（ms）。视口是高频事件，绝不能逐事件落库（N4）。 */
  debounceMs?: number
}

/**
 * 视口变化采集：记下最新视口 + 防抖触发一次落库。
 * 连续 N 次变化在窗口内只合并成 1 次 onPersist（N4）；pending 始终是最新的那个视口。
 */
export function createViewportTracker(options: ViewportTrackerOptions) {
  const debounceMs = options.debounceMs ?? 400
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: CanvasViewport | null = null

  function clear() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    get pending(): CanvasViewport | null {
      return pending
    },
    /** 视口变化入口：payload 可以是事件载荷或裸视口。 */
    note(payload: unknown): void {
      const vp = normalizeViewportPayload(payload)
      if (!vp) return
      pending = vp
      clear()
      timer = setTimeout(() => {
        timer = null
        options.onPersist()
      }, debounceMs)
    },
    /** 立即结算未触发的窗口（离开页面 / 手动保存前用），没有待触发则 no-op。 */
    flush(): void {
      if (!timer) return
      clear()
      options.onPersist()
    },
    dispose(): void {
      clear()
      pending = null
    },
  }
}
