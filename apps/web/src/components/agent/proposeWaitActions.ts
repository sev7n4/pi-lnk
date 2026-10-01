/**
 * 阻塞等待 propose 琥珀卡的动作守卫（纯函数，2026-10-01）。
 *
 * 取消语义：琥珀卡「取消」= 拒绝该节点的生成提议（clear-propose → 节点回 draft，
 * runtime draft 稳定性轮询判 rejected → run 恢复继续对话），绝不是中止整个 run
 * —— 后者是 composer「停止」按钮的语义。
 */

export type ProposeWaitLike = { toolName?: string; nodeId?: string } | null

/** 取消入口只挂在 propose_generation 等待卡上；无 nodeId 不可取消。 */
export function resolveProposeCancelNodeId(wait: ProposeWaitLike): string | null {
  if (!wait || wait.toolName !== 'propose_generation') return null
  const id = wait.nodeId?.trim()
  return id ? id : null
}
