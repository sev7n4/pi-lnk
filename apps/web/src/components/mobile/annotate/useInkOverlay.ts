import { nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { strokeMarkPath, type StrokePoint } from './strokePath'
import type { AnnotateMark } from './composeAnnotatedImage'

export interface UseInkOverlayOptions {
  /** 覆盖层 canvas（v-show 常驻 DOM，标注态才可见） */
  canvas: Ref<HTMLCanvasElement | null>
  /** 标注态开关（true = 采集开启；翻转 true 时自动按视口同步 bitmap 尺寸） */
  active: Ref<boolean>
  /** 一笔落定（含单点 tap）——调用方据此弹胶囊（§17-③ 首笔即弹） */
  onStrokeEnd?: (mark: AnnotateMark) => void
}

/** 画笔样式（预览与合成图共用同一组数值，保证所见即所得） */
const INK_LINE_WIDTH = 6
const INK_STROKE = 'rgba(255, 64, 64, 0.92)'
const INK_DOT_FILL = 'rgba(255, 64, 64, 0.18)'
/** DPR 上限：超过 3 的屏（个别安卓）按 3 渲染，防 4K 全屏 bitmap 内存爆量 */
const DPR_CAP = 3

/**
 * 移动端画笔覆盖层共享逻辑（§4.3 一支笔 · 2026-10-28 W-26/W-27 真机修复）。
 *
 * 消费方：`MobileNodeViewer`（查看器批注）。（历史：曾供已退役的 `MobileNodePromptReviewSheet` 使用。）
 * （全文审核层批注）——此前两处各自实现 ~90% 重复，且同犯一个真机 bug：
 *
 * ⭐ **修复 1（根因）：bitmap 尺寸从未设置**。canvas 有 CSS 尺寸与 bitmap 尺寸
 *   两个概念，`<canvas>` 默认 bitmap 仅 300×150；CSS `inset:0` 只拉伸显示盒，
 *   手指坐标（CSS 空间，最高 ~390×844）大多落在 300×150 bitmap 外 ⇒ 中下部
 *   笔画完全不可见、左上角可见部分被非均匀拉伸（横 1.3× / 纵 5.6×）。
 *   现按 CSS 尺寸 × devicePixelRatio（上限 3）设置 bitmap 并统一 `setTransform`，
 *   **坐标空间仍是 CSS 像素** ⇒ marks 契约与合成图坐标完全不变。
 *
 * ⭐ **修复 2：TouchEvent → Pointer Events**（W3C 统一指针标准）：
 *   - `pointerId` 过滤——第一根手指持笔期间第二根手指不接管（多点不误画）；
 *   - `setPointerCapture`——手指滑出覆盖层边界不丢轨迹；
 *   - `getCoalescedEvents`——高频合并采样，快速划动不丢中间点。
 *
 * ⭐ **修复 3：rAF 合并重绘**。此前每个 touchmove 全量 clear + 重画 + 每步
 *   展开新数组（Vue 响应式开销）；现 move 只追加原始点 + 标脏，帧内一次重绘。
 *
 * ⚠️ **jsdom 盲区**（本轮真机教训，记入规格 §4.7.1）：jsdom 的
 *   `getBoundingClientRect` 恒 0、canvas 为假对象 ⇒ bitmap 尺寸 bug 在单测里
 *   完全不可见。单测只能覆盖尺寸换算与事件语义（环境无关断言），**可见性
 *   判据必须真机走查**。
 */
export function useInkOverlay(options: UseInkOverlayOptions) {
  const { canvas, active, onStrokeEnd } = options

  /** 已落定的笔画（一笔 = 一串点；CSS 像素坐标，与合成图同一空间） */
  const marks = ref<AnnotateMark[]>([])

  let activePointerId: number | null = null
  let current: StrokePoint[] = []
  let rafId = 0
  let syncedW = -1
  let syncedH = -1
  let syncedDpr = -1

  function dpr(): number {
    return Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, DPR_CAP)
  }

  /**
   * 按 CSS 尺寸 × DPR 同步 bitmap。只在尺寸真变了才重设（重设会清空 bitmap，
   * 重设后必须全量重绘既有笔迹）。
   */
  function syncSize(): void {
    const el = canvas.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height))
    const r = dpr()
    const bw = Math.max(1, Math.round(w * r))
    const bh = Math.max(1, Math.round(h * r))
    if (bw === syncedW && bh === syncedH && r === syncedDpr && el.width === bw && el.height === bh) {
      return
    }
    el.width = bw
    el.height = bh
    syncedW = bw
    syncedH = bh
    syncedDpr = r
    redraw()
  }

  /** 全量重绘（恒等变换清屏 → DPR 变换下重画全部笔迹 + 当前笔画） */
  function redraw(): void {
    const el = canvas.value
    const ctx = el?.getContext('2d') ?? null
    if (!el || !ctx) return
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, el.width, el.height)
    ctx.restore()
    const r = dpr()
    ctx.setTransform(r, 0, 0, r, 0, 0)
    ctx.lineWidth = INK_LINE_WIDTH
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = INK_STROKE
    for (const m of marks.value) {
      strokeMarkPath(ctx, m.points, { dotRadius: INK_LINE_WIDTH, dotFill: INK_DOT_FILL })
    }
    strokeMarkPath(ctx, current, { dotRadius: INK_LINE_WIDTH, dotFill: INK_DOT_FILL })
  }

  function scheduleRedraw(): void {
    // jsdom（无 pretendToBeVisual）无 rAF ⇒ 直接同步重绘，保测试环境无关
    if (typeof requestAnimationFrame !== 'function') {
      redraw()
      return
    }
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      redraw()
    })
  }

  function toPoint(e: { clientX?: number; clientY?: number }): StrokePoint {
    const rect = canvas.value?.getBoundingClientRect()
    return {
      x: (e.clientX ?? 0) - (rect?.left ?? 0),
      y: (e.clientY ?? 0) - (rect?.top ?? 0),
    }
  }

  function onPointerDown(e: PointerEvent): void {
    if (!active.value) return
    // ⭐ 多点过滤：持笔期间第二根手指不接管（评审 I5 同语义：多点身份跳变不可信）
    if (activePointerId !== null) return
    activePointerId = e.pointerId
    try {
      canvas.value?.setPointerCapture?.(e.pointerId)
    } catch {
      /* jsdom / 旧内核不支持捕获 —— 降级为普通事件流 */
    }
    current = [toPoint(e)]
    scheduleRedraw()
  }

  function onPointerMove(e: PointerEvent): void {
    if (!active.value || activePointerId !== e.pointerId) return
    // getCoalescedEvents：两次 rAF 间的高频采样点合并进本笔（快速划动不丢中间点）
    let evts: PointerEvent[] | null = null
    try {
      evts = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null
    } catch {
      evts = null
    }
    const list = evts && evts.length ? evts : [e]
    for (const ev of list) current.push(toPoint(ev))
    scheduleRedraw()
  }

  function endStroke(e: PointerEvent): void {
    if (activePointerId !== e.pointerId) return
    activePointerId = null
    if (current.length) {
      const mark: AnnotateMark = { points: current }
      marks.value = [...marks.value, mark]
      onStrokeEnd?.(mark)
    }
    current = []
    scheduleRedraw()
  }

  function onPointerUp(e: PointerEvent): void {
    endStroke(e)
  }

  /** 系统接管（来电/通知中心）⇒ 丢弃当前未落定笔画，不清已落定 marks */
  function onPointerCancel(e: PointerEvent): void {
    if (activePointerId !== e.pointerId) return
    activePointerId = null
    current = []
    scheduleRedraw()
  }

  /** 清空全部笔迹（进入/退出标注态时由调用方触发） */
  function reset(): void {
    marks.value = []
    current = []
    activePointerId = null
    scheduleRedraw()
  }

  function onWindowResize(): void {
    if (active.value) syncSize()
  }

  watch(
    active,
    (v) => {
      if (v) {
        // v-show 翻转后布局才生效 ⇒ nextTick 后量尺寸
        void nextTick(() => syncSize())
        window.addEventListener('resize', onWindowResize)
      } else {
        window.removeEventListener('resize', onWindowResize)
      }
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    window.removeEventListener('resize', onWindowResize)
    if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId)
  })

  return {
    marks,
    reset,
    syncSize,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  }
}
