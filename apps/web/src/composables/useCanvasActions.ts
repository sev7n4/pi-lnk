import type { CanvasAction, CanvasData, NodeType } from '@lnkpi/shared'
import { applyCanvasActions, mergeNodeData } from '@lnkpi/shared'
import { dedupeNodesById } from '@/pages/canvas/canvasNodeMerge'

/** 重新导出共享 SSOT 的 mergeNodeData（历史 web 测试直接从此模块导入）。 */
export { mergeNodeData }

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

/**
 * 把 agent 下发的画布动作落地到 VueFlow 的 Flow 结构。
 *
 * Phase 5 收敛：委托 `@lnkpi/shared` 的 `applyCanvasActions`（唯一 SSOT），仅在此做
 * Flow ⇄ CanvasData 的投影适配——既存节点/边沿用原对象（保留 selected / dragging /
 * animated / style 等 VueFlow 运行时字段），新建边补 `animated:true`（VueFlow 渲染需要）。
 * 侧车（groups / compositionRunGroup）不走实时通道，故此处只透出 {nodes, edges, viewport}。
 */
export function applyActionsToFlow(
  nodes: FlowNode[],
  edges: FlowEdge[],
  actions: CanvasAction[],
): { nodes: FlowNode[]; edges: FlowEdge[]; viewport?: { x: number; y: number; zoom: number } } {
  // 投影为 CanvasData（丢弃 VueFlow 运行时字段，SSOT 只关心 {id,type,position,data}）。
  const canvasData: CanvasData = {
    nodes: nodes.map((n) => ({ id: n.id, type: (n.type ?? 'text') as NodeType, position: n.position, data: n.data })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  }
  const next = applyCanvasActions(canvasData, actions)

  // 回投为 Flow：既存对象就地更新（保留额外字段），新对象按 Flow 形状创建。
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const edgeById = new Map(edges.map((e) => [e.id, e]))
  const outNodes: FlowNode[] = next.nodes.map((n) => {
    const orig = nodeById.get(n.id)
    if (orig) {
      orig.type = n.type
      orig.position = n.position
      orig.data = n.data
      return orig
    }
    return { id: n.id, type: n.type, position: n.position, data: n.data }
  })
  const outEdges: FlowEdge[] = next.edges.map((e) => {
    const orig = edgeById.get(e.id)
    if (orig) return orig
    // 新边补 animated:true（与历史 web 行为一致，VueFlow 实时渲染需要）。
    return { id: e.id, source: e.source, target: e.target, animated: true }
  })

  return { nodes: outNodes, edges: outEdges, viewport: next.viewport }
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
  // SP-C 视口：只在显式传入时写入键本身（不写 viewport: undefined ⇒ N1）。
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
