import type { CanvasAction, CanvasData } from '@lnkpi/shared'

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
        newNodes.push({
          id: nodeId,
          type: p.nodeType ?? 'prompt',
          position: pos,
          data: p.data ?? {},
        })

        if (parentNode) {
          newEdges.push({
            id: `e-${parentNode.id}-${nodeId}`,
            source: parentNode.id,
            target: nodeId,
            animated: true,
          })
        }
        break
      }
      case 'update_node': {
        const node = newNodes.find((n) => n.id === action.payload.id)
        if (node) {
          if (action.payload.position) node.position = action.payload.position
          if (action.payload.data) node.data = { ...node.data, ...action.payload.data }
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

export function canvasDataToFlow(data: CanvasData): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return {
    nodes: data.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: n.data,
    })),
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
