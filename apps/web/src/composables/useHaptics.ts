import { usePreferences } from './usePreferences'

/**
 * 触感反馈（受偏好门控）。
 *
 * 平台真相（务必诚实）：
 * - Android Chrome/WebView：`navigator.vibrate()` 可用 ⇒ 真实震动。
 * - iOS Safari：Apple 至今**不实现** Vibration API ⇒ `navigator.vibrate` 为 `undefined`，
 *   本函数 `?.` 短路 + try/catch，零报错、零副作用（无真实触感）。
 * - 真 iOS Taptic 需原生壳（Capacitor）桥接，列入 §12 后续包，不改本调用面。
 */

const PATTERNS = {
  connectModeEnter: 8,
  connectSuccess: 18,
  connectCancel: 6,
  nodeSelect: 8,
  longPressMenu: 10,
} as const

export type HapticKind = keyof typeof PATTERNS

type VibrateFn = (pattern: number) => boolean

export function useHaptics() {
  const prefs = usePreferences()

  function fire(kind: HapticKind) {
    if (!prefs.value.haptics) return
    const v = (navigator as unknown as { vibrate?: VibrateFn }).vibrate
    if (typeof v !== 'function') return // iOS 等无 API：静默 no-op
    try {
      v.call(navigator, PATTERNS[kind])
    } catch {
      /* 不支持 / 被禁用：静默 */
    }
  }

  return { fire }
}
