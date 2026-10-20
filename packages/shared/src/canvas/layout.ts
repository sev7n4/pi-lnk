// SP-A（2026-10-20）：批量创建放置内核 + 布局原语上移（自 apps/server/src/agent/canvas-layout.util.ts
// 逐字上移 NODE_SIZES/getNodeSize/getAbsolutePosition/LayoutNode，保 Nest 侧 import 面与行为不变）。
// 避碰复用 canvas/workflowImportPlacement 的 rectsOverlap（既有 shared 资产，不重写第三份）。
// 分量 bbox/面积用真实节点尺寸（getAbsolutePosition+getNodeSize）——不复用该文件的 unionNodeBBox：
// 其 estimate 280×180 是 import 专用近似，会让 video(320 宽)/text(160 高) 分量的右缘算错。
// type-only：CanvasNode 定义在 barrel（index.ts），仅类型引用，编译后擦除，不产生运行时循环
import type { CanvasNode } from '../index'
import { rectsOverlap, type Rect } from './workflowImportPlacement'

/** 画布布局节点：CanvasNode + 分组/样式扩展（逐字上移，Nest 侧 canvas-layout.util.ts re-export 消费）。 */
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
  sceneComposer: { w: 280, h: 280 },
  shot: { w: 280, h: 280 },
  mediaInput: { w: 280, h: 280 },
  videoComposition: { w: 280, h: 200 },
  worldModel: { w: 280, h: 280 },
  group: { w: 280, h: 160 },
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

// ---- SP-A 放置内核（规格 §8.1）----

export const PLACEMENT_GRID = 20

/** 批内相邻间距 / 行宽 / 避碰 pad / 步进上限 / 空画布锚点（规格 §8.1 规则 A1-A6）。 */
const PLACEMENT_H_GAP = 40
const PLACEMENT_ROW_WIDTH = 1120
const PLACEMENT_COLLISION_PAD = 12
const PLACEMENT_MAX_STEPS = 24
const PLACEMENT_ORIGIN = { x: 80, y: 80 }

export function snapToGrid(value: number, grid = PLACEMENT_GRID) {
  return Math.round(value / grid) * grid
}

function toRect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, width: w, height: h }
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (w <= 0 || h <= 0) return 0
  return w * h
}

function absPointOf(node: LayoutNode, nodes: LayoutNode[]): { x: number; y: number } {
  return getAbsolutePosition(node, nodes)
}

/** 节点子集的真实尺寸绝对坐标 bbox；坐标非有限（脏数据）⇒ null（调用方 fail-open）。 */
function componentBBox(nodes: LayoutNode[], subset: LayoutNode[]): Rect | null {
  if (subset.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of subset) {
    const abs = absPointOf(n, nodes)
    const size = getNodeSize(n)
    if (!Number.isFinite(abs.x) || !Number.isFinite(abs.y)) return null
    minX = Math.min(minX, abs.x)
    minY = Math.min(minY, abs.y)
    maxX = Math.max(maxX, abs.x + size.w)
    maxY = Math.max(maxY, abs.y + size.h)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** 既有节点的绝对坐标 bbox 列表（分组子节点按 getAbsolutePosition 换算；脏数据 rect 不过滤会永久「重叠」）。 */
function obstacleRects(nodes: LayoutNode[]): Rect[] {
  const rects: Rect[] = []
  for (const n of nodes) {
    const abs = getAbsolutePosition(n, nodes)
    if (!Number.isFinite(abs.x) || !Number.isFinite(abs.y)) continue
    const size = getNodeSize(n)
    rects.push(toRect(abs.x, abs.y, size.w, size.h))
  }
  return rects
}

/** 最大弱连通分量（按既有边并查集；并列取真实尺寸 bbox 面积大者）。 */
function largestComponent(
  nodes: LayoutNode[],
  edges: Array<{ source: string; target: string }>,
): LayoutNode[] {
  if (nodes.length === 0) return []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const parent = new Map<string, string>(nodes.map((n) => [n.id, n.id]))
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)!
    let cur = id
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  for (const e of edges) {
    if (byId.has(e.source) && byId.has(e.target)) {
      const ra = find(e.source)
      const rb = find(e.target)
      if (ra !== rb) parent.set(ra, rb)
    }
  }
  const groups = new Map<string, LayoutNode[]>()
  for (const n of nodes) {
    const root = find(n.id)
    const list = groups.get(root)
    if (list) list.push(n)
    else groups.set(root, [n])
  }
  const areaOf = (ns: LayoutNode[]) => {
    const b = componentBBox(nodes, ns)
    return b ? b.width * b.height : 0
  }
  let best: LayoutNode[] = []
  for (const list of groups.values()) {
    if (list.length > best.length) {
      best = list
      continue
    }
    if (list.length === best.length && list.length > 0 && areaOf(list) > areaOf(best)) {
      best = list
    }
  }
  return best
}

/**
 * 锚点三级优先（规格 §8.1 A1）：① 边引用的既有节点右缘 → ② 最大分量 bbox 右缘 → ③ (80,80)。
 * ①只统计「至少一个端点是本批 item key」的边中另一侧的既有节点——既有边（两端都是旧节点）
 * 不构成引用，它们只参与②的分量合并。
 */
function resolveAnchor(
  nodes: LayoutNode[],
  items: Array<{ key: string }>,
  edges: Array<{ source: string; target: string }>,
): { x: number; y: number } {
  if (nodes.length === 0) return { ...PLACEMENT_ORIGIN }
  const itemKeys = new Set(items.map((it) => it.key))
  const refCount = new Map<string, number>()
  for (const e of edges) {
    const sourceIsBatch = itemKeys.has(e.source)
    const targetIsBatch = itemKeys.has(e.target)
    if (sourceIsBatch !== targetIsBatch) {
      const referencedId = sourceIsBatch ? e.target : e.source
      refCount.set(referencedId, (refCount.get(referencedId) ?? 0) + 1)
    }
  }
  const referenced = [...refCount.entries()]
    .filter(([id]) => nodes.some((n) => n.id === id)) // 本批 key 不在 nodes 中，天然排除
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (referenced.length > 0) {
    const anchorNode = nodes.find((n) => n.id === referenced[0][0])!
    const abs = absPointOf(anchorNode, nodes)
    const size = getNodeSize(anchorNode)
    return { x: abs.x + size.w + PLACEMENT_H_GAP, y: abs.y }
  }
  const component = largestComponent(nodes, edges)
  const bbox = componentBBox(nodes, component)
  if (bbox) return { x: bbox.x + bbox.width + PLACEMENT_H_GAP, y: bbox.y }
  return { ...PLACEMENT_ORIGIN }
}

/**
 * SP-A 放置内核：批内 items 按顺序链式右向落位；行宽 1120 换行；与 existing（含批内已放置）
 * bbox+pad12 冲突时垂直步进避让（上限 24 次，仍冲突 fail-open 取重叠最小）；收官 snapToGrid(20)。
 * 纯函数：无随机、无时钟、无视图依赖——同输入同输出（金样测试可锁）。
 */
export function placeBatchNodes(
  existing: LayoutNode[],
  items: Array<{ key: string; type: string }>,
  edges?: Array<{ source: string; target: string }>,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>()
  if (items.length === 0) return result
  const obstacles = obstacleRects(existing)
  const anchor = resolveAnchor(existing, items, edges ?? [])
  let cursorX = anchor.x
  let rowY = anchor.y
  let rowHeight = 0

  for (const item of items) {
    const size = getNodeSize({ type: item.type } as LayoutNode)
    if (cursorX > anchor.x && cursorX + size.w > anchor.x + PLACEMENT_ROW_WIDTH) {
      cursorX = anchor.x
      rowY += rowHeight + PLACEMENT_H_GAP
      rowHeight = 0
    }
    rowHeight = Math.max(rowHeight, size.h)

    let x = cursorX
    let y = rowY
    let clear = false
    for (let step = 0; step < PLACEMENT_MAX_STEPS; step++) {
      const candidate = toRect(x, y, size.w, size.h)
      if (!obstacles.some((o) => rectsOverlap(candidate, o, PLACEMENT_COLLISION_PAD))) {
        clear = true
        break
      }
      y += PLACEMENT_H_GAP
    }
    if (!clear) {
      // fail-open：24 次仍冲突 ⇒ 取垂直步进序列中重叠面积最小者（放置永不阻塞创建）
      let bestOverlap = Number.POSITIVE_INFINITY
      for (let step = 0; step < PLACEMENT_MAX_STEPS; step++) {
        const candidate = toRect(cursorX, rowY + step * PLACEMENT_H_GAP, size.w, size.h)
        const overlap = obstacles.reduce((sum, o) => sum + overlapArea(candidate, o), 0)
        if (overlap < bestOverlap) {
          bestOverlap = overlap
          x = candidate.x
          y = candidate.y
        }
      }
    }

    const snapped = { x: snapToGrid(x), y: snapToGrid(y) }
    result.set(item.key, snapped)
    obstacles.push(toRect(snapped.x, snapped.y, size.w, size.h))
    cursorX = snapped.x + size.w + PLACEMENT_H_GAP
  }
  return result
}
