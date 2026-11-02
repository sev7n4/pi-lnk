/**
 * P1-C C1b：canvasDiff——整份 PUT 通往 ops PATCH 的纯函数桥（规格
 * 2026-11-02-p1c-write-path-governance-design §3.2）。
 *
 * 输入 lastSavedSnapshot（每次成功保存后重建）+ 当前画布，输出 ops[]：
 * - 节点按 id 分桶：新增=add_node、删除=remove_node、存活=逐字段 diff。
 * - 存活节点：position 浅比较；data 键级浅比较，**仅提交变化键**（服务端
 *   applyCanvasActions 的 update_node 是键级 merge，未提交键原样保留）。
 * - 客户端白名单外键（服务端五键）的变化直接丢弃并计数——patch 语义下客户端
 *   根本不该持有它们的「改动」（status 由 Nest 生成链路推进；与 B2 ratchet 同一纪律）。
 * - 空差异 ⇒ ops=[] ⇒ 上层零请求（消灭「无变更也 PUT」的历史浪费面）。
 *
 * 已知边界（规格 §3.2 口径内）：
 * - node.type 变更不产生 diff（update_node 无 nodeType 通道；前端不提供该操作）。
 * - data 键「有→无」以 null 下发覆盖（JSON 传输无法表达 undefined 删除；
 *   服务端 merge 后该键值为 null，对可空字段等价）。
 * - 边按 id 分桶；端点变更 = remove_edge + add_edge。
 * - viewport 变化 = set_viewport op（executor 原生第 6 类 op；白名单放行）。
 * - groups / compositionRunGroup 变化 = set_groups / set_composition_run_group op
 *   （P1-C C2a 补的侧车通道；全量替换语义——侧车小而整体，无元素级 diff 必要）。
 * - sidecarChanged 旗标退役：C1 过渡期的 PUT 回退分支已无存在必要。
 */
import type { CanvasAction, CanvasData } from '@lnkpi/shared'

/** 服务端专属键（与 sessions-canvas-patch.ts CLIENT_FORBIDDEN_NODE_DATA_KEYS 同名单——两份常量，勿漂移）。 */
export const CLIENT_FORBIDDEN_NODE_DATA_KEYS: ReadonlySet<string> = new Set([
  'status',
  'generationRecordId',
  'generationStartedAt',
  'errorMessage',
  'proposalEpoch',
])

interface DiffNode {
  id: string
  type?: string
  position?: { x: number; y: number }
  data?: Record<string, unknown>
}

export interface CanvasDiffResult {
  ops: CanvasAction[]
  /** 被丢弃的白名单外键变化数（测试断言 + 观测面）。 */
  droppedKeys: number
  /**
   * 画布级侧车（groups / compositionRunGroup）发生变化。
   * ⭐ C2a 起侧车变化已 op 化（set_groups / set_composition_run_group 进 ops），
   * 本旗标仅保留作观测/断言面，调用方**不再**据此回退 PUT。
   */
  sidecarChanged: boolean
}

function samePosition(a: { x: number; y: number } | undefined, b: { x: number; y: number } | undefined) {
  return a?.x === b?.x && a?.y === b?.y
}

function indexNodes(data: CanvasData | null | undefined): Map<string, DiffNode> {
  const map = new Map<string, DiffNode>()
  const nodes = data && Array.isArray(data.nodes) ? data.nodes : []
  for (const node of nodes) {
    if (node && typeof node.id === 'string') map.set(node.id, node as DiffNode)
  }
  return map
}

function indexEdges(data: CanvasData | null | undefined): Map<string, { id: string; source: string; target: string }> {
  const map = new Map<string, { id: string; source: string; target: string }>()
  const edges = data && Array.isArray(data.edges) ? data.edges : []
  for (const edge of edges) {
    if (edge && typeof edge.id === 'string') map.set(edge.id, edge as { id: string; source: string; target: string })
  }
  return map
}

/**
 * 差异化两份画布。lastSaved 为 null（首存）⇒ 全量 add_node/add_edge。
 * viewport 变化 ⇒ set_viewport op（executor 原生支持；无法表达「删除视口键」，
 * current 无 viewport 时不产生 op——视口键留在服务端旧值，可接受）。
 * groups 变化 ⇒ set_groups（全量替换，清空=[]）；compositionRunGroup 变化 ⇒
 * set_composition_run_group（null=清除，可表达删除）。
 */
export function diffCanvasData(
  lastSaved: CanvasData | null | undefined,
  current: CanvasData | null | undefined,
): CanvasDiffResult {
  const ops: CanvasAction[] = []
  let droppedKeys = 0
  const savedNodes = indexNodes(lastSaved)
  const curNodes = indexNodes(current)

  // 删除（saved 有、current 无）
  for (const [id] of savedNodes) {
    if (!curNodes.has(id)) ops.push({ type: 'remove_node', payload: { id } } as CanvasAction)
  }
  // 新增（current 有、saved 无）
  for (const [id, node] of curNodes) {
    if (savedNodes.has(id)) continue
    ops.push({
      type: 'add_node',
      payload: { id, nodeType: node.type, position: node.position ?? { x: 0, y: 0 }, data: node.data ?? {} },
    } as CanvasAction)
  }
  // 存活：逐字段 diff
  for (const [id, cur] of curNodes) {
    const saved = savedNodes.get(id)
    if (!saved) continue
    const dataChanges: Record<string, unknown> = {}
    const savedData = saved.data ?? {}
    const curData = cur.data ?? {}
    // saved 独有键 ⇒ null 覆盖（见文件头边界说明）
    for (const key of Object.keys(savedData)) {
      if (key in curData) continue
      if (CLIENT_FORBIDDEN_NODE_DATA_KEYS.has(key)) {
        droppedKeys += 1
        continue
      }
      dataChanges[key] = null
    }
    // current 侧键：值变化才提交
    for (const [key, value] of Object.entries(curData)) {
      if (CLIENT_FORBIDDEN_NODE_DATA_KEYS.has(key)) {
        if (savedData[key] !== value) droppedKeys += 1
        continue
      }
      if (savedData[key] !== value) dataChanges[key] = value
    }
    const positionChanged = !samePosition(saved.position, cur.position)
    if (!positionChanged && Object.keys(dataChanges).length === 0) continue
    ops.push({
      type: 'update_node',
      payload: {
        id,
        ...(positionChanged && cur.position ? { position: cur.position } : {}),
        ...(Object.keys(dataChanges).length > 0 ? { data: dataChanges } : {}),
      },
    } as CanvasAction)
  }

  // 边
  const savedEdges = indexEdges(lastSaved)
  const curEdges = indexEdges(current)
  for (const [id, edge] of curEdges) {
    const saved = savedEdges.get(id)
    if (!saved) {
      ops.push({ type: 'add_edge', payload: { id, source: edge.source, target: edge.target } } as CanvasAction)
      continue
    }
    if (saved.source !== edge.source || saved.target !== edge.target) {
      ops.push({ type: 'remove_edge', payload: { id } } as CanvasAction)
      ops.push({ type: 'add_edge', payload: { id, source: edge.source, target: edge.target } } as CanvasAction)
    }
  }
  for (const [id] of savedEdges) {
    if (!curEdges.has(id)) ops.push({ type: 'remove_edge', payload: { id } } as CanvasAction)
  }

  // 视口（SP-C）：变化 ⇒ set_viewport（executor 原生 op）。
  const savedViewport = (lastSaved ?? null)?.viewport
  const curViewport = (current ?? null)?.viewport
  if (curViewport && (savedViewport?.x !== curViewport.x || savedViewport?.y !== curViewport.y || savedViewport?.zoom !== curViewport.zoom)) {
    ops.push({ type: 'set_viewport', payload: { viewport: curViewport } } as CanvasAction)
  }

  // 画布级侧车（C2a）：变化 ⇒ 对应 op（全量替换），旗标仅作观测面。
  const savedAny = lastSaved ?? null
  const curAny = current ?? null
  const groupsChanged =
    JSON.stringify(savedAny?.groups ?? null) !== JSON.stringify(curAny?.groups ?? null)
  const runGroupChanged =
    JSON.stringify(savedAny?.compositionRunGroup ?? null) !==
    JSON.stringify(curAny?.compositionRunGroup ?? null)
  if (groupsChanged && curAny) {
    // 清空 = 空数组（统一「设置」语义，消费方 ?? [] 等价于无组）。
    ops.push({ type: 'set_groups', payload: { groups: curAny.groups ?? [] } } as CanvasAction)
  }
  if (runGroupChanged && curAny) {
    // null = 清除（applier 落 undefined 删键——比 viewport 多出的删除表达力）。
    ops.push({
      type: 'set_composition_run_group',
      payload: { compositionRunGroup: curAny.compositionRunGroup ?? null },
    } as CanvasAction)
  }
  const sidecarChanged = groupsChanged || runGroupChanged

  return { ops, droppedKeys, sidecarChanged }
}
