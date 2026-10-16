/**
 * P1-5：移动端底部裸条三态形态路由（纯模块）。
 *
 * 移动端 composer = 单一裸条（spec §5.2），三态共用同一条 bar，差异只发生在
 * bar 的内嵌草稿内容（ref 芯片 + 文本）与条上方系统层（状态行 / 插话选项）：
 * - idle：空闲条——条内仅 ＋ + 「按住说话 · 点按输入」提示（P1-5.3）
 * - stacked：草稿含 ref 芯片（或生成中带引用）——条内两行：芯片行 + 输入行（P1-5.4）
 * - queued：生成中且无引用——占位「输入消息…加入待发队列」、发送槽位换停止（P1-3.2）
 */
export type MobileBarShape = 'idle' | 'stacked' | 'queued'

export function barShape(input: { hasRefs: boolean; isStreaming: boolean }): MobileBarShape {
  if (input.isStreaming) return input.hasRefs ? 'stacked' : 'queued'
  return input.hasRefs ? 'stacked' : 'idle'
}

/**
 * P1-5.3 条级手势阈值（Task 13 提供 classifyGesture 正式实现前的内联常量）：
 * 按住 ≥300ms 进入 hold（Task 13 接 ASR 录音）；否则视为 tap（切输入态）。
 */
export const COMPOSER_HOLD_MS = 300

/** 条级手势分类：按住时长达阈值 = hold（录音），否则 tap（切输入态）。 */
export function classifyGesture(heldMs: number, thresholdMs = COMPOSER_HOLD_MS): 'tap' | 'hold' {
  return heldMs >= thresholdMs ? 'hold' : 'tap'
}
