import type { CanvasAction, CanvasData } from '@lnkpi/shared'

/**
 * 回合终态一致性守卫（2026-11-07 生产事故 `cmw56hqit00nck801povzca3e`）。
 *
 * 事故形态：`upsert_media_node(target_type=text)` 新建了文本节点，但 HTML 正文被
 * `set_node_text` 写进了**上一轮的旧节点**，新建节点留在 `status:draft` + 空 content；
 * assistant 却回复「✅ 已完成！已在画布上新增HTML总结节点」。
 *
 * 本函数只做**观测判据**：从最终画布态里找出「本轮 add_node 的文本节点，收束后仍是
 * draft/无状态且没有正文」的 id 列表。纯静态、零 IO、不改 canvas、不阻断落库；
 * 产物真实落地由 pi-runtime `canvas-id-binding.ts` 的跨轮 id 纠偏保证，这里负责让
 * 「谎报完成」在日志里立刻可见（回归时不再需要人工查库才能发现）。
 *
 * 刻意不检查非本轮节点、媒体节点、已有正文的节点 ⇒ 零假阳性噪声。
 */
export function findUnfilledDraftTextNodes(
  canvas: CanvasData,
  actions: readonly CanvasAction[],
): string[] {
  const created = new Set<string>()
  for (const action of actions) {
    if (action.type !== 'add_node') continue
    const { id, nodeType } = action.payload
    if (!id) continue
    // nodeType 优先；存量路径可能缺省，用 id 前缀兜底（与 add_node 命名约定一致）。
    if (nodeType === 'text' || String(id).startsWith('text-')) created.add(String(id))
  }
  if (created.size === 0) return []

  const unfilled: string[] = []
  for (const node of canvas.nodes) {
    if (!created.has(node.id)) continue
    const data = (node.data ?? {}) as Record<string, unknown>
    const status = typeof data.status === 'string' ? data.status : ''
    const content = typeof data.content === 'string' ? data.content : ''
    // 只有「draft（或状态缺省）且零正文」才算产物未落地。
    if ((status === 'draft' || status === '') && content.trim().length === 0) {
      unfilled.push(node.id)
    }
  }
  return unfilled.sort()
}
