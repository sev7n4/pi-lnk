import type { CanvasAction, CanvasData } from '@lnkpi/shared'

/** Apply agent canvas mutations to an in-memory canvas snapshot. */
export function applyCanvasActions(data: CanvasData, actions: CanvasAction[]): CanvasData {
  const result: CanvasData = {
    ...data,
    nodes: [...data.nodes],
    edges: [...data.edges],
  }

  for (const action of actions) {
    switch (action.type) {
      case 'add_node': {
        const p = action.payload
        const parentShot = p.parentShotId
          ? result.nodes.find((n) => n.id === p.parentShotId)
          : null
        const pos = parentShot
          ? { x: parentShot.position.x + 280, y: parentShot.position.y }
          : (p.position ?? { x: 0, y: 0 })
        if (!p.id) break
        // 2026-10-01 修：add_node 必须幂等。同一条 action 被 apply 两次（SSE 重放 /
        // 前端整份覆盖保存）时，旧实现会 push 出第二条同 id 节点，且 update_node
        // 只命中首条 → 两条内容分化（生产 30/253 画布命中）。
        const existingIndex = result.nodes.findIndex((n) => n.id === p.id)
        if (existingIndex >= 0) {
          const existing = result.nodes[existingIndex]!
          existing.position = pos
          existing.data = { ...existing.data, ...(p.data ?? {}) }
          if (p.nodeType) existing.type = p.nodeType as CanvasData['nodes'][0]['type']
        } else {
          result.nodes.push({
            id: p.id,
            type: (p.nodeType ?? 'prompt') as CanvasData['nodes'][0]['type'],
            position: pos,
            data: p.data ?? {},
          })
        }
        if (parentShot) {
          const edgeId = `e-${parentShot.id}-${p.id}`
          if (!result.edges.some((e) => e.id === edgeId)) {
            result.edges.push({ id: edgeId, source: parentShot.id, target: p.id })
          }
        }
        break
      }
      case 'update_node': {
        const node = result.nodes.find((n) => n.id === action.payload.id)
        if (node) {
          if (action.payload.position) node.position = action.payload.position
          if (action.payload.data) node.data = { ...node.data, ...action.payload.data }
        }
        break
      }
      case 'add_edge': {
        const { id, source, target } = action.payload
        if (!id || !source || !target) break
        result.edges.push({ id, source, target })
        break
      }
      // 2026-09-29 补：此前 remove_edge / set_viewport 被静默忽略，导致
      // 「Nest 返回了 action、前端实时改了、但 canvasData 没落库」，
      // 回合末 loadSession() 全量回拉时被删的边会复活。
      case 'remove_edge': {
        const edgeId = action.payload.id
        if (!edgeId) break
        result.edges = result.edges.filter((e) => e.id !== edgeId)
        break
      }
      case 'set_viewport': {
        if (action.payload.viewport) result.viewport = action.payload.viewport
        break
      }
      case 'remove_node':
        result.nodes = result.nodes.filter((n) => n.id !== action.payload.id)
        result.edges = result.edges.filter(
          (e) => e.source !== action.payload.id && e.target !== action.payload.id,
        )
        break
    }
  }

  return result
}
