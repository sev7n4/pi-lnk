/**
 * 阻塞等待 propose 琥珀卡的动作守卫（纯函数，2026-10-01；2026-10-06 扩显式确认）。
 *
 * 取消语义：琥珀卡「取消」= 拒绝该节点的生成提议（clear-propose → 节点回 draft，
 * runtime draft 稳定性轮询判 rejected → run 恢复继续对话），绝不是中止整个 run
 * —— 后者是 composer「停止」按钮的语义。
 *
 * 确认语义（2026-10-06，生产事故 cmus6ha64001dk601lzsymqfa）：
 * 确认/取消都走**显式** /answers（registry answered / decline），不依赖 SSOT 时序
 * 推断 —— 与仓库铁律「状态担保 = 确定性事件」一致。
 *
 * 根治规格（2026-10-28）：等待态单一真相 = 时间线 proposal part，`wait` 入参即
 * `store.pendingProposal`。旧的「等待开始本地同步 pending_confirm + PUT 载荷强制
 * 声明」（shouldSyncProposePending / forcePendingConfirmInPayload）随其 emit
 * （propose-wait-start/end）一并下线——节点 pending_confirm 由服务端 update_node
 * 经 useCanvasActions.mergeNodeData 守卫落位，不再有前端并行镜像。
 */

export type ProposeWaitLike = { toolName?: string; callId?: string | null; nodeId?: string } | null

/** 取消入口只挂在 propose_generation 等待卡上；无 nodeId 不可取消。 */
export function resolveProposeCancelNodeId(wait: ProposeWaitLike): string | null {
  if (!wait || wait.toolName !== 'propose_generation') return null
  const id = wait.nodeId?.trim()
  return id ? id : null
}

/**
 * L1：本节点是否有可显式确认的 propose 等待；有则返回 callId（POST /answers 的依据）。
 *
 * 无等待 / 不是 propose / 等待属于别的节点 / 没有 callId（旧路径）一律 null，
 * 调用方据此退回「画布生成 + 轮询兜底」。
 */
export function resolveProposeConfirmCallId(
  wait: ProposeWaitLike,
  nodeId: string,
): string | null {
  if (!wait || wait.toolName !== 'propose_generation') return null
  if (!nodeId) return null
  if (wait.nodeId && wait.nodeId !== nodeId) return null
  const callId = typeof wait.callId === 'string' ? wait.callId.trim() : ''
  return callId ? callId : null
}

/**
 * 取消的显式信号（2026-10-06，第二处事故修复）：返回本次 propose 等待的 callId，
 * 供 `POST /answers { decision: "decline" }` 把「用户点了取消」变成**确定性事实**。
 *
 * 与 `resolveProposeConfirmCallId` 的唯一差别：不需要 nodeId（取消卡只挂当前等待，
 * 不存在「属于别的节点」的歧义），因此等待未带 nodeId 时同样可用。
 *
 * 不接这根线的后果（生产实证）：取消只写 Nest SSOT（节点回 draft），runtime 靠
 * 「连续两次读到 draft」推断 rejected —— 修误报时只得把文案中性化成「不要断定用户
 * 已取消」，于是用户真按了取消，模型也不知道，还回「请你在画布节点上点一下确认」。
 */
export function resolveProposeCancelCallId(wait: ProposeWaitLike): string | null {
  if (!wait || wait.toolName !== 'propose_generation') return null
  const callId = typeof wait.callId === 'string' ? wait.callId.trim() : ''
  return callId ? callId : null
}
