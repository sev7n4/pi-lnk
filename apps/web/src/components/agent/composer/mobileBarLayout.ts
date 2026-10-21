/**
 * P1-5：移动端底部裸条三态形态路由（纯模块）。
 *
 * 移动端 composer = 单一裸条（spec §5.2），三态共用同一条 bar，差异只发生在
 * bar 的内嵌草稿内容（ref 芯片 + 文本）与条上方系统层（状态行 / 插话选项）：
 * - idle：空闲条——条内仅 ＋ + 「点按输入」提示（P1-5.3）
 * - stacked：草稿含 ref 芯片（或生成中带引用）——条内两行：芯片行 + 输入行（P1-5.4）
 * - queued：生成中且无引用——占位「输入消息…加入待发队列」、发送槽位换停止（P1-3.2）
 */
export type MobileBarShape = 'idle' | 'stacked' | 'queued'

export function barShape(input: { hasRefs: boolean; isStreaming: boolean }): MobileBarShape {
  if (input.isStreaming) return input.hasRefs ? 'stacked' : 'queued'
  return input.hasRefs ? 'stacked' : 'idle'
}

/* 条级手势分类已上收至 ./holdGesture（Task 13 单一来源：HOLD_MS / CANCEL_SWIPE_PX /
 * classifyGesture），本模块只保留 bar 形态路由。 */
