/**
 * P2-2（Task 13）：条级/麦克风按住手势分类（纯模块，单一来源）。
 *
 * - tap：点按 < HOLD_MS —— 切输入态（移动条），不触发语音
 * - hold：按住 ≥ HOLD_MS —— 录音/ASR；松开转写填入输入框（不自动提交）
 * - cancel：按住中上滑 ≥ CANCEL_SWIPE_PX —— 丢弃本次录音
 */
export const HOLD_MS = 300
export const CANCEL_SWIPE_PX = 60

export type GestureVerdict = 'tap' | 'hold' | 'cancel'

export function classifyGesture(press: { durationMs: number; dy: number }): GestureVerdict {
  if (press.dy <= -CANCEL_SWIPE_PX) return 'cancel'
  return press.durationMs >= HOLD_MS ? 'hold' : 'tap'
}
