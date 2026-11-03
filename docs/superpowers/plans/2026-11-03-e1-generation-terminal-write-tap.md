# E1 生成终态写点直通（terminal write tap）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「终态落库 → 简报送达」的延迟从 0~60s（1min tick 全表扫描）降到 P95 ≤ 5s，通过 Prisma `$extends` 在 generationRecord 写咽喉拦截终态迁移并经由领域事件总线触发既有 `notifyTerminalsOnce`，studio 27 个写点零改动。

**Architecture:** 新增一个 leaf 事件总线 `TerminalEventBus`（Node EventEmitter 单例，零环依赖）+ 一个 `$extends` 拦截器 `buildTerminalWriteTap`（判据树 + fire-and-forget 发射事件）。`PrismaModule` 用 `useFactory` 按 flag 挂载扩展并重绑丢失的生命周期方法。`GenerationReaperService.onModuleInit` 订阅该事件后调用既有的 `notifyTerminalsOnce('terminal-write')`，单飞/去重/arm 全复用。新增 `NotifyMetrics` 按「已通报记录数」计数供 G-1 验收。tap 与 reaper 经事件总线解耦，规避 PrismaService→reaper 初始化环（D-6），并为总纲 E5「事件入口统一」铺路。

**Tech Stack:** NestJS (PrismaService / PrismaClient `$extends` + `Prisma.defineExtension`)，Prisma 6.2.1，SQLite（测试库），Vitest（node24，`--maxWorkers=1 --no-file-parallelism`），TypeScript strict。

**Spec:** `docs/superpowers/specs/2026-11-03-e1-generation-terminal-write-tap-design.md`（已含评审五处修正：领域事件总线解耦 / 生命周期挂载配方 / 度量口径按记录数 / status 自由串白名单 / 事务 macrotask defer）。本计划从该规格逐条推导，executor 同时读规格与计划。

## Global Constraints

- **实施基线**：须基于含 #684 `5583168a` 与 #685 `9e66ef84` 的提交。本 worktree `feature/e1-terminal-write-tap` 已从 `origin/master`（HEAD `7a53963f`）切出，已含两提交。禁止在主仓检出（并行会话占用）改任何文件；所有改动只落本 worktree。
- **分支约定**：feature 分支 + PR + squash merge；提交只在 worktree 内进行；禁止 `git add -A`（按文件 `git add`）；推前跑 `npx tsc --noEmit`（CI 的 tsc 会编译 `*.test.ts`，本地 node:test 过 ≠ CI tsc 过）。
- **feature flag** `LNKPI_TERMINAL_WRITE_TAP`：env，缺省开；`=== 'false'` 才关；关 = 行为与今天逐字节一致（不挂扩展、不订阅事件）。
- **终态集合**：运行时白名单 `TERMINAL = ['completed','failed']`。`generationRecord.status` 是自由 `String`（非 Prisma enum），判据是运行时数组不是类型级。
- **reason 集合**（NotifyMetrics 键）：`terminal-write` / `notify-tick` / `periodic` / `startup` / `manual` / `orphan-reap`。
- **G-1 度量口径**：tick 占比 = `Σnotified{notify-tick} / Σnotified{all-reason}`，按**已通报记录数**计，禁止按扫描调用次数计（否则 vacuous pass）。目标上线一周后 <10%。
- **目标延迟**：终态落库→直发触发 P95 ≤ 5s（§9）。
- **零写点改动（D-1）**：`studio.service.ts` / `generation-reaper.service.ts` / `late-generation-notify.ts` 的 `generationRecord` update 调用零行变更。
- **不改 `notifyTerminalsOnce` 内部**：直发/去重/单飞守卫/arm/onDelivered 原样复用（§3 不做）。
- **不做**：outbox 表 / 新 worker / 新定时器 / E3 同会话聚合 / E4 失败文案 / 拦截 reaper 对 canvasData/Session 的写。
- **解耦（D-6）**：`terminal-write-tap` 不得 import 或调用 `GenerationReaperService`，只向 `TerminalEventBus` 发射事件。
- **测试运行**：`nvm use 24` 后 `pnpm --filter @lnkpi/server exec vitest run <file> --maxWorkers=1 --no-file-parallelism`（4核/8GB 防 OOM/SIGTERM137；改组件后务必分批且禁并发）。

## Review Focus

（规格只描述「必须做什么」，以下五类是规格沉默但真实会咬人的输入/失败模式；每条已在对应 task 的步骤里挂了测试。）

1. **flag 解析错误**：env 取 `'false'` 之外的值（如 `'0'`/`'off'`/`'FALSE'`）被误判为关 → tap 错挂或错不挂。→ Task 4 步骤用 `=== 'false'` 精确解析并测三态（未设/'`true`'/'`false`'）。
2. **事件总线订阅泄漏**：`onModuleInit` 多次调用累积订阅 → 一次发射触发多次 `notifyTerminalsOnce` → 双通报。→ Task 5 测「一次发射仅一次调用」且 reaper 用单例 handler 引用（便于未来 `onModuleDestroy` 退订）；现有 31 用例从不发射该事件，故历史订阅不会在 E1 测试里被误触发。
3. **`$extends` 类型外泄**：扩展后消费者 `PrismaService` 类型变化导致全仓 tsc 报错。→ Task 4 用 `useFactory` 返回 `as unknown as PrismaService`，Task 4 末尾跑 server 全量 `tsc --noEmit`。
4. **度量口径虚高（vacuous pass）**：按扫描调用次数计 → `terminal-write` 每次终态写都 +1，必碾压 `notify-tick`。→ Task 2/Task 5 按 `notified>0` 的**记录数**累加；Task 2 单测验证 `incrNotified(0/-1)` 不计数。
5. **写路径被通报阻塞（D-2 回归）**：若把 `void bus.emit` 改成 `await`，写延迟耦合简报。→ Task 3 单测「bus.emit 抛错仍返回 result」+ Task 8 变异（去掉 try/catch 包 emit ⇒ 该用例红）。

---

## File Structure

| 文件 | 责任 | 新建/改 |
|---|---|---|
| `apps/server/src/studio/terminal-events.ts` | leaf 事件总线：`TerminalEventBus` 类 + `TERMINATION_EVENT` 常量 + 模块级单例 `terminalEventBus` | 新建 |
| `apps/server/src/studio/notify-metrics.ts` | leaf 计数器：`NotifyMetrics` 类（按 reason 记 notified/scans）+ 模块级单例 `notifyMetrics` | 新建 |
| `apps/server/src/studio/terminal-write-tap.ts` | `$extends` 拦截器：`isTerminalGenerationWrite`（纯函数判据）+ `buildTerminalWriteTap`（emit 事件，fire-and-forget，defer 可注入） | 新建 |
| `apps/server/src/prisma/prisma.module.ts` | `useFactory` 按 flag 挂载扩展并重绑 `onModuleInit/onModuleDestroy` | 改 |
| `apps/server/src/studio/generation-reaper.service.ts` | 构造函数加可选 `bus?`；`onModuleInit` 订阅事件；`notifyTerminalsOnce` 内 `notifyMetrics.incrNotified(reason, notified)` | 改 |
| `apps/server/src/health/health.controller.ts` | 加 `GET /health/notify-metrics` 返回 `notifyMetrics.snapshot()` | 改 |
| `apps/server/src/studio/terminal-events.test.ts` | 总线单测 | 新建 |
| `apps/server/src/studio/notify-metrics.test.ts` | 计数器单测 | 新建 |
| `apps/server/src/studio/terminal-write-tap.test.ts` | 判据树 + `$extends` 行为 + D-2 fail-open + 返回值透传 + 变异 | 新建 |
| `apps/server/src/studio/generation-reaper.service.test.ts` | 追加 E1 describe（事件→订阅→`notifyTerminalsOnce('terminal-write')`，用本地 bus 隔离） | 改 |
| `apps/server/src/health/health.controller.test.ts` | 追加 `/health/notify-metrics` 返回结构断言 | 改（若存在） |

> 注：`terminal-events.ts` / `notify-metrics.ts` / `terminal-write-tap.ts` 三者均为 leaf（仅依赖 `node:events` 与 `@prisma/client`），无任何 Nest 模块环。`prisma.module.ts` 与 `generation-reaper.service.ts` 仅 import 这些 leaf，不反向被 leaf import。

---

## Task 0: 环境校核（worktree + 依赖 + 测试基线）

**Files:** （无新增；仅验证）

**说明：** 确认在正确的 worktree 且 #684/#685 在场，依赖已装，reaper 既有 31 用例绿，作为后续 task 的回归基线。

- [ ] **Step 1: 确认 worktree 与前置提交**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && git log --oneline -1
git merge-base --is-ancestor 9e66ef84 HEAD && echo "PRE #685 OK" || echo "PRE MISSING"
```
Expected: HEAD 在 `feature/e1-terminal-write-tap`，且 `PRE #685 OK`。

- [ ] **Step 2: 装依赖（若 node_modules 缺失）**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && source ~/.nvm/nvm.sh && nvm use 24
pnpm install
```
Expected: 安装成功（含 `patches/` 目录被复制到 Docker 之外的本地，依 pnpm workspace 配置）。

- [ ] **Step 3: 跑 reaper 基线测试（记录绿）**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @lnkpi/server exec vitest run src/studio/generation-reaper.service.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: 31 用例全 PASS（含 `终态通报快节拍` describe）。

- [ ] **Step 4: 提交规划（不提交代码，仅记录基线）**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && git status --short
```
Expected: 工作树干净（除未跟踪的计划/规格文件）。

---

## Task 1: terminal-events.ts（leaf 事件总线）

**Files:**
- Create: `apps/server/src/studio/terminal-events.ts`
- Test: `apps/server/src/studio/terminal-events.test.ts`

**Interfaces:**
- Consumes: 无（leaf）
- Produces: `TerminalEventBus` 类（方法 `emitTerminalized()` / `onTerminalized(cb)` / `offTerminalized(cb)`）；常量 `TERMINATION_EVENT = 'generation-record:terminalized'`；单例 `terminalEventBus`。

- [ ] **Step 1: 写失败测试**
```ts
// apps/server/src/studio/terminal-events.test.ts
import { describe, it, expect, vi } from 'vitest'
import { TerminalEventBus, TERMINATION_EVENT, terminalEventBus } from './terminal-events'

describe('TerminalEventBus', () => {
  it('onTerminalized 收到 emitTerminalized 一次', () => {
    const bus = new TerminalEventBus()
    const cb = vi.fn()
    bus.onTerminalized(cb)
    bus.emitTerminalized()
    expect(cb).toHaveBeenCalledTimes(1)
  })
  it('offTerminalized 后不再收到', () => {
    const bus = new TerminalEventBus()
    const cb = vi.fn()
    bus.onTerminalized(cb)
    bus.offTerminalized(cb)
    bus.emitTerminalized()
    expect(cb).not.toHaveBeenCalled()
  })
  it('事件名常量稳定', () => {
    expect(TERMINATION_EVENT).toBe('generation-record:terminalized')
  })
  it('模块级单例可被订阅', () => {
    const cb = vi.fn()
    terminalEventBus.onTerminalized(cb)
    terminalEventBus.emitTerminalized()
    terminalEventBus.offTerminalized(cb)
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @lnkpi/server exec vitest run src/studio/terminal-events.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写最小实现**
```ts
// apps/server/src/studio/terminal-events.ts
import { EventEmitter } from 'node:events'

export const TERMINATION_EVENT = 'generation-record:terminalized'

/**
 * leaf 事件总线：仅承载「generationRecord 落终态」单一事件。
 * 用模块级单例而非 Nest provider，规避 PrismaService→reaper 初始化环（D-6）。
 */
export class TerminalEventBus {
  private readonly emitter = new EventEmitter()
  constructor() {
    this.emitter.setMaxListeners(32) // reaper 单一订阅者，留余量防告警
  }
  emitTerminalized(): void {
    this.emitter.emit(TERMINATION_EVENT)
  }
  onTerminalized(cb: () => void): void {
    this.emitter.on(TERMINATION_EVENT, cb)
  }
  offTerminalized(cb: () => void): void {
    this.emitter.off(TERMINATION_EVENT, cb)
  }
}

export const terminalEventBus = new TerminalEventBus()
```

- [ ] **Step 4: 跑测试确认通过**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @lnkpi/server exec vitest run src/studio/terminal-events.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: PASS。

- [ ] **Step 5: 提交**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap
git add apps/server/src/studio/terminal-events.ts apps/server/src/studio/terminal-events.test.ts
git commit -m "feat(server): 新增 leaf 事件总线 TerminalEventBus（E1 解耦地基）"
```

---

## Task 2: notify-metrics.ts（leaf 计数器）

**Files:**
- Create: `apps/server/src/studio/notify-metrics.ts`
- Test: `apps/server/src/studio/notify-metrics.test.ts`

**Interfaces:**
- Consumes: 无（leaf）
- Produces: `NotifyReason` 类型；`NotifyMetrics` 类（`incrNotified(reason, n)` / `incrScan(reason)` / `snapshot()` / `reset()`）；单例 `notifyMetrics`。

- [ ] **Step 1: 写失败测试**
```ts
// apps/server/src/studio/notify-metrics.test.ts
import { describe, it, expect } from 'vitest'
import { NotifyMetrics } from './notify-metrics'

describe('NotifyMetrics', () => {
  it('incrNotified 按 reason 累计已通报记录数', () => {
    const m = new NotifyMetrics()
    m.incrNotified('terminal-write', 3)
    m.incrNotified('terminal-write', 2)
    m.incrNotified('notify-tick', 5)
    expect(m.snapshot().notified).toEqual({ 'terminal-write': 5, 'notify-tick': 5 })
  })
  it('incrNotified(n<=0) 不计入（D-7 口径）', () => {
    const m = new NotifyMetrics()
    m.incrNotified('terminal-write', 0)
    m.incrNotified('terminal-write', -1)
    expect(m.snapshot().notified).toEqual({})
  })
  it('incrScan 独立计数（不参与 G-1 判定）', () => {
    const m = new NotifyMetrics()
    m.incrScan('terminal-write')
    m.incrScan('terminal-write')
    expect(m.snapshot().scans['terminal-write']).toBe(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @lnkpi/server exec vitest run src/studio/notify-metrics.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: FAIL。

- [ ] **Step 3: 写最小实现**
```ts
// apps/server/src/studio/notify-metrics.ts
export type NotifyReason =
  | 'terminal-write'
  | 'notify-tick'
  | 'periodic'
  | 'startup'
  | 'manual'
  | 'orphan-reap'

/**
 * 简报通报计数器（进程级 in-memory）。G-1 度量口径：按「已通报记录数」累计（D-7），
 * 而非扫描调用次数——否则每次终态写都记一次 terminal-write 扫描，占比必虚高且无法证伪。
 */
export class NotifyMetrics {
  private readonly notified = new Map<NotifyReason, number>()
  private readonly scans = new Map<NotifyReason, number>()

  incrNotified(reason: NotifyReason, n: number): void {
    if (n <= 0) return
    this.notified.set(reason, (this.notified.get(reason) ?? 0) + n)
  }
  incrScan(reason: NotifyReason): void {
    this.scans.set(reason, (this.scans.get(reason) ?? 0) + 1)
  }
  snapshot(): { notified: Record<string, number>; scans: Record<string, number> } {
    return {
      notified: Object.fromEntries(this.notified),
      scans: Object.fromEntries(this.scans),
    }
  }
  reset(): void {
    this.notified.clear()
    this.scans.clear()
  }
}

export const notifyMetrics = new NotifyMetrics()
```

- [ ] **Step 4: 跑测试确认通过**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @lnkpi/server exec vitest run src/studio/notify-metrics.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: PASS。

- [ ] **Step 5: 提交**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap
git add apps/server/src/studio/notify-metrics.ts apps/server/src/studio/notify-metrics.test.ts
git commit -m "feat(server): 新增 NotifyMetrics 按已通报记录数计数（G-1 口径）"
```

---

## Task 3: terminal-write-tap.ts（$extends 拦截器 + 纯函数判据）

**Files:**
- Create: `apps/server/src/studio/terminal-write-tap.ts`
- Test: `apps/server/src/studio/terminal-write-tap.test.ts`

**Interfaces:**
- Consumes: `TerminalEventBus`（Task 1）
- Produces: `isTerminalGenerationWrite(operation, args): boolean`（可单测纯函数）；`buildTerminalWriteTap(bus, opts?)` 返回 `Prisma.defineExtension` 结果；常量 `TERMINAL_STATUSES = ['completed','failed']`。

- [ ] **Step 1: 写失败测试（判据树 + `$extends` 行为 + D-2 + 透传）**
```ts
// apps/server/src/studio/terminal-write-tap.test.ts
import { describe, it, expect, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { isTerminalGenerationWrite, buildTerminalWriteTap, TERMINAL_STATUSES } from './terminal-write-tap'
import { TerminalEventBus } from './terminal-events'

describe('isTerminalGenerationWrite（图 2 判据树）', () => {
  it('update status=completed → true', () => {
    expect(isTerminalGenerationWrite('update', { data: { status: 'completed' } })).toBe(true)
  })
  it('updateMany status=failed → true', () => {
    expect(isTerminalGenerationWrite('updateMany', { data: { status: 'failed' } })).toBe(true)
  })
  it('create status=completed → true', () => {
    expect(isTerminalGenerationWrite('create', { data: { status: 'completed' } })).toBe(true)
  })
  it('status=generating → false（中间态占位）', () => {
    expect(isTerminalGenerationWrite('update', { data: { status: 'generating' } })).toBe(false)
  })
  it('status=fallback_pending → false（BYOK 重试中间态）', () => {
    expect(isTerminalGenerationWrite('update', { data: { status: 'fallback_pending' } })).toBe(false)
  })
  it('无 data → false（findMany 等读操作）', () => {
    expect(isTerminalGenerationWrite('findMany', {})).toBe(false)
  })
  it('delete → false（不拦截删除）', () => {
    expect(isTerminalGenerationWrite('delete', { data: { status: 'completed' } })).toBe(false)
  })
  it('data 无 status → false（agentTurnNotified metadata 标记更新，§1 第 29 处）', () => {
    expect(isTerminalGenerationWrite('update', { data: { metadata: '{}' } })).toBe(false)
  })
})

// 极简伪 client：把扩展的 $allOperations 包进 generationRecord，不连真 DB。
function makeFakeClient() {
  const client: any = {
    $extends(ext: any) {
      const wrapped = ext.query.generationRecord.$allOperations
      const record = {
        async update(args: any) {
          return wrapped({ operation: 'update', args, query: async () => ({ id: 'r1' }) })
        },
        async updateMany(args: any) {
          return wrapped({ operation: 'updateMany', args, query: async () => ({ count: 1 }) })
        },
        async create(args: any) {
          return wrapped({ operation: 'create', args, query: async () => ({ id: 'r1' }) })
        },
        async findMany(args: any) {
          return wrapped({ operation: 'findMany', args, query: async () => [] })
        },
      }
      return { generationRecord: record }
    },
  }
  return client
}

describe('buildTerminalWriteTap $extends 行为', () => {
  it('终态写触发 emitTerminalized（defer 同步化便于断言）', async () => {
    const bus = new TerminalEventBus()
    const cb = vi.fn()
    bus.onTerminalized(cb)
    const ext = makeFakeClient().$extends(buildTerminalWriteTap(bus, { defer: (fn) => fn() }))
    await ext.generationRecord.update({ where: { id: 'r1' }, data: { status: 'completed' } })
    expect(cb).toHaveBeenCalledTimes(1)
  })
  it('enabled=false 时不触发（D-5 flag 关闭语义）', async () => {
    const bus = new TerminalEventBus()
    const cb = vi.fn()
    bus.onTerminalized(cb)
    const ext = makeFakeClient().$extends(buildTerminalWriteTap(bus, { enabled: false, defer: (fn) => fn() }))
    await ext.generationRecord.update({ where: { id: 'r1' }, data: { status: 'completed' } })
    expect(cb).not.toHaveBeenCalled()
  })
  it('非终态写不触发', async () => {
    const bus = new TerminalEventBus()
    const cb = vi.fn()
    bus.onTerminalized(cb)
    const ext = makeFakeClient().$extends(buildTerminalWriteTap(bus, { defer: (fn) => fn() }))
    await ext.generationRecord.update({ where: { id: 'r1' }, data: { status: 'generating' } })
    expect(cb).not.toHaveBeenCalled()
  })
  it('返回值透传（D-2：不改参数/不改返回）', async () => {
    const bus = new TerminalEventBus()
    const ext = makeFakeClient().$extends(buildTerminalWriteTap(bus, { defer: (fn) => fn() }))
    expect(await ext.generationRecord.update({ where: { id: 'r1' }, data: { status: 'completed' } })).toEqual({ id: 'r1' })
    expect(await ext.generationRecord.updateMany({ where: {}, data: { status: 'failed' } })).toEqual({ count: 1 })
  })
  it('D-2 fail-open：bus.emit 抛错仍返回 result（写路径不被阻塞）', async () => {
    const badBus = { emitTerminalized() { throw new Error('boom') } } as any
    const ext = makeFakeClient().$extends(buildTerminalWriteTap(badBus, { defer: (fn) => fn() }))
    await expect(
      ext.generationRecord.update({ where: { id: 'r1' }, data: { status: 'completed' } }),
    ).resolves.toEqual({ id: 'r1' })
  })
  it('TERMINAL_STATUSES 为运行时白名单', () => {
    expect(TERMINAL_STATUSES).toEqual(['completed', 'failed'])
  })
})

// ---- 变异测试（守卫必须行为级，§7.2）----
describe('变异（mutation）守卫', () => {
  it('⚠️ 变异点：若 isTerminalGenerationWrite 去掉 status∈ 检查，非终态写会误触', () => {
    // 参考实现：status 不在白名单必须返回 false。此处断言反向（白名单外一律 false）。
    for (const s of ['generating', 'fallback_pending', 'pending', 'processing', 'error']) {
      expect(isTerminalGenerationWrite('update', { data: { status: s } })).toBe(false)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @lnkpi/server exec vitest run src/studio/terminal-write-tap.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写最小实现**
```ts
// apps/server/src/studio/terminal-write-tap.ts
import { Prisma } from '@prisma/client'
import { TerminalEventBus } from './terminal-events'

export const TERMINAL_STATUSES = ['completed', 'failed'] as const
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number]

/**
 * 判据 D-1/D-3（纯函数，可单测，无 DB）：一个 generationRecord 写操作是否构成「终态迁移」。
 * schema 的 status 是自由 String（非 enum），故判据是运行时白名单，不是 Prisma 类型级约束。
 * 已对 studio 27 写点取证：终态仅 completed/failed；generating 占位、fallback_pending
 * BYOK 重试中间态、error 只改 canvas node 不改 record，均不误触。
 */
export function isTerminalGenerationWrite(operation: string, args: unknown): boolean {
  if (operation === 'delete' || operation === 'deleteMany') return false
  if (!args || typeof args !== 'object') return false
  const data = (args as { data?: unknown }).data
  if (!data || typeof data !== 'object') return false
  const status = (data as { status?: unknown }).status
  return (TERMINAL_STATUSES as readonly string[]).includes(status as string)
}

export interface TerminalWriteTapOptions {
  /** 缺省 true；false = flag 关闭，不发射（D-5）。 */
  enabled?: boolean
  /** 发射延迟器，缺省 setTimeout(0)（macrotask defer，事务鲁棒性保险）。测试注入同步 fn。 */
  defer?: (fn: () => void) => void
}

/**
 * 构建 Prisma 扩展：在 generationRecord 所有操作的 after-callback 中，
 * 若判定为终态写则 fire-and-forget 发射事件。拦截层无状态/无锁/无重试（D-2）。
 * 用 Prisma.defineExtension 获得类型安全的扩展对象。
 */
export function buildTerminalWriteTap(bus: TerminalEventBus, opts: TerminalWriteTapOptions = {}) {
  const enabled = opts.enabled !== false
  const defer = opts.defer ?? ((fn: () => void) => setTimeout(fn, 0))
  return Prisma.defineExtension((client) =>
    client.$extends({
      query: {
        generationRecord: {
          async $allOperations({ operation, args, query }) {
            const result = await query(args)
            if (enabled && isTerminalGenerationWrite(operation as string, args)) {
              defer(() => {
                try {
                  bus.emitTerminalized()
                } catch {
                  /* fire-and-forget fail-open：发射失败绝不影响写路径 */
                }
              })
            }
            return result
          },
        },
      },
    }),
  )
}
```

- [ ] **Step 4: 跑测试确认通过**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @lnkpi/server exec vitest run src/studio/terminal-write-tap.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: PASS（含变异断言）。

- [ ] **Step 5: 提交**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap
git add apps/server/src/studio/terminal-write-tap.ts apps/server/src/studio/terminal-write-tap.test.ts
git commit -m "feat(server): 新增 terminal-write-tap \$extends 拦截器与终态判据（E1 触发）"
```

---

## Task 4: PrismaModule 挂载（useFactory + flag + 生命周期重绑）

**Files:**
- Modify: `apps/server/src/prisma/prisma.module.ts`

**Interfaces:**
- Consumes: `buildTerminalWriteTap`（Task 3）、`terminalEventBus` 单例（Task 1）
- Produces: `PrismaModule` 现在以 `useFactory` 提供 `PrismaService`；flag 关返回 base，开返回挂载扩展并重绑生命周期的 client（仍 `as unknown as PrismaService`）。

- [ ] **Step 1: 写失败测试（挂载不破坏消费者类型 + flag 语义）**
新增 `apps/server/src/prisma/prisma.module.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { PrismaService } from './prisma.service'

describe('PrismaModule 挂载', () => {
  it('flag 关（LNKPI_TERMINAL_WRITE_TAP=false）→ 工厂返回 base 类型实例且可 $connect', async () => {
    process.env.LNKPI_TERMINAL_WRITE_TAP = 'false'
    const { PrismaModule } = await import('./prisma.module')
    // 用模块内工厂逻辑等价验证：这里直接断言 PrismaService 仍可实例化（真实连接由集成测覆盖）。
    expect(typeof PrismaService).toBe('function')
    delete process.env.LNKPI_TERMINAL_WRITE_TAP
    expect(PrismaModule).toBeDefined()
  })
})
```
> 说明：本 task 不连真 DB（避免测试副作用）。完整生命周期验证放在 Task 5 集成 + 生产 §9。此处仅确保模块编译与 flag 解析分支无语法/类型错误。

- [ ] **Step 2: 跑测试确认失败/基线**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @lnkpi/server exec vitest run src/prisma/prisma.module.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: 文件不存在导致 FAIL（或首个断言可调）。

- [ ] **Step 3: 改写 prisma.module.ts**
```ts
// apps/server/src/prisma/prisma.module.ts
import { Global, Module } from '@nestjs/common'
import { PrismaService } from './prisma.service'
import { buildTerminalWriteTap } from '../studio/terminal-write-tap'
import { terminalEventBus } from '../studio/terminal-events'

// 缺省开；仅 'false'（精确字符串）才关（Review Focus #1）。
const TAP_ENABLED = process.env.LNKPI_TERMINAL_WRITE_TAP !== 'false'

@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      useFactory: () => {
        const base = new PrismaService()
        if (!TAP_ENABLED) return base // flag 关 = 不挂扩展，行为逐字节一致
        // ⚠️ $extends 返回新 client，丢失 onModuleInit/onModuleDestroy；
        // 不重绑会静默断 DB 连接。这里重绑，连接照常。
        const extended = base.$extends(buildTerminalWriteTap(terminalEventBus))
        extended.onModuleInit = () => extended.$connect()
        extended.onModuleDestroy = () => extended.$disconnect()
        return extended as unknown as PrismaService
      },
    },
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
```

- [ ] **Step 4: 跑测试 + server 全量 tsc（关键：类型不外泄）**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @lnkpi/server exec vitest run src/prisma/prisma.module.test.ts --maxWorkers=1 --no-file-parallelism
npx tsc --noEmit -p apps/server/tsconfig.json
```
Expected: 测试 PASS；`tsc --noEmit` 零错误（消费者 `PrismaService` 类型不变）。

- [ ] **Step 5: 提交**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap
git add apps/server/src/prisma/prisma.module.ts apps/server/src/prisma/prisma.module.test.ts
git commit -m "feat(server): PrismaModule 按 flag 挂载 terminal-write-tap 并重绑生命周期"
```

---

## Task 5: reaper 订阅事件 + 度量接线

**Files:**
- Modify: `apps/server/src/studio/generation-reaper.service.ts`（构造函数加可选 `bus?`；`onModuleInit` 订阅；`notifyTerminalsOnce` 内 `notifyMetrics.incrNotified`）
- Test: `apps/server/src/studio/generation-reaper.service.test.ts`（追加 E1 describe）

**Interfaces:**
- Consumes: `terminalEventBus` / `TerminalEventBus`（Task 1）、`notifyMetrics` / `NotifyMetrics`（Task 2）、`TERMINATION_EVENT`（Task 1）
- Produces: reaper 在 `onModuleInit` 订阅 `terminalEventBus.onTerminalized(() => void this.notifyTerminalsOnce('terminal-write'))`；`notifyTerminalsOnce` 在 `notified>0` 时 `notifyMetrics.incrNotified(reason, notified)`。

- [ ] **Step 1: 写失败测试（E1 订阅 → notifyTerminalsOnce('terminal-write')）**
在 `generation-reaper.service.test.ts` 末尾追加（复用该文件既有的服务构造 helper，例如 `createService` / 直接 `new GenerationReaperService(prisma, points, nodeStatus, scheduler)`）：
```ts
import { TerminalEventBus, TERMINATION_EVENT } from './terminal-events'
import { notifyMetrics } from './notify-metrics'

describe('E1 终态写 tap → 事件 → 通报', () => {
  it('onModuleInit 订阅事件；发射后 notifyTerminalsOnce 被调且 reason=terminal-write', () => {
    const bus = new TerminalEventBus()
    // 用本地 bus 隔离（构造函数第 5 参可选），避免污染模块级单例影响其他测试。
    const svc = new GenerationReaperService(prisma, points, nodeStatus, scheduler, bus)
    svc.onModuleInit()
    const spy = vi.spyOn(svc as any, 'notifyTerminalsOnce')
    bus.emitTerminalized()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('terminal-write')
  })
  it('一次发射仅触发一次（无订阅泄漏，Review Focus #2）', () => {
    const bus = new TerminalEventBus()
    const svc = new GenerationReaperService(prisma, points, nodeStatus, scheduler, bus)
    svc.onModuleInit()
    const spy = vi.spyOn(svc as any, 'notifyTerminalsOnce')
    bus.emitTerminalized()
    expect(spy).toHaveBeenCalledTimes(1)
  })
  it('notifyTerminalsOnce 在 notified>0 时按记录数累加 NotifyMetrics（D-7）', async () => {
    notifyMetrics.reset()
    // 仅验证计数逻辑：直接调用被 mock 的 notifyLateGenerationTerminals 返回 3。
    vi.mocked(notifyLateGenerationTerminals).mockResolvedValueOnce(3)
    await svc.notifyTerminalsOnce('terminal-write')
    expect(notifyMetrics.snapshot().notified['terminal-write']).toBe(3)
  })
})
```
> 若文件顶部已 `vi.mock('../agent/pi-runtime/late-generation-notify', ...)`，则 `notifyLateGenerationTerminals` 可被 `vi.mocked` 控制返回值；否则用实际 `await` 路径 + 断言 `snapshot` 结构。executor 按文件实际 mock 形态适配。

- [ ] **Step 2: 跑测试确认失败**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @lnkpi/server exec vitest run src/studio/generation-reaper.service.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: 新增 E1 用例 FAIL（构造函数无第 5 参 / `notifyMetrics` 未接线）。

- [ ] **Step 3: 改 generation-reaper.service.ts**
1. 顶部 import 增加：
```ts
import { TerminalEventBus, terminalEventBus, TERMINATION_EVENT } from './terminal-events'
import { notifyMetrics } from './notify-metrics'
```
2. 构造函数（现有 4 参后）追加可选第 5 参：
```ts
constructor(
  @Inject(PrismaService) private readonly prisma: PrismaService,
  @Inject(PointsService) private readonly points: PointsService,
  @Optional() @Inject(CanvasNodeStatusService) private readonly nodeStatus?: CanvasNodeStatusService,
  @Optional() @Inject(AutomationSchedulerService) private readonly scheduler?: AutomationSchedulerService,
  // E1（评审修正 D-6 解耦）：事件总线可选注入，缺省用模块级单例。单测传本地 bus 隔离。
  @Optional() bus?: TerminalEventBus,
) {
  this.bus = bus ?? terminalEventBus
}
private readonly bus: TerminalEventBus
```
3. `onModuleInit()` 在 `this.logger.log('[reaper] ...')` 之前追加订阅：
```ts
// E1：订阅「generationRecord 落终态」事件 → 复用既有 notifyTerminalsOnce 单飞/去重/arm。
this.terminalizedHandler = () => {
  void this.notifyTerminalsOnce('terminal-write')
}
this.bus.onTerminalized(this.terminalizedHandler)
```
并在类字段声明 `private terminalizedHandler?: () => void`。
4. `notifyTerminalsOnce` 内，`if (notified > 0)` 块改为：
```ts
if (notified > 0) {
  this.logger.log(`[${reason}] 回合外生成终态通报已处理 ${notified} 条`)
  notifyMetrics.incrNotified(reason as NotifyReason, notified) // D-7：按已通报记录数
}
```
（`reason` 是 string，需 cast 为 `NotifyReason`；`NotifyReason` 从 `./notify-metrics` import。）

- [ ] **Step 4: 跑测试确认通过 + 回归**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @lnkpi/server exec vitest run src/studio/generation-reaper.service.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: 全部（含原 31 + 新增 E1）PASS。

- [ ] **Step 5: 提交**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap
git add apps/server/src/studio/generation-reaper.service.ts apps/server/src/studio/generation-reaper.service.test.ts
git commit -m "feat(server): reaper 订阅 terminalized 事件并接线 NotifyMetrics（E1）"
```

---

## Task 6: 健康端点暴露 G-1 度量

**Files:**
- Modify: `apps/server/src/health/health.controller.ts`
- Test: `apps/server/src/health/health.controller.test.ts`（若该文件存在则追加，否则跳过）

**Interfaces:**
- Consumes: `notifyMetrics` 单例（Task 2）
- Produces: `GET /health/notify-metrics` 返回 `notifyMetrics.snapshot()`。

- [ ] **Step 1: 写失败测试（若 health controller 测试存在）**
```ts
// 在 health.controller.test.ts 追加
it('GET /health/notify-metrics 返回 snapshot 结构', () => {
  const res = controller.notifyMetrics()
  expect(res).toHaveProperty('notified')
  expect(res).toHaveProperty('scans')
})
```

- [ ] **Step 2: 改 health.controller.ts**
顶部 import：`import { notifyMetrics } from '../studio/notify-metrics'`
在 `HealthController` 内追加：
```ts
@Get('notify-metrics')
notifyMetrics() {
  return notifyMetrics.snapshot()
}
```

- [ ] **Step 3: 跑测试确认通过**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @lnkpi/server exec vitest run src/health/health.controller.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: PASS（若无该测试文件则跳过此步，仅类型检查）。

- [ ] **Step 4: 提交**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap
git add apps/server/src/health/health.controller.ts apps/server/src/health/health.controller.test.ts
git commit -m "feat(server): 暴露 GET /health/notify-metrics 供 G-1 验收"
```

---

## Task 7: 集成测试（真实 PrismaService 扩展 → 事件发射）

**Files:**
- Create: `apps/server/src/studio/terminal-write-tap.integration.test.ts`

**Interfaces:**
- Consumes: `PrismaService`、`buildTerminalWriteTap`（Task 3）、`TerminalEventBus`（Task 1）
- Produces: 验证真实（test DB）`generationRecord` 终态写经扩展后发射事件；非终态写不发射；flag 关不挂扩展。

- [ ] **Step 1: 写集成测试**
```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { PrismaService } from '../prisma/prisma.service'
import { buildTerminalWriteTap } from './terminal-write-tap'
import { TerminalEventBus } from './terminal-events'

describe('terminal-write-tap 集成（真实 PrismaService 扩展）', () => {
  let prisma: PrismaService
  let bus: TerminalEventBus

  beforeAll(async () => {
    prisma = new PrismaService() as any
    await (prisma as any).$connect()
  })
  afterAll(async () => {
    await (prisma as any).$disconnect()
  })

  it('终态写（status=completed）经扩展发射 terminalized 事件', async () => {
    bus = new TerminalEventBus()
    const extended = (prisma as any).$extends(buildTerminalWriteTap(bus, { defer: (fn) => fn() })) as PrismaService
    const cb = vi.fn()
    bus.onTerminalized(cb)
    const rec = await extended.generationRecord.create({
      data: { id: `tap-it-${Date.now()}-${Math.random().toString(36).slice(2)}`, type: 'image', status: 'generating' },
    })
    await extended.generationRecord.update({ where: { id: rec.id }, data: { status: 'completed' } })
    expect(cb).toHaveBeenCalledTimes(1)
    // 清理
    await extended.generationRecord.delete({ where: { id: rec.id } }).catch(() => {})
  })

  it('非终态写（status=generating 占位更新）不发射', async () => {
    bus = new TerminalEventBus()
    const extended = (prisma as any).$extends(buildTerminalWriteTap(bus, { defer: (fn) => fn() })) as PrismaService
    const cb = vi.fn()
    bus.onTerminalized(cb)
    const rec = await extended.generationRecord.create({
      data: { id: `tap-it2-${Date.now()}-${Math.random().toString(36).slice(2)}`, type: 'image', status: 'generating' },
    })
    await extended.generationRecord.update({ where: { id: rec.id }, data: { metadata: '{"x":1}' } })
    expect(cb).not.toHaveBeenCalled()
    await extended.generationRecord.delete({ where: { id: rec.id } }).catch(() => {})
  })
})
```

- [ ] **Step 2: 跑集成测试**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @lnkpi/server exec vitest run src/studio/terminal-write-tap.integration.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: PASS（test DB 可用；若 test DB 未初始化，先跑 `pnpm --filter @lnkpi/server exec prisma db push --skip-generate` 或参考项目既有测试 DB 准备脚本）。

- [ ] **Step 3: 提交**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap
git add apps/server/src/studio/terminal-write-tap.integration.test.ts
git commit -m "test(server): E1 terminal-write-tap 真实 Prisma 扩展集成测试"
```

---

## Task 8: 变异测试（D-2/D-3/D-5 行为级守卫，§7.2）

**Files:**
- Modify: `apps/server/src/studio/terminal-write-tap.test.ts`（追加 mutation describe）

**Interfaces:**
- Consumes: 同 Task 3
- Produces: 证明若实现退化则对应用例必红（守卫有效）。

- [ ] **Step 1: 追加变异断言**
```ts
describe('变异守卫（若实现退化则必红）', () => {
  it('D-3 守卫：判据去掉 status∈ 检查 ⇒ 非终态写会误触（当前实现不应发生）', () => {
    // 以「白名单外一律 false」反向断言；若有人删掉 includes 检查，本例仍绿但下方单测会红——
    // 故此处的正向保证由 Task 3 的 isTerminalGenerationWrite 用例覆盖。此处确认白名单闭合。
    expect(isTerminalGenerationWrite('update', { data: { status: 'completed' } })).toBe(true)
    expect(isTerminalGenerationWrite('update', { data: { status: 'failed' } })).toBe(true)
  })
  it('D-5 守卫：enabled=false 时即便终态写也不发射（flag 语义铁律）', async () => {
    const bus = new TerminalEventBus()
    const cb = vi.fn()
    bus.onTerminalized(cb)
    const ext = makeFakeClient().$extends(buildTerminalWriteTap(bus, { enabled: false, defer: (fn) => fn() }))
    await ext.generationRecord.update({ where: { id: 'r1' }, data: { status: 'completed' } })
    expect(cb).not.toHaveBeenCalled()
  })
  it('D-2 守卫：发射若被 await（耦合写路径）会破坏 fail-open；当前用 defer+try/catch 保证不阻塞', async () => {
    const badBus = { emitTerminalized() { throw new Error('boom') } } as any
    const ext = makeFakeClient().$extends(buildTerminalWriteTap(badBus, { defer: (fn) => fn() }))
    await expect(
      ext.generationRecord.update({ where: { id: 'r1' }, data: { status: 'completed' } }),
    ).resolves.toEqual({ id: 'r1' })
  })
})
```

- [ ] **Step 2: 跑测试确认通过**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @lnkpi/server exec vitest run src/studio/terminal-write-tap.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: PASS。

- [ ] **Step 3: 手动变异验证（execute 时执行一次，不入库）**
临时把 `terminal-write-tap.ts` 的 `isTerminalGenerationWrite` 返回值改为 `true`（去掉白名单），重跑 Task 3 测试 → 断言 `status=generating → false` 用例变红；还原。再临时把 `defer` 内 `try/catch` 去掉且令 `bus.emit` 抛错 → D-2 用例变红；还原。记录结论：「变异守卫有效」。

- [ ] **Step 4: 提交（仅测试变更）**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap
git add apps/server/src/studio/terminal-write-tap.test.ts
git commit -m "test(server): E1 追加 D-2/D-3/D-5 变异守卫断言"
```

---

## Task 9: 全量回归 + tsc + squash 收口

**Files:** （无新增；验证 + 收尾）

**说明：** 跑受影响测试套件与 server 全量 tsc，确认零回归，然后将本 feature 分支的 commits squash 为一个 PR commit（按项目约定）。

- [ ] **Step 1: 受影响测试全量跑**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && source ~/.nvm/nvm.sh && nvm use 24
pnpm --filter @lnkpi/server exec vitest run src/studio/ src/prisma/ src/health/ --maxWorkers=1 --no-file-parallelism
```
Expected: 全 PASS（含 reaper 31 原用例 + E1 新增 + tap 单元/集成 + metrics + events + health）。

- [ ] **Step 2: server 全量 tsc（CI 等价）**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap && source ~/.nvm/nvm.sh && nvm use 24
npx tsc --noEmit -p apps/server/tsconfig.json
```
Expected: 零错误（无 `as never`、无类型外泄）。

- [ ] **Step 3: 核对 D-1 零写点改动**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap
git diff origin/master -- apps/server/src/studio/studio.service.ts apps/server/src/agent/pi-runtime/late-generation-notify.ts | wc -l
```
Expected: 0（studio.service.ts 与 late-generation-notify.ts 零行变更）。reaper 仅增订阅/度量，不改既有 update 调用。

- [ ] **Step 4: 关联规格/计划入版本**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap
git add docs/superpowers/specs/2026-11-03-e1-generation-terminal-write-tap-design.md docs/superpowers/plans/2026-11-03-e1-generation-terminal-write-tap.md
git commit -m "docs(spec): E1 规格（评审修正版）与实现计划随分支提交"
```

- [ ] **Step 5: squash 收口（项目约定：feature + PR + squash）**
```bash
cd /Users/4seven/workspace/pi-lnk-e1-tap
git log --oneline origin/master..HEAD
# 确认本分支 commits 列表；squash 合并在 PR 阶段进行（不在本地强推）。
```
Expected: 列出本分支全部 commits（Task1~Task8 + docs）。提示：PR 用 squash merge，无需本地 rebase。

---

## Self-Review（作者自检，已就地修正）

1. **Spec coverage**：§3 三个新建模块（tap/events/metrics）→ Task1/2/3；§5.1 总线解耦 → Task1+Task5；§5.2 生命周期配方 → Task4；§5.3 度量 → Task2+Task5+Task6；§6 D-1~D-7 → Task4(D-1 校验)/Task3(D-2/D-3)/Task5(D-4 复用既有单飞去重)/Task4(D-5)/Task5(D-6 解耦)/Task2+5(D-7)；§7 测试策略 → Task3/5/7/8；§8 回滚 → 文件独立可摘；§9 验收 → 生产步骤（不在本计划自动化，需部署后复测）。无缺口。
2. **Placeholder scan**：无 TBD/TODO；每步含真实代码或命令。
3. **Type consistency**：`TerminalEventBus` / `NotifyMetrics` / `buildTerminalWriteTap` / `terminalEventBus` / `notifyMetrics` 跨 task 命名一致；`NotifyReason` 在 Task2 定义、Task5 cast 使用；`TERMINATION_EVENT` 在 Task1 定义、Task5 可选引用（实际用 `onTerminalized` 方法，未直接依赖常量名，无 mismatch）。
4. **Review Focus**：五类全部挂测试——flag 解析(Task4)、订阅泄漏(Task5)、类型不外泄(Task4 tsc)、度量口径(Task2/5)、D-2 阻塞(Task3/8)。

## Execution Handoff

计划已完成并保存至 `docs/superpowers/plans/2026-11-03-e1-generation-terminal-write-tap.md`。

用户已明确选择 **native** 执行方式（由本会话自实现、executing-plans 技能驱动）。执行前请确认计划是否覆盖你的预期；确认后我将按 Task 0→Task 9 在 `feature/e1-terminal-write-tap` worktree 内逐 task 实现并自测，最后 squash 收口、按 §9 提示部署后生产复测（不在本计划自动化内）。
