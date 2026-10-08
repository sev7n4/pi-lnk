/** Product visual v2 presentation envelope (runtime SSE / thread-state). */

export interface AgentPresentationStepper {
  current: string
  completed: string[]
}

export interface AgentPresentationPrimaryAction {
  label: string
  message: string
  disabled?: boolean
}

export interface MacroSchemeCardBody {
  id: string
  label?: string
  summary?: string
  tags?: string[]
  recommended?: boolean
  recommend_reason?: string | null
}

export interface TopoCardNode {
  key: string
  title: string
  category: string
  depends_on_labels?: string[]
  node_id?: string
}

export interface ShotTableRow {
  shot_id: string
  label: string
  type: string
  summary?: string
  node_id?: string | null
}

export interface DeliverySummaryFinalizedRow {
  title: string
  macro?: string
  node_id?: string
  shot_id?: string
}

export interface DeliverySummaryBasicsRow {
  title: string
  node_id?: string
  optional?: boolean
}

export interface DeliveryCardCandidate {
  variant_key: string
  url?: string | null
  title?: string | null
  recommended?: boolean
}

export interface DeliveryCardGroup {
  label: string
  subtitle?: string
  shot_id: string
  recommended?: boolean
  selected_variant_key?: string | null
  candidates: DeliveryCardCandidate[]
}

export interface AgentPresentationBody {
  /**
   * 🔀 `node_graph` 结构化载荷（2026-07）。
   *
   * ⚠️ **做成可选字段而不是联合类型**：试过 `body?: AgentPresentationBody | NodeGraphBodyPayload`，
   * 会让**所有**下游 `body.text` / `body.schemes` / `body.svg` 访问变成 TS2339（实测 16 处）。
   * 可选字段零影响，且与 `svg` 现有做法一致（svg 也是这么塞的）。
   */
  // ⚠️ 字段名带 `graph_` 前缀：`nodes` / `edges` **已被占用**
  //   （`nodes?: TopoCardNode[]` 是另一套「拓扑卡片」语义，`edges` 同理）⇒ 占用会TS2300。
  graph_nodes?: NodeGraphBodyPayload['nodes']
  graph_edges?: NodeGraphBodyPayload['edges']
  graph_droppedNodeIds?: string[]
  graph_totalNodeCount?: number
  /** 与后端 `NodeGraphPayload.title` 对齐。 */
  nodeGraphTitle?: string
  text?: string
  footer_hint?: string
  expected_delivery_count?: number
  hint?: string
  groups?: DeliveryCardGroup[]
  checks?: Array<{ label: string; ok: boolean }>
  /** Vision QA product understanding (product_summary). */
  understanding?: string
  callout?: string
  callout_conflict?: string
  callout_shot_limit?: string
  prose?: string
  schemes?: MacroSchemeCardBody[]
  max_select?: number
  nodes?: TopoCardNode[]
  eta_min?: number
  scene_count?: number
  credits_hint?: string
  mermaid?: string
  /** render_canvas_view 产出：净化前 SVG（spec §4.5）。空串 = 服务端超界整块丢弃，
   *  前端须走有可见文案的 `<pre>` 占位，不可与「解析失败」混为一谈。 */
  svg?: string
  annotations?: Array<{ nodeId: string; text: string; severity: 'info' | 'warn' }>
  shots?: ShotTableRow[]
  headline?: string
  finalized?: DeliverySummaryFinalizedRow[]
  basics?: DeliverySummaryBasicsRow[]
  basics_section_title?: string
}

/**
 * `node_graph` 载荷体（2026-07）。
 *
 * ⚠️ 字段名与后端 `services/pi-runtime/src/tools/types-node-graph.ts` **一一对应**，
 * 单方面改会造成「前端静默渲染空图」（不报错，最难查的一类退化）。
 */
export interface NodeGraphBodyPayload {
  /** 与后端 `NodeGraphPayload.title` 对齐。 */
  title?: string
  nodes: Array<{
    id: string
    type?: string
    title?: string
    position?: { x: number; y: number }
    size?: { width: number; height: number }
    groupId?: string
    status?: 'idle' | 'running' | 'failed'
  }>
  edges: Array<{ source: string; target: string; label?: string }>
  droppedNodeIds?: string[]
  totalNodeCount?: number
}

export interface AgentPresentationEnvelope {
  kind: string
  stepper: AgentPresentationStepper
  context_recap?: string
  title?: string
  body?: AgentPresentationBody
  primary_action?: AgentPresentationPrimaryAction
  secondary_actions?: AgentPresentationPrimaryAction[]
  options?: Array<{ id: string; label: string; message: string }>
}

/** 九步展示进度条（spec §1）。⚠️ 老 runtime 的 journey_update 已随退役删除，
 *  此表仅服务于 presentation envelope 自带 stepper（AgentStepper / AgentPresentationHost）。 */
export const PRESENTATION_STEPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'image_qa', label: '检查产品图' },
  { id: 'scheme_draft', label: '理解需求 · 出方案' },
  { id: 'macro_select', label: '选宏观风格' },
  { id: 'ssot_persist', label: '方案落盘' },
  { id: 'shot_plan', label: '定构图清单' },
  { id: 'topo_preview', label: '预览出图计划' },
  { id: 'generating', label: '出图中' },
  { id: 'delivery', label: '选定稿' },
  { id: 'done', label: '交付完成' },
]
