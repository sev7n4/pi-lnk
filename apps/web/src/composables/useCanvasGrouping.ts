import type { Node } from '@vue-flow/core'

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

export type ArrangeMode = 'grid' | 'along_edges'

/** arrange_nodes（agent 工具）与多选工具栏共用的派发参数。 */
export interface ArrangeRequest {
  nodeIds: string[]
  mode: ArrangeMode
  gap?: number
  /** along_edges 的有向边；缺省时退回画布全量边（同手动「顺着连线」）。 */
  edges?: LayoutEdge[]
}

/**
 * 按 mode 派发到两个既有布局函数，零新建算法。
 * 抽成纯函数是为了可测：CanvasPage 只负责 setNodes + persist + 聚焦。
 */
export function applyArrangeLayout(
  nodes: FlowNode[],
  req: ArrangeRequest,
  canvasEdges: LayoutEdge[] = [],
): FlowNode[] {
  const ids = (req?.nodeIds ?? []).filter((id) => typeof id === 'string' && id)
  if (ids.length < 2) return nodes
  const gap = typeof req.gap === 'number' && Number.isFinite(req.gap) ? req.gap : 40
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

/** 分组序号标题（`分组 N`），N = 现有分组数 + 1。 */
export function nextGroupTitle(groups: CanvasGroup[]): string {
  return `分组 ${groups.length + 1}`
}

/**
 * 由子节点包围盒算分组外框（绝对坐标 + padding）。
 * 子节点不足 2 个时返回 null（打组最少 2 个）。
 */
export function groupRectForChildren(
  nodes: FlowNode[],
  childIds: string[],
  padding = GROUP_PADDING,
): { position: { x: number; y: number }; size: { width: number; height: number } } | null {
  if (childIds.length < 2) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const id of childIds) {
    const node = nodes.find((n) => n.id === id)
    if (!node) continue
    const abs = getAbsolutePosition(node, nodes)
    const { w, h } = getNodeSize(node)
    minX = Math.min(minX, abs.x)
    minY = Math.min(minY, abs.y)
    maxX = Math.max(maxX, abs.x + w)
    maxY = Math.max(maxY, abs.y + h)
  }
  if (!Number.isFinite(minX)) return null
  return {
    position: { x: minX - padding, y: minY - padding },
    size: { width: maxX - minX + padding * 2, height: maxY - minY + padding * 2 },
  }
}

/**
 * 框选多个节点 → 打组。
 * 资格：节点存在、尚未属于任何分组（一个节点只进一个分组，避免嵌套歧义）。
 */
export function createGroupFromSelection(
  groups: CanvasGroup[],
  nodes: FlowNode[],
  selectedIds: string[],
  title?: string,
): { groups: CanvasGroup[]; group: CanvasGroup } | null {
  const grouped = new Set(groups.flatMap((g) => g.childIds))
  const childIds = selectedIds.filter((id) => {
    const node = nodes.find((n) => n.id === id)
    return Boolean(node) && !grouped.has(id)
  })
  const rect = groupRectForChildren(nodes, childIds)
  if (!rect || childIds.length < 2) return null

  const group: CanvasGroup = {
    id: `group-${Date.now().toString(36)}`,
    title: title?.trim() || nextGroupTitle(groups),
    childIds,
    ...rect,
  }
  return { groups: [...groups, group], group }
}

/** 解组：移除分组框，子节点保持各自绝对坐标不动。 */
export function ungroupById(groups: CanvasGroup[], groupId: string): CanvasGroup[] {
  return groups.filter((g) => g.id !== groupId)
}

/** 改分组背景色（key 取 groupColors 的 8 色卡）。 */
export function patchGroupColorKey(
  groups: CanvasGroup[],
  groupId: string,
  colorKey: string | null,
): CanvasGroup[] {
  return groups.map((g) =>
    g.id === groupId ? { ...g, colorKey: colorKey ?? undefined } : g,
  )
}

/** 重命名分组。 */
export function renameGroup(groups: CanvasGroup[], groupId: string, title: string): CanvasGroup[] {
  const trimmed = title.trim()
  if (!trimmed) return groups
  return groups.map((g) => (g.id === groupId ? { ...g, title: trimmed } : g))
}

/**
 * 拖分组框 → 整组平移（子节点跟着走）。
 * 返回新 groups 与新 nodes（不原地改）。
 */
export function moveGroupWithChildren(
  groups: CanvasGroup[],
  nodes: FlowNode[],
  groupId: string,
  delta: { x: number; y: number },
): { groups: CanvasGroup[]; nodes: FlowNode[] } {
  const group = groups.find((g) => g.id === groupId)
  if (!group || (delta.x === 0 && delta.y === 0)) return { groups, nodes }
  const childSet = new Set(group.childIds)
  const nextNodes = nodes.map((n) =>
    childSet.has(n.id)
      ? { ...n, position: { x: n.position.x + delta.x, y: n.position.y + delta.y } }
      : n,
  )
  const nextGroups = groups.map((g) =>
    g.id === groupId
      ? {
          ...g,
          position: { x: g.position.x + delta.x, y: g.position.y + delta.y },
          size: { ...g.size },
        }
      : g,
  )
  return { groups: nextGroups, nodes: nextNodes }
}

/**
 * 与画布现状对齐：子节点被删/被拖走后重算外框，子节点不足 2 个的分组自动解散。
 * 拖拽结束、加载完成、删节点后都应调用（幂等）。
 */
export function syncGroupsToChildren(groups: CanvasGroup[], nodes: FlowNode[]): CanvasGroup[] {
  const out: CanvasGroup[] = []
  for (const g of groups) {
    const childIds = g.childIds.filter((id) => nodes.some((n) => n.id === id))
    if (childIds.length < 2) continue
    const rect = groupRectForChildren(nodes, childIds)
    if (!rect) continue
    out.push({ ...g, childIds, ...rect })
  }
  return out
}

/** 节点被删除后把它从所属分组摘掉（返回新 groups）。 */
export function detachNodesFromGroups(groups: CanvasGroup[], nodeIds: Iterable<string>): CanvasGroup[] {
  const removed = new Set(nodeIds)
  if (removed.size === 0) return groups
  return groups
    .map((g) => ({ ...g, childIds: g.childIds.filter((id) => !removed.has(id)) }))
    .filter((g) => g.childIds.length >= 2)
}
