// SP-A（2026-10-20）：批量创建放置内核 + 布局原语上移（自 apps/server/src/agent/canvas-layout.util.ts
// 逐字上移 NODE_SIZES/getNodeSize/getAbsolutePosition/LayoutNode，保 Nest 侧 import 面与行为不变）。
// 避碰复用 canvas/workflowImportPlacement 的 rectsOverlap（既有 shared 资产，不重写第三份）。
// 分量 bbox/面积用真实节点尺寸（getAbsolutePosition+getNodeSize）——不复用该文件的 unionNodeBBox：
// 其 estimate 280×180 是 import 专用近似，会让 video(320 宽)/text(160 高) 分量的右缘算错。
// type-only：CanvasNode 定义在 barrel（index.ts），仅类型引用，编译后擦除，不产生运行时循环
import type { CanvasNode } from '../index'
import { rectsOverlap, type Rect } from './workflowImportPlacement'

/** 画布布局节点：CanvasNode + 分组/样式扩展（逐字上移，Nest 侧 canvas-layout.util.ts re-export 消费）。 */
// ⭐ `type` 放宽为 string（Omit 掉 CanvasNode 的 NodeType 收窄）：存量画布 JSON 里仍有已下线
//   类型的节点（prompt 2026-10-17 / group·shot·sceneComposer 2026-10-19 下线），布局内核必须
//   能处理它们（走 NODE_SIZES fallback 280×160），不能因类型收窄把它们挡在类型系统外。
export type LayoutNode = Omit<CanvasNode, 'type'> & {
  type: string
  parentNode?: string
  style?: Record<string, unknown> | string
  extent?: string
  expandParent?: boolean
  draggable?: boolean
  selectable?: boolean
  zIndex?: number
  dimensions?: { width?: number; height?: number }
}

// 尺寸表 = **实际渲染尺寸**表（量存量节点用），不是「可创建类型」表。
// ⚠️ 与 `shared/src/index.ts` 的 NodeType 联合（4 项 = 可创建/可新建的类型）**是两个口径**：
//   NodeType 决定「agent 能建什么」；本表决定「已存在的节点量出来多大」——
//   下线类型的历史节点仍留在存量画布 JSON 里且**仍在渲染**（neoNodeMeta 的 prompt 高 120），
//   若按 fallback 280×160 量，放置内核算出的 bbox 会与真实渲染尺寸不符 ⇒ 可能压盖/误避让。
//   故本表 = 当前 4 项 + 仍在渲染的已下线类型（prompt），与 master 的 Nest 原表逐字一致
//   （b13750e3 铁律：放置内核不得静默改变排布尺寸；与 web 侧 useCanvasGrouping.ts 同表同值）。
const NODE_SIZES: Record<string, { w: number; h: number }> = {
  text: { w: 280, h: 160 },
  image: { w: 280, h: 280 },
  // 视频：长边基准 320（尺寸随比例 contain，包络 320×320）
  video: { w: 320, h: 320 },
  audio: { w: 280, h: 140 },
  // prompt 2026-10-17 下线（创建入口已断），但存量节点仍渲染为 280×120 ⇒ 按真实尺寸量，
  // 不走 fallback。group/shot/sceneComposer/mediaInput 等无渲染 ⇒ 走 fallback 280×160。
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

export type AlignSixWay = 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom'

/** 节点绝对包围盒（含 parentNode 偏移）；尺寸走既有 getNodeSize。 */
function absBox(node: LayoutNode, nodes: LayoutNode[]) {
  const abs = getAbsolutePosition(node, nodes)
  const { w, h } = getNodeSize(node)
  return { x: abs.x, y: abs.y, w, h, left: abs.x, right: abs.x + w, top: abs.y, bottom: abs.y + h,
    cx: abs.x + w / 2, cy: abs.y + h / 2 }
}

/**
 * 把 ids 节点按 mode 对齐到选中集极值/中线（Figma 口径）。
 * 返回**局部坐标**新位置（已减 parent 绝对偏移）；未选中节点不在映射中。
 * 坐标零模型参与：只重排，不改尺寸/内容（HN1 纪律同构）。
 */
export function alignNodes(nodes: LayoutNode[], ids: string[], mode: AlignSixWay): Record<string, { x: number; y: number }> {
  const sel = nodes.filter((n) => ids.includes(n.id))
  if (sel.length === 0) return {}
  const boxes = sel.map((n) => ({ id: n.id, ...absBox(n, nodes) }))
  let target = 0
  if (mode === 'left') target = Math.min(...boxes.map((b) => b.left))
  else if (mode === 'right') target = Math.max(...boxes.map((b) => b.right))
  else if (mode === 'centerH') target = (Math.min(...boxes.map((b) => b.left)) + Math.max(...boxes.map((b) => b.right))) / 2
  else if (mode === 'top') target = Math.min(...boxes.map((b) => b.top))
  else if (mode === 'bottom') target = Math.max(...boxes.map((b) => b.bottom))
  else if (mode === 'centerV') target = (Math.min(...boxes.map((b) => b.top)) + Math.max(...boxes.map((b) => b.bottom))) / 2
  const out: Record<string, { x: number; y: number }> = {}
  for (const b of boxes) {
    const node = sel.find((n) => n.id === b.id)!
    const abs = getAbsolutePosition(node, nodes)
    const offX = abs.x - node.position.x
    const offY = abs.y - node.position.y
    let nx = abs.x
    let ny = abs.y
    if (mode === 'left') nx = target
    else if (mode === 'right') nx = target - b.w
    else if (mode === 'centerH') nx = target - b.w / 2
    else if (mode === 'top') ny = target
    else if (mode === 'bottom') ny = target - b.h
    else if (mode === 'centerV') ny = target - b.h / 2
    out[b.id] = { x: nx - offX, y: ny - offY }
  }
  return out
}

/**
 * 沿 axis 把 ids 节点等空隙分布（Figma "distribute spacing"）：相邻包围盒空隙相等，
 * 首尾锚定不动。ids.length<3 → no-op 返回空映射。返回局部坐标。
 */
export function distributeNodes(nodes: LayoutNode[], ids: string[], axis: 'x' | 'y'): Record<string, { x: number; y: number }> {
  const sel = nodes.filter((n) => ids.includes(n.id))
  if (sel.length < 3) return {}
  const boxes = sel.map((n) => ({ id: n.id, ...absBox(n, nodes) }))
  const sorted = [...boxes].sort((p, q) => (axis === 'x' ? p.left - q.left : p.top - q.top))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const span = axis === 'x' ? last.right - first.left : last.bottom - first.top
  const totalSize = sorted.reduce((s, b) => s + (axis === 'x' ? b.w : b.h), 0)
  const gap = (span - totalSize) / (sorted.length - 1)
  const out: Record<string, { x: number; y: number }> = {}
  let cursor = axis === 'x' ? first.left : first.top
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i]
    if (i === 0 || i === sorted.length - 1) {
      cursor += (axis === 'x' ? b.w : b.h) + gap
      continue
    }
    const node = sel.find((n) => n.id === b.id)!
    const lead = axis === 'x' ? b.left : b.top
    const delta = cursor - lead
    out[b.id] = { x: node.position.x + (axis === 'x' ? delta : 0), y: node.position.y + (axis === 'y' ? delta : 0) }
    cursor += (axis === 'x' ? b.w : b.h) + gap
  }
  return out
}

export interface SnapBox { x: number; y: number; w: number; h: number }
export interface SnapCandidate { id: string; box: SnapBox; parentId?: string; isSelf?: boolean }
export interface SnapPrev { horizontal?: { position: number; sourceNodeId: string }; vertical?: { position: number; sourceNodeId: string } }
export interface SnapResult { horizontal?: { position: number; sourceNodeId: string }; vertical?: { position: number; sourceNodeId: string }; snapped: { x: number; y: number } }
export const SNAP_RADIUS = 8
export const SNAP_HYSTERESIS = 0.5

type Orient = 'h' | 'v'
const SNAP_ANCHORS: Record<string, { o: Orient; resolve: (b: SnapBox) => number }> = {
  left: { o: 'v', resolve: (b) => b.x },
  right: { o: 'v', resolve: (b) => b.x + b.w },
  centerX: { o: 'v', resolve: (b) => b.x + b.w / 2 },
  top: { o: 'h', resolve: (b) => b.y },
  bottom: { o: 'h', resolve: (b) => b.y + b.h },
  centerY: { o: 'h', resolve: (b) => b.y + b.h / 2 },
}

/** 一条「拖拽锚点 ↔ 候选锚点」同朝向配对（pos = 候选线所在的 flow 坐标）。 */
interface SnapPair { dist: number; pos: number; id: string; dragOffset: number }

/** 半径内取最近的一条线（同线自然落到更近的拖拽锚点——配对级比较自带此性质）。 */
function nearestWithinRadius(pairs: SnapPair[], radius: number): SnapPair | undefined {
  let best: SnapPair | undefined
  for (const p of pairs) {
    if (p.dist > radius) continue
    if (!best || p.dist < best.dist) best = p
  }
  return best
}

/**
 * 单朝向选线（SP-B R1 平滑化，2026-10-23 用户实测反馈「不丝滑/被吸住/步阶太大」）：
 *
 * ① 半径内取最近线（换线只认更近，并列取先碰到的一条 ⇒ 候选顺序稳定则不闪）；
 * ② **prev 粘滞**：prev 线在 `radius + hysteresis` 释放带内仍有配对 ⇒ 保持原线，
 *    除非挑战线明显更近（近过 hysteresis 余量）才接管。余量存在的原因：
 *    两条邻近线（如相距 6px）的中点附近，鼠标微抖会让「谁更近」反复易主，
 *    无余量时节点在两线之间来回跳 = 横向抖动；有余量则贴住不跳；
 * ③ prev 线整体离开释放带 ⇒ 交还①（可能无线 ⇒ 节点自由跟手）。
 *
 * ⛔ 历史缺陷（R1 修复）：旧实现 `if (!keepPrev && dist > radius) continue` 对
 *    prev 线配对**不设距离上限** —— 一旦吸上就永不脱钩（只有别的线更近才被顶掉），
 *    与规格「超出 SNAP_RADIUS + hysteresis 才解除」相反，正是「被吸住」的体感来源。
 */
function pickGuideLine(
  pairs: SnapPair[],
  prevPos: number | undefined,
  radius: number,
  hys: number,
): SnapPair | undefined {
  const best = nearestWithinRadius(pairs, radius)
  if (prevPos == null) return best
  // prev 线上距离拖拽锚点最近的配对（释放带内的保持对象）
  let prevBest: SnapPair | undefined
  for (const p of pairs) {
    if (Math.abs(p.pos - prevPos) > hys) continue
    if (!prevBest || p.dist < prevBest.dist) prevBest = p
  }
  if (!prevBest || prevBest.dist > radius + hys) return best // ③ 释放
  if (!best || best.pos === prevPos) return prevBest // 同线：取更近的拖拽锚点
  // ② 挑战线需近过余量才接管；否则保持 prev（贴住不跳）
  return best.dist < prevBest.dist - hys ? best : prevBest
}

/**
 * 拖拽智能参考线（移植 React Flow xyflow Helper Lines + manta SpatialIndex 思路）：
 * - 6 锚点；每个朝向（h/v）在阈值内只取**一条最近线**；
 * - hysteresis：prev 线在 `snapRadius + hysteresis` 内保持（防抖），
 *   挑战线需近过 hysteresis 余量才接管（防邻近两线临界点反复横跳）；
 * - 跳过 isSelf（调用方已标）；
 * - 视口裁剪由调用方做（候选只传视口内）。
 * - **阈值语义由调用方决定**：屏幕空间手感（半径/迟滞按 1/zoom 换算）由
 *   CanvasPage 传入 flow 空间的 snapRadius/hysteresis，本函数保持纯几何。
 */
export function computeSnapGuides(
  dragBox: SnapBox,
  candidates: SnapCandidate[],
  opts: { snapRadius?: number; hysteresis?: number; prev?: SnapPrev } = {},
): SnapResult {
  const radius = opts.snapRadius ?? SNAP_RADIUS
  const hys = opts.hysteresis ?? SNAP_HYSTERESIS
  const dragAnchors = Object.entries(SNAP_ANCHORS).map(([name, a]) => {
    const pos = a.resolve(dragBox)
    const off = (a.o === 'v' ? dragBox.x : dragBox.y) - pos
    return { name, o: a.o, pos, off }
  })
  const pairs: Record<Orient, SnapPair[]> = { v: [], h: [] }
  for (const c of candidates) {
    if (c.isSelf) continue
    for (const ca of Object.values(SNAP_ANCHORS)) {
      const cpos = ca.resolve(c.box)
      for (const da of dragAnchors) {
        if (da.o !== ca.o) continue
        pairs[ca.o].push({ dist: Math.abs(da.pos - cpos), pos: cpos, id: c.id, dragOffset: da.off })
      }
    }
  }
  const bestV = pickGuideLine(pairs.v, opts.prev?.vertical?.position, radius, hys)
  const bestH = pickGuideLine(pairs.h, opts.prev?.horizontal?.position, radius, hys)
  const snapped = { x: dragBox.x, y: dragBox.y }
  // 锚点贴到线 cpos ⇒ 新原点 = cpos + off（off = 原点 - 锚点坐标）。
  // ⛔ 不是 cpos - off：那会把非首要锚点（right/centerX）的配对放到线的错误一侧。
  if (bestV) snapped.x = bestV.pos + bestV.dragOffset
  if (bestH) snapped.y = bestH.pos + bestH.dragOffset
  return {
    vertical: bestV ? { position: bestV.pos, sourceNodeId: bestV.id } : undefined,
    horizontal: bestH ? { position: bestH.pos, sourceNodeId: bestH.id } : undefined,
    snapped,
  }
}
