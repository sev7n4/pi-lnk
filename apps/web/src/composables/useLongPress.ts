import { onBeforeUnmount, ref } from 'vue'

/**
 * 触屏长按手势（2026-10-19 移动端重构 D-6，与对话页气泡菜单共用的单一实现）。
 *
 * 契约：按住 400ms 且位移 < 10px 且未滚动（touchcancel）⇒ 触发一次；
 * 触发后抑制紧随其后的合成 click（touchend preventDefault + 一次性抑制旗标），
 * 避免「长按出菜单 → 松手又选中节点」双触发。
 *
 * ⚠️ 触屏专用：PC 端右键菜单（contextmenu）不变，本 composable 不挂鼠标事件。
 * ⚠️ 触摸起点在 button/input/a 等可交互元素内时不触发（子控件有自己的点击语义）。
 */
export interface LongPressOptions {
  /** 长按判定时长，默认 400ms */
  delay?: number
  /** 位移容忍，默认 10px（超过视为平移/滚动，取消） */
  moveTolerance?: number
}

export interface LongPressBindings {
  onTouchstart: (event: TouchEvent) => void
  onTouchmove: (event: TouchEvent) => void
  onTouchend: (event: TouchEvent) => void
  onTouchcancel: () => void
}

const INTERACTIVE_SELECTOR = 'button, input, textarea, select, a, [role="button"]'

export function useLongPress(
  callback: (event: TouchEvent) => void,
  options: LongPressOptions = {},
) {
  const delay = options.delay ?? 400
  const moveTolerance = options.moveTolerance ?? 10

  const isPressing = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let startX = 0
  let startY = 0
  /** 长按已触发：touchend 时抑制合成 click，并供宿主 click 处理二次兜底 */
  let triggered = false

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function cancel() {
    clearTimer()
    isPressing.value = false
  }

  function onTouchstart(event: TouchEvent) {
    if (event.touches.length !== 1) {
      // 多指（捏合缩放）不触发长按
      return
    }
    const target = event.target as HTMLElement | null
    if (target?.closest?.(INTERACTIVE_SELECTOR)) {
      // 触摸起点落在可交互子元素上：保留其点击语义，不长按
      return
    }
    triggered = false
    startX = event.touches[0]!.clientX
    startY = event.touches[0]!.clientY
    isPressing.value = true
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      triggered = true
      isPressing.value = false
      callback(event)
    }, delay)
  }

  function onTouchmove(event: TouchEvent) {
    if (timer === null && !isPressing.value) return
    const touch = event.touches[0]
    if (!touch) return
    if (
      Math.abs(touch.clientX - startX) > moveTolerance
      || Math.abs(touch.clientY - startY) > moveTolerance
    ) {
      // 位移超限：用户在做平移/滚动，取消长按
      cancel()
    }
  }

  function onTouchend(event: TouchEvent) {
    const wasTriggered = triggered
    cancel()
    if (wasTriggered) {
      // 抑制长按后合成的 click（规范：touchend preventDefault 后不派发兼容鼠标事件）
      event.preventDefault()
    }
  }

  const bindings: LongPressBindings = {
    onTouchstart,
    onTouchmove,
    onTouchend,
    onTouchcancel: cancel,
  }

  /**
   * 宿主 click 处理入口处调用：若刚刚发生过长按，消费掉这次 click（返回 true）。
   * touchend preventDefault 在个别 WebKit 版本不总抑制 click，这里双保险。
   */
  function consumeSuppression(): boolean {
    if (!triggered) return false
    triggered = false
    return true
  }

  onBeforeUnmount(cancel)

  return { bindings, isPressing, consumeSuppression }
}
