# SP-A 批量创建即整齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 一次调用原子创建 ≤12 个节点 + ≤20 条边（单事务、单 SSE flush 一帧出现），落位由服务端放置内核保证零压盖、贴现有内容右侧生长。

**Architecture:** 新增 pi 工具 `create_nodes_batch`（薄暴露 Nest 沉睡端点 `addNodesBatch`，service.ts:899）；放置内核 `placeBatchNodes` 落 `packages/shared/src/canvas/layout.ts`（纯函数：锚点三级优先 → 链式右向 → bbox 避碰 → 网格吸附）；`upsertMediaNode` 创建路径本就包装 `addNodesBatch`（service.ts:1021-1037）⇒ 单建与批建零改动同享内核；批内连边用 `key` 索引、服务端解析为 nodeId（模型零参与 id）。

**Tech Stack:** TypeScript / NestJS（apps/server）/ @lnkpi/shared（pnpm workspace）/ pi-runtime（typebox 工具定义，node:test）/ Vue 3 + @vue-flow/core（apps/web）/ vitest（shared 与 server）/ node:test（pi-runtime）。

**Spec:** [docs/superpowers/specs/2026-10-20-agent-canvas-batch-layout-design.md](../specs/2026-10-20-agent-canvas-batch-layout-design.md)（PR #515；本计划的每个任务都从该规格论证，执行前先读规格对应章节）

## Global Constraints

- **HN1**：`create_nodes_batch` 工具永不接受 position 参数——坐标永远由 Nest 服务层放置内核计算。
- **HN2**：批内连边只接受本批 `key` 或既有节点 id 作端点；key→nodeId 解析完全在服务端。
- **HN3**：单批 ≤12 节点（`BATCH_NODES_MAX`）、≤20 边（与 `CONNECT_NODES_MAX_EDGES` 同值）；超限工具层抛可操作错误。
- 草稿-only：节点恒以 `status:'draft'` 创建；不启动生成；逐节点走既有 `propose_generation`。
- 放置计算只放 Nest 服务层；shared 模块是纯函数（无 IO、无时钟、无随机——确定性可金样测试）。
- prompt 点名走 `canvas_daily_ops`（加第 23 条，≤30 字符）；同步矩阵三处：disk md + `MANIFEST.yaml` contentHash + `prompt-registry.fallback.ts` 内嵌常量；`pnpm prompt:lint` L7 逐字校验把关（assembler test 的 EXPECTED 是常量引用，自动跟随）。
- tiering 注释内**禁出现带引号的工具名**（`verify-tool-tiering` 幽灵项误报）；新工具进 `ALWAYS_ON_TOOL_NAMES`（tiering 铁律：upsert 是部分替代品 ⇒ 必须常驻）。
- `addNodesBatch` 不得调用 `layoutNodesAlongEdges`（`agent-canvas-tools.no-auto-layout.test.ts:29-31` 源码扫描断言——放置内核不是 along_edges，不违反）。
- 跨包改动（shared/server/pi-runtime）完成后跑根目录 `pnpm build`；本机 pnpm 走 corepack shim（`PATH=/tmp/pnpm-shim:$PATH`）。
- 分支纪律：实现分支 `feat/agent-canvas-batch-layout` 从 `origin/master` 开（worktree 隔离）；规格+计划已在 `spec/agent-canvas-batch-layout`（PR #515），先合并规格 PR 再开实现分支。

## Review Focus

以下输入类规格未逐条明说、但最可能咬到真实用户——每条已固定到拥有该代码的任务：

1. **批内 key 恰好等于某既有 nodeId**（如 key=`image-1792`）：解析序「本批 key 优先」⇒ 边连到**新节点**而非同名旧节点。语义由 Task 3 测试固定（`resolves key before existing id`），错误信息不得暗示歧义。
2. **edges 引用不存在的 key/id**（模型拼写错）：fail-closed 整体 400、一个节点都不落库，错误逐条列未解析端点（Task 3 `fails closed on unresolved edge endpoints`）。
3. **恰好 12 节点 / 13 节点边界**：12 放行、13 在工具层被拒且错误文案含实际数量（Task 4 `rejects 13 nodes with actionable error`）。
4. **脏数据 existing**（position 缺字段 / NaN / 节点无 type）：放置内核 fail-open 不抛错（放置永不阻塞创建），输出仍为 20 倍数（Task 1 `tolerates malformed existing nodes`）。
5. **回合末 fitView 时 vueFlowRef 已卸载**（用户秒切页面）：try/catch 必须保留，不得因聚焦新节点把异常漏出（Task 5 保留既有 catch 结构 + 回归断言）。

---

## Task 1: shared 放置内核（layout.ts 上移 + placeBatchNodes）

**Files:**
- Create: `packages/shared/src/canvas/layout.ts`
- Modify: `packages/shared/src/index.ts`（追加 `export * from './canvas/layout'`，放在 workflowImportPlacement 导出行之后）
- Test: `packages/shared/src/canvas/layout.test.ts`

**Interfaces:**
- Consumes: `./workflowImportPlacement` 的 `rectsOverlap(a: Rect, b: Rect, margin)`、`unionNodeBBox(nodes: NodeLike[])`、`type Rect`、`type NodeLike`（既有，不重写——DRY，避免第三份避碰实现）；`../index` 的 `type CanvasNode`（type-only import，先例 `agentContract.ts:4` 注释「编译后擦除，不产生运行时循环」）。
- Produces:
  - `export type LayoutNode = CanvasNode & { parentNode?: string; style?: Record<string, unknown> | string; extent?: string; expandParent?: boolean; draggable?: boolean; selectable?: boolean; zIndex?: number; dimensions?: { width?: number; height?: number } }`（自 `apps/server/src/agent/canvas-layout.util.ts:5-14` 逐字上移）
  - `export function getNodeSize(node: LayoutNode): { w: number; h: number }`（逐字上移，含 `NODE_SIZES` 全表与 `parseStyleSize`）
  - `export function getAbsolutePosition(node: LayoutNode, nodes: LayoutNode[]): { x: number; y: number }`（逐字上移）
  - `export function snapToGrid(value: number, grid = PLACEMENT_GRID): number`；`export const PLACEMENT_GRID = 20`
  - `export function placeBatchNodes(existing: LayoutNode[], items: Array<{ key: string; type: string }>, edges?: Array<{ source: string; target: string }>): Map<string, { x: number; y: number }>`
  - 常数（模块内私有，测试经行为断言不直接引用）：`PLACEMENT_H_GAP=40`、`PLACEMENT_ROW_WIDTH=1120`、`PLACEMENT_COLLISION_PAD=12`、`PLACEMENT_MAX_STEPS=24`、`PLACEMENT_ORIGIN={x:80,y:80}`

- [ ] **Step 1: 写失败测试**（`packages/shared/src/canvas/layout.test.ts`，全文如下）

```ts
import { describe, expect, it } from 'vitest'
import {
  getAbsolutePosition,
  getNodeSize,
  placeBatchNodes,
  type LayoutNode,
} from './layout'
import { rectsOverlap, type Rect } from './workflowImportPlacement'

function node(id: string, type: string, x: number, y: number, parentNode?: string): LayoutNode {
  return { id, type, position: { x, y }, data: {}, parentNode }
}

describe('placeBatchNodes（SP-A 放置内核）', () => {
  it('空画布首批：从 (80,80) 链式右向，间距 40', () => {
    const out = placeBatchNodes(
      [],
      [
        { key: 'a', type: 'image' },
        { key: 'b', type: 'image' },
        { key: 'c', type: 'image' },
      ],
    )
    expect(out.get('a')).toEqual({ x: 80, y: 80 })
    expect(out.get('b')).toEqual({ x: 400, y: 80 }) // 80 + 280 + 40
    expect(out.get('c')).toEqual({ x: 720, y: 80 })
  })

  it('边引用锚点优先于分量锚点：落被引用节点右缘', () => {
    const existing = [
      node('n1', 'image', 1000, 500),
      node('n2', 'image', 2000, 900), // 孤立点
      node('n3', 'text', 1200, 700),
    ]
    const out = placeBatchNodes(existing, [{ key: 'a', type: 'image' }], [
      { source: 'n3', target: 'a' }, // target 'a' 是本批 key，不计锚点；source n3 计 1 次
    ])
    expect(out.get('a')).toEqual({ x: 1200 + 280 + 40, y: 700 })
  })

  it('无引用边：锚点取最大弱连通分量 bbox 右缘，离群点不进锚点', () => {
    const existing = [
      node('n1', 'image', 1000, 500),
      node('n3', 'text', 1200, 700), // 与 n1 同分量（既有边 n1->n3）
      node('n2', 'image', 4000, 900), // 离群点，不得影响锚点
    ]
    const out = placeBatchNodes(existing, [{ key: 'a', type: 'image' }], [
      { source: 'n1', target: 'n3' },
    ])
    // 分量 {n1,n3} bbox：x 1000..1480, y 500..860 ⇒ 右缘 (1520, 500)
    expect(out.get('a')).toEqual({ x: 1520, y: 500 })
  })

  it('分组子节点按绝对坐标参与避碰', () => {
    const existing = [node('g', 'group', 1000, 1000), node('c1', 'image', 40, 40, 'g')]
    const out = placeBatchNodes(
      existing,
      [
        { key: 'a', type: 'image' },
        { key: 'b', type: 'image' },
      ],
      [],
    )
    // 无引用边 ⇒ 分量各自单点并列 ⇒ 取 bbox 面积大者：{c1} 面积 78400 > {g} 44800
    // c1 绝对 (1040,1040) ⇒ 锚点右缘 (1360,1040)
    expect(out.get('a')).toEqual({ x: 1360, y: 1040 })
    const b = out.get('b')!
    const bRect: Rect = { x: b.x, y: b.y, width: 280, height: 280 }
    const c1Rect: Rect = { x: 1040, y: 1040, width: 280, height: 280 }
    expect(rectsOverlap(bRect, c1Rect, 12)).toBe(false)
  })

  it('密集区：候选点被占时垂直步进避让', () => {
    const existing = [node('n1', 'image', 400, 80), node('n2', 'image', 720, 80)]
    const out = placeBatchNodes(existing, [{ key: 'a', type: 'image' }], [
      { source: 'n1', target: 'a' }, // 锚点 = n1 右缘 (720,80)，该处被 n2 占据
    ])
    // n2 绝对范围 y 68..372（pad 12 膨胀）⇒ 垂直步进到 400 才不相交
    expect(out.get('a')).toEqual({ x: 720, y: 400 })
  })

  it('长链：超行宽 1120 换行', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, type: 'image' }))
    const out = placeBatchNodes([], items)
    expect(out.get('k0')).toEqual({ x: 80, y: 80 })
    expect(out.get('k1')).toEqual({ x: 400, y: 80 })
    expect(out.get('k2')).toEqual({ x: 720, y: 80 })
    expect(out.get('k3')).toEqual({ x: 80, y: 400 }) // 换行：y = 80 + 280 + 40
    expect(out.get('k4')).toEqual({ x: 400, y: 400 })
  })

  it('确定性：同输入两次调用逐点相等', () => {
    const existing = [node('n1', 'image', 300, 300)]
    const items = [
      { key: 'a', type: 'image' },
      { key: 'b', type: 'video' },
    ]
    const first = placeBatchNodes(existing, items, [{ source: 'n1', target: 'a' }])
    const second = placeBatchNodes(existing, items, [{ source: 'n1', target: 'a' }])
    expect([...first.entries()]).toEqual([...second.entries()])
  })

  it('网格吸附：输出均为 20 倍数', () => {
    const existing = [node('n1', 'image', 413, 257)]
    const out = placeBatchNodes(existing, [{ key: 'a', type: 'text' }])
    for (const p of out.values()) {
      expect(p.x % 20).toBe(0)
      expect(p.y % 20).toBe(0)
    }
  })

  it('脏数据 existing：position NaN / 无 type 不抛错，输出仍网格吸附', () => {
    const dirty = [
      { id: 'd1', type: '', position: { x: Number.NaN, y: Number.NaN }, data: {} },
      { id: 'd2', position: { x: 100, y: 100 }, data: {} },
    ] as unknown as LayoutNode[]
    const out = placeBatchNodes(dirty, [{ key: 'a', type: 'image' }])
    const p = out.get('a')!
    expect(Number.isFinite(p.x)).toBe(true)
    expect(Number.isFinite(p.y)).toBe(true)
    expect(p.x % 20).toBe(0)
    expect(p.y % 20).toBe(0)
  })

  it('空 items 返回空 Map', () => {
    expect(placeBatchNodes([node('n1', 'image', 0, 0)], []).size).toBe(0)
  })
})

describe('上移回归（getNodeSize / getAbsolutePosition 逐字等价）', () => {
  it('getNodeSize：style/dimensions 优先于 NODE_SIZES 表', () => {
    expect(getNodeSize({ id: 'x', type: 'image', position: { x: 0, y: 0 }, data: {} })).toEqual({
      w: 280,
      h: 280,
    })
    expect(
      getNodeSize({
        id: 'x',
        type: 'image',
        position: { x: 0, y: 0 },
        data: {},
        dimensions: { width: 100, height: 50 },
      }),
    ).toEqual({ w: 100, h: 50 })
    expect(
      getNodeSize({
        id: 'x',
        type: 'unknown-type',
        position: { x: 0, y: 0 },
        data: {},
        style: { width: '120px', height: 60 },
      }),
    ).toEqual({ w: 120, h: 60 })
  })

  it('getAbsolutePosition：嵌套分组逐级累加', () => {
    const nodes = [
      node('g1', 'group', 100, 100),
      node('g2', 'group', 50, 50, 'g1'),
      node('c', 'image', 10, 20, 'g2'),
    ]
    expect(getAbsolutePosition(nodes[2], nodes)).toEqual({ x: 160, y: 170 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/shared && pnpm vitest run src/canvas/layout.test.ts`
Expected: FAIL——`Cannot find module './layout'`（文件未建）

- [ ] **Step 3: 写实现**（`packages/shared/src/canvas/layout.ts`，全文如下）

```ts
// SP-A（2026-10-20）：批量创建放置内核 + 布局原语上移（自 apps/server/src/agent/canvas-layout.util.ts
// 逐字上移 NODE_SIZES/getNodeSize/getAbsolutePosition/LayoutNode，保 Nest 侧 import 面与行为不变）。
// 避碰/bbox 复用 canvas/workflowImportPlacement（既有 shared 资产，不重写第三份）。
// type-only：CanvasNode 定义在 barrel（index.ts），仅类型引用，编译后擦除，不产生运行时循环
import type { CanvasNode } from '../index'
import { rectsOverlap, unionNodeBBox, type NodeLike, type Rect } from './workflowImportPlacement'

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

/** 既有节点的绝对坐标 bbox 列表（分组子节点按 getAbsolutePosition 换算参与避碰）。 */
function obstacleRects(nodes: LayoutNode[]): Rect[] {
  return nodes.map((n) => {
    const abs = getAbsolutePosition(n, nodes)
    const size = getNodeSize(n)
    return toRect(abs.x, abs.y, size.w, size.h)
  })
}

function absPointOf(node: LayoutNode, nodes: LayoutNode[]): { x: number; y: number } {
  return getAbsolutePosition(node, nodes)
}

/** 最大弱连通分量（按既有边并查集；并列取 bbox 面积大者）。 */
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
  let best: LayoutNode[] = []
  for (const list of groups.values()) {
    if (list.length > best.length) {
      best = list
      continue
    }
    if (list.length === best.length && list.length > 0) {
      const areaOf = (ns: LayoutNode[]) => {
        const b = unionNodeBBox(ns.map((n) => ({ id: n.id, position: absPointOf(n, nodes) })))
        return b ? b.width * b.height : 0
      }
      if (areaOf(list) > areaOf(best)) best = list
    }
  }
  return best
}

/** 锚点三级优先（规格 §8.1 A1）：① 边引用的既有节点右缘 → ② 最大分量 bbox 右缘 → ③ (80,80)。 */
function resolveAnchor(
  nodes: LayoutNode[],
  edges: Array<{ source: string; target: string }>,
): { x: number; y: number } {
  if (nodes.length === 0) return { ...PLACEMENT_ORIGIN }
  const refCount = new Map<string, number>()
  for (const e of edges) {
    refCount.set(e.source, (refCount.get(e.source) ?? 0) + 1)
    refCount.set(e.target, (refCount.get(e.target) ?? 0) + 1)
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
  const bbox = unionNodeBBox(component.map((n) => ({ id: n.id, position: absPointOf(n, nodes) })))
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
  const anchor = resolveAnchor(existing, edges ?? [])
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
```

- [ ] **Step 4: 在 index.ts 追加导出并跑全量 shared 测试**

Edit `packages/shared/src/index.ts`（在 `export * from './canvas/workflowImportPlacement'` 行后加一行）：

```ts
export * from './canvas/layout'
```

Run: `cd packages/shared && pnpm vitest run`
Expected: PASS——layout.test.ts 金样 10+2 用例全绿；shared 既有测试零回归（re-export 未动既有导出）

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/canvas/layout.ts packages/shared/src/canvas/layout.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): SP-A 放置内核 placeBatchNodes + 布局原语上移（layout.ts）"
```

---

## Task 2: Nest canvas-layout.util.ts 切换为 shared re-export

**Files:**
- Modify: `apps/server/src/agent/canvas-layout.util.ts`（删除上移部分，改 import from `@lnkpi/shared`；其余函数原地不动）
- Test: 既有测试零回归（`agent-canvas-tools.service.test.ts`、`composition*.test.ts`、`workflowImportPlacement.test.ts` 等所有 import 链上的既有测试）

**Interfaces:**
- Consumes: Task 1 产出的 `getNodeSize` / `getAbsolutePosition` / `LayoutNode` / `placeBatchNodes` / `snapToGrid`（from `@lnkpi/shared`）。
- Produces: `canvas-layout.util.ts` 的既有导出面不变（`GROUP_PADDING`、`createGroupFromNodes`、`ungroupNode`、`layoutNodesAlongEdges`、`layoutNodesInGrid`、`moveNodes`、`applyLayoutOps`、`summarizeLayoutGroups`、`getNodeSize`、`getAbsolutePosition`、`LayoutNode`）——Nest 侧调用方零改动。

- [ ] **Step 1: 改文件头**（先跑一次既有测试拿基线，确认当前全绿）

Run: `pnpm --filter @lnkpi/server exec vitest run src/agent/agent-canvas-tools.service.test.ts src/agent/agent-canvas-tools.no-auto-layout.test.ts`
Expected: PASS（基线；若红先修绿再继续）

- [ ] **Step 2: 应用修改**

Edit `apps/server/src/agent/canvas-layout.util.ts`：

1. 删除文件头部第 1-72 行中的：`import type { CanvasNode } from '@lnkpi/shared'`（第 1 行）、`export type LayoutNode = ...`（第 5-14 行）、`const NODE_SIZES = ...`（第 16-29 行）、`function parseStyleSize ...`（第 31-48 行）、`export function getNodeSize ...`（第 50-58 行）、`export function getAbsolutePosition ...`（第 60-72 行）。
2. 在第 1 行位置替换为：

```ts
// SP-A：布局原语已上移 @lnkpi/shared（packages/shared/src/canvas/layout.ts，放置内核单建/批建同享）。
// 此处 re-export 保 Nest 侧既有 import 面不变；行为等价由 Task 1 金样测试 + 本文件既有测试锁。
import { getAbsolutePosition, getNodeSize, placeBatchNodes, type LayoutNode } from '@lnkpi/shared'

export { getAbsolutePosition, getNodeSize, placeBatchNodes, type LayoutNode }
```

3. 保留 `GROUP_PADDING`（第 3 行）及其后所有函数原文不动——它们内部对 `getNodeSize` / `getAbsolutePosition` 的同名调用因顶部 import 而继续解析。

- [ ] **Step 3: 跑 server 侧 import 链全量测试**

Run: `pnpm --filter @lnkpi/server exec vitest run src/agent/`
Expected: PASS——含 `agent-canvas-tools.service.test.ts`（import 链重度用户）、`no-auto-layout`、`controller.test.ts`、composition/workflow 相关测试零回归

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/agent/canvas-layout.util.ts
git commit -m "refactor(server): canvas-layout.util 切换 shared re-export（SP-A 内核合一，行为等价）"
```

---

## Task 3: addNodesBatch 扩展（edges 同事务解析 + key 校验 + cap + 放置内核）

**Files:**
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts`（`addNodesBatch`，:899-975；文件级常量区 :68-69 附近加 `BATCH_NODES_MAX`）
- Modify: `apps/server/src/agent/agent-canvas-tools.controller.ts`（`AddNodesBatchDto` :149-164 加 `edges` 字段；`EdgeDto` :166-172 与 `ConnectNodesDto` :174-186 是现成先例）
- Test: `apps/server/src/agent/agent-canvas-tools.service.test.ts`（追加 describe；mock 装配模式沿用文件既有 `canvas` 可变态 + `sessionFindUnique`/`sessionUpdate`）

**Interfaces:**
- Consumes: Task 1 的 `placeBatchNodes(existing, items, edges?)` 与 `LayoutNode`；既有 `applyOrStage`（:973 已在用）、`edgeId(source, target)`（connectNodes :1181 在用）、`nextNodeId`、`modalityDefaults`。
- Produces: `addNodesBatch(input: { sessionId, userId, items: Array<{key,title,targetType,prompt?,position?,...}>, edges?: Array<{source,target}>, stage? }): Promise<{ nodes: Array<{key,nodeId}>, actions: CanvasAction[] }>`——Task 4 的 pi 工具经 `POST /agent/internal/add-nodes-batch` 消费；服务端导出 `export const BATCH_NODES_MAX = 12`。

- [ ] **Step 1: 写失败测试**（在 `agent-canvas-tools.service.test.ts` 的 `describe('AgentCanvasToolsService')` 内追加）

```ts
  describe('addNodesBatch 批量创建与边解析（SP-A）', () => {
    const batch = (over: Partial<{ items: unknown[]; edges: Array<{ source: string; target: string }> }> = {}) =>
      svc.addNodesBatch({
        sessionId: 's1',
        userId: 'u1',
        items: [
          { key: 'a', title: 'A', targetType: 'image', prompt: 'pa' },
          { key: 'b', title: 'B', targetType: 'image', prompt: 'pb' },
        ],
        ...over,
      } as never)

    it('edges 端点按「本批 key → 既有 id」解析，节点+边同一批 actions', async () => {
      canvas = {
        nodes: [{ id: 'image-1', type: 'image', position: { x: 0, y: 0 }, data: {} }],
        edges: [],
      }
      const out = await batch({
        edges: [
          { source: 'image-1', target: 'a' }, // 既有 id → 本批 key
          { source: 'a', target: 'b' }, // 本批 key → 本批 key
        ],
      })
      expect(out.nodes.map((n) => n.key)).toEqual(['a', 'b'])
      const edgeActions = out.actions.filter((a) => a.type === 'add_edge')
      expect(edgeActions).toHaveLength(2)
      const ids = new Set(out.nodes.map((n) => n.nodeId))
      const sources = edgeActions.map((a) => (a.payload as { source: string }).source)
      const targets = edgeActions.map((a) => (a.payload as { target: string }).target)
      expect(sources).toContain('image-1')
      expect(sources).toContain(out.nodes[0].nodeId)
      expect(targets).toEqual([out.nodes[0].nodeId, out.nodes[1].nodeId])
    })

    it('key 与既有 nodeId 撞名时 key 优先（解析序固定，Review#1）', async () => {
      canvas = {
        nodes: [{ id: 'a', type: 'image', position: { x: 0, y: 0 }, data: {} }],
        edges: [],
      }
      const out = await batch({ edges: [{ source: 'a', target: 'b' }] })
      const edgeActions = out.actions.filter((a) => a.type === 'add_edge')
      expect(edgeActions).toHaveLength(1)
      // 'a' 解析为本批新节点（而非画布上同名的旧节点）
      expect((edgeActions[0].payload as { source: string }).source).toBe(out.nodes[0].nodeId)
      expect(out.nodes[0].nodeId).not.toBe('a')
    })

    it('edges 引用不存在的 key/id ⇒ fail-closed 整体 400 且不落库（Review#2）', async () => {
      canvas = { nodes: [], edges: [] }
      await assert.rejects(
        () => batch({ edges: [{ source: 'ghost-key', target: 'a' }] }),
        /ghost-key/,
      )
      expect(sessionUpdate).not.toHaveBeenCalled()
      expect(canvas.nodes).toHaveLength(0)
    })

    it('key 批内重复 / 空 ⇒ 400', async () => {
      await assert.rejects(
        () =>
          svc.addNodesBatch({
            sessionId: 's1',
            userId: 'u1',
            items: [
              { key: 'a', title: 'A', targetType: 'image', prompt: 'pa' },
              { key: 'a', title: 'A2', targetType: 'image', prompt: 'pa2' },
            ],
          } as never),
        /key 重复/,
      )
      await assert.rejects(
        () =>
          svc.addNodesBatch({
            sessionId: 's1',
            userId: 'u1',
            items: [{ key: '  ', title: 'A', targetType: 'image', prompt: 'pa' }],
          } as never),
        /key 不能为空/,
      )
    })

    it('items 超 BATCH_NODES_MAX ⇒ 400', async () => {
      const items = Array.from({ length: 13 }, (_, i) => ({
        key: `k${i}`,
        title: `T${i}`,
        targetType: 'image',
        prompt: 'p',
      }))
      await assert.rejects(
        () => svc.addNodesBatch({ sessionId: 's1', userId: 'u1', items } as never),
        /最多 12/,
      )
    })

    it('落位走放置内核：空画布首批 = (80,80) 链式，不再用网格取模', async () => {
      const out = await batch()
      const positions = out.actions
        .filter((a) => a.type === 'add_node')
        .map((a) => (a.payload as { position: { x: number; y: number } }).position)
      expect(positions).toEqual([
        { x: 80, y: 80 },
        { x: 400, y: 80 },
      ])
    })

    it('单建 upsertMediaNode 同享放置内核（不传 position 时）', async () => {
      const out = await svc.upsertMediaNode({
        sessionId: 's1',
        userId: 'u1',
        targetType: 'image',
        prompt: 'solo',
      } as never)
      const position = (
        out.actions.find((a) => a.type === 'add_node')!.payload as { position: { x: number; y: number } }
      ).position
      expect(position).toEqual({ x: 80, y: 80 })
    })
  })
```

注意：若测试文件顶部未 import `assert`，用既有 import（`vitest` 的 `expect` + `await expect(...).rejects.toThrow(/.../)`）替代 `assert.rejects`——执行时任选一种，全文统一。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @lnkpi/server exec vitest run src/agent/agent-canvas-tools.service.test.ts -t "addNodesBatch"`
Expected: FAIL——`edges` 参数不存在（类型报错或运行时不产 add_edge）；落位断言失败（旧网格公式给 `{x:80,y:80}` 恰好撞对第一个——把「落位」用例的 existing 预置一个节点使旧公式给出 `{x:360,y:80}` 而内核给避碰值，确保红）

- [ ] **Step 3: 实现 service.ts 扩展**

在 `agent-canvas-tools.service.ts` 常量区（:68-69 `GRID_X`/`GRID_Y` 旁）加：

```ts
/** SP-A：addNodesBatch 单批节点上限（pi 工具 create_nodes_batch 同值；tool 层先拦，此处兜底）。 */
export const BATCH_NODES_MAX = 12
```

将 `addNodesBatch`（:899-975）整体替换为：

```ts
  async addNodesBatch(input: {
    sessionId: string
    userId: string
    items: Array<{
      key: string
      title: string
      targetType: NodeType | string
      prompt?: string
      position?: { x: number; y: number }
      pipeline?: string
      imageAspect?: string
      videoSettings?: {
        aspectRatio?: string
        duration?: number
        resolution?: string
        crop?: string
        generateAudio?: boolean
      }
      videoMode?: string
      referenceImageUrl?: string
      guideSceneId?: string
      guideEditIntentId?: string
    }>
    /** SP-A：批内连边。端点按「本批 key → 既有节点 id」序解析；未解析 fail-closed 整体 400。 */
    edges?: Array<{ source: string; target: string }>
    stage?: boolean
  }): Promise<{ nodes: Array<{ key: string; nodeId: string }>; actions: CanvasAction[] }> {
    const { canvas } = await this.loadOwnedSession(input.sessionId, input.userId)

    // E3：key 批内唯一 + 非空 + 长度上限
    const seenKeys = new Set<string>()
    for (const item of input.items) {
      const key = String(item.key ?? '').trim()
      if (!key) throw new BadRequestException('items[].key 不能为空')
      if (key.length > 64) throw new BadRequestException('items[].key 长度不能超过 64')
      if (seenKeys.has(key)) throw new BadRequestException(`items[].key 重复：${key}`)
      seenKeys.add(key)
    }
    // E2：服务端兜底 cap（pi 工具层已有同款校验，双保险）
    if (input.items.length > BATCH_NODES_MAX) {
      throw new BadRequestException(`单批最多 ${BATCH_NODES_MAX} 个节点（got ${input.items.length}）`)
    }

    const prefs = await this.loadAccountGenPrefs(input.userId)

    // 放置内核：一次性算全批（锚点感知 edges 引用的既有节点；本批 key 天然不进锚点统计）
    const placements = placeBatchNodes(
      canvas.nodes as LayoutNode[],
      input.items.map((it) => ({ key: it.key, type: String(it.targetType || 'image') })),
      input.edges,
    )

    const actions: CanvasAction[] = []
    const mapping: Array<{ key: string; nodeId: string }> = []

    for (let i = 0; i < input.items.length; i++) {
      const item = input.items[i]
      const nodeType = (item.targetType || 'image') as NodeType
      const nodeId = nextNodeId(nodeType)
      const position = item.position ?? placements.get(item.key) ?? { x: 80, y: 80 }
      const defaults = modalityDefaults(nodeType, prefs)
      const nodeData: Record<string, unknown> = {
        title: item.title,
        manifestKey: item.key,
        prompt: item.prompt ?? '',
        status: 'draft',
        ...defaults,
      }
      if (item.pipeline) nodeData.pipeline = item.pipeline
      if (item.imageAspect) nodeData.imageAspect = item.imageAspect
      if (item.videoSettings && typeof item.videoSettings === 'object') {
        const base =
          nodeData.videoSettings && typeof nodeData.videoSettings === 'object'
            ? (nodeData.videoSettings as Record<string, unknown>)
            : {}
        nodeData.videoSettings = { ...base, ...item.videoSettings }
      }
      if (item.videoMode) nodeData.videoMode = item.videoMode
      if (item.referenceImageUrl) nodeData.referenceImageUrl = item.referenceImageUrl
      if (item.guideSceneId) nodeData.guideSceneId = item.guideSceneId
      if (item.guideEditIntentId) nodeData.guideEditIntentId = item.guideEditIntentId
      actions.push({
        type: 'add_node',
        payload: {
          id: nodeId,
          nodeType,
          position,
          data: nodeData,
        },
      })
      mapping.push({ key: item.key, nodeId })
    }

    // E1：edges 端点解析（key 优先于既有 id）+ 批内/库内去重 + fail-closed
    if (input.edges?.length) {
      const idByKey = new Map(mapping.map((m) => [m.key, m.nodeId]))
      const nodeIds = new Set(canvas.nodes.map((n) => n.id))
      const unresolved: string[] = []
      const seenEdges = new Set<string>()
      for (const e of input.edges) {
        const source = idByKey.get(e.source) ?? (nodeIds.has(e.source) ? e.source : null)
        const target = idByKey.get(e.target) ?? (nodeIds.has(e.target) ? e.target : null)
        if (!source || !target) {
          unresolved.push(`${e.source} -> ${e.target}`)
          continue
        }
        const dedupeKey = `${source}->${target}`
        if (seenEdges.has(dedupeKey)) continue
        seenEdges.add(dedupeKey)
        actions.push({
          type: 'add_edge',
          payload: {
            id: edgeId(source, target),
            source,
            target,
          },
        })
      }
      if (unresolved.length > 0) {
        throw new BadRequestException(
          `edges 端点无法解析（不在本批 key 也不在画布节点）：${unresolved.join('; ')}`,
        )
      }
    }

    await this.applyOrStage(input.sessionId, actions, input.stage)
    return { nodes: mapping, actions }
  }
```

文件顶部 import 区补（若尚无）：

```ts
import { placeBatchNodes, type LayoutNode } from './canvas-layout.util'
```

（`GRID_X`/`GRID_Y` 常量与 :1611/:2698 两处旧公式**保持不动**——规格 §12 登记的遗留，本任务不扩大改动面。）

- [ ] **Step 4: 实现 controller DTO 扩展**

Edit `apps/server/src/agent/agent-canvas-tools.controller.ts`：`AddNodesBatchDto`（:149-164）的 `items` 字段后、`stage` 前插入：

```ts
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => EdgeDto)
  @ArrayMaxSize(BATCH_NODES_MAX * 2)
  edges?: EdgeDto[]
```

（`EdgeDto` :166 已定义；`BATCH_NODES_MAX` 从 service import；`@ArrayMaxSize` 若未 import 则从 `class-validator` 补。边数上限取 24 = 节点上限×2，与规格「≤20」的表述差异以工具层 20 为准——DTO 只是兜底不卡合法请求。若评审要求严格 20，改 `@ArrayMaxSize(20)`。）

- [ ] **Step 5: 跑测试确认通过 + 源码扫描回归**

Run: `pnpm --filter @lnkpi/server exec vitest run src/agent/agent-canvas-tools.service.test.ts src/agent/agent-canvas-tools.no-auto-layout.test.ts src/agent/agent-canvas-tools.controller.test.ts`
Expected: PASS——新增 7 用例全绿；`no-auto-layout` 的 `addNodesBatch does not arrange` 继续过（放置内核不是 along_edges）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agent/agent-canvas-tools.service.ts apps/server/src/agent/agent-canvas-tools.controller.ts apps/server/src/agent/agent-canvas-tools.service.test.ts
git commit -m "feat(server): addNodesBatch 支持 edges 同事务解析 + key 校验 + cap + 放置内核落位（SP-A）"
```

---

## Task 4: pi-runtime create_nodes_batch 工具 + tiering 常驻登记

**Files:**
- Modify: `services/pi-runtime/src/tools/canvas-write.ts`（write 工具数组内、`connect_nodes`（:968-990）之后插入新工具定义）
- Modify: `services/pi-runtime/src/tools/tiering.ts`（`ALWAYS_ON_TOOL_NAMES` 加一行，:97 `connect_nodes` 之后）
- Modify: `services/pi-runtime/src/tools/tiering.test.ts`（`ALL_NAMES` 的 write 段 :63 后加名；常驻断言数组 :122 后加名）
- Test: `services/pi-runtime/src/tools/create-nodes-batch.test.ts`（新建，delete-nodes.test.ts 模式）

**Interfaces:**
- Consumes: Task 3 的 `POST /agent/internal/add-nodes-batch`（body: `{ sessionId, userId, items, edges }`；items 字段 `{key,title,targetType,prompt}`，edges 字段 `{source,target}`）；既有 `withWriteSignal`、`client.post`、`LnkpiToolContext`。
- Produces: 工具 `create_nodes_batch`（tier `graph_batch`，常驻）；模块常量 `CREATE_NODES_BATCH_MAX_NODES = 12` / `CREATE_NODES_BATCH_MAX_EDGES = 20`（canvas-write.ts 内，`CONNECT_NODES_MAX_EDGES` 同款模式）。

- [ ] **Step 1: 写失败测试**（`services/pi-runtime/src/tools/create-nodes-batch.test.ts`，全文如下）

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvasWriteTools } from "./canvas-write.js";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";

type Recorded = { path: string; body: Record<string, unknown> };
function makeClient(calls: Recorded[]) {
	return {
		post: async (path: string, body: Record<string, unknown>) => {
			calls.push({ path, body });
			return { nodes: [{ key: "a", nodeId: "image-1" }], actions: [] };
		},
	};
}
const CTX: LnkpiToolContext = { sessionId: "sess-1", userId: "u1" } as LnkpiToolContext;

function findTool(name: string): LnkpiTool {
	const tools = createCanvasWriteTools(makeClient([]) as never, { includeDeferred: true } as never);
	const tool = tools.find((t) => t.name === name);
	assert.ok(tool, `tool ${name} not registered`);
	return tool;
}

test("create_nodes_batch：schema 不暴露 sessionId/userId（toolContext 安全模型锁）", () => {
	const schema = JSON.stringify(findTool("create_nodes_batch").parameters);
	assert.ok(!schema.includes("sessionId"), "sessionId must not be model-visible");
	assert.ok(!schema.includes("userId"), "userId must not be model-visible");
	assert.equal(findTool("create_nodes_batch").tier, "graph_batch");
});

test("create_nodes_batch：items 驼峰映射 + edges 透传，sessionId 只取 toolContext", async () => {
	const calls: Recorded[] = [];
	const tools = createCanvasWriteTools(makeClient(calls) as never, { includeDeferred: true } as never);
	const tool = tools.find((t) => t.name === "create_nodes_batch")!;
	await tool.execute!("1", {
		items: [
			{ key: "a", type: "image", prompt: "一只猫", title: "猫" },
			{ key: "b", type: "video", prompt: "猫在跑" },
		],
		edges: [{ source: "a", target: "b" }],
	} as never, undefined as never, CTX, undefined as never, undefined as never);
	assert.equal(calls[0].path, "/agent/internal/add-nodes-batch");
	const body = calls[0].body as Record<string, unknown>;
	assert.equal(body.sessionId, "sess-1");
	assert.equal(body.userId, "u1");
	assert.equal((body.items as unknown[]).length, 2);
	assert.equal((body.items as Array<{ targetType: string }>)[0].targetType, "image");
	assert.deepEqual(body.edges, [{ source: "a", target: "b" }]);
});

test("create_nodes_batch：13 个节点 → execute 内兜底拒绝（Review#3）", async () => {
	const tools = createCanvasWriteTools(makeClient([]) as never, { includeDeferred: true } as never);
	const tool = tools.find((t) => t.name === "create_nodes_batch")!;
	const items = Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, type: "image", prompt: "p" }));
	await assert.rejects(
		() =>
			tool.execute!("1", { items } as never, undefined as never, CTX, undefined as never, undefined as never),
		/at most 12 nodes \(got 13\)/,
	);
});

test("create_nodes_batch：21 条边 → 拒绝", async () => {
	const tools = createCanvasWriteTools(makeClient([]) as never, { includeDeferred: true } as never);
	const tool = tools.find((t) => t.name === "create_nodes_batch")!;
	const edges = Array.from({ length: 21 }, (_, i) => ({ source: `k${i}`, target: `k${i + 1}` }));
	await assert.rejects(
		() =>
			tool.execute!("1", { items: [{ key: "k0", type: "image", prompt: "p" }], edges } as never, undefined as never, CTX, undefined as never, undefined as never),
		/at most 20 edges/,
	);
});

test("create_nodes_batch：空 items → 拒绝", async () => {
	const tools = createCanvasWriteTools(makeClient([]) as never, { includeDeferred: true } as never);
	const tool = tools.find((t) => t.name === "create_nodes_batch")!;
	await assert.rejects(
		() => tool.execute!("1", { items: [] } as never, undefined as never, CTX, undefined as never, undefined as never),
		/requires at least one item/,
	);
});

test("create_nodes_batch：toolContext 缺 sessionId → fail-closed（不达 Nest）", async () => {
	const calls: Recorded[] = [];
	const tools = createCanvasWriteTools(makeClient(calls) as never, { includeDeferred: true } as never);
	const tool = tools.find((t) => t.name === "create_nodes_batch")!;
	await assert.rejects(
		() => tool.execute!("1", { items: [{ key: "a", type: "image", prompt: "p" }] } as never, undefined as never, {} as LnkpiToolContext, undefined as never, undefined as never),
		/missing sessionId/,
	);
	assert.equal(calls.length, 0, "must not reach Nest without sessionId");
});

test("create_nodes_batch：Nest 返回的 actions 进 details.actions（canvas_action SSE 通道）", async () => {
	const tools = createCanvasWriteTools(
		{
			post: async () => ({
				nodes: [{ key: "a", nodeId: "image-1" }],
				actions: [{ type: "add_node", payload: { id: "image-1" } }],
			}),
		} as never,
		{ includeDeferred: true } as never,
	);
	const tool = tools.find((t) => t.name === "create_nodes_batch")!;
	const out = (await tool.execute!("1", { items: [{ key: "a", type: "image", prompt: "p" }] } as never, undefined as never, CTX, undefined as never, undefined as never)) as {
		details: { actions: unknown[] };
	};
	assert.equal((out.details.actions as unknown[]).length, 1);
});
```

注：`createCanvasWriteTools` 的实际签名（client/opts 形状）以 `canvas-write.ts` 顶部导出与 `canvas-write.test.ts:4-20` 的既有用法为准；`execute` 的 6 参模式同该文件。若既有工厂不接受 `{ includeDeferred: true }`，按该文件实际第二参调整（工具注册与 includeDeferred 无关时直接传 client）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && pnpm test src/tools/create-nodes-batch.test.ts`
Expected: FAIL——`tool create_nodes_batch not registered`

- [ ] **Step 3: 实现工具定义**

在 `canvas-write.ts` 的 `connect_nodes` 定义（:968-990）之后、数组收尾 `];`（:991）之前插入：

```ts
		{
			tier: "graph_batch",
			name: "create_nodes_batch",
			label: "批量建节点",
			description:
				"Create multiple canvas nodes in one call (draft only, max 12 nodes + 20 edges per call). " +
				"Edges connect nodes in the same batch by their key, or reference existing nodes by id. " +
				"Does NOT start generation: call propose_generation per node afterwards.",
			parameters: Type.Object({
				items: Type.Array(
					Type.Object({
						key: Type.String({ description: "Batch-local unique id used to reference this node in edges" }),
						type: Type.String({ description: "Node type: image | video | text | audio" }),
						prompt: Type.String({ description: "Node prompt (required)" }),
						title: Type.Optional(Type.String({ description: "Node title (defaults to prompt)" })),
					}),
					{ description: "Nodes to create (max 12)" },
				),
				edges: Type.Optional(
					Type.Array(
						Type.Object({
							source: Type.String({ description: "Source: batch key or existing node id" }),
							target: Type.String({ description: "Target: batch key or existing node id" }),
						}),
						{ description: "Directed edges (max 20); endpoints resolve batch key first, then existing node id" },
					),
				),
			}),
			execute: async (_id, p: { items: Array<{ key: string; type: string; prompt: string; title?: string }>; edges?: Array<{ source: string; target: string }> }, _u, tc: LnkpiToolContext) => {
				if (!tc.sessionId) throw new Error("create_nodes_batch requires sessionId in toolContext");
				if (p.items.length === 0) {
					throw new Error("create_nodes_batch requires at least one item");
				}
				if (p.items.length > CREATE_NODES_BATCH_MAX_NODES) {
					throw new Error(
						`create_nodes_batch accepts at most ${CREATE_NODES_BATCH_MAX_NODES} nodes per call (got ${p.items.length})`,
					);
				}
				if (p.edges && p.edges.length > CREATE_NODES_BATCH_MAX_EDGES) {
					throw new Error(
						`create_nodes_batch accepts at most ${CREATE_NODES_BATCH_MAX_EDGES} edges per call (got ${p.edges.length})`,
					);
				}
				return withWriteSignal(
					await client.post("/agent/internal/add-nodes-batch", {
						sessionId: tc.sessionId,
						userId: tc.userId,
						items: p.items.map((it) => ({
							key: it.key,
							title: it.title ?? it.prompt,
							targetType: it.type,
							prompt: it.prompt,
						})),
						edges: p.edges,
					}),
					p.items.length,
				);
			},
		},
```

在 `canvas-write.ts` 常量区（`CONNECT_NODES_MAX_EDGES` 定义旁）加：

```ts
/** SP-A：create_nodes_batch 单批上限（Nest 侧 BATCH_NODES_MAX 同值；工具层先拦）。 */
const CREATE_NODES_BATCH_MAX_NODES = 12
const CREATE_NODES_BATCH_MAX_EDGES = 20
```

- [ ] **Step 4: tiering 常驻登记**

Edit `tiering.ts`：在 `"connect_nodes",`（:97）之后加一行（**注释里禁带引号的工具名**——理由写「upsert 是批量创建的部分替代品，铁律：常驻不许给延迟域凑部分答案」）：

```ts
	// SP-A 批量创建（2026-10-20）：upsert_media_node 常驻且能逐个建节点 ⇒ 按「常驻工具不得给
	// 延迟工具的领域凑部分答案」铁律必须常驻；prompt canvas_daily_ops 第 23 条逐字点名。
	"create_nodes_batch",
```

Edit `tiering.test.ts`：`ALL_NAMES` 的 write 段 `"connect_nodes",`（:63）之后加 `"create_nodes_batch",`；常驻断言数组（:122 `"connect_nodes",` 之后）加 `"create_nodes_batch",`。

- [ ] **Step 5: 跑 pi-runtime 全量测试 + tiering 校验**

Run: `cd services/pi-runtime && pnpm test`
Expected: PASS——新增 7 用例全绿；tiering 既有断言（常驻名单/幻觉项）零回归

Run: `pnpm verify-tool-tiering`
Expected: 退出码 0（无幽灵项）

- [ ] **Step 6: Commit**

```bash
git add services/pi-runtime/src/tools/canvas-write.ts services/pi-runtime/src/tools/tiering.ts services/pi-runtime/src/tools/tiering.test.ts services/pi-runtime/src/tools/create-nodes-batch.test.ts
git commit -m "feat(runtime): create_nodes_batch 批量创建工具 + tiering 常驻登记（SP-A）"
```

---

## Task 5: 前端回合末视口分流（有新节点只聚焦新节点）

**Files:**
- Modify: `apps/web/src/pages/CanvasPage.vue`（`handleAgentTurnComplete`，:1740-1747 的 fitView 段）
- Test: `apps/web/src/composables/useCanvasActions.test.ts`（追加混合 add_node+add_edge 批量应用回归锁）

**Interfaces:**
- Consumes: 既有 `vueFlowRef.value?.fitView`（`{ nodes: ids, padding, maxZoom, duration }` 用法先例：`composables/fitImportedViewport.ts:73`、`components/canvas/CanvasBottomLeftControls.vue:95`）；既有 `nodes.value`（loadSession 前的本地快照）。
- Produces: 无新导出（页面内函数改动）。行为契约：本回合新增节点集合非空 ⇒ `fitView({ nodes: 新节点 id 数组, padding: 0.45, maxZoom: 1.05, duration: 360 })`；为空 ⇒ 维持既有 `fitView({ padding: 0.24, duration: 360 })`。

- [ ] **Step 1: 写回归锁测试**（`useCanvasActions.test.ts` 追加；先跑确认现状即绿——这是既有功能的回归锁，不是新功能）

```ts
  it('批量 actions：混合 add_node + add_edge 一次应用齐全（SP-A 回归锁）', () => {
    // 前置：store 已初始化（沿用该文件既有 setup）
    const actions = [
      { type: 'add_node', payload: { id: 'image-1', nodeType: 'image', position: { x: 80, y: 80 }, data: { status: 'draft' } } },
      { type: 'add_node', payload: { id: 'image-2', nodeType: 'image', position: { x: 400, y: 80 }, data: { status: 'draft' } } },
      { type: 'add_edge', payload: { id: 'e-1-2', source: 'image-1', target: 'image-2' } },
    ]
    applyActionsToFlow(actions)
    // 节点与边同时到位（同一 SSE flush 的应用面）
    expect(flowNodes.value.map((n) => n.id)).toEqual(expect.arrayContaining(['image-1', 'image-2']))
    expect(flowEdges.value.map((e) => e.id)).toContain('e-1-2')
  })
```

注：`applyActionsToFlow` / `flowNodes` / `flowEdges` 的确切命名以 `useCanvasActions.test.ts` 既有用例为准，沿用其既有导入与 setup，不新造 harness。

Run: `pnpm --filter @lnkpi/web exec vitest run src/composables/useCanvasActions.test.ts`
Expected: PASS（回归锁建基；若红，先查是不是既有失败——与本次改动无关的失败以 CI 为准，记忆纪律）

- [ ] **Step 2: 改 handleAgentTurnComplete**

Edit `apps/web/src/pages/CanvasPage.vue`，将 :1740-1747：

```ts
async function handleAgentTurnComplete() {
  await loadSession()
  await nextTick()
  try {
    await vueFlowRef.value?.fitView({ padding: 0.24, duration: 360 })
  } catch {
    // ignore
  }
```

替换为：

```ts
async function handleAgentTurnComplete() {
  // SP-A：回拉前快照本地节点 id，回拉后差集即「本回合新节点」
  const beforeIds = new Set(nodes.value.map((n) => n.id))
  await loadSession()
  await nextTick()
  const newNodeIds = nodes.value.filter((n) => !beforeIds.has(n.id)).map((n) => n.id)
  try {
    if (newNodeIds.length > 0) {
      // 有新节点：只把新区域带入视口，不劫持用户的全局缩放（规格 §5.4）
      await vueFlowRef.value?.fitView({ nodes: newNodeIds, padding: 0.45, maxZoom: 1.05, duration: 360 })
    } else {
      await vueFlowRef.value?.fitView({ padding: 0.24, duration: 360 })
    }
  } catch {
    // ignore（含组件卸载竞态：vueFlowRef 已置空——Review#5）
  }
```

（其余行 :1748-1775 不动。）

- [ ] **Step 3: 跑受影响前端测试 + 类型检查**

Run: `pnpm --filter @lnkpi/web exec vitest run src/composables/useCanvasActions.test.ts src/composables/useCanvasGrouping.restore.test.ts`
Expected: PASS

Run: `cd apps/web && ./node_modules/.bin/vue-tsc --noEmit -p tsconfig.json`（约 11 分钟，可后台）
Expected: 零新增错误（改动只碰一个函数，diff 极小）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/CanvasPage.vue apps/web/src/composables/useCanvasActions.test.ts
git commit -m "feat(web): 回合末有新节点只聚焦新节点，不再无条件 fitView 全画布（SP-A）"
```

---

## Task 6: prompt 点名 + 全量收尾

**Files:**
- Modify: `prompt-registry/rules/canvas_daily_ops.md`（加第 23 条；frontmatter `version: 1.3.0` → `1.4.0`、`updated:` → `2026-10-20`）
- Modify: `prompt-registry/MANIFEST.yaml`（canvas_daily_ops 条目 :44-47：version 1.4.0 + contentHash 重算）
- Modify: `apps/server/src/agent/pi-runtime/prompt-registry.fallback.ts`（`CANVAS_DAILY_OPS` 常量 :67-70 追加同款第 23 条，逐字一致）
- Verify: `pnpm prompt:lint`、`pnpm verify-spec-figures`、根目录 `pnpm build`

**Interfaces:**
- Consumes: Task 4 的工具名与语义（点名文案）；AGENTS.md prompt 同步矩阵（contentHash = `sha256(body.trimEnd())` 前 12 位）。
- Produces: L6 组合新增约 30 字符（余量 161 内，`PROMPT_SPEC.md:75` 机检表）；`prompt-lint.yml` 独立流水线门禁通过。

- [ ] **Step 1: 改三处 prompt**

`prompt-registry/rules/canvas_daily_ops.md` 末尾追加：

```md
23. 批量建节点（≥2 个）用 create_nodes_batch：items 带 key，edges 用 key 连边；它只建草稿，生成仍逐节点 propose_generation。
```

frontmatter `version: 1.3.0` → `1.4.0`，`updated: 2026-10-06` → `updated: 2026-10-20`。

`prompt-registry/MANIFEST.yaml` 的 canvas_daily_ops 条目：`version: 1.3.0` → `1.4.0`；`contentHash: 443bbf94e59c` → 重算值（Step 2 命令产出）。

`prompt-registry.fallback.ts` 的 `CANVAS_DAILY_OPS` 模板字符串内、第 22 条之后追加同款一行（**逐字一致**，L7 校验）：

```
23. 批量建节点（≥2 个）用 create_nodes_batch：items 带 key，edges 用 key 连边；它只建草稿，生成仍逐节点 propose_generation。
```

- [ ] **Step 2: 重算 contentHash 并回填**

```bash
node -e "const fs=require('fs');const body=fs.readFileSync('prompt-registry/rules/canvas_daily_ops.md','utf8').split('---').slice(2).join('---').trimEnd();console.log(require('crypto').createHash('sha256').update(body).digest('hex').slice(0,12))"
```

（若与 MANIFEST 既有算法口径不符，以 `pnpm prompt:lint` 报错信息里的期望值为准回填——L7 会逐字比对磁盘 body 与内嵌常量。）

- [ ] **Step 3: 跑 prompt 校验与全量 build**

Run: `pnpm prompt:lint`
Expected: PASS——L6 预算 warning 不触发（新增 ~30 字符 < 161 余量）；L7 磁盘 body == 内嵌常量；contentHash 一致

Run: `pnpm verify-spec-figures`
Expected: PASS（规格文档已在 PR #515，本任务不改图）

Run: `PATH=/tmp/pnpm-shim:$PATH pnpm build`（根目录全量，跨包改动纪律；本机 corepack shim）
Expected: 全包 build 成功（shared/server/pi-runtime/web 均被本计划触及）

- [ ] **Step 4: Commit + 汇总 PR**

```bash
git add prompt-registry/rules/canvas_daily_ops.md prompt-registry/MANIFEST.yaml apps/server/src/agent/pi-runtime/prompt-registry.fallback.ts
git commit -m "feat(prompt): canvas_daily_ops 第 23 条点名 create_nodes_batch（SP-A，L6 余量内）"
```

推送分支，开 PR（base master，标题 `feat(agent): SP-A 批量创建即整齐（create_nodes_batch + 放置内核）`），PR 描述贴规格链接 + 六个 commit 清单 + 目视验收清单（见规格 §10）。

---

## Self-Review（写作时已执行）

**1. Spec coverage：** 规格 §1-§13 逐节对照——
- §1 目标 3 条 ⇒ Task 3（原子事务+edges）+ Task 1（放置内核）+ Task 4（key 引用）✓
- §2.1 范围六项 ⇒ Task 1（layout.ts）、Task 2（re-export）、Task 3（Nest 扩展）、Task 4（工具+tiering）、Task 5（视口）、Task 6（prompt）✓；§2.2 不做项全部未进计划 ✓
- §3 规格关系 ⇒ 计划 Global Constraints 固化 HN1-HN3 与「显式修订 D3」上下文；不改 2026-10-16 规格本体（修订记录在规格 §3.1，随 PR #515 合并生效）✓
- §4 接入判据 ⇒ Task 4 tiering 注释与「必须常驻」理由落地 ✓
- §5 架构/契约/视口 ⇒ Task 3/4/5 接口与参数（padding 0.45/maxZoom 1.05）逐字落地 ✓
- §6 主场景五条 ⇒ Task 1 金样（零压盖）+ Task 3（一帧事务）+ Task 5（视口）+ 目视验收（Task 6 PR 描述）✓
- §7 数据变更零 ⇒ 计划无 migration/schema 任务 ✓
- §8 算法 A1-A6 ⇒ Task 1 实现与 10 个金样用例逐条对应（锚点三级/链式/避碰/分组/网格/确定性）✓
- §9 文件清单 ⇒ 六个任务的 Files 块全覆盖；差异一处已注明：rectsOverlap/unionNodeBBox 复用 shared 既有资产（规格「自含」精神不变——NODE_SIZES/getNodeSize/getAbsolutePosition 仍上移自含）✓
- §10 测试策略 ⇒ 各任务 Step 4/5 的运行命令与预期 ✓
- §11 风险 R1-R5 ⇒ 对应 Review Focus 1-5 + 各任务测试 ✓
- §12 后续包 ⇒ 不在本计划；两处规格内登记遗留（:1611/:2698 旧公式、无新节点 fitView）在 Task 3/5 注释中明示不动 ✓

**2. Placeholder scan：** 无 TBD/TODO；无「适当处理」；所有代码步骤含完整可运行代码；测试断言值全部由规格常数手工推演（如 k3 换行 {80,400}、密集步进 {720,400}、锚点 {1520,500}）✓

**3. Type consistency：** `placeBatchNodes(existing: LayoutNode[], items: Array<{key,type}>, edges?: Array<{source,target}>): Map<string,{x,y}>` 在 Task 1 定义、Task 3 消费，签名一致；`LayoutNode` Task 1 上移、Task 2 re-export、Task 3 import，命名一致；工具 body 字段 `items/targetType/edges` 与 Nest `AddNodesBatchDto` 对齐；`BATCH_NODES_MAX`（Nest 导出）/`CREATE_NODES_BATCH_MAX_NODES`（runtime 私有）同值 12 并互注 ✓

**4. Review Focus：** 5 条全部固定到任务——#1 key 撞名 ⇒ Task 3 `resolves key before existing id`；#2 未解析端点 ⇒ Task 3 `fails closed on unresolved edge endpoints`；#3 边界 12/13 ⇒ Task 4 `rejects 13 nodes with actionable error`；#4 脏数据 ⇒ Task 1 `tolerates malformed existing nodes`；#5 卸载竞态 ⇒ Task 5 catch 保留 + 注释 ✓

**已知执行时注意（不是占位符，是环境纪律）：**
- Task 1 Step 4 用 `pnpm vitest run`（shared 包 script）；server 侧用 `pnpm --filter @lnkpi/server exec vitest run <path>`；pi-runtime 用 `pnpm test <path>`（node:test  glob）。
- Task 3 测试里 `assert.rejects` 若该文件未 import node assert，统一改用 vitest `await expect(...).rejects.toThrow(/…/)`。
- Task 4 测试的 `createCanvasWriteTools` 第二参形状以 `canvas-write.test.ts` 既有用法为准微调。
