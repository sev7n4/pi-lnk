import type { AgentTaskItem, AgentTaskProgressState, TaskItemStatus } from './agentTaskProgress'

export type CanvasNodeLike = {
  id: string
  type?: string
  data?: Record<string, unknown> | null
}

/**
 * 画布节点状态 → 任务态映射（W11 口径：**有正据才动**）。
 *
 * 「正据」= url / 文本内容 / 明确的 completed|error|failed|generating 状态值；
 * 无证据返回 item.status 原样（绝不凭空翻 done —— 未确认的 propose 节点
 * （无 status/url）不会被误判）。2026-10-17 起同时被时间线产物回填
 * （AgentSideRail reconcileFromNodes 第二通道）复用，保证两处口径单源。
 */
export function mapNodeStatus(node: CanvasNodeLike, item: AgentTaskItem): TaskItemStatus {
  const data = node.data || {}
  const status = String(data.status || '')
  const url = typeof data.url === 'string' ? data.url : ''
  const content = typeof data.content === 'string' ? data.content.trim() : ''
  const kind = item.kind || node.type || ''

  if (status === 'generating') return 'running'
  if (status === 'fallback_pending') return 'needs_user'
  if (status === 'error' || status === 'failed') return 'failed'
  if (status === 'completed' && (url || (kind === 'text' && content))) return 'done'
  if (kind === 'text' || node.type === 'text') {
    if (content) return 'done'
    if (item.status === 'needs_user') return 'needs_user'
  }
  if (url) return 'done'
  return item.status
}

function findNodeForItem(item: AgentTaskItem, nodes: CanvasNodeLike[]): CanvasNodeLike | undefined {
  if (item.nodeId) {
    const byId = nodes.find((n) => n.id === item.nodeId)
    if (byId) return byId
  }
  const byKey = nodes.find((n) => String(n.data?.manifestKey || '') === item.id)
  if (byKey) return byKey
  return nodes.find((n) => String(n.data?.title || '') === item.title)
}

/** Image/video running|pending|retrying block finish; text needs_user does not. */
export function shouldFinishTaskCard(
  state: AgentTaskProgressState,
  nodes: CanvasNodeLike[],
): boolean {
  if (state.finished) return true
  if (!state.items.length) return false
  for (const item of state.items) {
    const node = findNodeForItem(item, nodes)
    const mapped = node ? mapNodeStatus(node, item) : item.status
    const kind = item.kind || node?.type || ''
    if (kind === 'text' || mapped === 'needs_user' || mapped === 'skipped') continue
    if (mapped === 'running' || mapped === 'pending' || mapped === 'retrying') return false
  }
  // Also block if any image/video node still generating even if not on card
  for (const n of nodes) {
    if (n.type !== 'image' && n.type !== 'video') continue
    if (String(n.data?.status || '') === 'generating') return false
  }
  return true
}

export function reconcileTaskProgress(
  state: AgentTaskProgressState,
  nodes: CanvasNodeLike[],
): AgentTaskProgressState {
  if (!state.items.length) return state
  const items = state.items.map((item) => {
    const node = findNodeForItem(item, nodes)
    if (!node) return item
    // W11: when polling a generation record, canvas/SSE must not override task status.
    if (item.recordId) return item
    return { ...item, status: mapNodeStatus(node, item) }
  })
  return { ...state, items }
}

export function synthesizeSummary(
  state: AgentTaskProgressState,
): NonNullable<AgentTaskProgressState['summary']> {
  let success = 0
  let failed = 0
  let needsUser = 0
  let skipped = 0
  const lines: Array<{ id: string; status: string; title: string; hint?: string }> = []
  for (const it of state.items) {
    if (it.status === 'done') success += 1
    else if (it.status === 'failed') failed += 1
    else if (it.status === 'needs_user') {
      needsUser += 1
      lines.push({
        id: it.id,
        status: 'needs_user',
        title: it.title,
        hint: it.errorHint || '请确认或到节点处理',
      })
    } else if (it.status === 'skipped') skipped += 1
  }
  return { success, failed, needsUser, skipped, lines }
}

/** 画布对账回填的归属源最小结构切片（AgentMessage，避免引入 store 类型依赖）。 */
export interface BackfillOwnableMessage {
  role: string
  timeline?: {
    parts: ReadonlyArray<{ kind: string; nodeId?: string }>
    pendingNodeMeta?: Record<string, unknown>
  } | null
}

/**
 * 回填归属集（2026-11-05 真机修复 Q1）：时间线已持有 artifact 的 nodeId +
 * 已暂存 pendingNodeMeta 的 nodeId。
 *
 * 为什么必须认 meta：文本/HTML 产物（P1-D 自动审批）没有 waiting_user 确认点，
 * 完成通报只入 followUp 不派 node_status ⇒ deferred 建卡机制下永远建不出
 * artifact part；若归属集只认已有 part，画布对账回填会静默跳过它们——
 * 这正是文本产物不进交付条的根因。W11「有正据才动」不破：收集归属≠判 done，
 * probe 仍要求 content/url 证据（mapNodeStatus）。
 */
export function collectBackfillOwnableNodeIds(
  messages: readonly BackfillOwnableMessage[],
): Set<string> {
  const owned = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.timeline) continue
    for (const p of m.timeline.parts) {
      if (p.kind === 'artifact' && p.nodeId) owned.add(p.nodeId)
    }
    for (const nodeId of Object.keys(m.timeline.pendingNodeMeta ?? {})) owned.add(nodeId)
  }
  return owned
}
