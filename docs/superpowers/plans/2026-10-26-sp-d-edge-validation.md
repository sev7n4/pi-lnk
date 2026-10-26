# SP-D 连线校验（edge validation）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（native/inline，本计划由用户指定 native 模式）implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 画布两条加边入口（用户手拉 / agent 工具）统一经过服务端权威校验：端点存在性 + 自环 + 环检测 + 有向对去重，fail-closed。

**Architecture:** shared 纯函数 `validateEdgeAdditions`/`wouldCreateCycle` 为唯一校验原语；服务端 `connectNodes`/`addNodesBatch` 消费之；浏览器侧新增 `POST /agent/canvas/connect-nodes`（AuthGuard+属主校验）委托同一服务方法（`/agent/internal/*` 是服务间 token，浏览器不可直达）；前端 `onConnect` 改走该通道（乐观本地 add + 失败回滚），`isValidConnection` 只做廉价本地拦截。

**Tech Stack:** TypeScript / Vue 3 + vue-flow / NestJS / vitest（server、shared）/ node:test（pi-runtime）。

**Spec:** `docs/superpowers/specs/2026-10-26-sp-d-edge-validation-design.md`（冲突时以 spec G1–G4/N1–N7 为准）
**ADR:** `docs/adr/0014-edge-validation-dag-and-unified-channel.md`

## Global Constraints（全部逐字有效，每任务隐含遵守）

- `edgeId` 规则不变：`e-${source}-${target}`（N5 存量零迁移）。
- 校验为纯函数：无随机、无时钟、无 IO（N7）；同输入同输出。
- 硬非法（`missing-node`/`self-loop`/`cycle`）⇒ **整批 fail-closed 拒绝**（server 400，错误逐条点名）；`duplicate` ⇒ 幂等跳过不报错（N4）。
  - **Ruling（规格内部矛盾裁决，落 ledger）**：spec §8 写「混合批合法者仍加」与 §6.3/G1「rejected 非空 ⇒ 400」冲突。裁决：**整批 fail-closed**（G1/G2 可验收判据优先于 §8 叙述行；部分落库是 silent-degrade 面）。
- 存量边/存量画布零改动：只拦新加边（N5）。
- 测试运行纪律（本机 4 核）：web 用 `~/.nvm/versions/node/v24.13.0/bin/node ./apps/web/node_modules/vitest/vitest.mjs run <file> --maxWorkers=1 --no-file-parallelism`；server 用 `pnpm --filter @lnkpi/server exec vitest run <file>`；pi-runtime 用 `node --import tsx --test src/<file>.test.ts`（在 `services/pi-runtime/` 下）；**禁并发跑测试与 commit**，输出重定向到文件看尾部。
- 改 `.vue` 后必跑 `pnpm --filter @lnkpi/web exec vue-tsc -b`。
- 提交 message：`feat(canvas): …` / `test(shared): …` 等；**只在 worktree 分支提交，master 不碰**。
- 零第三方依赖新增；无 UI 皮肤改动（错误反馈复用既有通道）。

## Review Focus（spec 暗示但单任务测试盖不到的输入类）

1. **混合批（部分合法部分非法）**：期望整批拒绝、零落库（Ruling 见上）——Task 2 用例锁定。
2. **批内自环**（`create_nodes_batch` 两节点 key 相同或自指）：期望 400——Task 3 锁定。
3. **手拉边服务端校验失败后的本地回滚**：期望 UI 无残留边、错误可见——Task 5 静态+行为用例锁定。
4. **撤销栈契约**：`onConnect` 不再 `persistUserEdit` 后，撤销栈对新增边的捕获是否退化——Task 5 步骤核 `useCanvasUndoStack` 契约并出 Ruling。
5. **`/agent/internal/connect-nodes`（agent 路径）与浏览器新端点的校验一致性**：同一服务方法，Task 4 用例锁定 400 语义两边相同。

---

### Task 1: shared 校验原语 `graph.ts`

**Files:**
- Create: `packages/shared/src/canvas/graph.ts`
- Modify: `packages/shared/src/index.ts`（canvas 导出区加一行）
- Test: `packages/shared/src/canvas/graph.test.ts`

**Interfaces:**
- Produces: `validateEdgeAdditions(nodes, existingEdges, newEdges): { valid: {id,source,target}[]; rejected: {edge,reason}[] }`、`wouldCreateCycle(existingEdges, source, target): boolean`、`edgeIdOf(source, target): string`、类型 `RawEdge`/`EdgeRejectReason`（Task 2/3/4 消费）。

- [ ] **Step 1: 写失败测试** `packages/shared/src/canvas/graph.test.ts`（金样：自环/2-环/长环/非环/悬空端点/重复幂等/混合批/确定性）

```ts
import { describe, expect, it } from 'vitest'
import { edgeIdOf, validateEdgeAdditions, wouldCreateCycle } from './graph'

const nodes = (ids: string[]) => ids.map((id) => ({ id }))

describe('wouldCreateCycle', () => {
  it('自环 source===target 即成环', () => {
    expect(wouldCreateCycle([], 'a', 'a')).toBe(true)
  })
  it('直接 2-环：a->b 存在时 b->a 成环', () => {
    expect(wouldCreateCycle([{ source: 'a', target: 'b' }], 'b', 'a')).toBe(true)
  })
  it('长环 a->b->c 存在时 c->a 成环', () => {
    expect(wouldCreateCycle([
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ], 'c', 'a')).toBe(true)
  })
  it('无回边不成环（a->b 后加 c->d、b->c）', () => {
    const edges = [{ source: 'a', target: 'b' }, { source: 'c', target: 'd' }]
    expect(wouldCreateCycle(edges, 'b', 'c')).toBe(false)
  })
})

describe('validateEdgeAdditions', () => {
  const ns = nodes(['a', 'b', 'c', 'd'])
  it('悬空端点 rejected(missing-node)', () => {
    const r = validateEdgeAdditions(ns, [], [{ source: 'a', target: 'ghost' }])
    expect(r.valid).toHaveLength(0)
    expect(r.rejected[0].reason).toBe('missing-node')
  })
  it('自环 rejected(self-loop)', () => {
    const r = validateEdgeAdditions(ns, [], [{ source: 'a', target: 'a' }])
    expect(r.rejected[0].reason).toBe('self-loop')
  })
  it('已存在同向对 rejected(duplicate)（幂等跳过语义，不报错）', () => {
    const r = validateEdgeAdditions(ns, [{ source: 'a', target: 'b' }], [{ source: 'a', target: 'b' }])
    expect(r.valid).toHaveLength(0)
    expect(r.rejected[0].reason).toBe('duplicate')
  })
  it('成环 rejected(cycle)，合法边产出 id=e-source-target', () => {
    const r = validateEdgeAdditions(ns, [{ source: 'a', target: 'b' }], [
      { source: 'c', target: 'd' },
      { source: 'b', target: 'a' },
    ])
    expect(r.valid).toEqual([{ id: 'e-c-d', source: 'c', target: 'd' }])
    expect(r.rejected).toEqual([{ edge: { source: 'b', target: 'a' }, reason: 'cycle' }])
  })
  it('批内互相成环（a->b 后 b->a）第二条约 cycle', () => {
    const r = validateEdgeAdditions(ns, [], [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ])
    expect(r.valid).toHaveLength(1)
    expect(r.rejected[0].reason).toBe('cycle')
  })
  it('确定性：同输入两次调用结果 deep-equal', () => {
    const input = [ns, [{ source: 'a', target: 'b' }], [{ source: 'b', target: 'c' }]] as const
    expect(validateEdgeAdditions(...input)).toEqual(validateEdgeAdditions(...input))
  })
})

describe('edgeIdOf', () => {
  it('沿用 e-source-target 规则', () => {
    expect(edgeIdOf('a', 'b')).toBe('e-a-b')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/shared && ~/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/canvas/graph.test.ts`
Expected: FAIL（`Cannot find module './graph'`）

- [ ] **Step 3: 最小实现** `packages/shared/src/canvas/graph.ts`

```ts
/**
 * SP-D 连线校验原语（ADR-0014）：框架无关纯函数，connectNodes / addNodesBatch /
 * 浏览器端点共同消费。确定性、无 IO（N7）。存量画布零迁移（N5）。
 */
export interface RawEdge { source: string; target: string }

export type EdgeRejectReason = 'missing-node' | 'self-loop' | 'cycle' | 'duplicate'

export interface EdgeAdditionResult {
  valid: Array<{ id: string; source: string; target: string }>
  rejected: Array<{ edge: RawEdge; reason: EdgeRejectReason }>
}

/** 沿用既有确定性有向对 id 规则，不改（N5）。 */
export function edgeIdOf(source: string, target: string): string {
  return `e-${source}-${target}`
}

/**
 * 加入 source→target 是否会闭合环：从 target 沿既有边出发能否到达 source。
 * source===target 视为自环成环（N2）。
 */
export function wouldCreateCycle(existingEdges: RawEdge[], source: string, target: string): boolean {
  if (source === target) return true
  const adj = new Map<string, string[]>()
  for (const e of existingEdges) {
    const list = adj.get(e.source)
    if (list) list.push(e.target)
    else adj.set(e.source, [e.target])
  }
  const seen = new Set<string>()
  const stack = [target]
  while (stack.length) {
    const cur = stack.pop()!
    if (cur === source) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const next of adj.get(cur) ?? []) if (!seen.has(next)) stack.push(next)
  }
  return false
}

/**
 * 在已有 nodes/edges 上校验一批待加边（N1 端点存在 → N2 自环 → N4 去重 → N3 环）。
 * duplicate 仅为幂等跳过标记；调用方对 missing-node/self-loop/cycle 必须 fail-closed。
 */
export function validateEdgeAdditions(
  nodes: Array<{ id: string }>,
  existingEdges: RawEdge[],
  newEdges: RawEdge[],
): EdgeAdditionResult {
  const nodeIds = new Set(nodes.map((n) => n.id))
  const seenPairs = new Set(existingEdges.map((e) => `${e.source}->${e.target}`))
  const accEdges = [...existingEdges]
  const valid: EdgeAdditionResult['valid'] = []
  const rejected: EdgeAdditionResult['rejected'] = []
  for (const edge of newEdges) {
    let reason: EdgeRejectReason | null = null
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) reason = 'missing-node'
    else if (edge.source === edge.target) reason = 'self-loop'
    else if (seenPairs.has(`${edge.source}->${edge.target}`)) reason = 'duplicate'
    else if (wouldCreateCycle(accEdges, edge.source, edge.target)) reason = 'cycle'
    if (reason) rejected.push({ edge, reason })
    else {
      valid.push({ id: edgeIdOf(edge.source, edge.target), source: edge.source, target: edge.target })
      seenPairs.add(`${edge.source}->${edge.target}`)
      accEdges.push(edge)
    }
  }
  return { valid, rejected }
}
```

- [ ] **Step 4: 导出** — `packages/shared/src/index.ts` 在 `export * from './canvas/viewport'` 后加 `export * from './canvas/graph'`。
- [ ] **Step 5: 跑测试确认通过**（同 Step 2 命令）Expected: PASS 全绿。
- [ ] **Step 6: 变异自检**（本仓血泪纪律：证明断言能红）——临时把 `wouldCreateCycle` 的 `if (cur === source) return true` 改成 `if (cur === target) return true`，Step 2 命令须转红；改回后复绿。
- [ ] **Step 7: Commit** `test(shared): SP-D 连线校验原语 validateEdgeAdditions/wouldCreateCycle 金样`

### Task 2: 服务端 `connectNodes` 接入校验（fail-closed）

**Files:**
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts:1260-1285`（connectNodes）
- Test: `apps/server/src/agent/agent-canvas-tools.service.test.ts`（:310 既有用例旁追加）

**Interfaces:**
- Consumes: Task 1 的 `validateEdgeAdditions`（从 `@lnkpi/shared` 导入，与文件既有 shared 导入方式一致）。
- Produces: `connectNodes` 对硬非法抛 `BadRequestException`（消息逐条 `source->target (reason)`）；duplicate 幂等跳过。

- [ ] **Step 1: 写失败测试**（在既有 `connectNodes adds edges` 用例后追加）

```ts
it('connectNodes 拒绝悬空端点（missing-node，fail-closed）', async () => {
  canvas = { nodes: [{ id: 'a', type: 'image', position: { x: 0, y: 0 }, data: {} }], edges: [] }
  await expect(svc.connectNodes({ sessionId: 's1', edges: [{ source: 'a', target: 'ghost' }] }))
    .rejects.toThrow(/ghost/)
  expect(canvas.edges).toHaveLength(0)
})
it('connectNodes 拒绝自环', async () => {
  canvas = { nodes: [{ id: 'a', type: 'image', position: { x: 0, y: 0 }, data: {} }], edges: [] }
  await expect(svc.connectNodes({ sessionId: 's1', edges: [{ source: 'a', target: 'a' }] }))
    .rejects.toThrow(/self-loop/)
})
it('connectNodes 拒绝成环（a->b 已存在时 b->a）', async () => {
  canvas = {
    nodes: [{ id: 'a', type: 'image', position: { x: 0, y: 0 }, data: {} },
            { id: 'b', type: 'image', position: { x: 280, y: 0 }, data: {} }],
    edges: [{ id: 'e-a-b', source: 'a', target: 'b' }],
  }
  await expect(svc.connectNodes({ sessionId: 's1', edges: [{ source: 'b', target: 'a' }] }))
    .rejects.toThrow(/cycle/)
  expect(canvas.edges).toHaveLength(1)
})
it('connectNodes 重复同向对幂等跳过（零动作不报错）', async () => {
  canvas = {
    nodes: [{ id: 'a', type: 'image', position: { x: 0, y: 0 }, data: {} },
            { id: 'b', type: 'image', position: { x: 280, y: 0 }, data: {} }],
    edges: [{ id: 'e-a-b', source: 'a', target: 'b' }],
  }
  const result = await svc.connectNodes({ sessionId: 's1', edges: [{ source: 'a', target: 'b' }] })
  expect(result.actions).toHaveLength(0)
})
```

- [ ] **Step 2: 跑测试确认失败** Run: `pnpm --filter @lnkpi/server exec vitest run src/agent/agent-canvas-tools.service.test.ts` Expected: 新增 4 用例 FAIL（现实现放行悬空/自环/成环）。
- [ ] **Step 3: 改 connectNodes**——`loadSession` 后调 `validateEdgeAdditions(canvas.nodes, canvas.edges, input.edges)`；`rejected.filter(r => r.reason !== 'duplicate')` 非空 ⇒ `throw new BadRequestException('connect_nodes: ' + 逐条 'source->target (reason)' 清单)`；`valid` 映射为既有 `add_edge` action（payload 形状与现实现逐字段一致，id 用 `edgeIdOf`）；duplicate 不产动作。保留 `applyOrStage` 与返回 `{ actions }` 契约不变（dedup-to-empty 快路径不受影响）。
- [ ] **Step 4: 跑测试确认通过**（同 Step 2；既有 `connectNodes adds edges` 必须仍绿）。
- [ ] **Step 5: Commit** `feat(canvas): connectNodes 接入统一连线校验（端点/自环/环 fail-closed，重复幂等）`

### Task 3: 服务端 `addNodesBatch` edges 环/自环校验

**Files:**
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts:1037-1066`（addNodesBatch edges 段）
- Test: `apps/server/src/agent/agent-canvas-tools.service.test.ts`

**Interfaces:**
- Consumes: Task 1 `wouldCreateCycle`。E1 端点解析与批内 dedupeKey **保持不动**（最小增量）。
- Produces: 批内 resolved edge 自环或成环 ⇒ 整批 400（E1 同款错误风格）。

- [ ] **Step 1: 写失败测试**（复用既有 addNodesBatch 测试的画布/节点构造模式）

```ts
it('addNodesBatch edges 批内互相成环 ⇒ 整批 400', async () => {
  // 节点构造沿用既有用例写法：nodes: [a, b]（或批内 key 解析）
  // edges: [{source:'a',target:'b'},{source:'b',target:'a'}] ⇒ rejects.toThrow(/cycle/)
})
it('addNodesBatch edges 自环 ⇒ 400', async () => {
  // edges: [{source:'a',target:'a'}] ⇒ rejects.toThrow(/self-loop/)
})
```

（Step 1 时按既有用例真实签名补全 `nodes`/`nodesBatch` 输入，不改断言目标。）

- [ ] **Step 2: 跑测试确认失败**（同 Task 2 命令）。
- [ ] **Step 3: 实现**——在 E1 解析出 resolved edges 后、生成 `add_edge` action 前：`acc = [...canvas.edges]`；对每条 `e`：`e.source === e.target` ⇒ 400(self-loop)；`wouldCreateCycle(acc, e.source, e.target)` ⇒ 400(cycle)；通过则 `acc.push(e)`。错误消息沿用 E1 风格点名 `source->target`。
- [ ] **Step 4: 跑测试确认通过**（既有 addNodesBatch 全部用例必须仍绿）。
- [ ] **Step 5: Commit** `feat(canvas): addNodesBatch 批量 edges 增加自环/环校验（fail-closed）`

### Task 4: 浏览器侧端点 `POST /agent/canvas/connect-nodes`

**Files:**
- Modify: `apps/server/src/canvas/canvas.controller.ts`（新 DTO + 端点）
- Modify: `apps/server/src/canvas/canvas.service.ts`（`assertSessionOwned`）
- Modify: `apps/server/src/canvas/canvas.module.ts`（imports 加 `AgentModule`；若成环用 `forwardRef`，本仓先例：反向依赖用惰性 get，禁构造器环）
- Test: 就近既有 harness（`apps/server/src/canvas/` 下无 controller 测试则只测 service 层新方法；归属逻辑为 prisma findFirst，与 `update` 同款）

**Interfaces:**
- Consumes: Task 2 的 `connectNodes`（同一服务方法 ⇒ agent/浏览器校验天然一致，Review Focus #5）。
- Produces: `POST /agent/canvas/connect-nodes`，body `{ sessionId, edges: [{source,target}] }`，成功 `{code:0,data:{actions}}`，硬非法 400 透传。

- [ ] **Step 1: 写失败测试**（若 `apps/server/src/canvas/` 有既有 `*.test.ts` harness 则加用例：属主不匹配 ⇒ 404/NotFound；无 harness ⇒ 为 `assertSessionOwned` 建最小单测，mock prisma 同既有 service 测试模式）
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**——`CanvasService.assertSessionOwned(id, userId)`：`findFirst({ where: { id, userId } })` 空 ⇒ `NotFoundException('Session not found')`（与 `update` 同款）；`canvas.controller.ts` 加 `ConnectNodesDto`（`@IsString sessionId` + `@ValidateNested({each:true})` 的 `{source,target}` 双 `@IsString`，`@ArrayMaxSize(50)`）与端点（`@UseGuards(AuthGuard)` + `assertSessionOwned` + 委托 `this.agentCanvasTools.connectNodes(...)`）；`canvas.module.ts` imports 加 `AgentModule`（`AgentModule` 已 `exports: [..., AgentCanvasToolsService]`）。
- [ ] **Step 4: 跑测试确认通过** + Task 2 的 service 用例仍绿（证明委托语义一致）。
- [ ] **Step 5: Commit** `feat(canvas): 浏览器侧 connect-nodes 端点（AuthGuard+属主校验，委托统一校验通道）`

### Task 5: 前端收口（isValidConnection + onConnect 走服务通道）

**Files:**
- Modify: `apps/web/src/services/canvas-api.ts`（新增 `connectNodes`）
- Modify: `apps/web/src/pages/CanvasPage.vue`（`:is-valid-connection` 绑定（:6063 `@connect` 同元素）、`isValidConnection` 函数、`onConnect`（:1418）重写）
- Test: `apps/web/src/pages/CanvasPage.edgeValidation.wiring.test.ts`（新建，静态契约，剥注释后断言）

**Interfaces:**
- Consumes: Task 4 端点。`vue-flow` 的 `useVueFlow` 已有 `addEdge`；回滚需要 `removeEdges`（从同一 `useVueFlow` 解构）。
- Produces: 手拉边 = 乐观本地 add + 服务端校验；失败回滚并反馈；`onConnect` 不再调 `persistUserEdit`（G4 静态断言）。

- [ ] **Step 1: 写失败静态测试** `CanvasPage.edgeValidation.wiring.test.ts`（沿用本仓静态契约模式：读源码、**剥注释后**断言，防注释假绿）

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const HERE = resolve(import.meta.dirname) // ESM：禁 __dirname
const src = readFileSync(resolve(HERE, '../pages/CanvasPage.vue'), 'utf8')
const strip = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
const body = strip(src)

describe('SP-D 手拉边校验收口（静态契约）', () => {
  it('isValidConnection 已定义且经 :is-valid-connection 绑到 VueFlow', () => {
    expect(body).toMatch(/function isValidConnection\(/)
    expect(body).toMatch(/:is-valid-connection="isValidConnection"/)
  })
  it('isValidConnection 拦自环 + 本地已存在同向对', () => {
    const fn = body.match(/function isValidConnection\([\s\S]*?\n\}/)?.[0] ?? ''
    expect(fn).toContain('connection.source === connection.target')
    expect(fn).toContain('->')
  })
  it('onConnect 走 canvasApi.connectNodes 服务通道', () => {
    const fn = body.match(/function onConnect\([\s\S]*?\n\}/)?.[0] ?? ''
    expect(fn).toContain('canvasApi.connectNodes')
  })
  it('onConnect 不再 persistUserEdit 整份直存（G4）', () => {
    const fn = body.match(/function onConnect\([\s\S]*?\n\}/)?.[0] ?? ''
    expect(fn).not.toContain('persistUserEdit')
  })
})
```

（`import.meta.dirname` 不可用时用 `fileURLToPath(import.meta.url)`——本机 node24 vitest 已支持 dirname，按实际报错切换。）

- [ ] **Step 2: 跑测试确认失败** Run: `cd apps/web && ~/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run src/pages/CanvasPage.edgeValidation.wiring.test.ts --maxWorkers=1 --no-file-parallelism` Expected: FAIL。
- [ ] **Step 3: 实现**——
  1. `canvas-api.ts` 加 `connectNodes: (sessionId, edges) => api.post('/agent/canvas/connect-nodes', { sessionId, edges })`；
  2. `CanvasPage.vue` 加 `isValidConnection`（拦 `source===target` + `edges` 中已存在同向对；注意用**剥注释后**逻辑、取值自页面现用 edges 引用名）；模板 `@connect` 同元素加 `:is-valid-connection="isValidConnection"`；
  3. `onConnect` 重写：保留 `connectCompleted/pendingConnect/connectPicker` 复位 ⇒ `addEdge({ id: 'e-${source}-${target}', source, target, sourceHandle, targetHandle })` 乐观落本地 ⇒ `canvasApi.connectNodes(sessionId, [{source, target}])`；catch：`removeEdges([刚才的边])` + 复用页面既有错误反馈通道（与 `saveCanvas` 失败反馈同款；若无 toast 机制则 console.error + 现有提示位，实现时定，落 Ruling）；
  4. **核撤销栈契约**（Review Focus #4）：读 `useCanvasUndoStack` 与 `saveCanvas(commitAfterChange)` 关系，确认去掉 `persistUserEdit` 后撤销栈对手拉边的行为，出 ledger Ruling（预期：接受「撤销粒度随下一次整存提交」的退化并在 Ruling 记录代价；若发现破坏性回归则改在本地补 undo commit、不动服务通道）。
- [ ] **Step 4: 跑静态测试通过 + `vue-tsc -b` 全绿 + 相关既有 CanvasPage 测试抽跑**（`CanvasPage.mobileCreateLoop.test.ts` 等涉及 persistUserEdit 断言的文件确认未被破坏）。
- [ ] **Step 5: Commit** `feat(web): 手拉边收口服务端统一校验通道（isValidConnection + onConnect 重写）`

### Task 6: pi-runtime 工具描述注明约束

**Files:**
- Modify: `services/pi-runtime/src/tools/canvas-write.ts`（`connect_nodes`(:977) / `create_nodes_batch` edges 描述）

**Interfaces:**
- Consumes: 无代码依赖；纯 description 文案（零 L6 预算成本——description 不进 prompt 组合）。

- [ ] **Step 1: 修改 description**——两个工具的 description 末尾追加：`端点须为画布已存在节点 id；禁止自环与成环（服务端 fail-closed 拒绝）；同向重复边幂等跳过。`
- [ ] **Step 2: 跑相关测试**——`cd services/pi-runtime && node --import tsx --test src/tools/canvas-write.test.ts`（若描述有快照断言需同步）；`node --import tsx --test src/tools/tiering.test.ts`（归属不变确认）。
- [ ] **Step 3: Commit** `feat(runtime): connect_nodes/create_nodes_batch 描述注明连线约束`

### 收尾（非 Task，收尾清单）

- [ ] `pnpm -r build` 全绿（提交前必跑；web 走 `vue-tsc -b`）
- [ ] `pnpm verify-spec-figures --file docs/superpowers/specs/2026-10-26-sp-d-edge-validation-design.md`（提交的 spec 版本复验 0 错误）
- [ ] INDEX 重生成：`python3 scripts/docs/gen_index.py > scripts/docs/index_data.json` + `gen_index_md.py`（净丢失须为 0）
- [ ] whole-branch review（requesting-code-review，fresh reviewer）
- [ ] push + PR（四必填：动机/影响面/验证证据/runtime 流水线=是，tag=合并后 master 短 SHA）+ CI 盯绿 + squash 合并 + 清 worktree
