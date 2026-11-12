# 子代理一等任务单据（D2） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把子代理「完成」的权威状态从 pi-runtime 进程内的内存 promise 迁移到跨 pod 存活的 Nest SQLite 一等单据，使 pod 被替换后仍能回答「派出去的那个去哪了」，并为 D3 回注 / D4 恢复 / D5 发布互斥提供幂等锚。

**Architecture:** 新增 additive `SubagentTask` 表与同族 `SubagentTaskService`（CAS 单点翻转、终态不复活、fail-open、挂既有 1min scheduler）；`pushTraceEvent` 是 `AgentEvent` 账本唯一写者，在该漏斗**同一同步段**按 `tool_call` / `tool_result` / `turn_interrupted` 三类帧驱动单据；只读查询面并入既有 `/threads/:id/state`。零 pi-runtime 改动、零新增跨服务链路。

**Tech Stack:** NestJS + Prisma/SQLite（`apps/server`）、TypeScript、vitest；`@earendil-works/pi-agent-core@0.99.2`（本刀不改、不 import）。

**Spec:** `docs/superpowers/specs/2026-11-12-subagent-task-ledger-design.md`（执行前必读；本计划从该规格推导，二者同行）

## Global Constraints

- **代码基线 = 真 master `ba0592834096fc5107d33328d0ae4b3d0db031bc`**（#847 合并树）。本地主仓 `/Users/4seven/workspace/pi-lnk` 是 `5926ac72` 文档分支（0.85.1、工作树长期脏），**禁止基于它读源码或改刀**。实施目录 = 干净快照 `/tmp/pi-lnk-master-ba059283`（`gh api repos/sev7n4/pi-lnk/tarball/ba0592834096fc5107d33328d0ae4b3d0db031bc` 解包）。所有代码路径相对该目录。
- **本机 ↔ GitHub 仅 `gh api` 可达**（git push 502 / SSH denied / fetch 不可达）。快照无 `.git`，因此**每个任务末尾的 "Commit" 步骤 = 把本任务改动路径登记进 Task 6 的 REST 单 commit 清单**；Task 6 统一按 `blob → tree(base_tree 只传改动路径) → commit → ref → PR` 推送，推前逐路径裸 blob sha 比对 master，推后 `compare` 核验。
- **本次不合并、不部署、不改生产数据**。D2 触发发布（仅 `apps/server` + additive migration）；按用户纪律 CI 全绿后停在合并前等单独授权。**本轮交付 = 规格 + 本计划两份 docs，连产品代码都不写。**
- **规格与计划文档落在主仓** `docs/superpowers/specs/` 与 `docs/superpowers/plans/`（用户偏好路径）；实施时同步复制一份到快照 `docs/` 内以便随 PR 同行。
- vitest 用 nvm node24：`$HOME/.nvm/versions/node/v24.13.0/bin` 加入 PATH，命令带 `--maxWorkers=1 --no-file-parallelism`；本机 pnpm 须 `env -u NODE_OPTIONS`；`vue-tsc -b` **不加** `--noEmit`（composite TS6310）；断言**禁用** `as never`。
- 快照需软链依赖：`ln -s /Users/4seven/workspace/pi-lnk/node_modules /tmp/pi-lnk-master-ba059283/node_modules`，并对 `apps/server` 同法软链；改 schema 后须 `pnpm --filter @lnkpi/server exec prisma generate`。
- **判据纪律**：按数据形态分支的修复，判据必须先贴真实生产记录求值 + 变异自检（#815 教训）；「0 命中」须排除假 0——BSD grep 不支持 BRE `\|`，一律 `grep -E` 或单模式。
- **文案纪律**：`reason` 恒为可观测事实（`no_terminal_event` / `lease_expired` / 4 态 outcome），**禁止** `pod_restarted` / `upstream_disconnected` 等无证据归因；禁止「服务更新打断了这次调研」。
- **不存全文纪律**：`outcomeJson` 只存 4 态摘要，`taskPreview` 截断 512 字符，**禁止把 report 全文写进单据**（P1c 的 530KB/行债不复刻）。
- **键不出现纪律**：单据是观测投影，不是子 run 内部真源；不臆造内部状态字段。
- **No-Go**：不改 pi-runtime、不触发 `runtime-deploy`、不新增 `/agent/internal/*` 回写端点、不改 `await attempt.promise` / C4 三件套 / 工具白名单 / `plan-gate`、不改 D1 判据 / `finalizeTurnTimeline` / `Math.max(1,…)`、不自动 `lane.resume()`、不回填历史 82 条 `truncated`、不新建第三套 seq/状态机、不 fork vendor、不靠加 prompt 条文。

## Review Focus

以下五类输入规格未显式展开、最可能咬人，各自已在所属任务的测试中钉住：

1. **非 `spawn_subagent` 的 `tool_call`/`tool_result` 洪水** —— 合理期望是漏斗**零副作用**（不查表、不写表），否则每个回合都多一次 DB 往返、把 D2 变成性能回归。→ Task 3 `it('★ 非 spawn 帧零副作用')` + Task 4 阴性用例，用 spy 断言不触达 prisma。
2. **SSE 重投 / 刷新重放导致同一 `tool_call` 到达两次** —— 合理期望是只开一张单据、字段不被第二次覆盖。→ Task 3 `it('★ 幂等：同一 tool_call 到达两次只 create 一次')`。
3. **`tool_result` 与 sweep 同刻竞态** —— 合理期望是只有一个赢家，且赢家必是「有真实结果」的一方（sweep 不得把已完成的单据翻成 interrupted）。→ Task 3 `it('★ sweep 竞态：不得覆盖终态')` 与 `it('★ CAS 单点：终态不复活')`。
4. **`turn_interrupted` 的 `outstandingToolCallIds` 里混着非 spawn 工具** —— 合理期望是只对已有 spawn 单据生效，其他 id 静默忽略、不造空单据。→ Task 3 `it('turn_interrupted 只对已存在的 spawn 单据收口')` + Task 4 关联用例。
5. **D1 挂起回合（`turn_suspended`）与 shadow 流** —— 合理期望是不产生任何 `interrupted` 单据，也不改变 D1 的计费与呈现。→ Task 4 复跑 D1 全部测试作回归锁（`turn-end` / `turn-interrupted` / `p1cShrink` / `p2Interruption` / `turn-settle-detached` / `turn-identity` / `eventLedger`）。

---

## File Structure

| 文件 | 职责 | 任务 |
|---|---|---|
| `apps/server/src/agent/subagent-task.status.ts` **（新建）** | 纯判据：从 `tool_result.details` 解析 4 态 outcome；中性 reason；spawn 帧识别 | T1 |
| `apps/server/src/agent/subagent-task.status.test.ts` **（新建）** | 贴生产记录 A/B 求值 + 6 组变异自检 | T1 |
| `apps/server/prisma/schema.prisma` | 新增 `SubagentTask` model（additive） | T2 |
| `apps/server/prisma/migrations/20261112120000_add_subagent_task/migration.sql` **（新建）** | 纯 additive `CREATE TABLE` + 索引 | T2 |
| `apps/server/src/agent/subagent-task.migration.test.ts` **（新建）** | 静态守卫：migration 不含 `ALTER`/`DROP`/回填、唯一键与索引齐备 | T2 |
| `apps/server/src/agent/subagent-task.service.ts` **（新建）** | 一等单据服务：`openTask` / `settleTask` / `sweepExpired` / `getSummaries` / `onTraceEvent`；全 fail-open | T3 |
| `apps/server/src/agent/subagent-task.service.test.ts` **（新建）** | CAS / 幂等 / sweep / fail-open / 注册 handler | T3 |
| `apps/server/src/automation/automation-scheduler.service.ts` | `AUTOMATION_DEFAULT_JOBS` 增 `job-subagent-task-sweep` 种子 | T3 |
| `apps/server/src/agent/agent.service.ts` | 构造注入 `@Optional` `SubagentTaskService`；`pushTraceEvent` 漏斗加一行 `onTraceEvent`；`getThreadResumeState` 增 `subagentTasks` | T4 / T5 |
| `apps/server/src/agent/agent.module.ts` | providers 登记 `SubagentTaskService` | T4 |
| `apps/server/src/agent/subagent-task.wiring.test.ts` **（新建）** | 漏斗接线行为级测试（非源码正则）+ 未装配零回归 | T4 |
| `apps/server/src/agent/agent.controller.ts` | `:288` 注释更新 | T5 |
| `apps/server/src/agent/agent.service.state-d2.test.ts` **（新建）** | 查询面裁剪 / 旧形状兼容 / fail-open | T5 |
| `docs/superpowers/{specs,plans}/2026-11-12-subagent-task-ledger*.md` | 规格与计划随 PR 同行 | T6 |

**分解依据**：T1 是无依赖纯函数，可独立 RED→GREEN；T2 是 additive schema，单独可被 reviewer 以「是否零破坏」拒绝；T3 消费 T1 的 `parseSubagentOutcome` 与 T2 的 prisma delegate，接口在 Interfaces 块锁定；T4 消费 T3 的 `onTraceEvent`，只改一行漏斗 + 注入；T5 消费 T3 的 `getSummaries`；T6 汇总推 PR。每个任务有自己的测试周期，可单独被 reviewer 拒绝而不拖累邻居。

---

### Task 1: 纯判据 —— `tool_result.details` 4 态解析 + 生产记录求值与变异自检

**Files:**
- Create: `apps/server/src/agent/subagent-task.status.ts`
- Create: `apps/server/src/agent/subagent-task.status.test.ts`

**Interfaces:**
- Consumes: 无（本任务零依赖，只用本地定义的结构化最小接口）
- Produces: 以下导出被 T3 使用，**签名不得改**：
  ```ts
  export type SubagentTerminalStatus =
    'completed' | 'failed' | 'timeout' | 'budget_exceeded' | 'interrupted'
  export type SubagentTaskStatus = 'spawned' | SubagentTerminalStatus
  export interface SubagentTaskOutcome {
    status: SubagentTerminalStatus
    reason: string
    /** 只用于 outcomeJson 摘要，禁止全文 */
    summary: { turns?: number; durationMs?: number; reportChars?: number }
  }
  export function parseSubagentOutcome(result: unknown): SubagentTaskOutcome | null
  export function interruptedOutcome(
    reason: 'no_terminal_event' | 'lease_expired',
  ): SubagentTaskOutcome
  export function isSpawnToolFrame(ev: { type: string; data?: unknown }): boolean
  ```

- [ ] **Step 1: 写红灯测试**（含真实生产夹具）

`apps/server/src/agent/subagent-task.status.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import {
  interruptedOutcome, isSpawnToolFrame, parseSubagentOutcome,
} from './subagent-task.status'

/**
 * 生产只读快照夹具（2026-11-11，lnkpi-api SQLite AgentMessage.metadata + AgentEvent）。
 * A = cmwbvfp4p000qrk01pch77w13（故障会话，pod 在 tool_call 后 0.4s 被替换）
 * B = …42ap2hej（同工具正常返回，78.9s 后有完整 tool_result）
 * 已脱敏：仅保留形态所需字段。
 */
const A_TOOL_CALL = {
  toolCallId: 'call_334ae8e2832146608be265e9',
  name: 'spawn_subagent', toolName: 'spawn_subagent',
  args: { task: '调研市场竞品' },
}
const A_INTERRUPTED_DATA = {
  reason: 'no_terminal_event', lastSeq: 152,
  outstandingToolCallIds: ['call_334ae8e2832146608be265e9'],
}
// spawn-subagent.ts textResult 的 details 即返回值；tool_execution_end.result.details 原样透传
const B_TOOL_RESULT = {
  toolCallId: 'call_b55c3b4616434aada4967bf4',
  name: 'spawn_subagent', toolName: 'spawn_subagent',
  result: {
    content: [{ type: 'text', text: '{"ok":true,"report":"R"}' }],
    details: {
      ok: true, report: 'R',
      usage: { turns: 3, durationMs: 78900, status: 'completed' },
    },
  },
  isError: false,
}

describe('D2：贴真实生产记录求值', () => {
  it('A（阳性）：tool_call 是 spawn 帧；中断 data 命中同一 callId', () => {
    expect(isSpawnToolFrame({ type: 'tool_call', data: A_TOOL_CALL })).toBe(true)
    expect(A_INTERRUPTED_DATA.outstandingToolCallIds).toContain(A_TOOL_CALL.toolCallId)
  })

  it('B（阴性）：正常 tool_result 解析为 completed，summary 不含 report 全文', () => {
    const o = parseSubagentOutcome(B_TOOL_RESULT.result)
    expect(o?.status).toBe('completed')
    expect(o?.reason).toBe('completed')
    expect(o?.summary.turns).toBe(3)
    expect(JSON.stringify(o)).not.toContain('"report":"R"')
  })
})

describe('D2：变异自检（每项必须能 RED）', () => {
  it('M1 把 usage.status 改 timeout ⇒ 终态变 timeout', () => {
    const r = structuredClone(B_TOOL_RESULT.result)
    ;(r.details.usage as { status: string }).status = 'timeout'
    expect(parseSubagentOutcome(r)?.status).toBe('timeout')
  })

  it('M2 failed 形态：ok:false + error:subagent_failed ⇒ failed', () => {
    const r = {
      content: [{ type: 'text', text: '{}' }],
      details: { ok: false, error: 'subagent_failed', report: '',
        usage: { turns: 1, durationMs: 10, status: 'failed' } },
    }
    expect(parseSubagentOutcome(r)?.status).toBe('failed')
  })

  it('M3 budget_exceeded 形态 ⇒ 原样透传，不塌成 failed', () => {
    const r = { details: { ok: false, error: 'subagent_budget_exceeded',
      usage: { turns: 30, durationMs: 100, status: 'budget_exceeded' } } }
    expect(parseSubagentOutcome(r)?.status).toBe('budget_exceeded')
  })

  it('M4 去掉 result.details（老 runtime 形态）⇒ null，不硬编码 completed', () => {
    expect(parseSubagentOutcome({ content: [{ type: 'text', text: 'ok' }] })).toBeNull()
  })

  it('M5 非 spawn 工具帧 ⇒ false（漏斗零副作用判据）', () => {
    expect(isSpawnToolFrame({ type: 'tool_call', data: { name: 'get_canvas_summary' } })).toBe(false)
    expect(isSpawnToolFrame({ type: 'tool_result', data: { name: 'get_canvas_summary' } })).toBe(false)
  })

  it('M6 interruptedOutcome 恒为中性 reason，不臆断 pod 重启', () => {
    const o = interruptedOutcome('no_terminal_event')
    expect(o.status).toBe('interrupted')
    expect(o.reason).toBe('no_terminal_event')
    expect(JSON.stringify(o)).not.toMatch(/pod|restart|disconnect/i)
  })
})
```

- [ ] **Step 2: 跑测试确认 RED**

```bash
cd /tmp/pi-lnk-master-ba059283
PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS \
  pnpm --filter @lnkpi/server exec vitest run src/agent/subagent-task.status.test.ts \
  --maxWorkers=1 --no-file-parallelism
```
预期：FAIL（`Cannot find module './subagent-task.status'`）。若报 `node_modules` 缺失，先按 Global Constraints 软链依赖再跑。

- [ ] **Step 3: 写最小实现**

`apps/server/src/agent/subagent-task.status.ts`：

```ts
/**
 * D2 子任务终态单一判据（spec §5.4 / §6）。
 *
 * ⚠️ 判据只陈述可观测事实：Nest 侧从 tool_execution_end.result.details 读到的
 * 4 态 outcome，或「本流没收到权威收束 / 租约过期」。禁止把 pod 重启、nginx
 * 掐断、客户端断网写成 reason —— 那些在 Nest 侧无法确证。
 * ⚠️ 不存 report 全文（P1c 530KB/行债），只留数值摘要。
 */

export type SubagentTerminalStatus =
  | 'completed' | 'failed' | 'timeout' | 'budget_exceeded' | 'interrupted'
export type SubagentTaskStatus = 'spawned' | SubagentTerminalStatus

export interface SubagentTaskOutcome {
  status: SubagentTerminalStatus
  reason: string
  summary: { turns?: number; durationMs?: number; reportChars?: number }
}

const TERMINAL = new Set<SubagentTerminalStatus>([
  'completed', 'failed', 'timeout', 'budget_exceeded',
])

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>) : null
}

/** tool_result.result.details 的形态（spawn-subagent.ts textResult 的 data）。 */
export function parseSubagentOutcome(result: unknown): SubagentTaskOutcome | null {
  const root = asRecord(result)
  if (!root) return null
  const details = asRecord(root.details)
  if (!details) return null
  const usage = asRecord(details.usage)
  const raw = usage?.status ?? (
    typeof details.error === 'string' && details.error.startsWith('subagent_')
      ? details.error.slice('subagent_'.length) : undefined
  )
  if (typeof raw !== 'string' || !TERMINAL.has(raw as SubagentTerminalStatus)) return null
  const status = raw as SubagentTerminalStatus
  const summary: SubagentTaskOutcome['summary'] = {}
  if (typeof usage?.turns === 'number') summary.turns = usage.turns
  if (typeof usage?.durationMs === 'number') summary.durationMs = usage.durationMs
  if (typeof details.report === 'string') summary.reportChars = details.report.length
  return { status, reason: status, summary }
}

export function interruptedOutcome(
  reason: 'no_terminal_event' | 'lease_expired',
): SubagentTaskOutcome {
  return { status: 'interrupted', reason, summary: {} }
}

/** 漏斗只认 spawn_subagent 的 tool_call/tool_result，其余帧零副作用。 */
export function isSpawnToolFrame(ev: { type: string; data?: unknown }): boolean {
  if (ev.type !== 'tool_call' && ev.type !== 'tool_result') return false
  const d = asRecord(ev.data)
  return d?.name === 'spawn_subagent' || d?.toolName === 'spawn_subagent'
}
```

- [ ] **Step 4: 跑测试确认 GREEN + 变异自检**

复用 Step 2 命令，预期 8/8 PASS。随后做**变异自检**：临时把 `parseSubagentOutcome` 的 `if (!details) return null` 改成 `return { status:'completed', reason:'completed', summary:{} }`，重跑确认 M4 RED；恢复后 GREEN。**记录实际输出**，勿只看测试文件存在。

- [ ] **Step 5: Commit（登记改动清单）**

```
T1 改动路径：apps/server/src/agent/subagent-task.status.ts、
             apps/server/src/agent/subagent-task.status.test.ts
```

---

### Task 2: additive schema + migration 静态守卫

**Files:**
- Modify: `apps/server/prisma/schema.prisma`（在 `PendingInterruption` model 之后追加）
- Create: `apps/server/prisma/migrations/20261112120000_add_subagent_task/migration.sql`
- Create: `apps/server/src/agent/subagent-task.migration.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `prisma.subagentTask` delegate（被 T3 消费）；`SubagentTask` 行形状见规格 §5.1。

- [ ] **Step 1: 写红灯静态守卫**

`apps/server/src/agent/subagent-task.migration.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sql = readFileSync(
  resolve(__dirname, '../../prisma/migrations/20261112120000_add_subagent_task/migration.sql'),
  'utf8',
)
const schema = readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8')

describe('D2 migration：纯 additive、零破坏', () => {
  it('只 CREATE TABLE，不 ALTER / DROP / UPDATE 存量', () => {
    expect(sql).toMatch(/CREATE TABLE "SubagentTask"/)
    expect(sql).not.toMatch(/\b(ALTER|DROP|DELETE|UPDATE|INSERT)\b/i)
  })

  it('唯一键与两个索引齐备（幂等 + sweep 可寻址）', () => {
    expect(sql).toMatch(/"SubagentTask_threadId_callId_key"/)
    expect(sql).toMatch(/"SubagentTask_requestId_key"/)
    expect(sql).toMatch(/"SubagentTask_threadId_status_idx"/)
    expect(sql).toMatch(/"SubagentTask_status_expiresAt_idx"/)
  })

  it('schema model 字段与 migration 逐字段对齐，且无 FK relation', () => {
    const start = schema.indexOf('model SubagentTask {')
    const model = schema.slice(start, schema.indexOf('\n}', start))
    for (const col of ['requestId', 'callId', 'runId', 'parentSessionKey',
      'taskPreview', 'outcomeJson', 'reason', 'expiresAt', 'endedAt']) {
      expect(model).toContain(col)
    }
    expect(model).not.toMatch(/@relation\(/)
    expect(model).toMatch(/@@unique\(\[threadId, callId\]\)/)
  })

  it('status 是 String + default spawned（SQLite 无 enum；不改存量）', () => {
    expect(sql).toMatch(/"status" TEXT NOT NULL DEFAULT 'spawned'/)
  })
})
```

- [ ] **Step 2: 跑测试确认 RED**

```bash
cd /tmp/pi-lnk-master-ba059283
PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS \
  pnpm --filter @lnkpi/server exec vitest run src/agent/subagent-task.migration.test.ts \
  --maxWorkers=1 --no-file-parallelism
```
预期：FAIL（migration 文件不存在）。

- [ ] **Step 3: 写 migration 与 schema model**

`migration.sql`（**逐字对齐 P2 样板风格，纯 additive**）：

```sql
-- D2 子代理一等任务单据：纯 additive 新表（不改任何存量表/列）。
-- 落库走 `prisma migrate deploy`（本仓库禁用 auto-merge）；回滚 = revert 本 commit。
-- 与 AgentEvent 账本 / P2 PendingInterruption 同策略：不做存量回填
-- （历史 82 条 truncated 无源 callId，读路径直通）。

CREATE TABLE "SubagentTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "runId" TEXT,
    "parentSessionKey" TEXT,
    "taskPreview" TEXT,
    "status" TEXT NOT NULL DEFAULT 'spawned',
    "outcomeJson" TEXT,
    "reason" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "SubagentTask_threadId_callId_key"
    ON "SubagentTask"("threadId", "callId");
CREATE UNIQUE INDEX "SubagentTask_requestId_key"
    ON "SubagentTask"("requestId");
CREATE INDEX "SubagentTask_threadId_status_idx"
    ON "SubagentTask"("threadId", "status");
CREATE INDEX "SubagentTask_status_expiresAt_idx"
    ON "SubagentTask"("status", "expiresAt");
```

`schema.prisma` 追加（放在 `PendingInterruption` 之后、`AgentMessage` 之前）：

```prisma
/// D2：子代理一等任务单据。完成的权威状态独立于 pi-runtime 进程存活。
/// - additive：只建表 + 索引，不改存量行；status 用 String（SQLite 无原生 enum）。
/// - 唯一键 (threadId, callId)：tool_call 帧重放 / SSE 重投幂等。
/// - 不建 FK：threadId 可能是前端 threadKey（不保证 AgentThread 行存在，同 P2）。
model SubagentTask {
  id               String    @id @default(cuid())
  threadId         String
  callId           String
  requestId        String    @unique
  runId            String?
  parentSessionKey String?
  taskPreview      String?
  status           String    @default("spawned")
  outcomeJson      String?
  reason           String?
  expiresAt        DateTime
  startedAt        DateTime  @default(now())
  endedAt          DateTime?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  @@unique([threadId, callId])
  @@index([threadId, status])
  @@index([status, expiresAt])
}
```

- [ ] **Step 4: 跑测试确认 GREEN + 生成 client**

```bash
cd /tmp/pi-lnk-master-ba059283
export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"
env -u NODE_OPTIONS pnpm --filter @lnkpi/server exec prisma generate
env -u NODE_OPTIONS pnpm --filter @lnkpi/server exec vitest run \
  src/agent/subagent-task.migration.test.ts --maxWorkers=1 --no-file-parallelism
```
预期：4/4 PASS。⚠️ `prisma generate` 会改 `node_modules/.prisma`（软链到主仓，未跟踪，不进 PR）；推前核对无已跟踪文件被改。

- [ ] **Step 5: Commit（登记改动清单）**

```
T2 改动路径：apps/server/prisma/schema.prisma、
             apps/server/prisma/migrations/20261112120000_add_subagent_task/migration.sql、
             apps/server/src/agent/subagent-task.migration.test.ts
```

---

### Task 3: `SubagentTaskService` —— CAS / 幂等 / sweep / fail-open / 查询摘要

**Files:**
- Create: `apps/server/src/agent/subagent-task.service.ts`
- Create: `apps/server/src/agent/subagent-task.service.test.ts`
- Modify: `apps/server/src/automation/automation-scheduler.service.ts`（`AUTOMATION_DEFAULT_JOBS` 追加种子）

**Interfaces:**
- Consumes: T1 的 `parseSubagentOutcome` / `interruptedOutcome` / `isSpawnToolFrame` / `SubagentTaskOutcome`；T2 的 `prisma.subagentTask` delegate
- Produces: 以下导出被 T4 / T5 使用，**签名不得改**：
  ```ts
  export const SUBAGENT_TASK_SWEEP_KEY = 'subagent-task-sweep'
  /** server 侧常量，不 import pi-runtime（两部署单元不共享代码）；300s + 60s 宽限 */
  export const SUBAGENT_TASK_TTL_MS = 360_000
  export interface SubagentTaskSummary {
    callId: string; status: string; reason: string | null
    taskPreview: string | null; startedAt: number; endedAt: number | null
  }
  export class SubagentTaskService implements OnModuleInit {
    constructor(
      prisma: PrismaService,
      scheduler?: AutomationSchedulerService,   // @Optional @Inject
    )
    onModuleInit(): void
    /** 漏斗唯一入口：非 spawn 帧立即返回，零 prisma 触达。fire-and-forget 语义。 */
    onTraceEvent(
      ev: { type: string; data?: unknown },
      ctx: { threadId: string; runId?: string | null; parentSessionKey?: string | null },
    ): void
    openTask(input: {
      threadId: string; callId: string; runId?: string | null
      parentSessionKey?: string | null; taskPreview?: string | null; startedAt?: number
    }): Promise<void>
    /** @returns 是否由本次请求完成 CAS 翻转 */
    settleTask(input: { callId: string; outcome: SubagentTaskOutcome }): Promise<boolean>
    sweepExpired(nowMs?: number): Promise<number>
    getSummaries(threadId: string, nowMs?: number): Promise<SubagentTaskSummary[]>
  }
  ```

- [ ] **Step 1: 写红灯服务测试**

`apps/server/src/agent/subagent-task.service.test.ts`（骨架照 `pending-interruption.service.test.ts:99` 的 FakeGates 姿势，用内存假 delegate）：

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  SUBAGENT_TASK_SWEEP_KEY, SUBAGENT_TASK_TTL_MS, SubagentTaskService,
} from './subagent-task.service'
import { interruptedOutcome, parseSubagentOutcome } from './subagent-task.status'

type Row = {
  id: string; threadId: string; callId: string; requestId: string
  status: string; reason: string | null; outcomeJson: string | null
  taskPreview: string | null; expiresAt: Date; startedAt: Date
  endedAt: Date | null; runId: string | null; parentSessionKey: string | null
}
function fakePrisma(rows: Row[]) {
  return {
    subagentTask: {
      create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
        rows.push({ id: `r${rows.length}`, ...data } as Row)
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const byRequest = (where as { requestId?: string }).requestId
        const byPair = (where as { threadId_callId?: { threadId: string; callId: string } })
          .threadId_callId
        return rows.find((r) =>
          (byRequest !== undefined && r.requestId === byRequest) ||
          (byPair !== undefined && r.threadId === byPair.threadId
            && r.callId === byPair.callId)) ?? null
      }),
      updateMany: vi.fn(async ({ where, data }: {
        where: { callId?: string; status?: string; expiresAt?: { lt: Date } }
        data: Partial<Row>
      }) => {
        let n = 0
        for (const r of rows) {
          const idOk = where.callId === undefined || r.callId === where.callId
          const statusOk = where.status === undefined || r.status === where.status
          const expOk = where.expiresAt === undefined || r.expiresAt < where.expiresAt.lt
          if (idOk && statusOk && expOk) { Object.assign(r, data); n += 1 }
        }
        return { count: n }
      }),
      findMany: vi.fn(async ({ where }: { where: { threadId: string } }) =>
        rows.filter((r) => r.threadId === where.threadId)),
    },
  }
}
const now = 1_700_000_000_000

function makeService(prisma: ReturnType<typeof fakePrisma>,
  scheduler?: { registerHandler: ReturnType<typeof vi.fn> }) {
  return new SubagentTaskService(prisma as never, scheduler as never)
}

const spawnCall = {
  type: 'tool_call',
  data: { toolCallId: 'call_A', name: 'spawn_subagent',
    toolName: 'spawn_subagent', args: { task: '调研X' } },
}
const completedResult = {
  type: 'tool_result',
  data: { toolCallId: 'call_B', name: 'spawn_subagent',
    result: { details: { ok: true, report: 'R',
      usage: { turns: 3, durationMs: 78900, status: 'completed' } } } },
}

describe('D2 单据：开单据 / 幂等 / CAS', () => {
  it('tool_call 开单据：requestId=subagent:{callId}，expiresAt=startedAt+TTL，不存 task 全文', async () => {
    const p = fakePrisma([]); const s = makeService(p)
    s.onTraceEvent(spawnCall, { threadId: 't1', runId: 'run-A' })
    await vi.waitFor(() => expect(p.subagentTask.create).toHaveBeenCalledOnce())
    const d = p.subagentTask.create.mock.calls[0]![0].data
    expect(d.requestId).toBe('subagent:call_A')
    expect(d.status).toBe('spawned')
    expect(new Date(d.expiresAt as Date).getTime() - now).toBeLessThanOrEqual(SUBAGENT_TASK_TTL_MS)
    expect(JSON.stringify(d)).not.toContain('调研X'.repeat(200))
  })

  it('★ 幂等：同一 tool_call 到达两次只 create 一次、不覆盖 startedAt', async () => {
    const p = fakePrisma([]); const s = makeService(p)
    await s.openTask({ threadId: 't1', callId: 'call_A', startedAt: now })
    await s.openTask({ threadId: 't1', callId: 'call_A', startedAt: now + 999 })
    expect(p.subagentTask.create).toHaveBeenCalledTimes(1)
  })

  it('★ CAS 单点：settleTask 只翻 spawned，终态不复活', async () => {
    const p = fakePrisma([]); const s = makeService(p)
    await s.openTask({ threadId: 't1', callId: 'call_A', startedAt: now })
    expect(await s.settleTask({ callId: 'call_A',
      outcome: parseSubagentOutcome(completedResult.data.result)! })).toBe(true)
    expect(await s.settleTask({ callId: 'call_A',
      outcome: interruptedOutcome('no_terminal_event') })).toBe(false)
  })

  it('★ sweep 竞态：sweep 不得覆盖已完成/已中断的终态', async () => {
    const p = fakePrisma([]); const s = makeService(p)
    await s.openTask({ threadId: 't1', callId: 'call_A', startedAt: now })
    await s.settleTask({ callId: 'call_A',
      outcome: parseSubagentOutcome(completedResult.data.result)! })
    expect(await s.sweepExpired(now + SUBAGENT_TASK_TTL_MS * 2)).toBe(0)
    const rows = await p.subagentTask.findMany({ where: { threadId: 't1' } })
    expect(rows[0]!.status).toBe('completed')
  })

  it('sweep 只翻过期 spawned，reason=lease_expired；二次扫描 count=0', async () => {
    const p = fakePrisma([]); const s = makeService(p)
    await s.openTask({ threadId: 't1', callId: 'call_A', startedAt: now })
    expect(await s.sweepExpired(now + 10_000)).toBe(0)
    expect(await s.sweepExpired(now + SUBAGENT_TASK_TTL_MS + 1)).toBe(1)
    const rows = await p.subagentTask.findMany({ where: { threadId: 't1' } })
    expect(rows[0]!.reason).toBe('lease_expired')
    expect(await s.sweepExpired(now + SUBAGENT_TASK_TTL_MS + 2)).toBe(0)
  })
})

describe('D2 单据：漏斗零副作用 / fail-open / 注册 / 摘要', () => {
  it('★ 非 spawn 帧零副作用：不触达任何 prisma 方法', () => {
    const p = fakePrisma([]); const s = makeService(p)
    s.onTraceEvent({ type: 'tool_call', data: { name: 'get_canvas_summary' } },
      { threadId: 't1' })
    s.onTraceEvent({ type: 'thinking', data: {} }, { threadId: 't1' })
    expect(p.subagentTask.create).not.toHaveBeenCalled()
    expect(p.subagentTask.updateMany).not.toHaveBeenCalled()
    expect(p.subagentTask.findUnique).not.toHaveBeenCalled()
  })

  it('turn_interrupted 只对已存在的 spawn 单据收口，其他 id 静默忽略', async () => {
    const p = fakePrisma([]); const s = makeService(p)
    await s.openTask({ threadId: 't1', callId: 'call_A', startedAt: now })
    s.onTraceEvent({ type: 'turn_interrupted', data: {
      reason: 'no_terminal_event',
      outstandingToolCallIds: ['call_A', 'call_other_tool'],
    } }, { threadId: 't1' })
    await vi.waitFor(() => expect(p.subagentTask.updateMany).toHaveBeenCalled())
    const rows = await p.subagentTask.findMany({ where: { threadId: 't1' } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('interrupted')
    expect(rows[0]!.reason).toBe('no_terminal_event')
  })

  it('fail-open：create 抛错不 throw、只 warn（不阻塞 SSE）', async () => {
    const p = fakePrisma([])
    p.subagentTask.create.mockRejectedValueOnce(new Error('db down'))
    const s = makeService(p)
    expect(() => s.onTraceEvent(spawnCall, { threadId: 't1' })).not.toThrow()
    await expect(s.openTask({ threadId: 't1', callId: 'call_X' })).resolves.toBeUndefined()
  })

  it('onModuleInit 注册 1min sweep handler（不新起 timer）', () => {
    const registerHandler = vi.fn()
    makeService(fakePrisma([]), { registerHandler }).onModuleInit()
    expect(registerHandler).toHaveBeenCalledTimes(1)
    expect(registerHandler.mock.calls[0]![0]).toBe(SUBAGENT_TASK_SWEEP_KEY)
    expect(typeof registerHandler.mock.calls[0]![1]).toBe('function')
  })

  it('getSummaries 只回裁剪字段、不含 outcomeJson/requestId/parentSessionKey', async () => {
    const p = fakePrisma([]); const s = makeService(p)
    await s.openTask({ threadId: 't1', callId: 'call_A', startedAt: now })
    const out = await s.getSummaries('t1', now)
    expect(out).toHaveLength(1)
    expect(Object.keys(out[0]!).sort()).toEqual(
      ['callId', 'endedAt', 'reason', 'startedAt', 'status', 'taskPreview'].sort(),
    )
  })
})
```

⚠️ `vi.waitFor` 需要 vitest 环境支持（本仓已有同款用法）；若不可用改为 `await new Promise(r => setTimeout(r, 0))` 后再断言。构造桩的 `as never` 仅用于 DI 参数（本仓既有惯例），**断言值禁用 `as never`**。

- [ ] **Step 2: 跑测试确认 RED**

```bash
cd /tmp/pi-lnk-master-ba059283
PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS \
  pnpm --filter @lnkpi/server exec vitest run src/agent/subagent-task.service.test.ts \
  --maxWorkers=1 --no-file-parallelism
```
预期：FAIL（`Cannot find module './subagent-task.service'`）。

- [ ] **Step 3: 写最小实现**

`apps/server/src/agent/subagent-task.service.ts`（**逐行对齐 `pending-interruption.service.ts` 的 fail-open 与 CAS 姿势**）：

```ts
/**
 * D2 子代理一等任务单据（spec §5.2/§5.3）。
 *
 * 设计纪律（与 P2 PendingInterruptionService 同族）：
 * - 全部方法 fail-open：表写失败只留痕不阻塞 SSE；读失败按「无在途」保守返回 []。
 * - 不新起 timer：过期扫描挂既有 AutomationSchedulerService 的 1min job（G1 唯一 timer）。
 * - 不改 pi-runtime：Nest 侧权威状态由 tool_call / tool_result / turn_interrupted 三类帧驱动。
 * - 单据是 Nest 观测投影，不是子 run 内部真源 ⇒ reason 恒为可观测事实。
 */
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common'
import { AutomationSchedulerService } from '../automation/automation-scheduler.service'
import { PrismaService } from '../prisma/prisma.service'
import {
  interruptedOutcome, isSpawnToolFrame, parseSubagentOutcome,
  type SubagentTaskOutcome,
} from './subagent-task.status'

export const SUBAGENT_TASK_SWEEP_KEY = 'subagent-task-sweep'
/** 300s 子任务硬边界 + 60s 宽限（不与 pi-runtime 共享代码，独立常量）。 */
export const SUBAGENT_TASK_TTL_MS = 360_000
const PREVIEW_MAX = 512

export interface SubagentTaskSummary {
  callId: string
  status: string
  reason: string | null
  taskPreview: string | null
  startedAt: number
  endedAt: number | null
}

type TaskRow = {
  callId: string
  status: string
  reason: string | null
  taskPreview: string | null
  startedAt: Date
  endedAt: Date | null
  expiresAt: Date
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

@Injectable()
export class SubagentTaskService implements OnModuleInit {
  private readonly logger = new Logger(SubagentTaskService.name)

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject(AutomationSchedulerService)
    private readonly scheduler?: AutomationSchedulerService,
  ) {}

  onModuleInit(): void {
    this.scheduler?.registerHandler(SUBAGENT_TASK_SWEEP_KEY, async () => this.sweepExpired())
  }

  /** 漏斗唯一入口。非 spawn 帧立即返回 ⇒ 零 prisma 触达（性能回归锁）。 */
  onTraceEvent(
    ev: { type: string; data?: unknown },
    ctx: { threadId: string; runId?: string | null; parentSessionKey?: string | null },
  ): void {
    const d = (ev.data ?? {}) as Record<string, unknown>
    if (ev.type === 'tool_call' && isSpawnToolFrame(ev)) {
      const callId = d.toolCallId
      if (typeof callId !== 'string' || !callId) return
      const args = (d.args ?? {}) as Record<string, unknown>
      void this.openTask({
        threadId: ctx.threadId,
        callId,
        runId: ctx.runId,
        parentSessionKey: ctx.parentSessionKey,
        taskPreview: typeof args.task === 'string' ? args.task.slice(0, PREVIEW_MAX) : null,
      })
      return
    }
    if (ev.type === 'tool_result' && isSpawnToolFrame(ev)) {
      const callId = d.toolCallId
      if (typeof callId !== 'string' || !callId) return
      const outcome = parseSubagentOutcome(d.result)
      if (outcome) void this.settleTask({ callId, outcome })
      return
    }
    if (ev.type === 'turn_interrupted') {
      const ids = d.outstandingToolCallIds
      if (!Array.isArray(ids)) return
      for (const id of ids) {
        if (typeof id !== 'string' || !id) continue
        void this.settleTask({ callId: id, outcome: interruptedOutcome('no_terminal_event') })
      }
    }
  }

  async openTask(input: {
    threadId: string
    callId: string
    runId?: string | null
    parentSessionKey?: string | null
    taskPreview?: string | null
    startedAt?: number
  }): Promise<void> {
    if (!input.threadId || !input.callId) return
    const now = input.startedAt ?? Date.now()
    const requestId = `subagent:${input.callId}`
    try {
      const key = { threadId_callId: { threadId: input.threadId, callId: input.callId } }
      const existing = await this.prisma.subagentTask.findUnique({ where: key })
      if (existing || await this.prisma.subagentTask.findUnique({ where: { requestId } })) return
      await this.prisma.subagentTask.create({
        data: {
          threadId: input.threadId,
          callId: input.callId,
          requestId,
          runId: input.runId ?? null,
          parentSessionKey: input.parentSessionKey ?? null,
          taskPreview: input.taskPreview ?? null,
          status: 'spawned',
          expiresAt: new Date(now + SUBAGENT_TASK_TTL_MS),
          startedAt: new Date(now),
          updatedAt: new Date(now),
        },
      })
    } catch (err) {
      // 唯一键并发冲突 / 表不可用：fail-open，不阻塞事件流
      this.logger.warn(`subagent_task_open_failed callId=${input.callId}: ${errMessage(err)}`)
    }
  }

  /** CAS 单点：只翻 spawned ⇒ 重复 tool_result / sweep 竞态 / 终态复活全部挡住。 */
  async settleTask(input: { callId: string; outcome: SubagentTaskOutcome }): Promise<boolean> {
    try {
      const res = await this.prisma.subagentTask.updateMany({
        where: { callId: input.callId, status: 'spawned' },
        data: {
          status: input.outcome.status,
          reason: input.outcome.reason,
          outcomeJson: JSON.stringify(input.outcome.summary),
          endedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      return res.count > 0
    } catch (err) {
      this.logger.warn(`subagent_task_settle_failed callId=${input.callId}: ${errMessage(err)}`)
      return false
    }
  }

  /** 1min 扫描：过期未裁决单据翻 interrupted；二次扫描 count=0（幂等）。 */
  async sweepExpired(nowMs = Date.now()): Promise<number> {
    try {
      const res = await this.prisma.subagentTask.updateMany({
        where: { status: 'spawned', expiresAt: { lt: new Date(nowMs) } },
        data: {
          status: 'interrupted',
          reason: 'lease_expired',
          endedAt: new Date(nowMs),
          updatedAt: new Date(nowMs),
        },
      })
      return res.count
    } catch (err) {
      this.logger.warn(`subagent_task_sweep_failed: ${errMessage(err)}`)
      return 0
    }
  }

  /** state API：在途（spawned 且未过期） + 最近 5 条终态，字段裁剪、旧形状兼容。 */
  async getSummaries(threadId: string, nowMs = Date.now()): Promise<SubagentTaskSummary[]> {
    if (!this.prisma?.subagentTask) return []
    try {
      const rows = (await this.prisma.subagentTask.findMany({
        where: { threadId },
        orderBy: { startedAt: 'desc' },
      })) as TaskRow[]
      const live = rows.filter((r) => r.status === 'spawned' && r.expiresAt > new Date(nowMs))
      const terminal = rows.filter((r) => r.status !== 'spawned').slice(0, 5)
      return [...live, ...terminal].map((r) => ({
        callId: r.callId,
        status: r.status,
        reason: r.reason,
        taskPreview: r.taskPreview,
        startedAt: new Date(r.startedAt).getTime(),
        endedAt: r.endedAt ? new Date(r.endedAt).getTime() : null,
      }))
    } catch (err) {
      this.logger.warn(`subagent_task_summaries_failed thread=${threadId}: ${errMessage(err)}`)
      return []
    }
  }
}
```

`automation-scheduler.service.ts` 的 `AUTOMATION_DEFAULT_JOBS` 末尾追加：

```ts
  {
    // D2 子代理一等单据（2026-11-12）：按持久化 expiresAt 收口在途任务。
    // 与 P2 同理由 —— 进程内 setTimeout 重启即丢 ⇒ 重启后必须有 startup 扫描。
    id: 'job-subagent-task-sweep',
    name: '子代理任务租约裁决',
    description: 'D2：按 expiresAt 把过期未裁决的 spawned 单据翻 interrupted（幂等）',
    handlerKey: 'subagent-task-sweep',
    intervalMinutes: 1,
    runOnStartup: true,
    params: '{}',
  },
```

- [ ] **Step 4: 跑测试确认 GREEN + 变异自检**

```bash
cd /tmp/pi-lnk-master-ba059283
PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS \
  pnpm --filter @lnkpi/server exec vitest run \
    src/agent/subagent-task.status.test.ts \
    src/agent/subagent-task.service.test.ts \
    src/agent/pending-interruption.service.test.ts \
    --maxWorkers=1 --no-file-parallelism
```
预期全 PASS。变异自检：把 `settleTask` 的 `where.status:'spawned'` 去掉 ⇒ 「终态不复活」与「sweep 不得覆盖终态」两条必须 RED；恢复后 GREEN。**记录实际输出**。

- [ ] **Step 5: Commit（登记改动清单）**

```
T3 改动路径：apps/server/src/agent/subagent-task.service.ts、
             apps/server/src/agent/subagent-task.service.test.ts、
             apps/server/src/automation/automation-scheduler.service.ts
```

---

### Task 4: 漏斗接线 + 构造注入 + module 登记（行为级测试，非源码正则）

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts`（import 区、constructor 末位、`pushTraceEvent` 漏斗）
- Modify: `apps/server/src/agent/agent.module.ts`（providers）
- Create: `apps/server/src/agent/subagent-task.wiring.test.ts`

**Interfaces:**
- Consumes: T3 的 `SubagentTaskService.onTraceEvent(ev, ctx)`；`pushTraceEvent` 内已可见的 `threadId` / `sessionId` / `currentPiEvent`（真 master `agent.service.ts:3202-3280`）
- Produces: 无新导出；D2 单据的运行时驱动路径。

- [ ] **Step 1: 写红灯行为级接线测试**

`apps/server/src/agent/subagent-task.wiring.test.ts`（**复用 `agent.service.turn-interrupted.test.ts` 的 `stubPiClient` + `onClosed()` 流耗尽构造，行为级断言，不用源码正则**）：

```ts
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { stubPiClient } from './agent.test-utils'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

function seqEvent(type: string, data: unknown, seq: number): PiRuntimeEvent {
  return { type, ts: 1_700_000_000_000, seq, data } as PiRuntimeEvent
}

/** D1 既有测试同款 3 参桩（DI 参数 as never 是本仓惯例）。 */
function makePrismaStub() {
  return {
    agentMessage: {
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'm1', ...data })),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    agentThread: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    session: { findUnique: vi.fn().mockResolvedValue(null) },
    userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
  }
}

describe('D2 漏斗接线：单据由 SSE 事件驱动', () => {
  let service: AgentService
  let tasks: { onTraceEvent: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    process.env.TEXT_TOKEN_BILLING = 'on'
    tasks = { onTraceEvent: vi.fn() }
    // ⚠️ 构造参位置必须按真 master agent.service.ts:360-420 核对后填入：
    //    pendingInterruptions 是 @Optional() 末位参数（:418-419），
    //    D2 的 subagentTasks 追加在其后。若位置错，onTraceEvent 零调用 ⇒ 测试 RED，
    //    这正是不用「源码正则假绿」的原因。
    service = makeService(makePrismaStub(), tasks)
  })

  async function runNaturallyExhausted(events: PiRuntimeEvent[]) {
    const pi = stubPiClient([])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    pi.streamEvents.mockImplementation(
      (_sid: string, onEvent: (e: PiRuntimeEvent) => void, onClosed: () => void) => {
        for (const e of events) onEvent(e)
        onClosed()
        return () => {}
      },
    )
    for await (const _e of service.streamConversation('s1', '帮我调研', 'u1', 't1')) { /* drain */ }
  }

  it('★ 阳性：tool_call{spawn} 到达漏斗 ⇒ onTraceEvent 收到 tool_call 帧', async () => {
    await runNaturallyExhausted([
      seqEvent('agent_start', { runId: 'run-A' }, 140),
      seqEvent('tool_execution_start', {
        toolCallId: 'call_A', toolName: 'spawn_subagent', args: { task: '调研X' },
      }, 152),
    ])
    expect(tasks.onTraceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_call' }),
      expect.objectContaining({ threadId: expect.any(String) }),
    )
  })

  it('★ 阴性 B：有配对 tool_result 的正常回合，漏斗收到 tool_result 帧', async () => {
    await runNaturallyExhausted([
      seqEvent('agent_start', { runId: 'run-B' }, 1),
      seqEvent('tool_execution_start', {
        toolCallId: 'call_B', toolName: 'spawn_subagent', args: { task: 'Y' },
      }, 2),
      seqEvent('tool_execution_end', {
        toolCallId: 'call_B', toolName: 'spawn_subagent',
        result: { details: { ok: true, report: 'R',
          usage: { turns: 1, durationMs: 10, status: 'completed' } } },
      }, 3),
      seqEvent('agent_end', { status: 'completed' }, 4),
    ])
    expect(tasks.onTraceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_result' }),
      expect.anything(),
    )
  })

  it('★ D1 关联：turn_interrupted 帧到达漏斗（Review Focus 4）', async () => {
    await runNaturallyExhausted([
      seqEvent('agent_start', { runId: 'run-A' }, 140),
      seqEvent('tool_execution_start', {
        toolCallId: 'call_A', toolName: 'spawn_subagent', args: { task: 'X' },
      }, 152),
    ])
    expect(tasks.onTraceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'turn_interrupted',
        data: expect.objectContaining({ reason: 'no_terminal_event' }),
      }),
      expect.anything(),
    )
  })

  it('★ 未装配 SubagentTaskService（既有单测）⇒ 整段短路、零回归', async () => {
    const bare = makeService(makePrismaStub(), undefined)
    const pi = stubPiClient([])
    vi.spyOn(bare, 'createPiRuntimeClient').mockReturnValue(pi)
    pi.streamEvents.mockImplementation(
      (_s: string, onEvent: (e: PiRuntimeEvent) => void, onClosed: () => void) => {
        onEvent(seqEvent('tool_execution_start', {
          toolCallId: 'call_X', toolName: 'spawn_subagent', args: { task: 'X' },
        }, 1))
        onClosed()
        return () => {}
      },
    )
    await expect(async () => {
      for await (const _e of bare.streamConversation('s1', 'x', 'u1', 't1')) { /* drain */ }
    }).not.toThrow()
  })
})

/**
 * 构造 helper：实施时按真 master 的 constructor 参数表补全中间的 undefined 占位。
 * ⚠️ 必须核对到具体行号，不能照抄本仓陈旧工作树（0.85.1 分支参数个数不同）。
 */
function makeService(prisma: ReturnType<typeof makePrismaStub>,
  tasks: { onTraceEvent: ReturnType<typeof vi.fn> } | undefined): AgentService {
  return new AgentService(
    prisma as never,
    { createFromAgent: vi.fn() } as never,
    { resolveForGeneration: vi.fn() } as never,
    undefined, undefined, undefined, undefined, undefined,
    tasks as never,
  )
}
```

⚠️ 这是**全计划唯一允许实施者按真代码补全的地方**：`AgentService` 构造参数表在 #845/#846/#847 三次并行窗口有变动，且本仓工作树陈旧（0.85.1）。实施者**必须先读真 master 快照 `apps/server/src/agent/agent.service.ts:360-425`**，数清参数个数后把 `makeService` 的 `undefined` 占位补齐到 `subagentTasks` 落在正确末位；同时保留 `it('未装配 ⇒ 零回归')` 与三条**行为级**阳性断言作为防假绿锁。若构造桩错位导致 `onTraceEvent` 零调用，测试必 RED，不得改用「源码正则」绕过。

- [ ] **Step 2: 跑测试确认 RED**

```bash
cd /tmp/pi-lnk-master-ba059283
PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS \
  pnpm --filter @lnkpi/server exec vitest run src/agent/subagent-task.wiring.test.ts \
  --maxWorkers=1 --no-file-parallelism
```
预期：FAIL（`onTraceEvent` 零调用）。

- [ ] **Step 3: 写最小实现**

**(a) `agent.service.ts` import 区**（紧邻 `PendingInterruptionService` import，真 master `:119` 附近）：

```ts
import { SubagentTaskService } from './subagent-task.service'
```

**(b) constructor 末位**（`pendingInterruptions` 之后追加，保持 `@Optional()` 语义与既有按位置构造单测零破坏）：

```ts
    @Optional()
    @Inject(SubagentTaskService)
    private readonly subagentTasks?: SubagentTaskService,
```

**(c) `pushTraceEvent` 漏斗**：在 `turnFactEvents.push(ev)` 之后、`appendAgentEvent(ev)` 之前插入**一行**：

```ts
      // D2：一等子任务单据与 AgentEvent 账本同一同步段驱动。
      // ⚠️ 只读当帧 ev 本身（全量事实），不读被 P1c 裁剪过的 executionEvents，
      //    也不反向依赖 fire-and-forget 账本读回（与 D1 §5.1 同源约束）。
      // ⚠️ onTraceEvent 内部对非 spawn 帧立即返回 ⇒ 绝大多数回合零 prisma 触达。
      this.subagentTasks?.onTraceEvent(ev, {
        threadId: threadId ?? sessionId,
        runId: currentPiEvent?.runId ?? null,
        parentSessionKey: threadId ?? sessionId,
      })
```

**(d) `agent.module.ts`**：`providers` 数组（`PendingInterruptionService` 所在 `:50` 附近）追加 `SubagentTaskService`，并补 import。

⚠️ `threadId` / `sessionId` / `currentPiEvent` 均为当前作用域既有变量（`appendAgentEvent` 内已用 `const threadKey = threadId ?? sessionId`，真 master `:3202-3210`）。若 `pushTraceEvent` 内不可见，按 `:3299` 附近的真实声明名替换，不得新造变量。

- [ ] **Step 4: 跑测试确认 GREEN + D1/P1c/P2 回归锁**

```bash
cd /tmp/pi-lnk-master-ba059283
PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS \
  pnpm --filter @lnkpi/server exec vitest run \
    src/agent/subagent-task.wiring.test.ts \
    src/agent/turn-end.test.ts \
    src/agent/agent.service.turn-interrupted.test.ts \
    src/agent/agent.service.p1cShrink.test.ts \
    src/agent/agent.service.p2Interruption.test.ts \
    src/agent/turn-settle-detached.test.ts \
    src/agent/turn-identity.test.ts \
    src/agent/agent.service.eventLedger.test.ts \
    --maxWorkers=1 --no-file-parallelism
```
预期全 PASS。**任何一条既有测试红都视为 D2 破坏契约**，不得「修测试」掩盖。变异自检：把漏斗那行注释掉 ⇒ wiring 测试 3 条阳性必须 RED，恢复后 GREEN。

- [ ] **Step 5: Commit（登记改动清单）**

```
T4 改动路径：apps/server/src/agent/agent.service.ts、
             apps/server/src/agent/agent.module.ts、
             apps/server/src/agent/subagent-task.wiring.test.ts
```

---

### Task 5: 只读查询面 —— `/threads/:id/state` 增 `subagentTasks`

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts`（`getThreadResumeState`，真 master `:1795-1813`）
- Modify: `apps/server/src/agent/agent.controller.ts`（`:288` 注释）
- Create: `apps/server/src/agent/agent.service.state-d2.test.ts`

**Interfaces:**
- Consumes: T3 的 `getSummaries(threadId)` / `SubagentTaskSummary`
- Produces: `GET /api/agent/threads/:threadId/state` 响应 `data.subagentTasks: SubagentTaskSummary[]`（旧客户端忽略未知字段）

- [ ] **Step 1: 写红灯测试**

`apps/server/src/agent/agent.service.state-d2.test.ts`（**只测 `getSummaries` 注入契约，不重复造 state 方法的全套桩**；`getThreadResumeState` 的属主校验桩沿用 `agent.controller.state` 既有测试，本文件用 `vi.spyOn` 绕开）：

```ts
import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import type { SubagentTaskSummary } from './subagent-task.service'

const prismaStub = () => ({
  agentMessage: { findMany: vi.fn().mockResolvedValue([]) },
  agentEvent: { aggregate: vi.fn().mockResolvedValue({ _max: { gSeq: null } }) },
  agentThread: { findUnique: vi.fn().mockResolvedValue(null) },
  session: { findUnique: vi.fn().mockResolvedValue(null) },
  userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
})

/**
 * 按真 master 构造参数表补全（同 T4 makeService）；subagentTasks 落正确末位。
 * assertThreadOwner / reconcileLatestAssistant 用 vi.spyOn 打桩，避免重复构造
 * 两套互不相同的 prisma 桩（本仓 #815「判据自匹配恒绿」教训）。
 */
async function stateWith(summaries: ReturnType<typeof vi.fn>): Promise<Record<string, unknown>> {
  const service = makeStateService(summaries)
  vi.spyOn(service, 'assertThreadOwner' as never).mockResolvedValue(undefined as never)
  vi.spyOn(service, 'reconcileLatestAssistant').mockResolvedValue({ outcome: 'complete' } as never)
  return (await service.getThreadResumeState('t1', 'u1')) as unknown as Record<string, unknown>
}

describe('state API：D2 subagentTasks 摘要', () => {
  it('无单据 ⇒ []（旧形状兼容，字段恒出现）', async () => {
    const data = await stateWith(vi.fn().mockResolvedValue([]))
    expect(data.subagentTasks).toEqual([])
    expect(data.pendingInterruption).toBeNull()
    expect(data.lastGSeq).toBeNull()
  })

  it('★ 只回裁剪字段：不含 outcomeJson / requestId / parentSessionKey', async () => {
    const one: SubagentTaskSummary = {
      callId: 'call_A', status: 'interrupted', reason: 'no_terminal_event',
      taskPreview: '调研X', startedAt: 1_700_000_000_000, endedAt: null,
    }
    const data = await stateWith(vi.fn().mockResolvedValue([one]))
    expect(data.subagentTasks).toEqual([one])
    expect(Object.keys((data.subagentTasks as unknown[])[0] as object).sort()).toEqual(
      ['callId', 'endedAt', 'reason', 'startedAt', 'status', 'taskPreview'].sort(),
    )
  })

  it('getSummaries 抛错 ⇒ []（fail-open，不 500）', async () => {
    const data = await stateWith(vi.fn().mockRejectedValue(new Error('db down')))
    expect(data.subagentTasks).toEqual([])
  })
})

function makeStateService(summaries: ReturnType<typeof vi.fn>): AgentService {
  const tasks = { getSummaries: summaries }
  return new AgentService(
    prismaStub() as never,
    { createFromAgent: vi.fn() } as never,
    { resolveForGeneration: vi.fn() } as never,
    undefined, undefined, undefined, undefined, undefined,
    tasks as never,
  )
}
```

⚠️ 与 T4 同一条纪律：`makeStateService` 的 `undefined` 占位必须按真 master 构造参数表核对补齐；`stateWith` 里的 `vi.spyOn(... as never)` 仅用于打桩私有/保护方法名，不是断言值。实施时若 `reconcileLatestAssistant` 的真实返回形状不是 `{ outcome }`，按真 master `agent.service.ts:1486` 的实现调整桩返回值，**不得改产品代码迁就测试**。

- [ ] **Step 2: 跑测试确认 RED**

```bash
cd /tmp/pi-lnk-master-ba059283
PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS \
  pnpm --filter @lnkpi/server exec vitest run src/agent/agent.service.state-d2.test.ts \
  --maxWorkers=1 --no-file-parallelism
```
预期：FAIL（`subagentTasks` 未定义）。

- [ ] **Step 3: 写最小实现**

`agent.service.ts` 的 `getThreadResumeState` 返回值类型与 return 对象各加一项：

```ts
  ): Promise<{
    status: 'in_progress' | 'complete'
    lastGSeq: number | null
    pendingInterruption: PendingInterruptionSummary | null
    subagentTasks: SubagentTaskSummary[]
  }> {
```
```ts
      // D2：在途 + 最近 5 条终态单据；读失败由 service 内部 fail-open 返回 []。
      subagentTasks: (await this.subagentTasks?.getSummaries(threadId)) ?? [],
```

import 区补：
```ts
import type { SubagentTaskSummary } from './subagent-task.service'
```

`agent.controller.ts:288` 注释改为：`/** 线程状态摘要：status / lastGSeq / pendingInterruption / subagentTasks（D2）。 */`

- [ ] **Step 4: 跑测试确认 GREEN + state 相关回归**

```bash
cd /tmp/pi-lnk-master-ba059283
PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS \
  pnpm --filter @lnkpi/server exec vitest run \
    src/agent/agent.service.state-d2.test.ts \
    src/agent/pending-interruption.service.test.ts \
    src/agent/agent.controller.test.ts \
    --maxWorkers=1 --no-file-parallelism
```
预期全 PASS，且旧 `pendingInterruption` 断言逐字节不变。⚠️ `agent.controller.test.ts` 文件名需实施时 `Glob` 确认；若不存在，改跑 `src/agent/*.controller*.test.ts` 全量，不得用 `--exclude` 跳过。

- [ ] **Step 5: Commit（登记改动清单）**

```
T5 改动路径：apps/server/src/agent/agent.service.ts、
             apps/server/src/agent/agent.controller.ts、
             apps/server/src/agent/agent.service.state-d2.test.ts
```

---

### Task 6: 全量验证、静态守卫、REST 推 PR（不合并）

**Files:**
- Modify: 无产品代码；同步 `docs/superpowers/specs/2026-11-12-subagent-task-ledger-design.md` 与 `docs/superpowers/plans/2026-11-12-subagent-task-ledger.md` 到快照 `docs/` 内

**Interfaces:** Consumes T1–T5 全部改动路径；Produces 一个基于真 master 的远端分支 + PR（**不合并**）

- [ ] **Step 1: 复制规格与计划进快照**

```bash
cp /Users/4seven/workspace/pi-lnk/docs/superpowers/specs/2026-11-12-subagent-task-ledger-design.md \
   /tmp/pi-lnk-master-ba059283/docs/superpowers/specs/
cp /Users/4seven/workspace/pi-lnk/docs/superpowers/plans/2026-11-12-subagent-task-ledger.md \
   /tmp/pi-lnk-master-ba059283/docs/superpowers/plans/
```

- [ ] **Step 2: 全量单测 + 类型检查**

```bash
cd /tmp/pi-lnk-master-ba059283
export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"
env -u NODE_OPTIONS pnpm --filter @lnkpi/server exec vitest run --maxWorkers=1 --no-file-parallelism
env -u NODE_OPTIONS pnpm --filter @lnkpi/web exec vitest run --maxWorkers=1 --no-file-parallelism
env -u NODE_OPTIONS pnpm exec vue-tsc -b     # 勿加 --noEmit
```
预期：全 PASS。任何 FAIL 必须定位到具体任务并修，不得跳过或改用 `--exclude`。本机既有基线失败（`sessions.service.test.ts` 的 `canvasPatchMetrics`、`tsc` 的 7 条 Prisma client/软链陈旧错误、pi-runtime `session-orphan-recovery.test.ts` 时间敏感）须与**未改动纯净 `ba059283` 基线快照**逐条比对区分，如实记录，不用「修测试」掩盖。

- [ ] **Step 3: 静态守卫 + 变异自检汇总**

```bash
cd /tmp/pi-lnk-master-ba059283
# 漏斗只有一处 D2 接线（不是散在各事件提取分支）
grep -cE "subagentTasks\?\.onTraceEvent" apps/server/src/agent/agent.service.ts
# 不存全文：outcomeJson 只写 summary
grep -nE "outcomeJson|report" apps/server/src/agent/subagent-task.service.ts
# 无新端点 / 无新 timer
grep -rEn "@(Post|Get)\(['\"].*subagent|setInterval|setTimeout" \
  apps/server/src/agent/subagent-task.service.ts apps/server/src/agent/agent.controller.ts || echo "NO_NEW_ENDPOINT_OR_TIMER"
# schema additive：migration 无 ALTER/DROP
grep -En "ALTER|DROP|DELETE|UPDATE|INSERT" \
  apps/server/prisma/migrations/20261112120000_add_subagent_task/migration.sql || echo "ADDITIVE_OK"
# 零 pi-runtime 改动：compare 的 DELTA 不得含 services/pi-runtime
```
逐项记录实际输出。变异自检至少复跑 T1 的 `details` 缺失变异、T3 的 `where.status:'spawned'` 变异、T4 的漏斗摘除变异，三者必须 RED→GREEN。

- [ ] **Step 4: 文案纪律扫描**

```bash
cd /tmp/pi-lnk-master-ba059283
grep -rEn "pod_restarted|upstream_disconnected|服务更新打断" \
  apps/server/src/agent/subagent-task*.ts || echo "COPY_OK"
```

- [ ] **Step 5: REST 推 PR（不合并）**

按项目纪律：
1. `gh api repos/sev7n4/pi-lnk/git/ref/heads/master` 取真实 HEAD；若已前移（`ba059283` 不再是 master），**先重新核对目标路径 blob 与新 master**：blob 全等 ⇒ 可换 parent/base_tree；blob 不全等 ⇒ 必须基于新 master 重建单 commit，**禁止**仅凭 `MERGEABLE` 下结论（#822 教训）。`agent.service.ts` 是 #845/#846/#847 三次并行窗口的高重叠路径，按 D1 的 `git merge-file -p ours base theirs` 三路合并处置，并做结构差分（`ALL_PARALLEL_KEPT`）。
2. 逐个改动路径 `gh api .../git/blobs` 建 blob 并 `git hash-object` 校验；`POST /git/trees` 时 `base_tree` = 真 master sha 且 `tree` **只列改动路径**。
3. `POST /git/commits` → `POST /git/refs`（新分支 `feat/subagent-task-ledger-d2`）→ `POST /pulls`。
4. 推后 `gh api .../compare/master...<branch>` 核验 `DELTA = 改动路径集合` 且 `ALL_PARALLEL_KEPT`（不覆盖并行窗口他人改动），且 `DELTA` **不含** `services/pi-runtime/**`（零发布面证据）。
5. PR 正文必须**回读长度**（`@文件路径` 会静默丢内容），写入：根因一句话、D2 改动清单、上游/生态对照结论、验收命令、变异自检实际输出、No-Go 边界、「未合并未部署，等单独授权」。

- [ ] **Step 6: 停在合并前，回报**

CI 结论以 `gh api` 为准（本机 fetch 不可达）。**不合并、不触发 `runtime-deploy`、不改生产数据**；等用户单独授权。回报内容：PR 号与 URL、CI 结论、T1–T5 测试结果、变异自检实际输出、静态守卫输出、未闭环项（D3 方案纠偏、D5 发布韧性、82 条 truncated 分层归因、真机走查、A-6、P2 严格重启前后对比）。**不宣告 ALL_PASS**。

---

## Self-Review（写完计划后对照规格逐项核对）

**1. Spec coverage**

| 规格章节 | 覆盖任务 |
|---|---|
| §3 取证基线（生产 PVC / 上游盘点 / 生态对照 / 自身缺陷） | 规格文档本身（docs-only，随 PR 同行）；T6 Step 1 |
| §4 方案裁决（C 采纳 / A·B·D 否决） | Global Constraints（零 pi-runtime、零 watcher、禁 resume） |
| §4.1 幂等键 `subagent:{callId}` | T1 夹具、T3 `openTask`、T2 `@@unique([requestId])` |
| §4.2 范围（只读查询面必含、checkpoint/回注/恢复排除） | T5 查询面；No-Go 明列 |
| §5.1 数据模型（字段、无 FK、String status、索引） | T2（schema + migration + 静态守卫） |
| §5.2 状态机（CAS 单点 / 终态不复活 / expiresAt / 1min sweep / 中性 reason） | T3（settleTask / sweepExpired / 注册 handler）+ T1（interruptedOutcome） |
| §5.3 写入漏斗（唯一写者、三类帧、全量事实视图、fail-open） | T4（一行接线 + 行为级测试）+ T3（onTraceEvent） |
| §5.4 4 态 outcome 可读性（零 pi-runtime 改动） | T1（parseSubagentOutcome + B 夹具 + M1–M4） |
| §5.5 只读查询面（裁剪字段、上限、旧形状兼容） | T5 + T3 `getSummaries` |
| §5.6 数据流 | T4 阳性/阴性/D1 关联三条 wiring 测试 |
| §6 生产记录 A/B 求值 + 6 组变异 | T1（全部）+ T3（CAS 变异） |
| §7 兼容性 / fail-open / 老消息 / D1 零回归 / 多实例 / additive 迁移 | T2（静态守卫）、T3（fail-open）、T4（回归锁 8 文件） |
| §8 测试矩阵 | T1–T5 + T6 Step 2/3/4 |
| §9 分刀与 D3 纠偏 / D5 依赖 | Global Constraints No-Go + T6 Step 6 回报 |
| §10 No-Go | Global Constraints + T6 Step 3/4 静态扫描 |
| §11 风险边界 | T6 Step 6 回报；规格 §11 随 PR 同行 |

**2. Placeholder scan**：全篇无 `TBD` / `TODO` / `implement later` / `add appropriate error handling` / `similar to Task N` / 「照抄某文件」式空指代——所有代码步骤都给出完整可执行片段。⚠️ 两处**显式标注「实施时按真代码核对」**而非隐藏占位：T4 `makeService` 与 T5 `makeStateService` 的构造参占位个数、T5 `stateWith` 里 `reconcileLatestAssistant` 的桩返回形状。这两处是**本仓反复踩过的静默假绿点**（#815、D1 的 `feedTimeline` 未导出、三次并行窗口构造参变动），必须在实施时先读真 master、且各有行为级断言兜底。若实施者读到与计划不符，按 D1 实施期纠偏的做法**只追加状态回填**，不改写计划原步骤。

**3. Type consistency**：`SubagentTerminalStatus` / `SubagentTaskOutcome` / `parseSubagentOutcome(result)` / `interruptedOutcome(reason)` / `isSpawnToolFrame(ev)` 在 T1 定义、T3 消费；`SUBAGENT_TASK_SWEEP_KEY` / `SUBAGENT_TASK_TTL_MS` / `SubagentTaskSummary` / `onTraceEvent(ev, ctx)` / `openTask` / `settleTask` / `sweepExpired` / `getSummaries` 在 T3 定义、T4/T5 消费，签名逐字一致；`status:'spawned'` 在 T2 定义为 default、T3 作为 CAS where 条件；`reason:'no_terminal_event'|'lease_expired'` 在 T1/T3 与 D1 的 `turn_interrupted.reason` 同值；`TaskRow` 含 `expiresAt: Date`（`getSummaries` 的在途过滤依赖它，T3 内已声明）。

**4. Review Focus**：5 类输入全部映射到具体测试 —— ① T3「非 spawn 帧零副作用」+ T4 阴性；② T3「★ 幂等」；③ T3「★ sweep 竞态」+「★ CAS 单点」；④ T3「turn_interrupted 只对已存在的 spawn 单据收口」+ T4 关联用例；⑤ T4 D1 回归锁（`turn-end` / `turn-interrupted` / `p1cShrink` / `p2Interruption` / `turn-settle-detached` / `turn-identity` / `eventLedger`）。无空项。

**5. 已知实施期风险锚（写前留痕，不作为占位）**：
- `agent.service.ts` 是 #845/#846/#847 三次并行窗口的高重叠路径 ⇒ T6 Step 5 必须逐路径裸 blob 比对 + 三路合并 + 结构差分，不能只换 parent（#822 / D1 纠偏⑨）。
- `pushTraceEvent` 漏斗在真 master 上已有 P1c 写面分流（`executionEvents` 最小兼容集 / `turnFactEvents` 全量事实视图）⇒ D2 只读当帧 `ev`，不得读 `executionEvents`（D1 纠偏⑨ 实锤过读错数组会同时坏三处）。
- `prisma generate` 会改软链指向的主仓 `node_modules/.prisma`（未跟踪），推前核对；`vue-tsc -b` 会重生 tsbuildinfo / vite.config.js，推前清理并核 blob。
- 本机验证快照若裁剪掉 vendor 或 `services/pi-runtime/src`，会让 `verify-claims` / `verify-tool-contract` 假红（D1 已踩）；判「守卫红」先分清代码 vs 快照裁剪。
