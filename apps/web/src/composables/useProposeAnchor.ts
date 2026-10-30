import { useAgentStore } from '@/stores/agent'

/**
 * P0-2 等待可见性（规格 2026-10-30-propose-confirm-execution-unity §4.3）：
 * 该节点是否被 proposal part（服务端 waiting_user 事件收敛的时间线 part，第一真相）
 * 锚定——等待期 `update_node{pending_confirm}` 随 tool_result 迟到、节点 status 恒
 * draft（2026-10-29 生产事故：磁贴提议内容 / 确认面全部消失），part 锚在事件到达
 * 瞬间即可见，不依赖节点状态复制。
 *
 * ⚠️ 安全性：测试环境（jsdom 直 mount，未装 pinia）里 `useAgentStore()` 会抛
 * getActivePinia 错误——这里 catch 后退化为 false，调用方行为与旧版逐字节一致。
 * 展示型组件（MobileNodeTile / CanvasNode* 家族）的「纯 props 契约」由此保住，
 * 不必把 part 锚一路从页面层 prop 钻透（那要动 NodeRenderer 分发与全部桩测试）。
 */
export function isPartAnchoredNode(nodeId: string | null | undefined): boolean {
  if (!nodeId) return false
  try {
    return useAgentStore().pendingProposal?.nodeId === nodeId
  } catch {
    return false
  }
}
