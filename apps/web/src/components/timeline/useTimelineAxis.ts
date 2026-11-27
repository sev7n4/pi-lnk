import { computed, ref, type Ref, type ComputedRef, type WritableComputedRef } from 'vue'

/**
 * 时间轴标量坐标系（P2.2）：唯一真相源。
 *
 * 规格 §5.2：pxPerSec 是纯前端 UI 态，不写 op、不写服务端——与 playheadSec 同理。
 * ruler / 视频轨 / A1/A2 音轨 / 播放头必须共享同一个 axis 实例，否则横滑或缩放后刻度与片段会错位。
 *
 * 初值 PX_PER_SEC=24、zoom 0.5~8（规格 §5.2 建议值；待确认项 #2 允许调整）。
 */
export const TIMELINE_BASE_PX_PER_SEC = 24
export const TIMELINE_MIN_ZOOM = 0.5
export const TIMELINE_MAX_ZOOM = 8
/** 吸附阈值（px）：播放头/片段边缘 6px 内对齐，剪映范式。 */
export const TIMELINE_SNAP_PX = 6

export interface TimelineAxis {
  totalSec: Ref<number>
  /** 带 clamp 的双向 computed：外部赋值也夹在 MIN~MAX，避免绕过 zoomIn/Out 的裸写。 */
  zoom: WritableComputedRef<number>
  pxPerSec: ComputedRef<number>
  contentWidth: ComputedRef<number>
  scrollLeft: Ref<number>
  secToPx: (sec: number) => number
  pxToSec: (px: number) => number
  /** 内容坐标（含滚动偏移）→ 秒；供播放头拖动用。 */
  contentXToSec: (contentX: number) => number
  secToContentX: (sec: number) => number
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
  /** 秒值吸附到 edges（秒）中 6px 内最近者；无命中返回原值。 */
  snapSec: (sec: number, edges: number[]) => number
  setScrollLeft: (v: number) => void
}

export interface TimelineAxisOptions {
  totalSec: () => number
  initialZoom?: number
  /** 视口宽度（px）：fit 用它反算 pxPerSec；缺省取 720（PC 浮层宽度）。 */
  viewportWidth?: () => number
}

export function useTimelineAxis(options: TimelineAxisOptions): TimelineAxis {
  const totalSec = ref(Math.max(0, options.totalSec()))
  const _zoom = ref(clampZoom(options.initialZoom ?? 1))
  const zoom = computed({
    get: (): number => _zoom.value,
    set: (z: number) => { _zoom.value = clampZoom(z) },
  })
  const scrollLeft = ref(0)
  const viewportWidth = options.viewportWidth ?? (() => 720)

  const pxPerSec = computed(() => TIMELINE_BASE_PX_PER_SEC * zoom.value)
  const contentWidth = computed(() => Math.max(viewportWidth(), totalSec.value * pxPerSec.value))

  function clampZoom(z: number) {
    return Math.min(TIMELINE_MAX_ZOOM, Math.max(TIMELINE_MIN_ZOOM, z))
  }
  function secToPx(sec: number) { return sec * pxPerSec.value }
  function pxToSec(px: number) { return px / pxPerSec.value }
  // 内容坐标系中的 X 就是 sec*pxPerSec；滚动偏移只影响视口坐标，播放头落在内容层内，
  // 因此 contentXToSec 与 secToPx 互逆（横滑通过 transform 移动内容层，不改坐标映射）。
  function contentXToSec(contentX: number) { return pxToSec(contentX) }
  function secToContentX(sec: number) { return secToPx(sec) }

  function zoomIn() { zoom.value = clampZoom(zoom.value * 1.5) }
  function zoomOut() { zoom.value = clampZoom(zoom.value / 1.5) }
  function fit() {
    const w = viewportWidth()
    if (totalSec.value > 0 && w > 0) {
      zoom.value = clampZoom(w / (totalSec.value * TIMELINE_BASE_PX_PER_SEC))
      scrollLeft.value = 0
    }
  }
  function setScrollLeft(v: number) { scrollLeft.value = Math.max(0, v) }

  function snapSec(sec: number, edges: number[]): number {
    const toleranceSec = TIMELINE_SNAP_PX / pxPerSec.value
    let best = sec
    let bestDist = toleranceSec
    for (const edge of edges) {
      if (!Number.isFinite(edge)) continue
      const d = Math.abs(edge - sec)
      if (d <= bestDist) { best = edge; bestDist = d }
    }
    return best
  }

  return {
    totalSec, zoom, pxPerSec, contentWidth, scrollLeft,
    secToPx, pxToSec, contentXToSec, secToContentX,
    zoomIn, zoomOut, fit, snapSec, setScrollLeft,
  }
}
