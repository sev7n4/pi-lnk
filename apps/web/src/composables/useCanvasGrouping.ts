import type { Node } from '@vue-flow/core'
import {
  alignNodes,
  distributeNodes,
  type AlignSixWay,
  type LayoutNode,
  type SnapCandidate,
} from '@lnkpi/shared'

type FlowNode = Node & { dimensions?: { width?: number; height?: number } }

export type { FlowNode }

const NODE_SIZES: Record<string, { w: number; h: number }> = {
  text: { w: 280, h: 160 },
  image: { w: 280, h: 280 },
  // 视频：长边基准 320（尺寸随比例 contain，包络 320×320）
  video: { w: 320, h: 320 },
  audio: { w: 280, h: 140 },
  prompt: { w: 280, h: 120 },
}

export function getNodeSize(node: FlowNode) {
  const type = String(node.type ?? '')
  const fallback = NODE_SIZES[type] ?? { w: 280, h: 160 }
  return {
    w: node.dimensions?.width ?? fallback.w,
    h: node.dimensions?.height ?? fallback.h,
  }
}

export function getAbsolutePosition(node: FlowNode, nodes: FlowNode[]) {
  let x = node.position.x
  let y = node.position.y
  let parentId = node.parentNode
  while (parentId) {
    let parent: FlowNode | null = null
    for (const n of nodes) {
      if (n.id === parentId) {
        parent = n
        break
      }
    }
    if (!parent) break
    x += parent.position.x
    y += parent.position.y
    parentId = parent.parentNode
  }
  return { x, y }
}

/**
 * 松手吸附（2026-10-12 拖拽丝滑化）：拖拽中节点 1:1 跟手（VueFlow 的
 * snap-to-grid 已关），松手时才把「被抓节点」吸附到 grid，其余同批被拖
 * 节点（多选兄弟）平移同一吸附量 —— 相对阵列不变，整批一次性落格。
 *
 * dragStarts 是拖拽开始时的位置快照（id → position），只含 vue-flow 的
 * dragItems：已选父节点的子节点不在其中（它们随父移动、相对坐标不变，
 * 不该被平移）。无吸附量时返回原数组引用（零扰动）。
 */
export function applySnapOnRelease(
  nodes: FlowNode[],
  dragStarts: Map<string, { x: number; y: number }>,
  anchorId: string,
  grid: number,
): FlowNode[] {
  if (!(grid > 0)) return nodes
  const start = dragStarts.get(anchorId)
  const anchor = nodes.find((n) => n.id === anchorId)
  if (!start || !anchor) return nodes
  const round = (v: number) => Math.round(v / grid) * grid
  const shiftX = round(anchor.position.x) - start.x
  const shiftY = round(anchor.position.y) - start.y
  if (shiftX === 0 && shiftY === 0) return nodes
  return nodes.map((n) => {
    const s = dragStarts.get(n.id)
    return s ? { ...n, position: { x: s.x + shiftX, y: s.y + shiftY } } : n
  })
}

// ══════════════════════════════════════════════════════════
// 拖拽智能参考线：候选构造（SP-B T9a）
//
// `computeSnapGuides`（@lnkpi/shared）只跳过 `isSelf`，**从不读 `parentId`**
// ⇒「谁配当吸附目标」的全部判定必须在本层做完。
// ══════════════════════════════════════════════════════════

/** 视口裁剪矩形（flow 坐标）。 */
export interface SnapBounds {
  x: number
  y: number
  w: number
  h: number
}

/** 两个矩形是否相交（贴边也算相交 —— 边界候选仍可能是 8px 内的吸附目标）。 */
function rectsIntersect(a: SnapBounds, b: SnapBounds): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y
}

/**
 * 构造拖拽参考线的吸附候选（box 为 flow 坐标）。
 *
 * 排除规则（本层全责）：
 * 1. **被拖节点自己** —— 它是移动方，不是目标；
 * 2. **被拖节点的父节点** —— 否则分组会跟父分组互吸（框套框）；
 * 3. **被拖节点自己的子节点** —— 它们随组一起移动，是「移动目标」而非吸附目标；
 * 4. **其余一律保留**：⚠️ 被拖节点**没有父节点**时，其他顶层节点必须仍是候选。
 *    （曾经的缺陷：用 `n.parentNode !== dragged.parentNode` 过滤 ⇒ 两侧都是
 *    undefined 时把**所有**顶层候选全丢掉 ⇒ 顶层拖拽静默失去吸附能力。）
 *
 * 候选的 `parentId` = **该候选节点自己的父节点**（`computeSnapGuides` 不读它，
 * 仅供调用方/调试判断层级关系；**不是**被拖节点的父节点）。
 *
 * `opts.bounds`（可选）：只保留与该矩形相交的候选 —— 规格 §9 的性能护栏
 * （大画布不扫描全部节点；调用方按「视口 + 边距」传入）。
 */
/**
 * SP-B 参考线候选（排除规则 + 视口裁剪）。
 *
 * `opts.sizeOf`：SP-B R1（2026-10-23）新增的**实测尺寸注入点**。媒体节点
 * （image/video）真实尺寸随素材比例（16:9 视频 320×180），而 `getNodeSize`
 * 的 NODE_SIZES 兜底是方框包络（320×320）——按兜底算吸附几何，中心/底边
 * 会差 70-140px：节点视觉边没到线就突然被弹回、guide 线悬在节点旁边。
 * 调用方（CanvasPage）把 vue-flow ResizeObserver 实测尺寸经此注入；
 * 缺省仍走 getNodeSize（分组框/文本/音频与实测一致，且测试造数零依赖）。
 */
export function buildSnapCandidates(
  nodes: FlowNode[],
  dragId: string,
  opts?: { bounds?: SnapBounds; sizeOf?: (node: FlowNode) => { w: number; h: number } },
): SnapCandidate[] {
  const dragged = nodes.find((n) => n.id === dragId)
  const parentId = dragged?.parentNode
  const bounds = opts?.bounds
  const sizeOf = opts?.sizeOf ?? getNodeSize
  const out: SnapCandidate[] = []
  for (const n of nodes) {
    if (n.id === dragId) continue // 规则 1
    if (parentId && n.id === parentId) continue // 规则 2
    if (n.parentNode === dragId) continue // 规则 3
    const { w, h } = sizeOf(n)
    const box = { x: n.position.x, y: n.position.y, w, h }
    if (bounds && !rectsIntersect(box, bounds)) continue // 规则 4 之外的性能裁剪
    out.push({ id: n.id, box, parentId: n.parentNode, isSelf: false })
  }
  return out
}

export function layoutNodesInGrid(nodes: FlowNode[], selectedIds: string[], gap = 40): FlowNode[] {
  const selected = new Set(selectedIds)
  const targets: FlowNode[] = []
  for (const n of nodes) {
    if (selected.has(n.id)) targets.push(n)
  }
  if (targets.length < 2) return nodes

  const cols = Math.ceil(Math.sqrt(targets.length))
  let minX = Infinity
  let minY = Infinity
  for (const node of targets) {
    const abs = getAbsolutePosition(node, nodes)
    minX = Math.min(minX, abs.x)
    minY = Math.min(minY, abs.y)
  }

  const next = nodes.map((n) => ({ ...n }))
  let idx = 0
  for (const node of targets) {
    const col = idx % cols
    const row = Math.floor(idx / cols)
    const { w, h } = getNodeSize(node)
    const newAbsX = minX + col * (w + gap)
    const newAbsY = minY + row * (h + gap)

    if (node.parentNode) {
      let parentAbs = { x: 0, y: 0 }
      for (const p of next) {
        if (p.id === node.parentNode) {
          parentAbs = getAbsolutePosition(p, next)
          break
        }
      }
      updateNodePosition(next, node.id, {
        x: newAbsX - parentAbs.x,
        y: newAbsY - parentAbs.y,
      })
    } else {
      updateNodePosition(next, node.id, { x: newAbsX, y: newAbsY })
    }
    idx += 1
  }
  return next
}

function updateNodePosition(nodes: FlowNode[], id: string, pos: { x: number; y: number }) {
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i]?.id === id) {
      nodes[i] = { ...nodes[i]!, position: pos }
      break
    }
  }
}

export type LayoutEdge = { source: string; target: string }

function setAbsolutePosition(
  nodes: FlowNode[],
  node: FlowNode,
  abs: { x: number; y: number },
) {
  if (node.parentNode) {
    let parentAbs = { x: 0, y: 0 }
    for (const p of nodes) {
      if (p.id === node.parentNode) {
        parentAbs = getAbsolutePosition(p, nodes)
        break
      }
    }
    updateNodePosition(nodes, node.id, {
      x: abs.x - parentAbs.x,
      y: abs.y - parentAbs.y,
    })
    return
  }
  updateNodePosition(nodes, node.id, abs)
}

function assignRanks(
  component: string[],
  adj: Map<string, string[]>,
  absById: Map<string, { x: number; y: number }>,
): Map<string, number> {
  const inComp = new Set(component)
  const hasEdge = component.some((id) => (adj.get(id) ?? []).some((t) => inComp.has(t)))
  const rank = new Map<string, number>()

  if (!hasEdge) {
    const ordered = [...component].sort((a, b) => {
      const pa = absById.get(a)!
      const pb = absById.get(b)!
      return pa.x - pb.x || pa.y - pb.y
    })
    ordered.forEach((id, i) => rank.set(id, i))
    return rank
  }

  const indeg = new Map<string, number>()
  for (const id of component) indeg.set(id, 0)
  for (const id of component) {
    for (const t of adj.get(id) ?? []) {
      if (!inComp.has(t)) continue
      indeg.set(t, (indeg.get(t) ?? 0) + 1)
    }
  }

  let layer = 0
  let frontier = component.filter((id) => (indeg.get(id) ?? 0) === 0)
  const placed = new Set<string>()
  while (frontier.length) {
    frontier.sort((a, b) => {
      const pa = absById.get(a)!
      const pb = absById.get(b)!
      return pa.y - pb.y || pa.x - pb.x
    })
    for (const id of frontier) {
      rank.set(id, layer)
      placed.add(id)
    }
    const nextFrontier: string[] = []
    for (const id of frontier) {
      for (const t of adj.get(id) ?? []) {
        if (!inComp.has(t) || placed.has(t)) continue
        const nextDeg = (indeg.get(t) ?? 0) - 1
        indeg.set(t, nextDeg)
        if (nextDeg === 0) nextFrontier.push(t)
      }
    }
    frontier = nextFrontier
    layer += 1
  }

  const leftover = component.filter((id) => !placed.has(id))
  leftover.sort((a, b) => {
    const pa = absById.get(a)!
    const pb = absById.get(b)!
    return pa.x - pb.x || pa.y - pb.y
  })
  leftover.forEach((id, i) => rank.set(id, layer + i))
  return rank
}

/** Layered left-to-right along selected edges; same-rank nodes stack vertically and columns share a vertical center. */
export function layoutNodesAlongEdges(
  nodes: FlowNode[],
  edges: LayoutEdge[],
  selectedIds: string[],
  gap = 40,
): FlowNode[] {
  const selected = new Set(selectedIds)
  const targets: FlowNode[] = []
  for (const n of nodes) {
    if (selected.has(n.id)) targets.push(n)
  }
  if (targets.length < 2) return nodes

  const ids = new Set(targets.map((n) => n.id))
  const adj = new Map<string, string[]>()
  for (const id of ids) adj.set(id, [])
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) continue
    adj.get(edge.source)!.push(edge.target)
  }

  const next = nodes.map((n) => ({ ...n }))
  const absById = new Map<string, { x: number; y: number }>()
  const sizeById = new Map<string, { w: number; h: number }>()
  for (const node of targets) {
    absById.set(node.id, getAbsolutePosition(node, nodes))
    sizeById.set(node.id, getNodeSize(node))
  }

  const component = targets.map((n) => n.id)
  const ranks = assignRanks(component, adj, absById)
  const byRank = new Map<number, string[]>()
  let maxRank = 0
  for (const id of component) {
    const r = ranks.get(id) ?? 0
    maxRank = Math.max(maxRank, r)
    const list = byRank.get(r) ?? []
    list.push(id)
    byRank.set(r, list)
  }
  for (const list of byRank.values()) {
    list.sort((a, b) => {
      const pa = absById.get(a)!
      const pb = absById.get(b)!
      return pa.y - pb.y || pa.x - pb.x
    })
  }

  let minX = Infinity
  let minY = Infinity
  let maxBottom = -Infinity
  let colW = 0
  for (const id of component) {
    const abs = absById.get(id)!
    const size = sizeById.get(id)!
    minX = Math.min(minX, abs.x)
    minY = Math.min(minY, abs.y)
    maxBottom = Math.max(maxBottom, abs.y + size.h)
    colW = Math.max(colW, size.w)
  }

  const colHeights: number[] = []
  for (let r = 0; r <= maxRank; r += 1) {
    const list = byRank.get(r) ?? []
    let h = 0
    list.forEach((id, i) => {
      h += sizeById.get(id)!.h
      if (i > 0) h += gap
    })
    colHeights[r] = h
  }
  const tallest = Math.max(0, ...colHeights)
  const originY = minY + (maxBottom - minY - tallest) / 2

  for (let r = 0; r <= maxRank; r += 1) {
    const list = byRank.get(r) ?? []
    const colH = colHeights[r] ?? 0
    let y = originY + (tallest - colH) / 2
    const x = minX + r * (colW + gap)
    for (const id of list) {
      const node = next.find((n) => n.id === id)
      if (!node) continue
      const size = sizeById.get(id)!
      setAbsolutePosition(next, node, { x, y })
      y += size.h + gap
    }
  }

  return next
}

export type ArrangeMode = 'grid' | 'along_edges' | 'align' | 'distribute'

/** arrange_nodes（agent 工具）与多选工具栏共用的派发参数。 */
export interface ArrangeRequest {
  nodeIds: string[]
  mode: ArrangeMode
  gap?: number
  /** along_edges 的有向边；缺省时退回画布全量边（同手动「顺着连线」）。 */
  edges?: LayoutEdge[]
  /** align 的六向口径（left|centerH|right|top|centerV|bottom），对齐到选中集极值/中线。 */
  alignMode?: AlignSixWay
  /** distribute 的轴（x=水平等距 / y=垂直等距），需 ≥3 个节点才有效果。 */
  axis?: 'x' | 'y'
}

/**
 * 按 mode 派发到既有布局函数，零新建算法。
 * 抽成纯函数是为了可测：CanvasPage 只负责 setNodes + persist + 聚焦。
 *
 * align / distribute 复用 shared 的纯函数（alignNodes / distributeNodes），
 * 它们返回**局部坐标**（已减 parentNode 偏移）⇒ 可直接写回 FlowNode.position。
 *
 * ⚠️ align 缺 alignMode / distribute 缺 axis = **畸形请求 ⇒ no-op**（返回原数组引用），
 * 绝不落 grid 分支：否则「对齐」意图会被静默换成「网格重排」（另一种会搬动所有节点的动作）。
 */
export function applyArrangeLayout(
  nodes: FlowNode[],
  req: ArrangeRequest,
  canvasEdges: LayoutEdge[] = [],
): FlowNode[] {
  const ids = (req?.nodeIds ?? []).filter((id) => typeof id === 'string' && id)
  if (ids.length < 2) return nodes
  const gap = typeof req.gap === 'number' && Number.isFinite(req.gap) ? req.gap : 40
  if (req.mode === 'align') {
    // 缺 alignMode = 畸形请求（规格：align 必带 alignMode）⇒ no-op。
    // ⚠️ 不得落到末尾的 grid 分支：那会把「对齐」意图静默换成「网格重排」。
    if (!req.alignMode) return nodes
    const pos = alignNodes(nodes as unknown as LayoutNode[], ids, req.alignMode)
    return nodes.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n))
  }
  if (req.mode === 'distribute') {
    // 缺 axis 同理：畸形请求 ⇒ no-op（退化 distribute 本身也是 no-op，语义一致）。
    if (!req.axis) return nodes
    const pos = distributeNodes(nodes as unknown as LayoutNode[], ids, req.axis)
    return nodes.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n))
  }
  if (req.mode === 'along_edges') {
    const edges = req.edges?.length ? req.edges : canvasEdges
    return layoutNodesAlongEdges(nodes, edges, ids, gap)
  }
  return layoutNodesInGrid(nodes, ids, gap)
}

export function getSelectionBounds(nodes: FlowNode[], selectedIds: string[]) {
  const frame = getSelectionFrame(nodes, selectedIds)
  if (!frame) return null
  return {
    centerX: frame.centerX,
    bottomY: frame.bottomY,
    connectX: frame.connectX,
    connectY: frame.connectY,
  }
}

export function getSelectionFrame(nodes: FlowNode[], selectedIds: string[]) {
  if (!selectedIds.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const id of selectedIds) {
    for (const node of nodes) {
      if (node.id !== id) continue
      const abs = getAbsolutePosition(node, nodes)
      const { w, h } = getNodeSize(node)
      minX = Math.min(minX, abs.x)
      minY = Math.min(minY, abs.y)
      maxX = Math.max(maxX, abs.x + w)
      maxY = Math.max(maxY, abs.y + h)
    }
  }
  if (!Number.isFinite(minX)) return null
  return {
    minX,
    minY,
    maxX,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    bottomY: maxY + 12,
    connectX: maxX,
    connectY: (minY + maxY) / 2,
  }
}

// ══════════════════════════════════════════════════════════
// 分组（2026-10-20 侧车化）
//
// 分组曾以 `group` 节点承载；现改为 `CanvasData.groups` 侧车 + overlay 渲染：
// - 分组框**不是节点**，不进 node-types、不占节点位、不进 agent 节点白名单；
// - 子节点 position 一律画布绝对坐标（不再有 parentNode 相对语义）；
// - 纯函数全部在此，CanvasPage 只做状态与事件接线。
// ══════════════════════════════════════════════════════════

/** 分组框相对子节点包围盒的留白（与旧 GROUP_PADDING 同值，保持视觉一致）。 */
export const GROUP_PADDING = 80

export type { CanvasGroup } from '@lnkpi/shared'
import type { CanvasGroup } from '@lnkpi/shared'

// ── 运行态分组操作（2026-10-21 分组原生节点形态）────────────────
//
// 分组在工作内存里是 `type:'group'` 的 vue-flow 节点，父子关系靠 parentNode；
// 落库时才折叠回 `CanvasGroup[]`（见 foldGroups）。以下全部是对 nodes 的纯函数。

/** 分组节点的直接子节点。 */
function childrenOf(nodes: FlowNode[], groupId: string): FlowNode[] {
  return nodes.filter((n) => n.parentNode === groupId)
}

/** 清掉一个节点的父子字段并把坐标写成给定的绝对值。 */
function toTopLevel(node: FlowNode, abs: { x: number; y: number }): FlowNode {
  const {
    parentNode: _parentNode,
    extent: _extent,
    expandParent: _expandParent,
    zIndex: _zIndex,
    ...rest
  } = node as FlowNode & { expandParent?: boolean }
  return { ...rest, position: { x: abs.x, y: abs.y } } as FlowNode
}

/**
 * 把一批节点从所属分组里「放出来」（节点本身保留，只是不再归属任何分组）。
 *
 * 分组余下子节点不足 2 个 ⇒ 该分组就地解散（与 #494 侧车时代的自愈语义一致：
 * 单成员的分组对用户没有意义）。被解散分组的幸存子节点同样回顶层、坐标转绝对。
 *
 * ⚠️ 绝对坐标必须在**父分组仍在数组里**时算完 —— 先删父再算会让 parentNode 链
 * 断掉、绝对坐标退化成相对坐标（表现为「解组后整组散架」）。
 */
export function releaseNodesFromGroups(nodes: FlowNode[], ids: Iterable<string>): FlowNode[] {
  const releasing = new Set(ids)
  const groups = nodes.filter(isGroupNode)
  if (groups.length === 0 || releasing.size === 0) return nodes

  const dissolved = new Set<string>()
  const shrink = new Map<string, string[]>()
  for (const g of groups) {
    const kids = childrenOf(nodes, g.id)
    if (!kids.some((k) => releasing.has(k.id))) continue
    const rest = kids.filter((k) => !releasing.has(k.id))
    if (rest.length < 2) dissolved.add(g.id)
    else shrink.set(g.id, rest.map((k) => k.id))
  }
  if (dissolved.size === 0 && shrink.size === 0) return nodes

  // 解散分组下的所有子节点都要回顶层：被放出来的 + 幸存下来的
  const release = new Map<string, { x: number; y: number }>()
  for (const g of groups) {
    if (!dissolved.has(g.id)) continue
    for (const kid of childrenOf(nodes, g.id)) {
      if (releasing.has(kid.id)) continue
      release.set(kid.id, getAbsolutePosition(kid, nodes))
    }
  }

  return nodes
    .filter((n) => !dissolved.has(n.id))
    .map((n) => {
      if (isGroupNode(n) && shrink.has(n.id)) {
        return {
          ...n,
          data: {
            ...((n.data ?? {}) as Record<string, unknown>),
            childIds: shrink.get(n.id),
          },
        } as FlowNode
      }
      if (releasing.has(n.id)) return toTopLevel(n, getAbsolutePosition(n, nodes))
      const abs = release.get(n.id)
      return abs ? toTopLevel(n, abs) : n
    })
}

/**
 * 节点被删除后收拾分组：把 removedIds 放出来（连带解散被摘空的分组），再把它们移除。
 * 幂等：空 removals 直接返回原数组引用。
 */
export function detachNodesFromGroupNodes(
  nodes: FlowNode[],
  removedIds: Iterable<string>,
): FlowNode[] {
  const removed = new Set(removedIds)
  if (removed.size === 0) return nodes
  return releaseNodesFromGroups(nodes, removed).filter((n) => !removed.has(n.id))
}

/**
 * 解组：移除分组框，子节点保留在原位（坐标回绝对）。
 * groupId 不是分组节点时返回 null（调用方据此不给「解组」反馈）。
 */
export function ungroupById(nodes: FlowNode[], groupId: string): FlowNode[] | null {
  const group = nodes.find((n) => n.id === groupId && isGroupNode(n))
  if (!group) return null
  const absById = new Map(
    childrenOf(nodes, groupId).map((k) => [k.id, getAbsolutePosition(k, nodes)] as const),
  )
  return nodes
    .filter((n) => n.id !== groupId)
    .map((n) => {
      const abs = absById.get(n.id)
      return abs ? toTopLevel(n, abs) : n
    })
}

/** 改分组标题 / 背景色（colorKey=null 表示复位默认中性）。目标不存在 ⇒ 原样返回。 */
export function patchGroupNodeData(
  nodes: FlowNode[],
  groupId: string,
  patch: { title?: string; colorKey?: string | null },
): FlowNode[] {
  if (!nodes.some((n) => n.id === groupId && isGroupNode(n))) return nodes
  return nodes.map((n) => {
    if (n.id !== groupId) return n
    const data = { ...((n.data ?? {}) as Record<string, unknown>) }
    if (patch.title !== undefined) data.title = patch.title
    if (patch.colorKey !== undefined) {
      if (patch.colorKey === null) delete data.colorKey
      else data.colorKey = patch.colorKey
    }
    return { ...n, data } as FlowNode
  })
}

/**
 * 分组序号标题：扫描现存分组 title 取**最小空位**（`分组 1` 起）。
 *
 * 不用「分组总数 + 1」：删组会让总数回落，再次建组即重名（生产实测：4 个分组
 * 里两个叫「分组 1」，且首个分组叫「分组 0」）。最小空位口径对任意增删时序都成立。
 */
export function nextGroupTitle(nodes: FlowNode[]): string {
  const taken = new Set<string>()
  for (const n of nodes) {
    if (!isGroupNode(n)) continue
    const title = (n.data as Record<string, unknown> | undefined)?.title
    if (typeof title === 'string' && title) taken.add(title)
  }
  let i = 1
  while (taken.has(`分组 ${i}`)) i += 1
  return `分组 ${i}`
}

/** 打组结果：mode 供调用方给出准确反馈（UI 层必须据此提示，否则「没反应」会被误读为失败）。 */
export type GroupFromSelectionResult = {
  nodes: FlowNode[]
  groupId: string
  /** reselect=所选节点本就同属一个分组（仅选中它）；merged=从旧分组摘出后归并成新分组。 */
  mode: 'created' | 'reselect' | 'merged'
  childIds: string[]
}

/**
 * 框选多个节点 → 打组。可用节点不足 2 个时返回 null。
 *
 * 容错语义（保留 #494 的口径，避免「明明已打组却报失败」的困惑）：
 * - 所选节点全部已属于【同一个】现存分组 ⇒ 视为重选该分组（不新建、不改写）；
 * - 选中的节点横跨多个分组 / 部分已分组 ⇒ 先把这些节点从原分组放出来，再整体归并。
 *
 * ⭐ `groupId`（2026-10-21，Agent 路径）：**由调用方指定分组 id**。
 * 起因：Agent 建组后必须能立刻用同一个 id 调改色/解组，但 `canvas_command` 是
 * **单向 SSE 下发**（pi-runtime → Nest → 前端），**没有回传通道** ⇒ 前端自生成的
 * id（`group-${Date.now().toString(36)}`）Agent 永远拿不到 ⇒ 「建组→改色」断链。
 * ⇒ Agent 侧先算好 id 随命令下发，前端照用 ⇒ 同一轮内即可继续操作。
 * 用户手动路径**不传**该参数 ⇒ 沿用原生成逻辑（行为零变化）。
 */
export function createGroupFromSelection(
  nodes: FlowNode[],
  selectedIds: string[],
  title?: string,
  groupId?: string,
): GroupFromSelectionResult | null {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const selected = selectedIds.filter((id) => {
    const n = byId.get(id)
    if (!n) return false
    return !isGroupNode(n)
  })
  if (selected.length < 2) return null

  const groupIds = new Set(nodes.filter(isGroupNode).map((n) => n.id))
  const ownerOf = (id: string): string | undefined => {
    const parentId = byId.get(id)?.parentNode
    return parentId && groupIds.has(parentId) ? parentId : undefined
  }
  const touched = Array.from(
    new Set(selected.map(ownerOf).filter((x): x is string => Boolean(x))),
  )
  if (touched.length === 1 && selected.every((id) => ownerOf(id) === touched[0])) {
    const groupId = touched[0]!
    return {
      nodes,
      groupId,
      mode: 'reselect',
      childIds: childrenOf(nodes, groupId).map((n) => n.id),
    }
  }

  let working = nodes
  let merged = false
  let childIds = selected.filter((id) => !ownerOf(id))
  if (childIds.length < 2) {
    merged = touched.length > 0
    // 归并路径：把选中节点从原分组放出来（节点本身保留），再整体建一个新组
    working = releaseNodesFromGroups(nodes, selected)
    childIds = selected
  }
  if (childIds.length < 2) return null

  const workingById = new Map(working.map((n) => [n.id, n]))
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const id of childIds) {
    const child = workingById.get(id)!
    const abs = getAbsolutePosition(child, working)
    const { w, h } = getNodeSize(child)
    minX = Math.min(minX, abs.x)
    minY = Math.min(minY, abs.y)
    maxX = Math.max(maxX, abs.x + w)
    maxY = Math.max(maxY, abs.y + h)
  }
  if (!Number.isFinite(minX)) return null

  const gx = minX - GROUP_PADDING
  const gy = minY - GROUP_PADDING
  // ⚠️ Agent 指定的 id 必须**校验后**才用：空串/与现有节点撞号都不能落，
  // 否则会覆盖掉真实节点（渲染层按 id 索引，撞号 = 节点凭空消失）。
  const requestedId = typeof groupId === 'string' ? groupId.trim() : ''
  const idTaken = requestedId.length > 0 && byId.has(requestedId)
  const finalGroupId =
    requestedId.length > 0 && !idTaken ? requestedId : `group-${Date.now().toString(36)}`
  const groupNode = {
    id: finalGroupId,
    type: GROUP_NODE_TYPE,
    position: { x: gx, y: gy },
    style: {
      width: `${maxX - minX + GROUP_PADDING * 2}px`,
      height: `${maxY - minY + GROUP_PADDING * 2}px`,
    },
    data: { title: title?.trim() || nextGroupTitle(working), childIds: [...childIds] },
    draggable: true,
    selectable: true,
    zIndex: 0,
  } as unknown as FlowNode

  const patched = new Map<string, FlowNode>()
  for (const id of childIds) {
    const child = workingById.get(id)!
    const abs = getAbsolutePosition(child, working)
    patched.set(id, {
      ...child,
      parentNode: finalGroupId,
      extent: 'parent',
      expandParent: true,
      zIndex: 1,
      position: { x: abs.x - gx, y: abs.y - gy },
    } as unknown as FlowNode)
  }

  return {
    nodes: [...working.map((n) => patched.get(n.id) ?? n), groupNode],
    groupId: finalGroupId,
    mode: merged ? 'merged' : 'created',
    childIds: [...childIds],
  }
}

/**
 * 按子节点包围盒重算单个分组框（+GROUP_PADDING 留白），并把子节点相对坐标同步
 * 平移，使每个子节点的**绝对位置保持不变** —— 框变大只是「让位」，不是搬东西。
 * 目标不是分组节点 / 无子节点 ⇒ 原样返回。
 */
export function resizeGroupToFitChildren(nodes: FlowNode[], groupId: string): FlowNode[] {
  const target = nodes.find((n) => n.id === groupId && isGroupNode(n))
  if (!target) return nodes
  const kids = childrenOf(nodes, groupId)
  if (kids.length === 0) return nodes

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const kid of kids) {
    const { w, h } = getNodeSize(kid)
    minX = Math.min(minX, kid.position.x)
    minY = Math.min(minY, kid.position.y)
    maxX = Math.max(maxX, kid.position.x + w)
    maxY = Math.max(maxY, kid.position.y + h)
  }
  if (!Number.isFinite(minX)) return nodes

  const pad = GROUP_PADDING
  const offsetX = minX - pad
  const offsetY = minY - pad
  const wantW = `${maxX - minX + pad * 2}px`
  const wantH = `${maxY - minY + pad * 2}px`

  return nodes.map((n) => {
    if (n.id === groupId) {
      const style = (
        typeof n.style === 'object' && n.style ? n.style : {}
      ) as Record<string, unknown>
      return {
        ...n,
        position: { x: n.position.x + offsetX, y: n.position.y + offsetY },
        style: { ...style, width: wantW, height: wantH },
        data: {
          ...((n.data ?? {}) as Record<string, unknown>),
          childIds: kids.map((k) => k.id),
        },
      } as FlowNode
    }
    if (n.parentNode === groupId) {
      return {
        ...n,
        position: { x: n.position.x - offsetX, y: n.position.y - offsetY },
      } as FlowNode
    }
    return n
  })
}

/**
 * 拖拽结束 / 加载测量后统一把分组框贴回子节点包围盒。
 * 已贴合（±1px）的分组跳过并返回**原数组引用** —— 幂等，避免无谓的 nodes 引用抖动。
 */
export function syncGroupsToFitChildren(nodes: FlowNode[]): FlowNode[] {
  let next = nodes
  for (const g of nodes) {
    if (!isGroupNode(g)) continue
    const kids = childrenOf(next, g.id)
    if (kids.length === 0) continue
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const kid of kids) {
      const { w, h } = getNodeSize(kid)
      minX = Math.min(minX, kid.position.x)
      minY = Math.min(minY, kid.position.y)
      maxX = Math.max(maxX, kid.position.x + w)
      maxY = Math.max(maxY, kid.position.y + h)
    }
    if (!Number.isFinite(minX)) continue
    const cur = groupNodeSize(g)
    const wantW = maxX - minX + GROUP_PADDING * 2
    const wantH = maxY - minY + GROUP_PADDING * 2
    if (Math.abs(cur.width - wantW) <= 1 && Math.abs(cur.height - wantH) <= 1) continue
    next = resizeGroupToFitChildren(next, g.id)
  }
  return next
}


// ══════════════════════════════════════════════════════════
// 分组原生节点形态（2026-10-21）：渲染层回归 vue-flow 父子节点
//
// #494 把分组改成 overlay 侧车后，PC 端只能点 26px 的小胶囊交互，且 overlay
// 手搓的 viewport 变换层上挂着 `overflow:hidden` —— 按元素本地流空间裁剪，
// 映射到屏幕后 ≠ 可见区 ⇒ 拖动时框被「塞进信封」式淹没。本段把渲染层改回
// 原生 `parentNode` + `extent:'parent'` + `expandParent`，交互全部由库提供。
//
// **持久化格式一行不改**：加载时 materializeGroups 物化成父节点（子节点坐标
// 转相对），保存时 foldGroups 折叠回 `CanvasGroup[]` + 子节点绝对坐标。
// ⇒ group 节点只在内存里存在，任何落库路径都必须先 fold。
// ══════════════════════════════════════════════════════════

/** 分组作为 vue-flow 节点时的 type（仅内存态，CanvasData.nodes 里永不出现）。 */
export const GROUP_NODE_TYPE = 'group'

export function isGroupNode(node: FlowNode): boolean {
  return String(node.type ?? '') === GROUP_NODE_TYPE
}

/**
 * group 节点尺寸：style（物化时写死的权威值，vue-flow 测量前也准）
 * → dimensions（测量后）→ 兜底 280×160。解析失败一律兜底，绝不返回 NaN
 * （NaN 会一路渗进 CSS `style`，框直接消失）。
 */
export function groupNodeSize(node: FlowNode): { width: number; height: number } {
  const style = (
    typeof node.style === 'object' && node.style ? node.style : {}
  ) as Record<string, unknown>
  const sw = Number.parseFloat(String(style.width ?? ''))
  const sh = Number.parseFloat(String(style.height ?? ''))
  if (Number.isFinite(sw) && sw > 0 && Number.isFinite(sh) && sh > 0) {
    return { width: sw, height: sh }
  }
  const dw = node.dimensions?.width
  const dh = node.dimensions?.height
  if (typeof dw === 'number' && dw > 0 && typeof dh === 'number' && dh > 0) {
    return { width: dw, height: dh }
  }
  return { width: 280, height: 160 }
}

/** 正数解析器：`0 / NaN / undefined / 脏字符串` 一律判为无效（交给调用方兜底）。 */
function positiveNumber(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 加载边界：把 `CanvasData.groups` 物化成 vue-flow 父子节点。
 *
 * - 每个 CanvasGroup → 一个 `type:'group'` 节点（`zIndex:0`、`style` 写死尺寸）；
 * - childIds 里的节点 → `parentNode` + `extent:'parent'` + `expandParent:true`
 *   + `zIndex:1`，`position` 改为**相对父节点**（vue-flow 父子坐标系语义）。
 *
 * fail-open 纪律（存量脏数据不得让画布白屏）：
 * - `size` 为 0/NaN/缺失 ⇒ 回退「子节点包围盒 + GROUP_PADDING」；
 * - `childIds` 指向不存在的节点 ⇒ 静默丢弃；有效子节点 < 2 ⇒ 整个分组不物化；
 * - **不支持嵌套分组**：childIds 里的 group 节点被跳过；同一节点被两个分组点名
 *   时只归第一个（后到的整组因可用子节点不足而自然跳过）。
 *
 * 幂等前提：入参最好是刚落库、尚未物化过的节点数组；已存在的 group 节点会被
 * 剔除，其子节点的 parentNode 一并清干净（避免同 id 出现两个节点）。
 */
export function materializeGroups(
  nodes: FlowNode[],
  groups: CanvasGroup[] | undefined,
): FlowNode[] {
  if (!Array.isArray(groups) || groups.length === 0) return nodes

  const staleGroupIds = new Set(nodes.filter(isGroupNode).map((n) => n.id))
  const flat: FlowNode[] = nodes
    .filter((n) => !isGroupNode(n))
    .map((n) =>
      n.parentNode && staleGroupIds.has(n.parentNode)
        ? ({
            ...n,
            parentNode: undefined,
            extent: undefined,
            expandParent: undefined,
          } as unknown as FlowNode)
        : n,
    )
  const byId = new Map(flat.map((n) => [n.id, n]))

  const claimed = new Set<string>()
  const groupNodes: FlowNode[] = []
  const patched = new Map<string, FlowNode>()

  for (const g of groups) {
    if (!g || typeof g.id !== 'string' || !g.id) continue
    const childIds = (Array.isArray(g.childIds) ? g.childIds : []).filter((id) => {
      if (claimed.has(id)) return false
      const child = byId.get(id)
      if (!child) return false
      return !isGroupNode(child)
    })
    if (childIds.length < 2) continue
    for (const id of childIds) claimed.add(id)

    // 子节点包围盒（绝对坐标）——脏 size 的兜底来源
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const id of childIds) {
      const child = byId.get(id)!
      // 注意用 nodes（而非 flat）算绝对：存量数据里子节点可能仍挂在旧父节点下
      const abs = getAbsolutePosition(child, nodes)
      const { w, h } = getNodeSize(child)
      minX = Math.min(minX, abs.x)
      minY = Math.min(minY, abs.y)
      maxX = Math.max(maxX, abs.x + w)
      maxY = Math.max(maxY, abs.y + h)
    }
    if (!Number.isFinite(minX)) continue

    const width = positiveNumber(g.size?.width) ?? (maxX - minX + GROUP_PADDING * 2)
    const height = positiveNumber(g.size?.height) ?? (maxY - minY + GROUP_PADDING * 2)
    const gx =
      Number.isFinite(g.position?.x) && Number.isFinite(g.position?.y)
        ? { x: g.position.x, y: g.position.y }
        : { x: minX - GROUP_PADDING, y: minY - GROUP_PADDING }

    groupNodes.push({
      id: g.id,
      type: GROUP_NODE_TYPE,
      position: { x: gx.x, y: gx.y },
      style: { width: `${width}px`, height: `${height}px` },
      data: {
        title: typeof g.title === 'string' && g.title ? g.title : '未命名分组',
        childIds: [...childIds],
        ...(typeof g.colorKey === 'string' && g.colorKey ? { colorKey: g.colorKey } : {}),
      },
      draggable: true,
      selectable: true,
      zIndex: 0,
    } as unknown as FlowNode)

    for (const id of childIds) {
      const child = byId.get(id)!
      const abs = getAbsolutePosition(child, nodes)
      patched.set(id, {
        ...child,
        parentNode: g.id,
        extent: 'parent',
        expandParent: true,
        zIndex: 1,
        position: { x: abs.x - gx.x, y: abs.y - gx.y },
      } as unknown as FlowNode)
    }
  }

  if (groupNodes.length === 0) return flat
  return [...flat.map((n) => patched.get(n.id) ?? n), ...groupNodes]
}

/**
 * 保存边界：把运行态（group 父节点 + 子节点相对坐标）折叠回持久化形态。
 *
 * - `nodes` 里剔除全部 group 节点，子节点**坐标回绝对**并清掉
 *   parentNode/extent/expandParent（残留会让下次加载把绝对坐标当相对坐标渲染，
 *   表现为「整组散架」）；
 * - `groups` 由 group 节点与真实父子关系重建；无有效子节点的分组不落库。
 *
 * 无 group 节点时返回原数组引用（零扰动）。
 */
export function foldGroups(nodes: FlowNode[]): { nodes: FlowNode[]; groups: CanvasGroup[] } {
  const groupNodes = nodes.filter(isGroupNode)
  if (groupNodes.length === 0) return { nodes, groups: [] }

  const groups: CanvasGroup[] = []
  for (const g of groupNodes) {
    const children = nodes.filter((n) => n.parentNode === g.id)
    if (children.length === 0) continue
    const { width, height } = groupNodeSize(g)
    const data = (g.data ?? {}) as Record<string, unknown>
    const title = data.title
    const colorKey = data.colorKey
    groups.push({
      id: g.id,
      title: typeof title === 'string' && title ? title : '未命名分组',
      ...(typeof colorKey === 'string' && colorKey ? { colorKey } : {}),
      childIds: children.map((c) => c.id),
      position: { x: g.position.x, y: g.position.y },
      size: { width, height },
    })
  }

  const nextNodes = nodes
    .filter((n) => !isGroupNode(n))
    .map((n) => {
      if (!n.parentNode) return n
      const abs = getAbsolutePosition(n, nodes)
      const {
        parentNode: _parentNode,
        extent: _extent,
        expandParent: _expandParent,
        ...rest
      } = n as FlowNode & { expandParent?: boolean }
      return { ...rest, position: { x: abs.x, y: abs.y }, zIndex: undefined } as FlowNode
    })

  return { nodes: nextNodes, groups }
}

// ── 分组框 8 方向缩放（2026-10-21 用户实测新增诉求）────────────────
//
// 语义与本项目**裁剪 / 扩图**完全一致（见 refine/outpaintGeometry.ts）：
//   - 8 个手柄（4 角 + 4 边），**只移动该手柄所在的边，对边固定**；
//   - 单边下限 GROUP_MIN_SIZE（框不能缩到比最小尺寸还小）；
//   - **只改框**（style.width/height + position），**子节点绝对位置不动** ——
//     子节点相对坐标随框的新 origin 平移补偿，「内容不动、框变」。
//
// 为什么不用 @vue-flow/node-resizer：官方插件群整体停在 1.x 早期
// （node-resizer 1.5.1 / background 1.3.2 / controls 1.1.3），而 core 已是 1.48.2；
// 且它走 dimensions 通道写回，本项目是受控模式（style 为唯一权威），接它要另开通道。
//
// 为什么不复用 refine/outpaintGeometry 的常量：那份的 HandleDir 语义绑定「图片像素矩形」
// （base 是原图、rect 是新画布），与分组框的「画布坐标矩形」不是同一层；此处独立定义，
// 但**手柄集合与「只动该边、对边固定」的规则刻意与之一致**（用户体验同源）。

/** 分组框缩放手柄方向（4 角 + 4 边）。 */
export type GroupHandleDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** 手柄渲染顺序（4 角 + 4 边），与裁剪/扩图一致。 */
export const GROUP_HANDLE_DIRS: GroupHandleDir[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** 手柄 → 随指针移动的边；未标 true 的边在该手柄拖拽时保持固定（对边固定）。 */
export const GROUP_HANDLE_MOVING_EDGES: Record<
  GroupHandleDir,
  { west: boolean; east: boolean; north: boolean; south: boolean }
> = {
  nw: { west: true, east: false, north: true, south: false },
  n: { west: false, east: false, north: true, south: false },
  ne: { west: false, east: true, north: true, south: false },
  e: { west: false, east: true, north: false, south: false },
  se: { west: false, east: true, north: false, south: true },
  s: { west: false, east: false, north: false, south: true },
  sw: { west: true, east: false, north: false, south: true },
  w: { west: true, east: false, north: false, south: false },
}

/** 分组框最小边长（画布坐标 px）：再小就没法框住内容了。 */
export const GROUP_MIN_SIZE = 160

/** 一次拖拽位移（画布坐标 px，调用方已按 zoom 换算）。 */
export type GroupDragDelta = { dx: number; dy: number }

/**
 * 按手柄方向缩放分组框。
 *
 * 契约：
 * - 目标不是分组节点 / 框无有效尺寸 ⇒ 原样返回（幂等、零扰动）；
 * - 缩到 GROUP_MIN_SIZE 以下 ⇒ 该轴 clamp 到下限（不出现 0 / 负宽）；
 * - **子节点绝对位置逐个不变**（相对坐标随框 origin 平移补偿）；
 * - 框尺寸写回 `style.width/height`（字符串 px）—— 受控模式下 `style` 才是权威，
 *   不写 `dimensions`（那是 vue-flow 的测量值，两条通道不能打架）；
 * - 落库由 `foldGroups` 自动把新尺寸带进 `CanvasGroup.size`（持久化格式零改动）。
 */
export function resizeGroupByHandle(
  nodes: FlowNode[],
  groupId: string,
  dir: GroupHandleDir,
  delta: GroupDragDelta,
): FlowNode[] {
  const target = nodes.find((n) => n.id === groupId && isGroupNode(n))
  if (!target) return nodes

  const cur = groupNodeSize(target)
  if (!(cur.width > 0) || !(cur.height > 0)) return nodes

  const moving = GROUP_HANDLE_MOVING_EDGES[dir]
  if (!moving) return nodes

  // 以「四条边」表达当前框：west/east 是 x 坐标，north/south 是 y 坐标。
  const originX = target.position.x
  const originY = target.position.y
  let west = originX
  let east = originX + cur.width
  let north = originY
  let south = originY + cur.height

  if (moving.west) west += delta.dx
  if (moving.east) east += delta.dx
  if (moving.north) north += delta.dy
  if (moving.south) south += delta.dy

  // 单边下限：夹住「正在移动的边」，固定边不跳动（与裁剪/扩图同思路）。
  if (moving.west) west = Math.min(west, east - GROUP_MIN_SIZE)
  if (moving.east) east = Math.max(east, west + GROUP_MIN_SIZE)
  if (moving.north) north = Math.min(north, south - GROUP_MIN_SIZE)
  if (moving.south) south = Math.max(south, north + GROUP_MIN_SIZE)

  const nextWidth = east - west
  const nextHeight = south - north
  if (!(nextWidth > 0) || !(nextHeight > 0)) return nodes

  // 框 origin 变了 ⇒ 子节点相对坐标要同步平移，才能保持**绝对位置不变**。
  const shiftX = originX - west
  const shiftY = originY - north

  return nodes.map((n) => {
    if (n.id === groupId) {
      const style = (
        typeof n.style === 'object' && n.style ? n.style : {}
      ) as Record<string, unknown>
      return {
        ...n,
        position: { x: west, y: north },
        style: { ...style, width: `${nextWidth}px`, height: `${nextHeight}px` },
      } as FlowNode
    }
    if (n.parentNode === groupId) {
      return {
        ...n,
        position: { x: n.position.x + shiftX, y: n.position.y + shiftY },
      } as FlowNode
    }
    return n
  })
}
