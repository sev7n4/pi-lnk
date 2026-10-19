import type { CanvasNode } from '@lnkpi/shared'

/** 分组框相对子节点包围盒的留白（与 web 端 GROUP_PADDING 同值，视觉一致）。 */
export const GROUP_PADDING = 80

export type LayoutNode = CanvasNode & {
  parentNode?: string
  style?: Record<string, unknown> | string
  extent?: string
  expandParent?: boolean
  draggable?: boolean
  selectable?: boolean
  zIndex?: number
  dimensions?: { width?: number; height?: number }
}

const NODE_SIZES: Record<string, { w: number; h: number }> = {
  text: { w: 280, h: 160 },
  image: { w: 280, h: 280 },
  // 视频：长边基准 320（尺寸随比例 contain，包络 320×320）
  video: { w: 320, h: 320 },
  audio: { w: 280, h: 140 },
  prompt: { w: 280, h: 120 },
}

function parseStyleSize(style: LayoutNode['style']): { w?: number; h?: number } {
  if (!style || typeof style === 'string') return {}
  const width = style.width
  const height = style.height
  const w =
    typeof width === 'number'
      ? width
      : typeof width === 'string'
        ? Number.parseFloat(width)
        : undefined
  const h =
    typeof height === 'number'
      ? height
      : typeof height === 'string'
        ? Number.parseFloat(height)
        : undefined
  return { w: Number.isFinite(w) ? w : undefined, h: Number.isFinite(h) ? h : undefined }
}

export function getNodeSize(node: LayoutNode): { w: number; h: number } {
  const type = String(node.type ?? '')
  const fallback = NODE_SIZES[type] ?? { w: 280, h: 160 }
  const fromStyle = parseStyleSize(node.style)
  return {
    w: node.dimensions?.width ?? fromStyle.w ?? fallback.w,
    h: node.dimensions?.height ?? fromStyle.h ?? fallback.h,
  }
}

export function getAbsolutePosition(node: LayoutNode, nodes: LayoutNode[]): { x: number; y: number } {
  let x = node.position.x
  let y = node.position.y
  let parentId = node.parentNode
  while (parentId) {
    const parent = nodes.find((n) => n.id === parentId)
    if (!parent) break
    x += parent.position.x
    y += parent.position.y
    parentId = parent.parentNode
  }
  return { x, y }
}

function updateNodePosition(nodes: LayoutNode[], id: string, pos: { x: number; y: number }) {
  const idx = nodes.findIndex((n) => n.id === id)
  if (idx >= 0) {
    nodes[idx] = { ...nodes[idx]!, position: pos }
  }
}

export type LayoutEdge = { source: string; target: string }

function setAbsolutePosition(
  nodes: LayoutNode[],
  node: LayoutNode,
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
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  selectedIds: string[],
  gap = 40,
): LayoutNode[] {
  const selected = new Set(selectedIds)
  const targets: LayoutNode[] = []
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

export function layoutNodesInGrid(
  nodes: LayoutNode[],
  selectedIds: string[],
  gap = 40,
): LayoutNode[] {
  const selected = new Set(selectedIds)
  const targets = nodes.filter((n) => selected.has(n.id))
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
      const parent = next.find((p) => p.id === node.parentNode)
      const parentAbs = parent ? getAbsolutePosition(parent, next) : { x: 0, y: 0 }
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

export type CanvasLayoutOp =
  | { op: 'group'; nodeIds: string[]; title?: string }
  | { op: 'ungroup'; groupId: string }
  | { op: 'arrange_grid'; nodeIds: string[]; gap?: number }
  | { op: 'arrange_along_edges'; nodeIds: string[]; gap?: number }
  | { op: 'move'; items: Array<{ nodeId: string; x: number; y: number }> }

export type CanvasLayoutOpResult =
  | { op: 'group'; groupId: string; nodeIds: string[] }
  | { op: 'ungroup'; groupId: string; nodeIds: string[] }
  | { op: 'arrange_grid'; nodeIds: string[] }
  | { op: 'arrange_along_edges'; nodeIds: string[] }
  | { op: 'move'; nodeIds: string[] }

/** Move nodes by absolute canvas coordinates (converts to parent-relative when nested). */
export function moveNodes(
  nodes: LayoutNode[],
  items: Array<{ nodeId: string; x: number; y: number }>,
): { nodes: LayoutNode[]; movedIds: string[] } {
  const next = nodes.map((n) => ({ ...n, data: { ...(n.data ?? {}) } }))
  const movedIds: string[] = []
  for (const item of items) {
    const idx = next.findIndex((n) => n.id === item.nodeId)
    if (idx < 0) continue
    const node = next[idx]!
    let position = { x: item.x, y: item.y }
    if (node.parentNode) {
      const parent = next.find((n) => n.id === node.parentNode)
      if (parent) {
        const parentAbs = getAbsolutePosition(parent, next)
        position = {
          x: item.x - parentAbs.x,
          y: item.y - parentAbs.y,
        }
      }
    }
    next[idx] = { ...node, position }
    movedIds.push(item.nodeId)
  }
  return { nodes: next, movedIds }
}

/** Apply ordered layout ops on an in-memory node list (no persistence). */
export function applyLayoutOps(
  nodes: LayoutNode[],
  ops: CanvasLayoutOp[],
  edges: LayoutEdge[] = [],
  groups: CanvasGroup[] = [],
): { nodes: LayoutNode[]; groups: CanvasGroup[]; results: CanvasLayoutOpResult[] } {
  let current = nodes.map((n) => ({ ...n, data: { ...(n.data ?? {}) } }))
  let currentGroups = groups.map((g) => ({ ...g, childIds: [...g.childIds] }))
  const results: CanvasLayoutOpResult[] = []

  for (const op of ops) {
    switch (op.op) {
      case 'group': {
        // 2026-10-20：分组落 sidecar（不再是节点）。
        const grouped = createGroupFromSelection(currentGroups, current, op.nodeIds, op.title);
        if (!grouped) {
          throw new Error(`group requires at least 2 ungrouped nodes: ${op.nodeIds.join(', ')}`);
        }
        currentGroups = grouped.groups;
        results.push({ op: 'group', groupId: grouped.group.id, nodeIds: grouped.group.childIds });
        break;
      }
      case 'ungroup': {
        const target = currentGroups.find((g) => g.id === op.groupId);
        if (!target) throw new Error(`group not found: ${op.groupId}`);
        currentGroups = ungroupById(currentGroups, op.groupId);
        results.push({ op: 'ungroup', groupId: op.groupId, nodeIds: [...target.childIds] });
        break;
      }
      case 'arrange_grid': {
        current = layoutNodesInGrid(current, op.nodeIds, op.gap ?? 40)
        results.push({ op: 'arrange_grid', nodeIds: op.nodeIds })
        break
      }
      case 'arrange_along_edges': {
        current = layoutNodesAlongEdges(current, edges, op.nodeIds, op.gap ?? 40)
        results.push({ op: 'arrange_along_edges', nodeIds: op.nodeIds })
        break
      }
      case 'move': {
        const moved = moveNodes(current, op.items)
        current = moved.nodes
        results.push({ op: 'move', nodeIds: moved.movedIds })
        break
      }
      default: {
        const _exhaustive: never = op
        throw new Error(`unknown layout op: ${JSON.stringify(_exhaustive)}`)
      }
    }
  }

  return { nodes: current, groups: currentGroups, results }
}


// ══════════════════════════════════════════════════════════
// 分组（2026-10-20 侧车化）
//
// 分组曾以 `group` 节点承载；现改为 `CanvasData.groups` 侧车：
// - 分组框不是节点（不进 node-types / agent 节点白名单）；
// - 子节点 position 一律画布绝对坐标；
// - web 端同一套语义在 `apps/web/src/composables/useCanvasGrouping.ts`，两侧保持一致。
// ══════════════════════════════════════════════════════════

export type { CanvasGroup } from '@lnkpi/shared';
import type { CanvasGroup } from '@lnkpi/shared';

/** 分组序号标题（`分组 N`）。 */
export function nextGroupTitle(groups: CanvasGroup[]): string {
	return `分组 ${groups.length + 1}`;
}

/** 由子节点包围盒算分组外框（绝对坐标 + padding）；不足 2 个子节点返回 null。 */
export function groupRectForChildren(
	nodes: LayoutNode[],
	childIds: string[],
	padding = GROUP_PADDING,
): { position: { x: number; y: number }; size: { width: number; height: number } } | null {
	if (childIds.length < 2) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const id of childIds) {
		const node = nodes.find((n) => n.id === id);
		if (!node) continue;
		const abs = getAbsolutePosition(node, nodes);
		const { w, h } = getNodeSize(node);
		minX = Math.min(minX, abs.x);
		minY = Math.min(minY, abs.y);
		maxX = Math.max(maxX, abs.x + w);
		maxY = Math.max(maxY, abs.y + h);
	}
	if (!Number.isFinite(minX)) return null;
	return {
		position: { x: minX - padding, y: minY - padding },
		size: { width: maxX - minX + padding * 2, height: maxY - minY + padding * 2 },
	};
}

/** 打组：≥2 个未分组节点才成立（一个节点只进一个分组，避免嵌套歧义）。 */
export function createGroupFromSelection(
	groups: CanvasGroup[],
	nodes: LayoutNode[],
	selectedIds: string[],
	title?: string,
): { groups: CanvasGroup[]; group: CanvasGroup } | null {
	const grouped = new Set(groups.flatMap((g) => g.childIds));
	const childIds = selectedIds.filter((id) => {
		const node = nodes.find((n) => n.id === id);
		return Boolean(node) && !grouped.has(id);
	});
	const rect = groupRectForChildren(nodes, childIds);
	if (!rect || childIds.length < 2) return null;
	const group: CanvasGroup = {
		id: `group-${Date.now().toString(36)}`,
		title: title?.trim() || nextGroupTitle(groups),
		childIds,
		...rect,
	};
	return { groups: [...groups, group], group };
}

/** 解组：移除分组框，子节点保持各自绝对坐标不动。 */
export function ungroupById(groups: CanvasGroup[], groupId: string): CanvasGroup[] {
	return groups.filter((g) => g.id !== groupId);
}

/** 改分组背景色（null = 复位默认中性）。 */
export function patchGroupColorKey(
	groups: CanvasGroup[],
	groupId: string,
	colorKey: string | null,
): CanvasGroup[] {
	return groups.map((g) => (g.id === groupId ? { ...g, colorKey: colorKey ?? undefined } : g));
}

/** 与画布现状对齐：子节点被删/被挪后重算外框；不足 2 个的分组自动解散。 */
export function syncGroupsToChildren(groups: CanvasGroup[], nodes: LayoutNode[]): CanvasGroup[] {
	const out: CanvasGroup[] = [];
	for (const g of groups) {
		const childIds = g.childIds.filter((id) => nodes.some((n) => n.id === id));
		if (childIds.length < 2) continue;
		const rect = groupRectForChildren(nodes, childIds);
		if (!rect) continue;
		out.push({ ...g, childIds, ...rect });
	}
	return out;
}

/** 分组摘要（工具结果回给 agent：有哪些组、含哪些节点）。 */
export function summarizeGroups(groups: CanvasGroup[]): Array<{
	id: string;
	title: string;
	childIds: string[];
}> {
	return groups.map((g) => ({ id: g.id, title: g.title, childIds: g.childIds }));
}
