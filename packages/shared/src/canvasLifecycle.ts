/**
 * 生成生命周期终态吸收守卫（规格
 * `docs/superpowers/specs/2026-11-04-generation-terminal-projection-design.md` §5.2）。
 *
 * 病灶（2026-11-04 取消刷屏事故）：节点终态（error/completed/failed）可被陈旧
 * 快照 / 迟到 op 回写成 generating——服务端画布节点长时间停在 generating，
 * 前端每次 loadSession / 重挂载都把「generating→error」边重放一遍 ⇒ toast 刷屏。
 *
 * 契约：**吸收态回写 generating 仅当携带不同的新 generationRecordId**（新一轮
 * 生成的合法重置），否则拒绝。双端共用同一纯函数：服务端 `applyCanvasActions`
 * （packages/agent executor）与 web `mergeNodeData`（useCanvasActions）。
 *
 * 注意：`status` 词汇表**不扩**「cancelled」终态——取消由 `errorCode: 'cancelled'`
 * 承载（规格 §5.3 裁决），本守卫只关心单调性。
 */

/** 节点 lifecycle 终态（吸收态）。`failed` 是历史写者（late-notify 旧映射）落过的字面量，一并吸收。 */
export const TERMINAL_NODE_STATUSES = ['completed', 'error', 'failed'] as const

export type TerminalNodeStatus = (typeof TERMINAL_NODE_STATUSES)[number]

export function isTerminalNodeStatus(status: unknown): status is TerminalNodeStatus {
  return (
    typeof status === 'string' &&
    (TERMINAL_NODE_STATUSES as readonly string[]).includes(status)
  )
}

/**
 * 吸收态回写判定（图 4 判据的纯函数化）。
 *
 * 返回 true = 该 update_node 的 data 载荷试图把「已终态」的节点拉回在途态
 * 且没有携带新一轮生成的 recordId ⇒ 调用方必须拒绝这次 data 合并。
 *
 * 表驱动语义：
 * - 入向不是在途态（generating/pending）⇒ false（与吸收无关，按既有白名单走）；
 * - 当前不是终态 ⇒ false；
 * - 当前终态 + 入向在途态：
 *   - 入向带**不同的**新 recordId ⇒ false（合法重置：新一轮生成）；
 *   - 入向无 recordId 或 recordId 相同 ⇒ true（拒绝）。
 */
export function isTerminalRegen(opts: {
  currentStatus?: unknown
  currentRecordId?: unknown
  incomingStatus?: unknown
  incomingRecordId?: unknown
}): boolean {
  const { currentStatus, currentRecordId, incomingStatus, incomingRecordId } = opts
  if (incomingStatus !== 'generating' && incomingStatus !== 'pending') return false
  if (!isTerminalNodeStatus(currentStatus)) return false
  const incomingId =
    typeof incomingRecordId === 'string' && incomingRecordId.trim() ? incomingRecordId.trim() : ''
  // 无 recordId 的在途态回写 = 陈旧快照/重放 ⇒ 拒绝；
  // recordId 与现值相同 = 同一轮生成的重放 ⇒ 拒绝；
  // 只有**不同的新 recordId**（新一轮生成）才放行。
  if (!incomingId) return true
  return String(currentRecordId ?? '') === incomingId
}
