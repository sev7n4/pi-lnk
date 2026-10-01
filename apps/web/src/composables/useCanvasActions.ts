import type { CanvasAction, CanvasData } from '@lnkpi/shared'
import { dedupeNodesById } from '@/pages/canvas/canvasNodeMerge'

export interface FlowNode {
  id: string
  type?: string
  position: { x: number; y: number }
  data: Record<string, unknown>
}

export interface FlowEdge {
  id: string
  source: string
  target: string
  animated?: boolean
  style?: Record<string, unknown>
}

let nodeCounter = 0

/**
 * 节点状态降级守卫（2026-10-01）：阻塞 propose 模式下，propose_generation 的
 * tool result（内含 update_node{status:'pending_confirm'}）在等待结束后才随
 * tool_execution_end 下发——此时节点可能已被用户确认进入 generating/completed。
 * stale 的 pending_confirm 一旦覆盖，节点整个剩余回合回退成「待确认」，用户再点
 * 「生成」会误触 cancelGeneration 取消在途生成。规则：本地已处于在途/终态时，
 * 丢弃 stale 的 pending_confirm，其余字段照常合并。
 */
const STALE_BLOCKED_STATUSES = new Set(['generating', 'completed', 'error', 'failed'])

export function mergeNodeData(
  existingData: Record<string, unknown> | undefined,
  incomingData: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged = { ...existingData, ...incomingData }
  const existingStatus = String(existingData?.status ?? '')
  if (
    String(incomingData?.status ?? '') === 'pending_confirm'
    && STALE_BLOCKED_STATUSES.has(existingStatus)
  ) {
    if (existingData && 'status' in existingData) merged.status = existingStatus
    else delete merged.status
  }
  return merged
}

export function applyActionsToFlow(
  nodes: FlowNode[],
  edges: FlowEdge[],
  actions: CanvasAction[],
): { nodes: FlowNode[]; edges: FlowEdge[]; viewport?: { x: number; y: number; zoom: number } } {
  const newNodes = [...nodes]
  const newEdges = [...edges]
  let viewport: { x: number; y: number; zoom: number } | undefined

  for (const action of actions) {
    switch (action.type) {
      case 'add_node': {
        const p = action.payload
        const parentNode = p.parentShotId
          ? newNodes.find((n) => n.id === p.parentShotId)
          : null
        const pos = parentNode
          ? { x: parentNode.position.x + 320, y: parentNode.position.y + 20 }
          : p.position ?? { x: 200, y: 200 }

        const nodeId = p.id ?? `node-${++nodeCounter}`
        // 2026-10-01 修：add_node 必须幂等。画布 SSOT 在前端，SSE 重放把同一条
        // action 再投一次就会 push 出第二条同 id 节点，下一次 saveCanvas 整份
        // 覆盖回 DB 后重复被固化（生产 30/253 画布命中）。
        const existingIndex = newNodes.findIndex((n) => n.id === nodeId)
        if (existingIndex >= 0) {
          const existing = newNodes[existingIndex]!
          existing.position = pos
          existing.data = mergeNodeData(existing.data, p.data)
          if (p.nodeType) existing.type = p.nodeType
        } else {
          newNodes.push({
            id: nodeId,
            type: p.nodeType ?? 'prompt',
            position: pos,
            data: p.data ?? {},
          })
        }

        if (parentNode) {
          const edgeId = `e-${parentNode.id}-${nodeId}`
          if (!newEdges.some((e) => e.id === edgeId)) {
            newEdges.push({
              id: edgeId,
              source: parentNode.id,
              target: nodeId,
              animated: true,
            })
          }
        }
        break
      }
      case 'update_node': {
        const node = newNodes.find((n) => n.id === action.payload.id)
        if (node) {
          if (action.payload.position) node.position = action.payload.position
          if (action.payload.data) node.data = mergeNodeData(node.data, action.payload.data)
        }
        break
      }
      case 'remove_node': {
        const id = action.payload.id!
        const idx = newNodes.findIndex((n) => n.id === id)
        if (idx > -1) newNodes.splice(idx, 1)
        for (let i = newEdges.length - 1; i >= 0; i--) {
          if (newEdges[i].source === id || newEdges[i].target === id) {
            newEdges.splice(i, 1)
          }
        }
        break
      }
      case 'add_edge':
        newEdges.push({
          id: action.payload.id ?? `e-${action.payload.source}-${action.payload.target}`,
          source: action.payload.source!,
          target: action.payload.target!,
          animated: true,
        })
        break
      // 2026-09-29 补：此前 remove_edge / set_viewport 落入无 case 分支被静默丢弃，
      // 与 packages/agent 的 applyCanvasActions 同源缺陷（那侧已同步补分支）。
      case 'remove_edge': {
        const edgeId = action.payload.id
        if (!edgeId) break
        const idx = newEdges.findIndex((e) => e.id === edgeId)
        if (idx > -1) newEdges.splice(idx, 1)
        break
      }
      case 'set_viewport':
        if (action.payload.viewport) viewport = action.payload.viewport
        break
    }
  }

  return { nodes: newNodes, edges: newEdges, viewport }
}

/**
 * 2026-10-01 修：加载画布时按 id 去重，让**存量**重复节点在用户下次打开画布时自愈。
 * 去重策略复用 `dedupeNodesById`（保留首条），避免两处各写一份。
 */
export function canvasDataToFlow(data: CanvasData): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes = dedupeNodesById(data.nodes).map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position,
    data: n.data,
  }))
  return {
    nodes,
    edges: data.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      animated: true,
    })),
  }
}

export function flowToCanvasData(
  nodes: FlowNode[],
  edges: FlowEdge[],
  extras?: {
    compositionRunGroup?: CanvasData['compositionRunGroup']
    previousCanvas?: Pick<CanvasData, 'compositionRunGroup'>
  },
): CanvasData {
  const ids = new Set(nodes.map((n) => n.id))
  const data: CanvasData = {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: (n.type ?? 'prompt') as CanvasData['nodes'][0]['type'],
      position: n.position,
      data: n.data,
    })),
    // 丢弃指向已删除节点的边，避免紫线悬空
    edges: edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
      })),
  }
  const group = extras?.compositionRunGroup ?? extras?.previousCanvas?.compositionRunGroup
  if (group) {
    data.compositionRunGroup = group
  }
  return data
}

export type CanvasSaveExtras = {
  compositionRunGroup?: CanvasData['compositionRunGroup']
  previousCanvas?: Pick<CanvasData, 'compositionRunGroup'>
}

/** Prefer in-memory extras; if both are empty, keep a server-side compositionRunGroup. */
export function extrasForCanvasSave(input: {
  current?: CanvasData['compositionRunGroup'] | null
  lastKnown?: CanvasData['compositionRunGroup'] | null
  server?: CanvasData['compositionRunGroup'] | null
}): CanvasSaveExtras {
  const extras: CanvasSaveExtras = {}
  if (input.current) extras.compositionRunGroup = input.current
  const previous = input.lastKnown ?? input.server ?? undefined
  if (previous) extras.previousCanvas = { compositionRunGroup: previous }
  return extras
}
