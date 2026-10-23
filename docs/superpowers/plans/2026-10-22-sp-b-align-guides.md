# SP-B 对齐与参考线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给画布补上「多选精排」与「拖拽对齐感知」——align 六向 + distribute H/V（用户工具条与 agent 工具同源）+ 拖拽中 8px 智能参考线，消除「画布很凌乱」的最大交互来源。

**Architecture:** 三个纯几何原语（`alignNodes` / `distributeNodes` / `computeSnapGuides`）落 `packages/shared/src/canvas/layout.ts`，框架无关、可单测、复用 SP-A 的 `getNodeSize`/`getAbsolutePosition`。用户工具条与 agent 工具都下发**同一 `arrange_nodes` canvas_command**（`mode` 扩 `'align'|'distribute'`），由前端 `CanvasPage` 执行器分支消费 shared 纯函数、`setNodes` + `persistUserEdit`。拖拽参考线是纯前端实时层，拦截 `onNodesChange` 的位置变更调 `computeSnapGuides`。**不新增任何 Nest HTTP op**——坐标变更必须前端执行（直调 Nest 会被下一次 `saveCanvas` 整份覆盖，见 `CanvasPage.vue:2162`）。

**Tech Stack:** TypeScript（shared / pi-runtime / web 三包同源）、Vue 3 + `@vue-flow/core`、Vitest / `node:test`、design-token 体系（L2/L3，禁新增 hex）。

**Spec:** `docs/superpowers/specs/2026-10-22-sp-b-align-guides-design.md`（本计划逐条论证自规格；执行者同时读规格与计划）

## Global Constraints

- **坐标类变更一律走前端 canvas_command 通道，不新增 Nest HTTP op**（规格 §7，已回代码核实 `CanvasPage.vue:2162`）。
- **Figma 口径**：六向 = 左缘/水平中/右缘/上缘/垂直中/下缘；distribute = 相邻包围盒**空隙相等**，首尾锚定（规格 D2）。
- **拖拽参考线**：边缘+中心 6 锚点吸附，阈值 `SNAP_RADIUS=8`、hysteresis `0.5`，guide 渲染；**参考线优先于松手 20px 网格吸附**（共存不叠加，规格 D3）。
- **design token 令牌 SSOT**：组件只消费 L2/L3，禁新增 `hex` / `rgba(` / `text-white`（AGENTS.md `design-tokens.css`）。改令牌或组件样式后必跑 `design-token.test.ts` + `theme-usage.test.ts`。
- **agent 工具不点名 prompt-registry**：靠 `description` 承担发现能力，零 L6 预算成本（规格 D1；先例分组三工具）。
- **分支纪律**：所有改动在 worktree `feat/sp-b-align-guides`（路径 `/Users/4seven/workspace/pi-lnk-sp-b-wt`）；commit 只在 worktree 内做；最终 squash 合并 + 生产复测（规格 §10）。
- **跨包改动**：跑根目录 `pnpm build` + 每个改动包的 `tsc`；改 `.vue` 后跑 `apps/web` 的 `vue-tsc --noEmit -p tsconfig.json`（约 11 分钟，AGENTS.md 铁律）。
- **TDD**：每个原语/分支先写失败测试，再实现；纯函数金样单测。

## Review Focus

（规格没明说但真实会咬人的输入/失败模式；每条的测试钉在对应任务里）

1. **含 parentNode 的分组子节点**对齐/分布：绝对坐标↔局部坐标换算错 ⇒ 节点跳到错误位置。→ 任务 1/2 的 parent-offset fixture。
2. **distribute 选 <3 节点**（常见误选 2 个）⇒ 必须 no-op 返回空映射，不能报错或移动。→ 任务 2 测试。
3. **拖拽吸附 hysteresis 缺失** ⇒ 临界点 guide 闪烁、位置抖动。→ 任务 3 测试 `prev` 保持。
4. **松手时 guide 被 20px 网格覆盖** ⇒ 拖拽中吸了参考线，松手又被网格吸回，精确对齐失效。→ 任务 9 的 `onNodeDragStop` 优先级。
5. **候选含被拖节点自身或其父** ⇒ 自己吸自己（永远命中）/ 分组整体拖时父子互吸。→ 任务 3 测试跳过 self/parent；任务 9 调用方裁剪。
6. **agent 触发 align 但画布属他人账号**（`agentReadOnly`）⇒ 应 `ElMessage.warning` 不执行（同 `handleArrangeNodes` 口径）。→ 任务 7 守卫。

---

## Task 1: shared `alignNodes` 纯函数

**Files:**
- Modify: `packages/shared/src/canvas/layout.ts`（在 `placeBatchNodes` 之后追加）
- Test: `packages/shared/src/canvas/layout.test.ts`（追加 `describe('alignNodes')`）

**Interfaces:**
- Consumes: `getNodeSize(node)`, `getAbsolutePosition(node, nodes)`（SP-A 既有，同文件）
- Produces: `export type AlignSixWay = 'left'|'centerH'|'right'|'top'|'centerV'|'bottom'`；`export function alignNodes(nodes: LayoutNode[], ids: string[], mode: AlignSixWay): Record<string, { x: number; y: number }>` —— 返回**局部坐标**新位置（已减去 parent 绝对偏移），未选中节点不在映射中。

- [x] **Step 1: 写失败测试**

```ts
import { alignNodes, type AlignSixWay, type LayoutNode } from './layout'

function mk(id: string, x: number, y: number, w = 280, h = 160, parent?: string): LayoutNode {
  return { id, type: 'text', position: { x, y }, dimensions: { width: w, height: h }, ...(parent ? { parentNode: parent } : {}) } as LayoutNode
}

describe('alignNodes', () => {
  it('left：选中集最小左缘对齐', () => {
    const nodes = [mk('a', 100, 0), mk('b', 300, 0, 280, 280), mk('c', 0, 500)]
    const r = alignNodes(nodes, ['a', 'b'], 'left')
    expect(r['a'].x).toBe(100); expect(r['b'].x).toBe(100) // 都移到 a 的左缘
    expect(r['c']).toBeUndefined()
  })
  it('right：最大右缘对齐（b 右缘=580）', () => {
    const nodes = [mk('a', 100, 0), mk('b', 300, 0, 280, 280)]
    const r = alignNodes(nodes, ['a', 'b'], 'right')
    expect(r['a'].x).toBe(580 - 280); expect(r['b'].x).toBe(300)
  })
  it('centerH：以选中集水平中轴对齐', () => {
    const nodes = [mk('a', 100, 0), mk('b', 300, 0, 280, 280)]
    // 选中集左缘 100 / 右缘 580 → 中轴 340；a 宽 280 → 左缘 200
    const r = alignNodes(nodes, ['a', 'b'], 'centerH')
    expect(r['a'].x).toBe(200); expect(r['b'].x).toBe(340 - 140)
  })
  it('含 parentNode：结果减回 parent 偏移（parent 在 1000,1000）', () => {
    const parent = mk('p', 1000, 1000, 600, 600)
    const child = mk('a', 1100, 1100, 280, 160, 'p') // 局部 100,100，绝对 1100,1100
    const nodes = [parent, child]
    const r = alignNodes(nodes, ['a'], 'left')
    // 绝对左缘 1100，无他者 ⇒ 目标=1100；局部 = 1100 - (绝对1100 - 局部100) = 100（不变）
    expect(r['a'].x).toBe(100)
  })
  it('空集返回空映射', () => {
    expect(alignNodes([mk('a', 0, 0)], [], 'left')).toEqual({})
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `cd packages/shared && npx vitest run src/canvas/layout.test.ts -t alignNodes`
Expected: FAIL（`alignNodes` 未定义）

- [x] **Step 3: 实现（追加到 layout.ts 末尾）**

```ts
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
```

- [x] **Step 4: 运行测试确认通过**

Run: `cd packages/shared && npx vitest run src/canvas/layout.test.ts -t alignNodes`
Expected: PASS（5 用例）

- [x] **Step 5: 提交**

```bash
git add packages/shared/src/canvas/layout.ts packages/shared/src/canvas/layout.test.ts
git commit -m "feat(shared): SP-B alignNodes 六向对齐纯函数（Figma 口径 + parentNode 偏移换算）"
```

---

## Task 2: shared `distributeNodes` 纯函数

**Files:**
- Modify: `packages/shared/src/canvas/layout.ts`
- Test: `packages/shared/src/canvas/layout.test.ts`（追加 `describe('distributeNodes')`）

**Interfaces:**
- Consumes: `getNodeSize`, `getAbsolutePosition`（同文件）
- Produces: `export function distributeNodes(nodes: LayoutNode[], ids: string[], axis: 'x' | 'y'): Record<string, { x: number; y: number }>` —— 相邻包围盒**空隙相等**、首尾锚定；`ids.length < 3` 返回 `{}`（no-op）；返回局部坐标。

- [x] **Step 1: 写失败测试**

```ts
describe('distributeNodes', () => {
  it('x 轴：3 节点等空隙，首尾锚定', () => {
    // a 左缘 0 宽 100；c 左缘 300 宽 100 ⇒ span 用 right：a.right=100, c.right=400
    const nodes = [mk('a', 0, 0, 100, 50), mk('b', 120, 0, 100, 50), mk('c', 300, 0, 100, 50)]
    const r = distributeNodes(nodes, ['a', 'b', 'c'], 'x')
    // first.left=0, last.right=400, totalW=300, gap=(400-0-300)/2=50
    // 中间 b 左缘应 = first.left + w_a + gap = 0+100+50 = 150 ⇒ b.x=150
    expect(r['a']).toBeUndefined() // 首锚定
    expect(r['c']).toBeUndefined() // 尾锚定
    expect(r['b'].x).toBe(150)
  })
  it('x 轴混宽：按包围盒空隙算', () => {
    const nodes = [mk('a', 0, 0, 100, 50), mk('b', 200, 0, 200, 50), mk('c', 600, 0, 100, 50)]
    // first.left=0,last.right=700,totalW=400,gap=(700-400)/2=150 ⇒ b 左缘=0+100+150=250
    const r = distributeNodes(nodes, ['a', 'b', 'c'], 'x')
    expect(r['b'].x).toBe(250)
  })
  it('<3 节点返回空映射（no-op）', () => {
    const nodes = [mk('a', 0, 0), mk('b', 100, 0)]
    expect(distributeNodes(nodes, ['a', 'b'], 'x')).toEqual({})
  })
})
```

- [x] **Step 2: 运行确认失败**

Run: `cd packages/shared && npx vitest run src/canvas/layout.test.ts -t distributeNodes`
Expected: FAIL

- [x] **Step 3: 实现（追加到 layout.ts）**

```ts
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
```

- [x] **Step 4: 运行确认通过**

Run: `cd packages/shared && npx vitest run src/canvas/layout.test.ts -t distributeNodes`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add packages/shared/src/canvas/layout.ts packages/shared/src/canvas/layout.test.ts
git commit -m "feat(shared): SP-B distributeNodes 等空隙分布纯函数（首尾锚定 + <3 no-op）"
```

---

## Task 3: shared `computeSnapGuides` 纯函数（移植 React Flow Helper Lines 算法）

**Files:**
- Modify: `packages/shared/src/canvas/layout.ts`
- Test: `packages/shared/src/canvas/layout.test.ts`（追加 `describe('computeSnapGuides')`）

**Interfaces:**
- Consumes: 无（纯几何，自包含）
- Produces:
  ```ts
  export interface SnapBox { x: number; y: number; w: number; h: number }
  export interface SnapCandidate { id: string; box: SnapBox; parentId?: string; isSelf?: boolean }
  export interface SnapPrev { horizontal?: { position: number; sourceNodeId: string }; vertical?: { position: number; sourceNodeId: string } }
  export interface SnapResult { horizontal?: { position: number; sourceNodeId: string }; vertical?: { position: number; sourceNodeId: string }; snapped: { x: number; y: number } }
  export const SNAP_RADIUS = 8
  export const SNAP_HYSTERESIS = 0.5
  export function computeSnapGuides(dragBox: SnapBox, candidates: SnapCandidate[], opts?: { snapRadius?: number; hysteresis?: number; prev?: SnapPrev }): SnapResult
  ```
  调用方负责：传入**视口内**候选、标记 `isSelf`（被拖节点）与 `parentId`（被拖节点父），算法跳过这两者。

- [x] **Step 1: 写失败测试**

```ts
describe('computeSnapGuides', () => {
  const drag = { x: 95, y: 200, w: 100, h: 50 } // 左缘 95，距候选 left=100 差 5 ≤ 8
  it('垂直方向最近线命中：被拖左缘吸到候选左缘', () => {
    const cands = [{ id: 'o', box: { x: 100, y: 0, w: 80, h: 80 } }]
    const r = computeSnapGuides(drag, cands)
    expect(r.vertical?.position).toBe(100)
    expect(r.snapped.x).toBe(100) // 左缘对齐到 100
    expect(r.snapped.y).toBe(200)
  })
  it('无命中返回原位置、无 guide', () => {
    const cands = [{ id: 'o', box: { x: 500, y: 500, w: 80, h: 80 } }]
    const r = computeSnapGuides(drag, cands)
    expect(r.vertical).toBeUndefined(); expect(r.horizontal).toBeUndefined()
    expect(r.snapped).toEqual({ x: 95, y: 200 })
  })
  it('hysteresis：prev 线在半径+0.5 内保持', () => {
    const cands = [{ id: 'o', box: { x: 100, y: 0, w: 80, h: 80 } }]
    const r1 = computeSnapGuides(drag, cands)
    const drag2 = { ...drag, x: 109 } // 距 prev 100 差 9（>8 但 ≤8.5）
    const r2 = computeSnapGuides(drag2, cands, { prev: { vertical: r1.vertical } })
    expect(r2.vertical?.position).toBe(100)
  })
  it('跳过自身：isSelf 候选不命中', () => {
    const cands = [{ id: 'self', box: { x: 100, y: 0, w: 80, h: 80 }, isSelf: true }]
    const r = computeSnapGuides(drag, cands)
    expect(r.vertical).toBeUndefined()
  })
})
```

- [x] **Step 2: 运行确认失败**

Run: `cd packages/shared && npx vitest run src/canvas/layout.test.ts -t computeSnapGuides`
Expected: FAIL

- [x] **Step 3: 实现（追加到 layout.ts，算法吸收官方 React Flow Helper Lines）**

```ts
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

interface BestV { dist: number; pos: number; id: string; dragOffset: number }

/**
 * 拖拽智能参考线（移植 React Flow xyflow Helper Lines + manta SpatialIndex 思路）：
 * - 6 锚点；每个朝向（h/v）在阈值内只取**一条最近线**；
 * - hysteresis 0.5px：prev 线在 radius+hysteresis 内保持，防抖；
 * - 跳过 isSelf（调用方已标）；
 * - 视口裁剪由调用方做（候选只传视口内）。
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
  let bestV: (BestV & { o: 'v' }) | undefined
  let bestH: (BestV & { o: 'h' }) | undefined
  for (const c of candidates) {
    if (c.isSelf) continue
    for (const ca of Object.values(SNAP_ANCHORS)) {
      const cpos = ca.resolve(c.box)
      for (const da of dragAnchors) {
        if (da.o !== ca.o) continue
        const dist = Math.abs(da.pos - cpos)
        const prevPos = ca.o === 'v' ? opts.prev?.vertical?.position : opts.prev?.horizontal?.position
        const keepPrev = prevPos != null && Math.abs(cpos - prevPos) <= hys
        if (!keepPrev && dist > radius) continue
        const cur = ca.o === 'v' ? bestV : bestH
        if (!cur || dist < cur.dist || keepPrev) {
          const nb = { dist, pos: cpos, id: c.id, dragOffset: da.off }
          if (ca.o === 'v') bestV = { ...nb, o: 'v' } else bestH = { ...nb, o: 'h' }
        }
      }
    }
  }
  const snapped = { x: dragBox.x, y: dragBox.y }
  if (bestV) snapped.x = bestV.pos - bestV.dragOffset
  if (bestH) snapped.y = bestH.pos - bestH.dragOffset
  return {
    vertical: bestV ? { position: bestV.pos, sourceNodeId: bestV.id } : undefined,
    horizontal: bestH ? { position: bestH.pos, sourceNodeId: bestH.id } : undefined,
    snapped,
  }
}
```

- [x] **Step 4: 运行确认通过**

Run: `cd packages/shared && npx vitest run src/canvas/layout.test.ts -t computeSnapGuides`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add packages/shared/src/canvas/layout.ts packages/shared/src/canvas/layout.test.ts
git commit -m "feat(shared): SP-B computeSnapGuides 拖拽参考线算法（6 锚点/单方向最近线/hysteresis/跳过自身）"
```

---

## Task 4: pi-runtime `arrange_nodes` 工具扩 mode

**Files:**
- Modify: `services/pi-runtime/src/tools/arrange-nodes.ts`（schema `mode` 联合 + 参数）
- Test: `services/pi-runtime/src/tools/arrange-nodes.test.ts`（追加 mode 校验用例）

**Interfaces:**
- Consumes: 本任务只改 schema 与 canvasCommand 负载；执行端不动（Task 6/7 接）
- Produces: `mode` 联合扩 `'grid'|'along_edges'|'align'|'distribute'`；选 `align` 时命令带 `alignMode`，选 `distribute` 时带 `axis`；canvasCommand 仍 `type:'arrange_nodes'`。**不点名 prompt-registry**（description 已在，靠之承担发现能力）。

- [x] **Step 1: 写失败测试（arrange-nodes.test.ts 追加）**

```ts
it("mode=align 带 alignMode 透传命令", async () => {
  const tool = createArrangeNodesTools(undefined)[0]
  const r = await run(tool!, { node_ids: ['a', 'b', 'c'], mode: 'align', align_mode: 'left' })
  const cmd = (r.details as any).canvasCommands[0]
  expect(cmd.type).toBe('arrange_nodes')
  expect(cmd.mode).toBe('align'); expect(cmd.alignMode).toBe('left')
})
it("mode=distribute 带 axis 透传命令", async () => {
  const tool = createArrangeNodesTools(undefined)[0]
  const r = await run(tool!, { node_ids: ['a', 'b', 'c'], mode: 'distribute', axis: 'x' })
  const cmd = (r.details as any).canvasCommands[0]
  expect(cmd.mode).toBe('distribute'); expect(cmd.axis).toBe('x')
})
```

- [x] **Step 2: 运行确认失败**

Run: `cd services/pi-runtime && npx node --test src/tools/arrange-nodes.test.ts 2>&1 | tail -20`（或仓库既定 test 命令）
Expected: 新用例 FAIL（mode 不接受 align）

- [x] **Step 3: 实现**

- `parameters` 中 `mode` 改为 `Type.String({ description: "grid | along_edges | align | distribute" })`
- 新增 `align_mode: Type.Optional(Type.String({ description: "align 时必填: left|centerH|right|top|centerV|bottom" }))`、`axis: Type.Optional(Type.String({ description: "distribute 时必填: x|y" }))`
- `execute` 的 `mode` 推导：`const mode = p.mode === 'along_edges' || p.mode === 'align' || p.mode === 'distribute' ? p.mode : 'grid'`
- 命令对象 `{ type:'arrange_nodes', nodeIds, mode, gap, ...(mode==='align' && p.align_mode ? { alignMode: p.align_mode } : {}), ...(mode==='distribute' && p.axis ? { axis: p.axis } : {}), ...(mode==='along_edges' && edges?.length ? { edges } : {}) }`
- `description` 末尾追加：「也支持 mode=align（align_mode 六向）/ distribute（axis x|y）做精确对齐与等距分布」——零 L6 预算（不进 prompt-registry）

- [x] **Step 4: 运行确认通过**

Run: 同 Step 2
Expected: 全绿（含既有用例）

- [x] **Step 5: 提交**

```bash
git add services/pi-runtime/src/tools/arrange-nodes.ts services/pi-runtime/src/tools/arrange-nodes.test.ts
git commit -m "feat(runtime): arrange_nodes 扩 align/distribute mode（canvas_command 透传，不点名 prompt）"
```

> tiering：`arrange_nodes` 已在 `tiering.test.ts` 登记（ui_command），本任务不改 tier；仅确认 `tool-capability-catalog.md` 的「点名资产」列该项仍写「无（description 承担）」。

---

## Task 5: web `useCanvasGrouping` 派发扩 align/distribute

**Files:**
- Modify: `apps/web/src/composables/useCanvasGrouping.ts`（`ArrangeMode` 联合 + `applyArrangeLayout` 分支）
- Test: `apps/web/src/composables/useCanvasGrouping.arrange.test.ts`（追加 align/distribute 用例）

**Interfaces:**
- Consumes: `alignNodes` / `distributeNodes`（Task 1/2，从 `@lnkpi/shared` 导入——确认 barrel 已导出；若未导出在 shared barrel 补导出）
- Produces: `ArrangeMode = 'grid'|'along_edges'|'align'|'distribute'`；`ArrangeRequest` 扩 `alignMode?` / `axis?`；`applyArrangeLayout` 在 `mode==='align'` 调 `alignNodes`、在 `mode==='distribute'` 调 `distributeNodes`，把返回的局部坐标映射落到 `FlowNode.position`（shared 已返局部坐标，直接用）。

- [x] **Step 1: 写失败测试（useCanvasGrouping.arrange.test.ts 追加）**

```ts
it('applyArrangeLayout mode=align 调 alignNodes 并落局部坐标', () => {
  const nodes = [node('a', 100, 0), node('b', 300, 0, 280, 280)]
  const next = applyArrangeLayout(nodes, { nodeIds: ['a', 'b'], mode: 'align', alignMode: 'left' })
  expect(next.find((n) => n.id === 'b')!.position.x).toBe(100)
})
it('applyArrangeLayout mode=distribute 调 distributeNodes', () => {
  const nodes = [node('a', 0, 0, 100, 50), node('b', 120, 0, 100, 50), node('c', 300, 0, 100, 50)]
  const next = applyArrangeLayout(nodes, { nodeIds: ['a', 'b', 'c'], mode: 'distribute', axis: 'x' })
  expect(next.find((n) => n.id === 'b')!.position.x).toBe(150)
})
```

- [x] **Step 2: 运行确认失败**

Run: `cd apps/web && npx vitest run src/composables/useCanvasGrouping.arrange.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

```ts
export type ArrangeMode = 'grid' | 'along_edges' | 'align' | 'distribute'
export interface ArrangeRequest {
  nodeIds: string[]
  mode: ArrangeMode
  gap?: number
  edges?: LayoutEdge[]
  alignMode?: 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom'
  axis?: 'x' | 'y'
}

export function applyArrangeLayout(nodes: FlowNode[], req: ArrangeRequest, canvasEdges: LayoutEdge[] = []): FlowNode[] {
  const ids = (req?.nodeIds ?? []).filter((id) => typeof id === 'string' && id)
  if (ids.length < 2) return nodes
  if (req.mode === 'align' && req.alignMode) {
    const pos = alignNodes(nodes as unknown as LayoutNode[], ids, req.alignMode)
    return nodes.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n))
  }
  if (req.mode === 'distribute' && req.axis) {
    const pos = distributeNodes(nodes as unknown as LayoutNode[], ids, req.axis)
    return nodes.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n))
  }
  if (req.mode === 'along_edges') {
    const edges = req.edges?.length ? req.edges : canvasEdges
    return layoutNodesAlongEdges(nodes, edges, ids, gap)
  }
  return layoutNodesInGrid(nodes, ids, gap)
}
```

> `gap` 变量在原 `applyArrangeLayout` 内已定义（`const gap = ...`），保留。

- [x] **Step 4: 运行确认通过**

Run: 同 Step 2
Expected: PASS（含既有 3 处 arrange 用例）

- [x] **Step 5: 提交**

```bash
git add apps/web/src/composables/useCanvasGrouping.ts apps/web/src/composables/useCanvasGrouping.arrange.test.ts
git commit -m "feat(web): useCanvasGrouping 派发扩 align/distribute（消费 shared 纯函数）"
```

---

## Task 6: web `AgentSideRail` ArrangeRequest 联合 + emit

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（`ArrangeRequest` 类型 + `emit('arrangeNodes')` 负载）

**Interfaces:**
- Consumes: 同 Task 4 的 canvasCommand 形态（`type:'arrange_nodes'` + `mode` + `alignMode`/`axis`）
- Produces: `ArrangeRequest` 联合扩 `'align'|'distribute'` 分支；`emit('arrangeNodes', payload)` 透传完整负载（含 `alignMode`/`axis`）

- [x] **Step 1: 扩类型与 emit**

把 `AgentSideRail.vue:208` 的：
```ts
arrangeNodes: [payload: { nodeIds: string[]; mode: 'grid' | 'along_edges'; gap: number; edges?: { source: string; target: string }[] }]
```
改为：
```ts
arrangeNodes: [payload: {
  nodeIds: string[]; mode: 'grid' | 'along_edges' | 'align' | 'distribute'; gap: number;
  edges?: { source: string; target: string }[]; alignMode?: 'left'|'centerH'|'right'|'top'|'centerV'|'bottom'; axis?: 'x'|'y'
}]
```
`AgentSideRail.vue:3208` 的 `emit('arrangeNodes', { nodeIds: cmd.nodeIds, mode: cmd.mode, gap: cmd.gap, ...(cmd.edges?{edges:cmd.edges}:{}) })` 扩展为透传 `alignMode`/`axis`：
```ts
emit('arrangeNodes', {
  nodeIds: cmd.nodeIds, mode: cmd.mode, gap: cmd.gap,
  ...(cmd.edges ? { edges: cmd.edges } : {}),
  ...(cmd.mode === 'align' && cmd.alignMode ? { alignMode: cmd.alignMode } : {}),
  ...(cmd.mode === 'distribute' && cmd.axis ? { axis: cmd.axis } : {}),
})
```

- [x] **Step 2: 类型检查**

Run: `cd apps/web && npx vue-tsc --noEmit -p tsconfig.json`（约 11 分钟；改 .vue 必跑）
Expected: 无 `arrangeNodes` 相关类型错误

- [x] **Step 3: 提交**

```bash
git add apps/web/src/components/agent/AgentSideRail.vue
git commit -m "feat(web): AgentSideRail arrangeNodes 事件透传 align/distribute 负载"
```

---

## Task 7: web `CanvasPage` 执行器分支 + 只读守卫

**Files:**
- Modify: `apps/web/src/pages/CanvasPage.vue`（`handleArrangeNodes` payload 联合 + 分支）

**Interfaces:**
- Consumes: `applyArrangeLayout`（Task 5，已支持四 mode）
- Produces: `handleArrangeNodes` 接收四 mode 联合；`align`/`distribute` 走 `applyArrangeLayout` 后 `setNodes` + `persistUserEdit` + 自动聚焦（与现有同构）；`agentReadOnly` 守卫复用（Review Focus #6）。

- [x] **Step 1: 扩 handleArrangeNodes 签名与分支**

`CanvasPage.vue:2166` 函数改为：
```ts
async function handleArrangeNodes(payload: {
  nodeIds: string[]
  mode: 'along_edges' | 'grid' | 'align' | 'distribute'
  gap?: number
  edges?: { source: string; target: string }[]
  alignMode?: 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom'
  axis?: 'x' | 'y'
}) {
  const ids = (payload?.nodeIds ?? []).filter((id) => typeof id === 'string' && id)
  if (ids.length < 2) return
  if (agentReadOnly.value) {
    ElMessage.warning('此画布属于其他账号，Agent 无法整理画布')
    return
  }
  const current = nodes.value as unknown as FlowNode[]
  const next = applyArrangeLayout(
    current,
    { nodeIds: ids, mode: payload.mode, gap: payload.gap, edges: payload.edges, alignMode: payload.alignMode, axis: payload.axis },
    edges.value.map((e) => ({ source: e.source, target: e.target })),
  )
  nodes.value = next as EditableFlowNode[]
  persistUserEdit()
  await nextTick()
  await focusNodesByIds(ids)
}
```
（原 `handleArrangeNodes` 已调用 `applyArrangeLayout`，仅需把 `mode` 联合与 `alignMode`/`axis` 透传进去——上面为完整替换。）

- [x] **Step 2: 类型检查**

Run: `cd apps/web && npx vue-tsc --noEmit -p tsconfig.json`
Expected: 无错误

- [x] **Step 3: 提交**

```bash
git add apps/web/src/pages/CanvasPage.vue
git commit -m "feat(web): CanvasPage handleArrangeNodes 接收 align/distribute（含只读守卫）"
```

---

## Task 8: web `MultiSelectToolbar` align 六向 + distribute 按钮组

**Files:**
- Modify: `apps/web/src/components/canvas/MultiSelectToolbar.vue`（`defineEmits` 加 `align`；模板加按钮组；`onLayout` 旁加 `onAlign`）

**Interfaces:**
- Consumes: `handleArrangeNodes` 经 `CanvasPage` 的 `@align` 接线（Task 7 已支持四 mode）
- Produces: `emit('align', { kind:'align'; alignMode } | { kind:'distribute'; axis })`；`CanvasPage` 在 `@align` 处把负载转成 `handleArrangeNodes` 入参（`mode` 映射：`kind:'align'→mode:'align', alignMode`；`kind:'distribute'→mode:'distribute', axis`）。

- [x] **Step 1: 加 emit 与 handler**

`defineEmits` 追加：`align: [payload: { kind: 'align'; alignMode: 'left'|'centerH'|'right'|'top'|'centerV'|'bottom' } | { kind: 'distribute'; axis: 'x'|'y' }]`
```ts
function onAlign(payload: { kind: 'align'; alignMode: any } | { kind: 'distribute'; axis: any }) {
  layoutMenuOpen.value = false
  emit('align', payload)
}
```

- [x] **Step 2: 模板加按钮组（在「整理布局」菜单同区块，新增 align 分组，复用 `.toolbar-action` / `.export-menu` 令牌类）**

```html
<button type="button" class="export-menu-item" @click="onAlign({ kind: 'align', alignMode: 'left' })">左对齐</button>
<button type="button" class="export-menu-item" @click="onAlign({ kind: 'align', alignMode: 'centerH' })">水平居中</button>
<button type="button" class="export-menu-item" @click="onAlign({ kind: 'align', alignMode: 'right' })">右对齐</button>
<button type="button" class="export-menu-item" @click="onAlign({ kind: 'align', alignMode: 'top' })">顶对齐</button>
<button type="button" class="export-menu-item" @click="onAlign({ kind: 'align', alignMode: 'centerV' })">垂直居中</button>
<button type="button" class="export-menu-item" @click="onAlign({ kind: 'align', alignMode: 'bottom' })">底对齐</button>
<button type="button" class="export-menu-item" @click="onAlign({ kind: 'distribute', axis: 'x' })">水平等距</button>
<button type="button" class="export-menu-item" @click="onAlign({ kind: 'distribute', axis: 'y' })">垂直等距</button>
```
（图标优先用既有 `src/assets/icons/*.png` mask 资产风格；无对应图标时用文字按钮，保持令牌配色。）

- [x] **Step 3: 接线 CanvasPage `@align`**

`CanvasPage.vue:5125` 附近 `@layout="handleLayoutSelection"` 后面加：
```html
@align="(p) => handleArrangeNodes(p.kind === 'align' ? { nodeIds: multiSelectedIds.value, mode: 'align', alignMode: p.alignMode } : { nodeIds: multiSelectedIds.value, mode: 'distribute', axis: p.axis })"
```
（`multiSelectedIds` 为现有多选集合；与 `handleLayoutSelection` 取选中节点同源。）

- [x] **Step 4: 组件测试**

`apps/web/src/components/canvas/MultiSelectToolbar.test.ts` 追加：点击「左对齐」→ emit `align` 且 `payload.kind==='align' && alignMode==='left'`。

- [x] **Step 5: 守卫 + 类型**

Run: `cd apps/web && npx vitest run src/components/canvas/MultiSelectToolbar.test.ts && npx vue-tsc --noEmit -p tsconfig.json`
Expected: 组件测试 PASS；tsc 无错误

- [x] **Step 6: 提交**

```bash
git add apps/web/src/components/canvas/MultiSelectToolbar.vue apps/web/src/components/canvas/MultiSelectToolbar.test.ts apps/web/src/pages/CanvasPage.vue
git commit -m "feat(web): 多选工具条加 align 六向 + distribute H/V（design-token 配色）"
```

---

## Task 9: web 拖拽智能参考线（computeSnapGuides 接线 + GuideLines 渲染）

**Files:**
- Create: `apps/web/src/components/canvas/GuideLines.vue`（guide 线渲染，design-token 颜色，经 viewport transform 投射）
- Modify: `apps/web/src/pages/CanvasPage.vue`（`onNodesChange` 位置分支拦截 + guide 状态；`onNodeDragStart` 重置；`onNodeDragStop` 优先级；引入 GuideLines）
- Test: `apps/web/src/components/canvas/GuideLines.test.ts`（渲染 props）

**Interfaces:**
- Consumes: `computeSnapGuides`（Task 3，从 `@lnkpi/shared`）
- Produces: 拖拽中实时吸附（覆盖被拖节点 position）+ `horizontal`/`vertical` guide 状态 → GuideLines 渲染；松手时 guide 优先于 20px 网格。

- [x] **Step 1: 写 GuideLines.vue（纯展示组件）**

```vue
<script setup lang="ts">
defineProps<{ horizontal?: number; vertical?: number }>() // flow 坐标（y / x）
</script>
<template>
  <div v-if="horizontal != null" class="snap-guide snap-guide-h" :style="{ top: horizontal + 'px' }" />
  <div v-if="vertical != null" class="snap-guide snap-guide-v" :style="{ left: vertical + 'px' }" />
</template>
<style scoped>
.snap-guide { position: absolute; background: var(--lnk-accent); pointer-events: none; z-index: 60; }
.snap-guide-h { left: 0; right: 0; height: 1px; }
.snap-guide-v { top: 0; bottom: 0; width: 1px; }
</style>
```
> `--lnk-accent` 是 L2 令牌（design-token 体系内），不新增 hex；投放于 vue-flow 的 viewport transform 容器内即随缩放/平移精确（规格 §3.4）。

- [x] **Step 2: CanvasPage 拖拽拦截**

- 新增响应式 `const snapGuides = ref<{ horizontal?: number; vertical?: number }>({})`
- `onNodeDragStart`（:2034）末尾加 `snapGuides.value = {}`
- `onNodesChange`（:1960）的 `position` 分支内，若处于拖拽（`dragStartPositions.size > 0` 且 `change.id` 在被拖集合），调：
  ```ts
  const dragId = change.id
  const node = next.find((n) => n.id === dragId)
  if (node && dragStartPositions.has(dragId)) {
    const box = { x: pos.x, y: pos.y, w: getNodeSize(node as any).w, h: getNodeSize(node as any).h }
    const cands = (nodes.value as any[])
      .filter((n) => n.id !== dragId && n.parentNode !== <被拖节点 parent>)
      .map((n) => ({ id: n.id, box: { x: n.position.x, y: n.position.y, w: getNodeSize(n).w, h: getNodeSize(n).h }, parentId: n.parentNode, isSelf: false }))
      // 视口裁剪：仅取视口四至 + 边距（性能护栏，规格 §9）
    const res = computeSnapGuides(box, cands, { prev: snapGuides.value })
    snapGuides.value = { horizontal: res.horizontal?.position, vertical: res.vertical?.position }
    if (res.snapped.x !== pos.x || res.snapped.y !== pos.y) {
      next = next.map((n) => (n.id === dragId ? { ...n, position: res.snapped } : n))
    }
  }
  ```
  > 候选的 `parentId` 传被拖节点的 parent，使同父兄弟被跳过（Review Focus #5）。视口裁剪用现有 viewport 状态（`useVueFlow` 的 `viewport` 或 `getViewportForBounds`，沿用仓库既有取视口方式）。

- [x] **Step 3: onNodeDragStop 优先级（Review Focus #4）**

`CanvasPage.vue:2046` `onNodeDragStop`：若 `snapGuides.value` 有命中（本帧拖拽吸了参考线），**跳过** `applySnapOnRelease`（20px 网格）：
```ts
const hadGuide = !!(snapGuides.value.horizontal != null || snapGuides.value.vertical != null)
if (viewportSettings.value.snapToGrid && dragStartPositions.size > 0 && !hadGuide) {
  nodes.value = applySnapOnRelease(...)
  ...
}
snapGuides.value = {}
```

- [x] **Step 4: 挂载 GuideLines**

在 vue-flow 容器内（`<VueFlow>` 同级或内部 viewport 层）加 `<GuideLines :horizontal="snapGuides.horizontal" :vertical="snapGuides.vertical" />`。

- [x] **Step 5: 测试 + 守卫**

新增 `GuideLines.test.ts`：传 `horizontal=100` → 渲染一条水平线且 `top:100px`；不传 → 无。
Run: `cd apps/web && npx vitest run src/components/canvas/GuideLines.test.ts && npx vue-tsc --noEmit -p tsconfig.json`
Expected: PASS；tsc 无错

- [x] **Step 6: 提交**

```bash
git add apps/web/src/components/canvas/GuideLines.vue apps/web/src/components/canvas/GuideLines.test.ts apps/web/src/pages/CanvasPage.vue
git commit -m "feat(web): 拖拽智能参考线（computeSnapGuides 接线 + GuideLines 渲染 + 松手优先级）"
```

---

## Task 10: 移动端 `MobileMultiSelectMoreSheet` align 六向入口

**Files:**
- Modify: `apps/web/src/components/mobile/MobileMultiSelectMoreSheet.vue`（`defineEmits` 加 `align`；layout 视图加 align 六向；`onLayout` 旁加 `onAlign`）

**Interfaces:**
- Consumes: `handleArrangeNodes`（Task 7，四 mode）
- Produces: `emit('align', payload)`（同 Task 8 形状）；`CanvasPage` 对该 sheet 的 `@align` 接线同 Task 8 Step 3。

- [x] **Step 1: 加 emit + handler**

`defineEmits` 加：`align: [payload: { kind: 'align'; alignMode: any } | { kind: 'distribute'; axis: any }]`
```ts
function onAlign(payload: any) { emit('align', payload) }
```

- [x] **Step 2: 模板加 align 六向（在 `view==='layout'` 区块追加，复用 `.msms-item` 令牌类）**

```html
<button type="button" class="msms-item" @click="onAlign({ kind: 'align', alignMode: 'left' })">左对齐</button>
<button type="button" class="msms-item" @click="onAlign({ kind: 'align', alignMode: 'centerH' })">水平居中</button>
<button type="button" class="msms-item" @click="onAlign({ kind: 'align', alignMode: 'right' })">右对齐</button>
<button type="button" class="msms-item" @click="onAlign({ kind: 'align', alignMode: 'top' })">顶对齐</button>
<button type="button" class="msms-item" @click="onAlign({ kind: 'align', alignMode: 'centerV' })">垂直居中</button>
<button type="button" class="msms-item" @click="onAlign({ kind: 'align', alignMode: 'bottom' })">底对齐</button>
<button type="button" class="msms-item" @click="onAlign({ kind: 'distribute', axis: 'x' })">水平等距</button>
<button type="button" class="msms-item" @click="onAlign({ kind: 'distribute', axis: 'y' })">垂直等距</button>
```

- [x] **Step 3: 接线 CanvasPage `@align`（移动端 sheet 同 Task 8 Step 3 的 `@align` 绑定）**

- [x] **Step 4: 测试 + 类型**

`MobileMultiSelectMoreSheet.test.ts` 追加：点击「左对齐」→ emit `align` 且 `alignMode==='left'`。
Run: `cd apps/web && npx vitest run src/components/mobile/MobileMultiSelectMoreSheet.test.ts && npx vue-tsc --noEmit -p tsconfig.json`

- [x] **Step 5: 提交**

```bash
git add apps/web/src/components/mobile/MobileMultiSelectMoreSheet.vue apps/web/src/components/mobile/MobileMultiSelectMoreSheet.test.ts apps/web/src/pages/CanvasPage.vue
git commit -m "feat(web): 移动端更多 sheet 加 align 六向（复用 shared 原语）"
```

---

## 执行台账（2026-10-23 落地审计回填）

**产出**：

- PR #554 `feat(web): SP-B 画布对齐六向 + 等距分布 + 拖拽智能参考线` → squash `7471901a`
  （web 与 pi-runtime 均已上线；agent 通道 `arrange_nodes(mode=align|distribute)` 生产可用）。
- PR #557 `fix(web): SP-B R1 拖拽吸附平滑化` → squash `4d0d3376`
  （用户真机反馈「不丝滑 / 被吸住 / 步阶太大」后的手感修复，规格 §14 R1 addendum）。

**提交对应关系**：Task 1~10 在开发分支 `feat/sp-b-align-guides`（16 提交）内完成，随 #554 squash 合入 ⇒
**逐 Task 的 commit 对应关系已随 squash 丢失**（SP-A 台账尚可逐条对应，本包不可）⇒ 归属以本文件
Step 清单 + 规格 §2.1 六项范围为准；功能证据见规格 §15.2 审计表（代码级逐条）。

### ⭐ 执行中发现并修正的 2 处（与 SP-A 台账体例一致）

1. **shared `computeSnapGuides` 的两处真 bug**（SP-B 落地时即修，shared 提交 `2bd7da8d`）：
   - `snapped` 的锚点贴线方向写反（`pos + dragOffset` 误写成减号）⇒ 非首要锚点配对被放到线的错误一侧；
   - 「同一根线取更近拖拽锚点」的比较式带无条件 `|| keepPrev` ⇒ 更优配对被更差配对覆盖（节点被拉偏）。
   两者均做「改回即红」变异验证。
2. **R1 真机手感缺陷**（PR #557，规格 §14）：① 受控模式丢弃 vue-flow `dimensions` 变更 ⇒
   媒体节点按 NODE_SIZES 方框兜底（16:9 视频真实 320×180 被估成 320×320，中心/底边差 70-140px）；
   ② prev 参考线**无限粘滞**（`!keepPrev && dist > radius` 对 prev 不设距离上限，与规格
   「超出 radius + hysteresis 才解除」相反）；③ 阈值是 flow 坐标、未按 `1/zoom` 换算 ⇒ 放大态步阶翻倍。
   三条全修 + 5 项变异验证（释放带 / 切换余量 / dimensions 捕获 / zoom 换算 / sizeOf 注入）。

### ⭐ 2026-10-23 落地审计（代码级逐条，基准 `origin/master` @ `7fc3672f`）

- 规格 §2.1 六项范围 + 本文件 Task 1~10：**逐条有代码证据，全部落地**（证据表见规格 §15.2）。
- 本计划点名的 8 个测试文件：7 个独立存在；**`MultiSelectToolbarOverlay.test.ts` 不存在** ⇒
  Overlay（包装层）的触发断言并入 `MultiSelectToolbar.test.ts`（「整理布局」菜单含六向对齐 +
  两轴等距、点击 emit 判别联合负载）⇒ 覆盖等价，无缺口。
- **三处未闭合（均非功能缺失）**：
  - **G1 真机走查清单 §1~§7 未确认**（对齐六向 / 等距分布 / 参考线基础行为 / 移动端一致 /
    agent 自然语言触发 / SP-A 回归 / 生产复测；用户仅确认了 §8 的手感 7 条）
    ⇒ 规格 §10 的「目视 + 生产复测」是 SP-B 验收标准，**验收未闭环**，待用户登录态执行
    `docs/superpowers/2026-10-22-sp-b-align-guides-verify-checklist.md`。
  - **G2 本台账此前未回填**（本节即补齐；SP-A 同类文档有完整台账 + 偏离记录，本包原先缺失）。
  - **G3 规格 §6.1/§6.2 坐标口径表述与实现相反**（规格写「返回绝对位置」，实现返回局部坐标）
    ⇒ 已订正为「以实现为准（局部坐标，父偏移已扣除）」，**不改实现**（局部更安全：调用方直接写
    `node.position`，无需再反算父偏移）。

---

## Task 11: 守卫 + 跨包全量验证

**Files:** 无新增；跑既有守卫与构建

- [x] **Step 1: shared 全量**

Run: `cd packages/shared && npx vitest run src/canvas/layout.test.ts`
Expected: alignNodes + distributeNodes + computeSnapGuides 全绿

- [x] **Step 2: web 设计令牌守卫（AGENTS.md 铁律）**

Run: `cd apps/web && npx vitest run src/styles/design-token.test.ts src/styles/theme-usage.test.ts`
Expected: PASS（确认未新增 hex/rgba/text-white）

- [x] **Step 3: 根 build + 各包 tsc**

Run: `pnpm build`（根目录）+ `cd apps/web && npx vue-tsc --noEmit -p tsconfig.json`
Expected: 六包全绿；tsc 无错

- [x] **Step 4: pi-runtime 契约测试**

Run: `cd services/pi-runtime && npx node --test src/tools/arrange-nodes.test.ts`（+ 既有 tiering 测试）
Expected: 全绿

- [x] **Step 5: 提交（若无改动则跳过）**

仅当验证发现需修补时才提交；否则本任务为验证闸门。

---

## Task 12: 真机查验清单（交付前总门，用户登录态执行）

> 此任务由用户在其登录态的 App/Web 执行（agent 无法做）；列在此作为上线前总门，与 SP-A 的 §10 目视验收 6 条一并做。

**Files:** 无（走查清单）

- [ ] **SP-B 用户侧**
  1. 桌面多选 2~20 节点 → 左/水平中/右/上/垂直中/底 六向对齐，零压盖、坐标正确（含分组内子节点）
  2. 多选 ≥3 节点 → 水平等距/垂直等距，首尾锚定、中间等空隙
  3. 拖拽节点靠近其他节点边缘/中心 → 8px 内出参考线并吸附；松手保持精确对齐（不被 20px 网格覆盖）
  4. 移动端「更多」→ 对齐六向可用，行为同桌面

- [ ] **SP-B agent 侧**
  5. 对 agent 说「把这些节点左对齐 / 等距排开」→ 触发 `arrange_nodes(mode=align/distribute)`，画布精确对齐，不自己算坐标

- [ ] **SP-A 回归（截图原任务遗留，需真机）**
  6. 规格 §10 目视验收 6 条（含第 6 条：agent 传 `targetType:"prompt"` 明确报错拒建）
  7. 生产复测：上述行为在生产环境复现（非仅本地）

- [ ] **完成判据**：1~7 在生产环境（非本地）全部通过，且 `pnpm build` 六包全绿、设计令牌守卫通过。

---

## 自审结论（写计划时自查）

- **规格覆盖**：§6 三原语 → Task 1/2/3；§7 前端 canvas_command → Task 4/5/6/7/8/10；§8 用户侧 UI → Task 8/10；§8.3 拖拽参考线 → Task 9；§9 性能护栏（视口裁剪）→ Task 9 Step 2；§10 同步矩阵 → Task 4(tiering)/5/7/8/10；§12 测试 → Task 1~11；§11 后续 → Task 12 真机门。无遗漏。
- **占位符扫描**：无 TBD/TODO；每个代码步骤均含可贴实现。
- **类型一致性**：`AlignSixWay` / `ArrangeMode` / `SnapBox` / `SnapCandidate` / `SnapResult` 在 Task 1/3 定义，Task 4~10 消费名一致；canvasCommand `type:'arrange_nodes'` 贯穿工具→AgentSideRail→CanvasPage。
- **Review Focus 覆盖**：6 条失败模式均已钉入对应任务测试（Task 1/2 parent、Task 2 <3 no-op、Task 3 hysteresis + 跳过 self、Task 7 只读守卫、Task 9 松手优先级）。
