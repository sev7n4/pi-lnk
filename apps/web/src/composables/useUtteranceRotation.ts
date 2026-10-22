/**
 * A1 二期：金句定时轮换。
 *
 * 背景：empty 相 7 条金句 > 4 个展示位，原先偏移只由「相变」驱动
 * （AgentSideRail 的 utteranceRotation watch）⇒ 用户停在同一相时，第 5~7 条
 * 永不露出，等于白写。本 composable 补上「时间」这个驱动维度。
 *
 * 四条守卫（缺一条就出问题）：
 * 1. reduced-motion：系统要求减少动效时**完全不轮换**（不是轮慢）。
 * 2. 聚焦暂停：composer 获得焦点时暂停 —— 用户正在写字，金句在脚下跳会干扰。
 * 3. 池 <= 展示位时不轮换：偏移无意义，且白白触发重渲染。
 * 4. 卸载清理：定时器随组件卸载清除，否则泄漏 + 幽灵状态更新。
 *
 * 设计要点：
 * - 用 `setTimeout` 递归而非 `setInterval`：暂停/恢复时不留「幽灵 tick」。
 * - matchMedia 缺失的宿主（jsdom 单测 / SSR 预渲染）按「不轮换」处理 ——
 *   宁可少一个动效，也不要在无守卫的环境里动起来。
 */
import { onScopeDispose, watch, type Ref } from 'vue'

const REDUCE_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export interface UtteranceRotationOptions {
  /** 轮换偏移（外部持有，本 composable 只负责推进） */
  rotation: Ref<number>
  /** 轮换间隔（ms） */
  intervalMs: number
  /** 当前池的条目数 */
  poolSize: () => number
  /** 展示位数量；池 <= 展示位时轮换无意义 */
  visibleCount: number
  /** 暂停信号（如 composer 聚焦中） */
  paused: Ref<boolean>
}

export function useUtteranceRotation(opts: UtteranceRotationOptions) {
  const { rotation, intervalMs, poolSize, visibleCount, paused } = opts

  let timer: ReturnType<typeof setTimeout> | null = null
  let mql: MediaQueryList | null = null
  let reduceMotion = false
  let stopped = false

  const canMatchMedia = typeof window !== 'undefined' && typeof window.matchMedia === 'function'

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /** 当前是否应当轮换：未停 + 非 reduced-motion + 未暂停 + 池大于展示位 */
  function shouldRotate(): boolean {
    if (stopped) return false
    if (reduceMotion) return false
    if (paused.value) return false
    return poolSize() > visibleCount
  }

  function tick() {
    timer = null
    if (!shouldRotate()) return
    rotation.value += 1
    schedule()
  }

  function schedule() {
    clearTimer()
    if (!shouldRotate()) return
    timer = setTimeout(tick, intervalMs)
  }

  function onReduceMotionChange(e: MediaQueryListEvent) {
    reduceMotion = e.matches
    if (reduceMotion) clearTimer()
    else schedule()
  }

  function start() {
    stopped = false
    if (canMatchMedia) {
      mql = window.matchMedia(REDUCE_MOTION_QUERY)
      reduceMotion = mql.matches
      mql.addEventListener('change', onReduceMotionChange)
    } else {
      // 无 matchMedia 宿主：按「不轮换」处理（保守：宁可不动，不要无守卫地动）
      reduceMotion = true
    }
    schedule()
  }

  function stop() {
    stopped = true
    clearTimer()
    mql?.removeEventListener('change', onReduceMotionChange)
    mql = null
  }

  // 暂停状态变化时即时响应（聚焦/失焦不必等下一个 tick）
  watch(paused, () => {
    if (paused.value) clearTimer()
    else schedule()
  })

  // ⚠️ 用 onScopeDispose 而**不是** onUnmounted：
  // onUnmounted 只在**组件实例**卸载时触发；本 composable 也可能在普通
  // effectScope 里用（单测、非组件宿主）⇒ onUnmounted 不会跑，定时器就泄漏了。
  // onScopeDispose 覆盖两者（组件卸载时其 setup scope 也会被 dispose）。
  onScopeDispose(stop)

  return { start, stop }
}
