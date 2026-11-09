# SP-E 阶段 1：零契约观测 + op 幂等加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 PATCH 契约、不加 DB 列、不拒绝任何请求的前提下，给「画布过期基线冲突」补上可观测的分母，并修掉 `add_edge` 重放不幂等与 `update_node` 静默 no-op。

**Architecture:** 前端 per-tab `clientId` 走 HTTP header（不进 DTO，规避全局 `ValidationPipe({whitelist:true})` 静默剥字段）；服务端 PATCH 主通道在 `$transaction` 成功后记录进程内存样本（仿 `NotifyMetrics`）；`packages/shared/src/canvasActionApplier.ts` 只加可选 `onSkipped` 回调，保持返回形状与既有行为。度量经 `GET /api/health/canvas-patch-metrics` 暴露，供 14 天数据门取数。

**Tech Stack:** Nest 10 + Prisma（SQLite/生产）、Vitest、Vue 3 + axios、`@lnkpi/shared` 单一 applier SSOT、GitHub Actions `deploy.yml`。

**Spec:** [`docs/superpowers/specs/2026-11-09-sp-e-canvas-cas-decision-gate-design.md`](../specs/2026-11-09-sp-e-canvas-cas-decision-gate-design.md) —— 本计划只实现其 §9（阶段 1），**不实现** §10 数据门、§11 的 409 升级。

> ⛔ **执行状态：本计划已完成并等待审阅，尚未执行。** 用户 2026-11-09 的授权范围是「按决策建议执行开干」＝阶段 0 文档刀；阶段 1 改动 `apps/server/**`、`apps/web/**`、`packages/**` 会触发生产发布，须另行授权并选定执行方式后才可开始 Task 1。

## Global Constraints

- **I1** `PATCH /sessions/:id/canvas` 请求/响应形状不变：仍 `{ ops }` → `{ code:0, message:'ok', data:{ applied } }`；不新增必填字段、不新增状态码、不新增 409。
- **I2** 不新增 Prisma 列、不新增 migration、不改 `apps/server/prisma/schema.prisma`。
- **I3** 不拒绝任何请求；失败语义沿用 `apps/web/src/pages/CanvasPage.vue:5332-5357` 的「全量 GET 对账 + 丢弃 diff、不本地重放」。
- **I4** `clientId` 仅用于观测，不参与鉴权与任何判定；缺失/异常一律降级 `'unknown'`。
- **I5** `applyCanvasActions` 返回形状不变；新增能力一律走可选回调（沿用 `ApplyCanvasActionsOpts.onGuardReject` 既有模式，`canvasActionApplier.ts:20-27`）。
- **I6** 不改 `CanvasPage.vue` 中 `await canvasApi.patchCanvas(` 字面量 —— `canvasLoadGuard.wiring.test.ts:46` 与 `CanvasPage.mobileChromeHygiene.test.ts:84` 锚定它。
- **I7** 埋点不得成为故障源：任何埋点异常 `try/catch` 吞掉 + `Logger.warn`，主流程照常。
- **I8** 观测只在事务**成功后**记录；抛 409 / NotFound / 事务回滚的 PATCH 不算样本。
- **I9** `stale_conflict` 定义固定为「同 session、不同 clientId、相邻 ≤2s、目标键相交」，常量 `NEAR_CONCURRENT_MS = 2000` 写在 `canvas-patch-metrics.ts` 并加注释，禁止取数时改口径。
- **I10** 本仓测试纪律：vitest 用 nvm node24 + `--maxWorkers=1 --no-file-parallelism`；改组件后 `vue-tsc -b`；本机 pnpm 须 `env -u NODE_OPTIONS`；推前 `npx tsc --noEmit`；CI `pnpm -r build` 会编译 `*.test.ts` ⇒ **断言禁用 `as never`**。
- **I11** 本机 ↔ GitHub 网络阻断（git fetch/clone/push 全走 `gh api` REST Git Data API）；`git commit` 只在隔离 worktree 内做，真实 HEAD 以 `gh api` 为准，禁信本地 ref。
- **I12** 合并即触发生产发布（`deploy.yml:4-23`）；推前重取 true master 逐路径裸 blob sha 比对（基线可能在写作→推送间前移 → `MASTER_MOVED_SAFE`），合并时按真实 parent 核对 `ALL_PARALLEL_KEPT`。

## Review Focus

| # | 输入 / 条件 | 合理预期 | 钉在哪 |
|---|---|---|---|
| R1 | 无 `sessionStorage`（隐私模式 / SSR / `getItem` 抛异常） | `clientId='unknown'`，PATCH 照常成功、不抛错 | Task 1 Step 1 的 ③ 用例 + Task 4 Step 1 的 header 缺失用例 |
| R2 | 埋点代码自身抛错（`record` 被 mock 成 throw） | PATCH 仍返回 `{applied}`，只多一条 warn | Task 4 Step 1 的「埋点故障不影响主流程」用例 |
| R3 | PATCH 抛 409（`stagedActions` 在场）/ 事务回滚 | 计数器 `patches` **不增加** | Task 4 Step 1 的「失败 PATCH 不记样本」用例 |
| R4 | agent 侧调用 `applyCanvasActions` 不传 `onSkipped` | 返回 `CanvasData` 与改动前逐字段相等，重复边行为按新规（有意修正），无异常 | Task 3 Step 1 的「无回调」用例 + Task 8 的 agent executor 回归 |
| R5 | 同一 `clientId` 2s 内连发两次 | `nearConcurrentPairs` 不 +1（只有不同 clientId 才算） | Task 2 Step 1 的「同 client 不自计」用例 |

## File Structure

| 文件 | 职责 | 变动 |
|---|---|---|
| `apps/web/src/utils/canvasClientId.ts` | per-tab 稳定标识生成 + 降级 | 新建 |
| `apps/web/src/utils/canvasClientId.test.ts` | 行为级测试 | 新建 |
| `apps/web/src/services/canvas-api.ts` | `patchCanvas` 注入 header | 修改 `:17-18` |
| `apps/server/src/sessions/canvas-patch-metrics.ts` | 进程内存计数器 + `stale_conflict` 口径 | 新建 |
| `apps/server/src/sessions/canvas-patch-metrics.test.ts` | 纯函数/计数器测试 | 新建 |
| `packages/shared/src/canvasActionApplier.ts` | `onSkipped` 回调 + `add_edge` 查重 | 修改 `:20-27, :135-165` |
| `packages/shared/src/canvasActionApplier.test.ts` | 重复边 / 缺失节点 / 无回调回归 | 修改（追加用例） |
| `apps/server/src/sessions/sessions.service.ts` | 事务成功后记录样本 | 修改 `:125-176` 的 `patchCanvas` |
| `apps/server/src/sessions/sessions.service.test.ts` | 行为级 PATCH 埋点用例 | 修改（追加用例） |
| `apps/server/src/sessions/sessions.controller.ts` | 读 header 并下传（不进 DTO） | 修改 `:1, :77-86` |
| `apps/server/src/sessions/sessions.controller.headers.test.ts` | header + 真实管道透传测试 | 新建 |
| `apps/server/src/health/health.controller.ts` | `GET canvas-patch-metrics` | 修改 `:22-33` 之后 |
| `apps/server/src/health/health.controller.test.ts` | 端点字段断言 | 修改（追加用例） |
| `apps/web/src/pages/canvas/canvasLoadGuard.wiring.test.ts` | 静态契约锚点 | **不改**（回归确认） |
| `apps/web/src/pages/CanvasPage.mobileChromeHygiene.test.ts` | 静态契约锚点 | **不改**（回归确认） |

---

### Task 1: 前端 per-tab `clientId`

**Files:**
- Create: `apps/web/src/utils/canvasClientId.ts`
- Test: `apps/web/src/utils/canvasClientId.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `getCanvasClientId(deps?: CanvasClientIdDeps): string`，`CanvasClientIdDeps { storage?: Pick<Storage,'getItem'|'setItem'>; random?: () => string }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { getCanvasClientId } from './canvasClientId'

function fakeStorage() {
  const m = new Map<string, string>()
  return {
    m,
    storage: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, v) },
    },
  }
}

describe('getCanvasClientId', () => {
  it('① 同一 storage 内稳定', () => {
    const { storage } = fakeStorage()
    expect(getCanvasClientId({ storage, random: () => 'c-fixed' })).toBe('c-fixed')
    expect(getCanvasClientId({ storage, random: () => 'c-other' })).toBe('c-fixed')
  })
  it('② 不同 storage（新标签页）不同', () => {
    expect(getCanvasClientId({ storage: fakeStorage().storage, random: () => 'a' })).toBe('a')
    expect(getCanvasClientId({ storage: fakeStorage().storage, random: () => 'b' })).toBe('b')
  })
  it('③ R1：storage 缺失 / 抛异常 ⇒ unknown，不抛错', () => {
    expect(getCanvasClientId({ storage: undefined, random: () => 'x' })).toBe('unknown')
    const boom = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(getCanvasClientId({ storage: boom, random: () => 'x' })).toBe('unknown')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `env -u NODE_OPTIONS npx vitest run apps/web/src/utils/canvasClientId.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL — `Cannot find module './canvasClientId'`

- [ ] **Step 3: 最小实现**

```ts
const STORAGE_KEY = 'lnkpi.canvas.clientId'

export interface CanvasClientIdDeps {
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  random?: () => string
}

/** 观测专用 per-tab 标识。不参与鉴权、不进画布数据、异常一律降级。 */
export function getCanvasClientId(deps: CanvasClientIdDeps = {}): string {
  const storage =
    deps.storage ?? (typeof sessionStorage === 'undefined' ? null : sessionStorage)
  const random =
    deps.random ??
    (() => globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  if (!storage) return 'unknown'
  try {
    const existing = storage.getItem(STORAGE_KEY)
    if (existing) return existing
    const id = random()
    storage.setItem(STORAGE_KEY, id)
    return id
  } catch {
    return 'unknown'
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `env -u NODE_OPTIONS npx vitest run apps/web/src/utils/canvasClientId.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: PASS 3/3

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/utils/canvasClientId.ts apps/web/src/utils/canvasClientId.test.ts
git commit -m "feat(web): per-tab canvas client id for patch observability"
```

---

### Task 2: 服务端进程内存计数器

**Files:**
- Create: `apps/server/src/sessions/canvas-patch-metrics.ts`
- Test: `apps/server/src/sessions/canvas-patch-metrics.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `CanvasPatchMetrics`（`record(sample, opCount, applied, skips)` / `snapshot()` / `reset()`）、`canvasPatchMetrics` 单例、`targetKeysOf(ops: unknown[]): string[]`、`NEAR_CONCURRENT_MS = 2000`、`CanvasPatchSample`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { CanvasPatchMetrics, NEAR_CONCURRENT_MS, canvasPatchMetrics, targetKeysOf } from './canvas-patch-metrics'

describe('targetKeysOf', () => {
  it('提取 node/edge 目标键', () => {
    expect(targetKeysOf([
      { type: 'update_node', payload: { id: 'n1' } },
      { type: 'add_edge', payload: { id: 'e1', source: 'n1', target: 'n2' } },
      { type: 'set_viewport', payload: { viewport: {} } },
    ])).toEqual(['node:n1', 'edge:e1'])
  })
})

describe('CanvasPatchMetrics', () => {
  let m: CanvasPatchMetrics
  beforeEach(() => { m = new CanvasPatchMetrics() })
  it('六项计数精确', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 2, 1,
      [{ type: 'update_node' }])
    expect(m.snapshot()).toMatchObject({ patches: 1, ops: 2, applied: 1, skipped: 1,
      skippedByType: { update_node: 1 }, distinctClients: 1,
      nearConcurrentPairs: 0, keyOverlapPairs: 0 })
  })
  it('R5：同 clientId 2s 内连发不自计', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000 + NEAR_CONCURRENT_MS, targetKeys: ['node:n1'] }, 1, 1, [])
    expect(m.snapshot().nearConcurrentPairs).toBe(0)
  })
  it('不同 clientId + 2s 内 + 键相交 ⇒ stale_conflict', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's1', clientId: 'c2', ts: 1500, targetKeys: ['node:n1'] }, 1, 1, [])
    expect(m.snapshot()).toMatchObject({ nearConcurrentPairs: 1, keyOverlapPairs: 1, distinctClients: 2 })
  })
  it('不同 clientId + 键不相交 ⇒ 只计 nearConcurrent', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's1', clientId: 'c2', ts: 1500, targetKeys: ['node:n2'] }, 1, 1, [])
    expect(m.snapshot()).toMatchObject({ nearConcurrentPairs: 1, keyOverlapPairs: 0 })
  })
  it('超过 2s / 不同 session 均不计', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's1', clientId: 'c2', ts: 1000 + NEAR_CONCURRENT_MS + 1, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's2', clientId: 'c2', ts: 1000 + NEAR_CONCURRENT_MS + 2, targetKeys: ['node:n1'] }, 1, 1, [])
    expect(m.snapshot().nearConcurrentPairs).toBe(0)
  })
  it('单例可 reset', () => {
    canvasPatchMetrics.reset()
    expect(canvasPatchMetrics.snapshot().patches).toBe(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `env -u NODE_OPTIONS npx vitest run apps/server/src/sessions/canvas-patch-metrics.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL — `Cannot find module './canvas-patch-metrics'`

- [ ] **Step 3: 最小实现**

```ts
/** I9：数据门口径常量，禁止取数时改。 */
export const NEAR_CONCURRENT_MS = 2000

export interface CanvasPatchSample {
  sessionId: string
  clientId: string
  ts: number
  targetKeys: string[]
}

/** 从 sanitize 后的 ops 提取目标键（node:id / edge:id），用于键相交判定。 */
export function targetKeysOf(ops: unknown[]): string[] {
  const out: string[] = []
  for (const raw of ops) {
    const op = raw as { type?: string; payload?: { id?: unknown } }
    if (typeof op?.type !== 'string' || typeof op.payload?.id !== 'string') continue
    if (op.type.includes('node')) out.push(`node:${op.payload.id}`)
    else if (op.type.includes('edge')) out.push(`edge:${op.payload.id}`)
  }
  return out
}

export class CanvasPatchMetrics {
  private patches = 0
  private ops = 0
  private applied = 0
  private skipped = 0
  private skippedByType = new Map<string, number>()
  private clientsBySession = new Map<string, Set<string>>()
  private lastBySession = new Map<string, CanvasPatchSample>()
  private nearConcurrentPairs = 0
  private keyOverlapPairs = 0

  record(s: CanvasPatchSample, opCount: number, applied: number, skips: Array<{ type: string }>): void {
    this.patches += 1
    this.ops += opCount
    this.applied += applied
    this.skipped += skips.length
    for (const sk of skips) this.skippedByType.set(sk.type, (this.skippedByType.get(sk.type) ?? 0) + 1)
    const clients = this.clientsBySession.get(s.sessionId) ?? new Set<string>()
    clients.add(s.clientId)
    this.clientsBySession.set(s.sessionId, clients)
    const last = this.lastBySession.get(s.sessionId)
    if (last && last.clientId !== s.clientId && s.ts - last.ts <= NEAR_CONCURRENT_MS && s.ts >= last.ts) {
      this.nearConcurrentPairs += 1
      if (s.targetKeys.some((k) => last.targetKeys.includes(k))) this.keyOverlapPairs += 1
    }
    this.lastBySession.set(s.sessionId, s)
  }

  snapshot() {
    return {
      patches: this.patches,
      ops: this.ops,
      applied: this.applied,
      skipped: this.skipped,
      skippedByType: Object.fromEntries(this.skippedByType),
      distinctClients: [...this.clientsBySession.values()].reduce((n, s) => n + s.size, 0),
      nearConcurrentPairs: this.nearConcurrentPairs,
      keyOverlapPairs: this.keyOverlapPairs,
      staleConflict: this.keyOverlapPairs,
    }
  }

  reset(): void {
    this.patches = this.ops = this.applied = this.skipped = 0
    this.skippedByType.clear()
    this.clientsBySession.clear()
    this.lastBySession.clear()
    this.nearConcurrentPairs = this.keyOverlapPairs = 0
  }
}

export const canvasPatchMetrics = new CanvasPatchMetrics()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `env -u NODE_OPTIONS npx vitest run apps/server/src/sessions/canvas-patch-metrics.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: PASS 7/7

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sessions/canvas-patch-metrics.ts apps/server/src/sessions/canvas-patch-metrics.test.ts
git commit -m "feat(server): in-memory PATCH metrics with stale_conflict gauge"
```

---

### Task 3: applier SSOT 幂等加固与 `onSkipped`

**Files:**
- Modify: `packages/shared/src/canvasActionApplier.ts:20-27, :135-165`
- Test: `packages/shared/src/canvasActionApplier.test.ts`（追加用例）

**Interfaces:**
- Consumes: `CanvasAction`, `CanvasData`（`./index`）
- Produces: `CanvasActionSkipReason = 'duplicate_edge' | 'node_not_found'`；`ApplyCanvasActionsOpts.onSkipped?: (type: string, reason: CanvasActionSkipReason, id: string) => void`

- [ ] **Step 1: 写失败测试**

```ts
import { applyCanvasActions } from './canvasActionApplier'
import type { CanvasData } from './index'

const base = (): CanvasData => ({ nodes: [], edges: [] })

it('add_edge 重复 id ⇒ 只产生一条边 + onSkipped', () => {
  const skips: string[] = []
  const out = applyCanvasActions(base(), [
    { type: 'add_edge', payload: { id: 'e1', source: 'a', target: 'b' } },
    { type: 'add_edge', payload: { id: 'e1', source: 'a', target: 'b' } },
  ], { onSkipped: (t, r) => skips.push(`${t}:${r}`) })
  expect(out.edges).toHaveLength(1)
  expect(skips).toEqual(['add_edge:duplicate_edge'])
})

it('update_node 打已删节点 ⇒ onSkipped(node_not_found)', () => {
  const skips: string[] = []
  const out = applyCanvasActions(base(), [
    { type: 'update_node', payload: { id: 'gone', position: { x: 1, y: 2 } } },
  ], { onSkipped: (t, r, id) => skips.push(`${t}:${r}:${id}`) })
  expect(out.nodes).toHaveLength(0)
  expect(skips).toEqual(['update_node:node_not_found:gone'])
})

it('R4：不传 onSkipped ⇒ 返回形状与既有行为不变（除重复边修正）', () => {
  const out = applyCanvasActions(base(), [
    { type: 'add_edge', payload: { id: 'e1', source: 'a', target: 'b' } },
    { type: 'add_node', payload: { id: 'n1' } },
  ])
  expect(out.edges).toHaveLength(1)
  expect(out.nodes).toHaveLength(1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `env -u NODE_OPTIONS npx vitest run packages/shared/src/canvasActionApplier.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL — 重复边用例得 2 条；`onSkipped` 类型不存在（ts 报错）

- [ ] **Step 3: 最小实现**

```ts
// ApplyCanvasActionsOpts 追加字段（保留 onGuardReject 不动）
export type CanvasActionSkipReason = 'duplicate_edge' | 'node_not_found'

export interface ApplyCanvasActionsOpts {
  onGuardReject?: (nodeId: string) => void
  /** 观测专用：op 被跳过时留痕。不改变返回值，也不改变 op 的落地结果。 */
  onSkipped?: (type: string, reason: CanvasActionSkipReason, id: string) => void
}
```

`update_node` 分支把 `if (node) { ... }` 改为 early return：

```ts
case 'update_node': {
  const node = result.nodes.find((n) => n.id === action.payload.id)
  if (!node) {
    opts?.onSkipped?.('update_node', 'node_not_found', String(action.payload.id ?? ''))
    break
  }
  if (action.payload.position) node.position = action.payload.position
  if (action.payload.data) {
    if (isTerminalRegen({
      currentStatus: node.data?.status,
      currentRecordId: node.data?.generationRecordId,
      incomingStatus: action.payload.data.status,
      incomingRecordId: action.payload.data.generationRecordId,
    })) {
      if (action.payload.id) opts?.onGuardReject?.(action.payload.id)
    } else {
      node.data = mergeNodeData(node.data, action.payload.data, IN_TRANSIT_ONLY)
    }
  }
  break
}
```

`add_edge` 分支在 push 前查重，并修正文件头注释 `:15-16`（原注释声称「重放幂等」但实现未查重）：

```ts
case 'add_edge': {
  const { id, source, target } = action.payload
  const edgeId = id ?? (source && target ? `e-${source}-${target}` : undefined)
  if (!edgeId || !source || !target) break
  if (result.edges.some((e) => e.id === edgeId)) {
    opts?.onSkipped?.('add_edge', 'duplicate_edge', edgeId)
    break
  }
  result.edges.push({ id: edgeId, source, target })
  break
}
```

- [ ] **Step 4: 跑测试确认通过 + shared 全量回归**

Run: `env -u NODE_OPTIONS npx vitest run packages/shared/src/canvasActionApplier.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: PASS（含既有 12 组用例）
Run: `env -u NODE_OPTIONS npx vitest run packages/agent/src/tools/executor.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: PASS（R4：agent 薄适配器不传回调，行为不变）

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/canvasActionApplier.ts packages/shared/src/canvasActionApplier.test.ts
git commit -m "fix(shared): dedupe add_edge and expose onSkipped for canvas PATCH observability"
```

---

### Task 4: PATCH 主通道接入埋点

**Files:**
- Modify: `apps/server/src/sessions/sessions.service.ts:125-176`（`patchCanvas`）
- Test: `apps/server/src/sessions/sessions.service.test.ts`（追加用例）

**Interfaces:**
- Consumes: `canvasPatchMetrics`、`targetKeysOf`（Task 2）、`applyCanvasActions` 的 `onSkipped`（Task 3）
- Produces: `patchCanvas(id: string, userId: string, rawOps: unknown[], clientId?: string)` —— 第 4 参数**可选**，默认 `'unknown'`；返回形状仍 `{ applied: number }`

- [ ] **Step 1: 写失败测试**（追加到既有 `sessions.service.test.ts` 的 PATCH describe）

```ts
import { canvasPatchMetrics } from './canvas-patch-metrics'

beforeEach(() => canvasPatchMetrics.reset())

it('成功 PATCH ⇒ 记录样本，skipped 精确', async () => {
  // 既有 mock：prisma.$transaction 直接执行回调，findUnique 返回 { canvasData: <含 n1> 的节点, stagedActions: null }
  const res = await service.patchCanvas('s1', 'u1', [
    { type: 'update_node', payload: { id: 'n1', position: { x: 1, y: 2 } } },
    { type: 'add_edge', payload: { id: 'e1', source: 'a', target: 'b' } },
    { type: 'add_edge', payload: { id: 'e1', source: 'a', target: 'b' } },
  ], 'c1')
  expect(res).toEqual({ applied: 3 })
  expect(canvasPatchMetrics.snapshot()).toMatchObject({
    patches: 1, ops: 3, applied: 3, skipped: 1,
    skippedByType: { add_edge: 1 }, distinctClients: 1,
  })
})

it('R3：stagedActions 409 ⇒ 不记样本', async () => {
  // mock findUnique 返回 stagedActions: '[...]'
  await expect(service.patchCanvas('s1', 'u1', [{ type: 'set_viewport', payload: { viewport: {} } }], 'c1'))
    .rejects.toThrow(/staged actions pending commit/)
  expect(canvasPatchMetrics.snapshot().patches).toBe(0)
})

it('R2：埋点抛错 ⇒ PATCH 仍成功', async () => {
  const spy = vi.spyOn(canvasPatchMetrics, 'record').mockImplementation(() => { throw new Error('boom') })
  const res = await service.patchCanvas('s1', 'u1', [{ type: 'set_viewport', payload: { viewport: {} } }], 'c1')
  expect(res).toEqual({ applied: 1 })
  spy.mockRestore()
})
```

> 说明：三个用例的 prisma mock 沿用 `sessions.service.test.ts` 既有的 `$transaction` / `findUnique` 夹具，不新造 harness。

- [ ] **Step 2: 跑测试确认失败**

Run: `env -u NODE_OPTIONS npx vitest run apps/server/src/sessions/sessions.service.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL — `canvasPatchMetrics` 未接入 / `patchCanvas` 不接受第 4 参数

- [ ] **Step 3: 最小实现**

```ts
// patchCanvas 签名（保留前 3 参数不动）
async patchCanvas(id: string, userId: string, rawOps: unknown[], clientId = 'unknown') {
  // ...既有 :130-153 的鉴权 / sanitize / remove_node 守卫 / 空 diff 短路全部不动...

  const applied = await this.prisma.$transaction(async (tx) => {
    const row = await tx.session.findUnique({ where: { id }, select: { canvasData: true, stagedActions: true } })
    if (!row) throw new NotFoundException('会话不存在')
    if (row.stagedActions) {
      throw new ConflictException(
        'Canvas has staged actions pending commit; call commitStage or rollbackStage first',
      )
    }
    const current = parseCanvas(row.canvasData)
    const skips: Array<{ type: string }> = []
    const updated = applyCanvasActions(current, sanitized, {
      onSkipped: (type) => skips.push({ type }),
    })
    const merged: CanvasData = { ...current, ...updated }
    await tx.session.update({ where: { id }, data: { canvasData: JSON.stringify(merged) } })
    return { applied: sanitized.length, skips, keys: targetKeysOf(sanitized) }
  })

  // I7/I8：只在事务成功后记；埋点任何异常都不影响主流程
  try {
    canvasPatchMetrics.record(
      { sessionId: id, clientId: clientId || 'unknown', ts: Date.now(), targetKeys: applied.keys },
      sanitized.length,
      applied.applied,
      applied.skips,
    )
  } catch (e) {
    this.logger.warn(`canvas_patch_metrics_failed sessionId=${id} err=${String(e)}`)
  }
  return { applied: applied.applied }
}
```

⚠️ `this.logger` 已存在于 `sessions.service.ts:26`；`parseCanvas` / `sanitizeClientOps` / `CanvasData` 均为既有导入，只新增 `canvasPatchMetrics` / `targetKeysOf` 两个 import。

- [ ] **Step 4: 跑测试确认通过 + 写点守卫回归**

Run: `env -u NODE_OPTIONS npx vitest run apps/server/src/sessions/sessions.service.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: PASS
Run: `env -u NODE_OPTIONS npx vitest run apps/server/src/sessions/canvas-write-governance.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: PASS（埋点不新增 `canvasData:` 落库语句，白名单 7 文件 / 12 写点零漂移）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sessions/sessions.service.ts apps/server/src/sessions/sessions.service.test.ts
git commit -m "feat(server): record PATCH samples after successful canvas transaction"
```

---

### Task 5: Controller 读 header（绕开 DTO）

**Files:**
- Modify: `apps/server/src/sessions/sessions.controller.ts:1, :77-86`
- Test: `apps/server/src/sessions/sessions.controller.headers.test.ts`（新建）

**Interfaces:**
- Consumes: `patchCanvas(id, userId, ops, clientId?)`（Task 4）
- Produces: HTTP header `x-lnkpi-canvas-client`（可选）→ service 第 4 参数；`PatchCanvasDto` **完全不动**

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { ValidationPipe } from '@nestjs/common'
import { SessionsController, PatchCanvasDto } from './sessions.controller'
import type { SessionsService } from './sessions.service'

describe('PATCH canvas header + 真实管道', () => {
  it('真实 ValidationPipe 下 { ops } 不被剥离（DTO 形状未变）', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true })
    const dto = await pipe.transform({ ops: [{ type: 'set_viewport' }] },
      { type: 'body', metatype: PatchCanvasDto })
    expect(dto).toEqual({ ops: [{ type: 'set_viewport' }] })
  })

  it('header 值下传给 service，缺失时降级 unknown', async () => {
    const svc = { patchCanvas: vi.fn().mockResolvedValue({ applied: 1 }) }
    const ctrl = new SessionsController(svc as unknown as SessionsService)
    await ctrl.patchCanvas('s1', { user: { sub: 'u1' } }, { ops: [] }, 'c-abc')
    expect(svc.patchCanvas).toHaveBeenCalledWith('s1', 'u1', [], 'c-abc')
    await ctrl.patchCanvas('s1', { user: { sub: 'u1' } }, { ops: [] }, undefined)
    expect(svc.patchCanvas).toHaveBeenLastCalledWith('s1', 'u1', [], 'unknown')
  })
})
```

说明：`SessionsController` 构造器只注入 `SessionsService`（`sessions.controller.ts:36`），上述单参数构造与真实签名一致。类型断言用 `as unknown as` 而非 `as never`（I10：CI 的 `pnpm -r build` 会编译 `*.test.ts`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `env -u NODE_OPTIONS npx vitest run apps/server/src/sessions/sessions.controller.headers.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL — `PatchCanvasDto` 未导出 / `patchCanvas` 只接受 3 参数

- [ ] **Step 3: 最小实现**

```ts
import { Body, Controller, Delete, Get, Headers, Inject, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common'

/** P1-C C1a：PATCH /sessions/:id/canvas 载荷。阶段 1 形状不变，clientId 走 header 不进 DTO。 */
export class PatchCanvasDto {
  @IsArray()
  @ArrayMaxSize(200)
  ops!: unknown[]
}

  @Patch(':id/canvas')
  @UseGuards(AuthGuard)
  async patchCanvas(
    @Param('id') id: string,
    @Req() req: { user: { sub: string } },
    @Body() dto: PatchCanvasDto,
    @Headers('x-lnkpi-canvas-client') clientId?: string,
  ) {
    const data = await this.sessionsService.patchCanvas(id, req.user.sub, dto.ops, clientId ?? 'unknown')
    return { code: 0, message: 'ok', data }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `env -u NODE_OPTIONS npx vitest run apps/server/src/sessions/sessions.controller.headers.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: PASS 2/2

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sessions/sessions.controller.ts apps/server/src/sessions/sessions.controller.headers.test.ts
git commit -m "feat(server): read canvas client header without touching PatchCanvasDto"
```

---

### Task 6: health 度量端点

**Files:**
- Modify: `apps/server/src/health/health.controller.ts`（在 `getNotifyMetrics()` 之后）
- Test: `apps/server/src/health/health.controller.test.ts`（追加用例）

**Interfaces:**
- Consumes: `canvasPatchMetrics.snapshot()`（Task 2）
- Produces: `GET /api/health/canvas-patch-metrics` → `{ ok, metrics, timestamp }`

- [ ] **Step 1: 写失败测试**

```ts
import { canvasPatchMetrics } from '../sessions/canvas-patch-metrics'

it('canvas-patch-metrics 暴露六项计数 + staleConflict', () => {
  canvasPatchMetrics.reset()
  canvasPatchMetrics.record({ sessionId: 's1', clientId: 'c1', ts: 1, targetKeys: [] }, 1, 1, [])
  const res = new HealthController().getCanvasPatchMetrics()
  expect(res.ok).toBe(true)
  expect(res.metrics).toMatchObject({ patches: 1, ops: 1, applied: 1, skipped: 0,
    nearConcurrentPairs: 0, keyOverlapPairs: 0, staleConflict: 0, distinctClients: 1 })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `env -u NODE_OPTIONS npx vitest run apps/server/src/health/health.controller.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL — `getCanvasPatchMetrics is not a function`

- [ ] **Step 3: 最小实现**

```ts
import { canvasPatchMetrics } from '../sessions/canvas-patch-metrics'

  /** SP-E 阶段 1：进程内存 PATCH 样本，供 14 天数据门取数（重启清零，取数须记录容器启动时间）。 */
  @Get('canvas-patch-metrics')
  getCanvasPatchMetrics() {
    return {
      ok: true,
      metrics: canvasPatchMetrics.snapshot(),
      timestamp: new Date().toISOString(),
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `env -u NODE_OPTIONS npx vitest run apps/server/src/health/health.controller.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/health/health.controller.ts apps/server/src/health/health.controller.test.ts
git commit -m "feat(health): expose canvas PATCH metrics endpoint"
```

---

### Task 7: 前端注入 header（不碰静态契约锚点）

**Files:**
- Modify: `apps/web/src/services/canvas-api.ts:1-2, :17-18`
- Test: `apps/web/src/services/canvas-api.patch-header.test.ts`（新建）+ 两处既有静态契约回归

**Interfaces:**
- Consumes: `getCanvasClientId()`（Task 1）、`api`（`./api` axios 实例）
- Produces: `patchCanvas(id, ops)` 形状不变，内部多一个 header

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('./api', () => ({ api: { patch: vi.fn().mockResolvedValue({ data: { data: { applied: 1 } } }) } }))
vi.mock('@/utils/canvasClientId', () => ({ getCanvasClientId: () => 'c-test' }))

import { api } from './api'
import { canvasApi } from './canvas-api'

it('patchCanvas 注入 x-lnkpi-canvas-client，URL 与 body 形状不变', async () => {
  await canvasApi.patchCanvas('s1', [{ type: 'set_viewport' }])
  expect(api.patch).toHaveBeenCalledWith('/sessions/s1/canvas',
    { ops: [{ type: 'set_viewport' }] },
    { headers: { 'x-lnkpi-canvas-client': 'c-test' } })
})

it('I6：CanvasPage.vue 的调用字面量仍存在（两处静态契约锚点）', () => {
  const src = readFileSync('apps/web/src/pages/CanvasPage.vue', 'utf8')
  expect(src).toContain('await canvasApi.patchCanvas(')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `env -u NODE_OPTIONS npx vitest run apps/web/src/services/canvas-api.patch-header.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL — 第三个参数缺失

- [ ] **Step 3: 最小实现**

```ts
import { api } from './api'
import { getCanvasClientId } from '@/utils/canvasClientId'

  patchCanvas: (id: string, ops: unknown[]) =>
    api.patch<{ data: { applied: number } }>(`/sessions/${id}/canvas`, { ops }, {
      headers: { 'x-lnkpi-canvas-client': getCanvasClientId() },
    }),
```

- [ ] **Step 4: 跑测试确认通过 + 两处静态契约 + 类型检查**

Run: `env -u NODE_OPTIONS npx vitest run apps/web/src/services/canvas-api.patch-header.test.ts apps/web/src/pages/canvas/canvasLoadGuard.wiring.test.ts apps/web/src/pages/CanvasPage.mobileChromeHygiene.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: PASS
Run: `env -u NODE_OPTIONS npx vue-tsc -b`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/canvas-api.ts apps/web/src/services/canvas-api.patch-header.test.ts
git commit -m "feat(web): send per-tab canvas client header on PATCH"
```

---

### Task 8: 全量回归、变异测试、发布与观测窗口启动

**Files:**
- Test: 既有 `canvas-write-governance.test.ts`、两处静态契约、`packages/shared`、`packages/agent`、服务端全量
- Modify: 无（只读验收 + 发布）

**Interfaces:**
- Consumes: Task 1–7 全部产出
- Produces: 生产可访问的 `GET /api/health/canvas-patch-metrics`、14 天窗口起始记录

- [ ] **Step 1: 本地全量回归（4 核，串行）**

Run（逐条）:
```bash
env -u NODE_OPTIONS npx vitest run apps/server/src/sessions apps/server/src/health --maxWorkers=1 --no-file-parallelism
env -u NODE_OPTIONS npx vitest run packages/shared/src/canvasActionApplier.test.ts packages/agent/src/tools/executor.test.ts --maxWorkers=1 --no-file-parallelism
env -u NODE_OPTIONS npx vitest run apps/web/src/utils/canvasClientId.test.ts apps/web/src/services/canvas-api.patch-header.test.ts --maxWorkers=1 --no-file-parallelism
env -u NODE_OPTIONS npx tsc --noEmit
env -u NODE_OPTIONS npx vue-tsc -b
```
Expected: 全绿，0 type errors。

- [ ] **Step 2: 变异测试（≥7 组，行为级）**

逐组注入并确认判据 **RED**：
1. 删 `add_edge` 查重 ⇒ 重复边用例 RED；
2. 删 `onSkipped?.('update_node', ...)` ⇒ 缺失节点用例 RED；
3. `NEAR_CONCURRENT_MS` 改 0 ⇒ 「不同 client 2s 内」用例 RED；
4. `record` 里去掉 `last.clientId !== s.clientId` ⇒ R5 同 client 用例 RED；
5. 埋点挪到 `$transaction` 之前 ⇒ R3 失败 PATCH 用例 RED；
6. 去掉埋点 `try/catch` ⇒ R2 用例 RED；
7. `targetKeysOf` 去掉 `edge:` 分支 ⇒ 键相交场景 RED。

⚠️ 变异不 RED 先怀疑**伪变异**（注入点被下游过滤 / 余量吞掉），别直接判「守卫无效」。⚠️ 判据自匹配恒绿：断言锚点字面量写在判据函数自身 ⇒ 用 `implementation_code()` 剔除判据函数体只看实现层。

- [ ] **Step 3: 推 PR 前核对（I11/I12）**

```bash
gh api repos/sev7n4/pi-lnk/commits/master --jq '.sha'   # 重取真实 HEAD
# 逐路径比对 worktree 裸 blob sha 与 master，确认差异恰为本计划文件清单
# 新增 CI script 也会触发发布（deploy.yml paths 含 package.json），本刀不动它
```
Expected: `ALL_LOCAL_MATCH True`、`NO_OTHER True`；若 master 前移且目标路径 blob 未变 ⇒ `MASTER_MOVED_SAFE`，换 parent/base_tree，不追溯改写历史陈述。

- [ ] **Step 4: 合并与生产发布验收**

`git squash` 合并后按 commit 真实 parent 核对 `ALL_PARALLEL_KEPT`（并行改动零回退）。`deploy.yml` 自动触发 `deploy-api` + `deploy-web`（并行无依赖），部署后 502 窗约 30s。生产验收：

```bash
curl -sS --noproxy '*' --max-time 15 https://119.29.173.89:8888/api/health/canvas-patch-metrics
curl -sS --noproxy '*' --max-time 15 https://119.29.173.89:8888/api/health
```
Expected: 前者返回 `ok:true` + 六项计数；后者 `ok:true`。

再用生产 curl 复现 PATCH 请求/响应形状（I1）：响应须仍为 `{"code":0,"message":"ok","data":{"applied":N}}`，**无新字段、无 409**。

- [ ] **Step 5: 启动 14 天观测窗口 + 记录**

记录：部署成功时间、容器镜像 tag、容器启动时间（计数器重启清零）、起始 `snapshot()`、master SHA。取数命令：
```bash
curl -sS --noproxy '*' https://119.29.173.89:8888/api/health/canvas-patch-metrics | jq .
```
窗口内**禁止改动 PATCH 契约**，否则样本作废。窗口结束按规格 §10.2 三条门判定，不达标 ⇒ NO-GO 定案（不宣告 ALL_PASS）。

- [ ] **Step 6: Commit（记录验收产物，不改运行时代码）**

```bash
git add docs/superpowers/specs/2026-11-09-sp-e-canvas-cas-decision-gate-design.md
git commit -m "docs(sp-e): record stage-1 production acceptance and observation window start"
```

---

## Self-Review

**1. Spec coverage（对照规格 §9 / §12）**

| 规格要求 | 承载 Task |
|---|---|
| I1 契约形状不变 | Task 4/5/7 + Task 8 Step 4 生产逐字段比对 |
| I2 无 DB 列 / migration | 全计划未出现 `schema.prisma`；Task 8 Step 3 核对 |
| I3 不拒绝、沿用对账纪律 | Task 4 未改失败分支；Task 5 DTO 不动 |
| I4 clientId 降级 | Task 1 ③ + Task 4 `clientId || 'unknown'` |
| I5 applier 返回形状不变 | Task 3 + R4 回归 |
| I6 静态契约锚点 | Task 7 Step 1/4 两处回归确认 |
| I7 埋点非故障源 | Task 4 try/catch + R2 |
| I8 仅事务成功后记 | Task 4 + R3 |
| I9 口径常量固定 | Task 2 `NEAR_CONCURRENT_MS` |
| §9.3 六项埋点字段 | Task 2 `snapshot()` |
| §9.4 错误处理 | Task 1/4 |
| §9.5 测试分层 | Task 1–8 全覆盖 |
| §12.2 V1–V7 | Task 8 Step 1/2/4；V1、V2 属阶段 0 文档刀，不在本计划 |
| §12.3 准入三问 | 数据门不挂 CI，本计划无 CI 门禁改动 |

**2. Placeholder scan**：无「延后实现 / 待补细节 / 泛化措辞 / 相似任务引用 / 未定义符号」实例；每个代码步骤有完整代码块与真实类型；Task 5 的构造器夹具按 `sessions.controller.ts:36` 的真实单参数签名写死。**自审修正记录**：初稿曾在 Task 5 留 `as never` 并在注释里补说明、Task 7 用了 `require('fs')` —— 已就地改为 `as unknown as SessionsService` 与 `readFileSync` import，消除 I10 违约与 ESM 下 `require` 未定义。

**3. Type consistency**：`getCanvasClientId` → `canvas-api.ts` → header `x-lnkpi-canvas-client` → `@Headers('x-lnkpi-canvas-client')` → `patchCanvas(..., clientId?: string)` → `CanvasPatchSample.clientId` 全链同名同型；`onSkipped(type, reason, id)` 在 Task 3 定义、Task 4 以 `(type) => skips.push({ type })` 消费；`staleConflict = keyOverlapPairs` 与规格 §10.2 定义一致。

**4. Review Focus**：R1→Task 1/4、R2→Task 4、R3→Task 4、R4→Task 3/8、R5→Task 2，五条均有对应用例，非空检查。

**5. 已知未覆盖（显式登记，不隐性留白）**：
- 生产 nginx access log 的 `(IP, UA, 秒)` 分辨率不因本计划提升；阶段 1 的 `stale_conflict` 完全依赖新埋点，窗口重新起算。
- 进程内存计数器重启清零、多副本各自计数；生产当前单容器 `lnkpi-api`，若扩容需改聚合口径（超出阶段 1 范围）。
- `deploy/prod-layout-workflow-verify.py:187` 的第二 PATCH 调用方不带 header ⇒ 计入 `'unknown'` client，不影响主流程，但取数时须在报告中注明其样本量。

## Execution Handoff

本计划已保存，等待用户审阅并选择执行方式（阶段 1 需另行授权，因其触发生产发布）：

- **Subagent-driven** —— 每个 Task 由新子代理实现、新审查者复核后再进下一个，最后整分支评审。最彻底；本计划 8 个 Task 接口耦合较紧（applier → service → controller → web），独立上下文成本较高，但 shared SSOT 的一次错误会污染两端，独立审查价值大。**推荐此项**。
- **Native** —— 本会话逐 Task 实现，最后一次性整分支评审。最快，但直到末尾才有独立审查。

请确认：计划是否捕捉了你要的内容，以及采用哪种执行方式。
