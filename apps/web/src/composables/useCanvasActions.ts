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
            // 2026-10-17 prompt 节点下线：兜底默认值 'prompt' → 'text'
            // （仅对导入 workflow 包缺 nodeType 的脏数据生效；新建路径均显式带类型）。
            type: p.nodeType ?? 'text',
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
    /** 2026-10-20 分组侧车（分组不再是节点，单列一份随画布落库）。 */
    groups?: CanvasData['groups']
    /**
     * SP-C（2026-10-23）视口：可选。
     * ⛔ 不传 ⇒ 产出的对象里**没有这个键**（不是 `viewport: undefined`）——
     *    存量画布 payload 形状零变化，不产生 migration（N1/N2）。
     */
    viewport?: CanvasData['viewport']
  },
): CanvasData {
  const ids = new Set(nodes.map((n) => n.id))
  const data: CanvasData = {
    nodes: nodes.map((n) => ({
      id: n.id,
      // 2026-10-17 prompt 节点下线：兜底默认值 'prompt' → 'text'（见上方 add 路径同款注释）。
      type: (n.type ?? 'text') as CanvasData['nodes'][0]['type'],
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
  // 分组侧车：只在非空时落库（空画布不写空数组，保持旧 payload 形状）。
  if (extras?.groups && extras.groups.length > 0) {
    data.groups = extras.groups
  }
  // SP-C 视口：只在显式传入时写入键本身（不写 viewport: undefined ⇒ N1）
  if (extras?.viewport) {
    data.viewport = extras.viewport
  }
  return data
}

export type CanvasSaveExtras = {
  compositionRunGroup?: CanvasData['compositionRunGroup']
  previousCanvas?: Pick<CanvasData, 'compositionRunGroup'>
  groups?: CanvasData['groups']
  /** SP-C：视口；省略 ⇒ 落库 payload 不含该键（N1）。 */
  viewport?: CanvasData['viewport']
}

/** Prefer in-memory extras; if both are empty, keep a server-side compositionRunGroup. */
export function extrasForCanvasSave(input: {
  current?: CanvasData['compositionRunGroup'] | null
  lastKnown?: CanvasData['compositionRunGroup'] | null
  server?: CanvasData['compositionRunGroup'] | null
  groups?: CanvasData['groups'] | null
  /** SP-C：当前视口；不传 ⇒ extras 不含 viewport（⇒ 落库不写该键，N1）。 */
  viewport?: CanvasData['viewport'] | null
}): CanvasSaveExtras {
  const extras: CanvasSaveExtras = {}
  if (input.current) extras.compositionRunGroup = input.current
  const previous = input.lastKnown ?? input.server ?? undefined
  if (previous) extras.previousCanvas = { compositionRunGroup: previous }
  if (input.groups && input.groups.length > 0) extras.groups = input.groups
  if (input.viewport) extras.viewport = input.viewport
  return extras
}

/**
 * P0-2 等待可见性锚点判定（规格 2026-10-30-propose-confirm-execution-unity §4.3，
 * 唯一判定来源）：
 *
 * - `'part'`：服务端 `waiting_user` 事件收敛的 proposal part 仍 pending（第一真相）
 *   —— 覆盖「update_node{pending_confirm} 随 tool_result 迟到」的整个窗口期
 *   （2026-10-29 生产事故：等待期节点恒 draft ⇒ 确认面 / 磁贴提议内容全部消失）。
 * - `'status'`：节点 status 已是 pending_confirm（服务端状态复制到达后的稳态）。
 * - `'none'`：两者皆无（无等待，不渲染确认面）。
 */
export function deriveProposeConfirmAnchor(
  waitingNodeId: string | null | undefined,
  nodeStatus: unknown,
): 'part' | 'status' | 'none' {
  if (typeof waitingNodeId === 'string' && waitingNodeId) return 'part'
  if (String(nodeStatus ?? '') === 'pending_confirm') return 'status'
  return 'none'
}

/**
 * P0-1 配套（规格 §5.3）：服务端启动的生成（runtime 确认即启动）会把
 * generationRecordId 写上节点 SSOT；前端对该 record 启动轮询的去重判据——
 * 只有「generating + 有 recordId + 不是已在轮询的那条」才需要挂载轮询。
 */
export function shouldStartPolling(
  nodeData: { status?: unknown; generationRecordId?: unknown } | null | undefined,
  activeRecordId: string | null | undefined,
): boolean {
  if (!nodeData) return false
  if (String(nodeData.status ?? '') !== 'generating') return false
  const recordId = typeof nodeData.generationRecordId === 'string' ? nodeData.generationRecordId : ''
  if (!recordId) return false
  return recordId !== activeRecordId
}
