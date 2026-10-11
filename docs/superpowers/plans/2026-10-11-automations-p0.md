# C5 Automations P0 实现计划（统一调度器 + probe/reaper 迁移 + admin 端点）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 upstream-probe / generation-reaper 两个手写 `setInterval` 定时任务迁入统一调度器（DB 配置 + 运行史 + admin 端点），达成 spec G1/G2/G4(trigger/只读)。

**Architecture:** 单例 `AutomationSchedulerService`（进程内唯一 timer 持有者，tick 驱动）+ `AutomationJob`/`AutomationRun` 两张 DB 表（配置与运行史 SSOT）+ 业务服务以 handler 代码级注册（`probeOnce`/`reapOnce` 业务函数零改动）+ admin 三端点（列表/运行史/手动触发，`AdminTokenGuard` 守卫）。

**Tech Stack:** NestJS provider 单例 · Prisma + SQLite（hand-written migration，部署走 entrypoint `migrate deploy`）· vitest（临时 SQLite harness，同 `model-catalog.controller.sqlite.integration.test.ts` 先例）。

**Spec:** `docs/superpowers/specs/2026-10-11-automations-design.md`（v1.0.0，PR #353 落库 `f9811c58`）。分期依据 §5：本计划只做 **P0**（告警 webhook、PATCH 写端点、cron 表达式属 P1/P2，不在本计划）。

**分支/工作区：** `feat/automations-p0` @ worktree `/Users/4seven/workspace/pi-lnk-wt-c5`（基线 origin/master `f9811c58`）。

## 执行环境（每个 Task 的命令都基于此）

```bash
WT=/Users/4seven/workspace/pi-lnk-wt-c5
SRV=$WT/apps/server
# 单测（新增文件）：
cd $SRV && pnpm exec vitest run src/automation/automation-scheduler.service.test.ts
# 全量回归：
cd $SRV && pnpm exec vitest run
# 类型检查（worktree 根）：
cd $WT && pnpm exec tsc --noEmit -p apps/server
```

⚠️ worktree 的 node_modules 复用主仓（`ln -s`，C4 同款）。**共享 hazard**：`prisma generate` 会重建共享的 `node_modules/.prisma/client`（新增模型向后兼容，主仓前端窗口不受影响；但主仓若同时 `prisma generate` 会反向抹掉新模型——执行期间避免在主仓跑 prisma generate）。

## Global Constraints（spec §6 全局约束，逐条绑定）

1. 单实例内存锁（`running` Map 为并发权威）；多实例分布式锁不在 P0。
2. 底层 timer 必须 `unref()`；job 执行不阻塞 bootstrap（`onApplicationBootstrap` 里 fire-and-forget）。
3. `NODE_ENV === 'test'` 时不启动任何 timer/startup run，但 `tick`/`triggerManual` 保持可用。
4. 失败隔离：单 job 失败（含运行史落库失败）绝不影响 scheduler 与其他 job。
5. at-least-once：handler 自身幂等（`probeOnce`/`reapOnce` 已幂等，reaper 有 exactly-once 事务守卫）。
6. admin 端点全部 `@UseGuards(AdminTokenGuard)`，复用 B1 机制，响应形状 `{ code: 0, message: 'ok', data }`。
7. 不引入新依赖：P0 只有 interval 调度，手写实现（不装 node-cron）。
8. 边界裁定：workflow recipe 不并入（spec §6-8）；本计划不触碰 `UserWorkflowRecipe`。

## 本计划的显式裁决（实现前与 spec 的差异，收口 Task 5 回写 spec v1.1.0）

| # | 裁决 | 理由 |
|---|---|---|
| D1 | schema 增列 `runOnStartup Boolean @default(false)`（spec §4.1 未列） | `AutomationRun.reason='startup'` 的唯一触发来源；probe/reaper 现有启动首扫语义必须保留（B3 竞态修复 / 15s 首扫） |
| D2 | 两服务的 startup 首扫从「服务内 setTimeout」迁移为「scheduler 启动后延迟 `STARTUP_RUN_DELAY_MS=15s` 派发 reason='startup' 的 run」 | 满足 G1「无业务级 timer」；probe 的「等路由表就绪」逻辑（B3 归属）保留在 probe 服务内，handler 在 startup 时先 await 它 |
| D3 | `LNKPI_UPSTREAM_PROBE_INTERVAL_MINUTES` 语义退役（间隔改 DB 配置）；`resolveProbeIntervalMinutes` 导出函数与相关测试保留不动 | 避免破坏无关测试；退役记录进 spec 收口 |
| D4 | reason 映射：`'scheduled'→'periodic'`、`'manual'→'manual'`、`'startup'→'startup'` | `probeOnce(reason: 'manual'\|'periodic'\|'startup')` 与 `reapOnce(reason: 'startup'\|'periodic'\|'manual')` 的现有签名**零改动**（实测锚点：upstream-probe.service.ts:293、generation-reaper.service.ts:169） |
| D5 | 种子策略 = scheduler `start()` 时 create-if-missing（upsert `update: {}`），绝不覆盖既有行 | 重启不得清掉 admin/手工调过的配置；不依赖 `prisma/seed.ts`（仅手工 db seed 执行） |
| D6 | `concurrencyPolicy='replace'` 在 P0 视同 `forbid`（不实现取消） | spec §4.2 自注「replace 慎用」；P1 再实现 |
| D7 | due 判据 = 该 job **最近一条 run（任意 status，含 skipped）** 的 `startedAt + max(1, intervalMinutes)·60_000 ≤ now` | 无 run ⇒ 立即 due；口径简单可测；skipped 不提前也不重复触发 |
| D8 | dispatch 的 check-then-act 竞口用**同步占位**封死（先 `running.set(jobId,'pending')` 再 await create） | tick 与 manual trigger 可能交错；JS 单线程下同步段不可插入 |
| D9 | 重启孤儿（DB 残留 status='running' 行）不阻塞新调度（内存 Map 才是并发权威），旧行保留原状 | spec §7 第 1 行的 P0 取舍；P1 告警可检测「超长 running」再收口 |

## Review Focus（spec §7 五条 → 落点）

| 输入/条件 | 期望行为 | 钉住测试 |
|---|---|---|
| admin 调过 interval 后 scheduler 重启 | 种子 create-if-missing，不覆盖 | Task 2 · `ensureDefaultJobs 不覆盖已调配置` |
| handler 抛异常 | run='failure'+error 落库，同 tick 其他 job 照常，scheduler 存活 | Task 2 · `handler 抛异常失败隔离` |
| 上一轮 running 时下一轮到点（定时或手动） | forbid → skipped 行 + 不重入 handler | Task 2 · `forbid 并发闸`、Task 3 · `trigger 运行中` |
| `NODE_ENV==='test'` | 零 timer 零 startup run，但 tick/trigger 可用 | Task 2 · `test 环境不启动 timer` |
| 进程重启时 job 正在执行（孤儿 running 行） | 不阻塞新调度；旧行保留 | Task 2 · `重启孤儿不阻塞` |

---

### Task 1: Prisma 两表 + migration

**Files:**
- Modify: `apps/server/prisma/schema.prisma`（文件末尾追加）
- Create: `apps/server/prisma/migrations/20261011150000_add_automation_tables/migration.sql`

**Interfaces（后续 Task 消费）:**
- `prisma.automationJob`：`{ id, name, description, handlerKey, enabled, scheduleType, intervalMinutes, params, concurrencyPolicy, runOnStartup, failureThreshold, failureWebhook, createdAt, updatedAt }`
- `prisma.automationRun`：`{ id, jobId, reason, status, startedAt, finishedAt, output, error }`

- [ ] **Step 1: schema.prisma 末尾追加两个 model**

```prisma
// ── C5 Automations（spec docs/superpowers/specs/2026-10-11-automations-design.md）──────
// AutomationJob：配置层（handler 代码级注册，运维配置级）。id 用固定语义键
// （'job-upstream-probe'），种子 create-if-missing（D5），admin 不发 id。
model AutomationJob {
  id                String   @id
  name              String
  description       String?
  handlerKey        String
  enabled           Boolean  @default(true)
  scheduleType      String   @default("interval") // P0 仅 interval；cron 属 P2
  intervalMinutes   Int      @default(5)
  params            String? // JSON
  concurrencyPolicy String   @default("forbid") // forbid | replace | allow（P0 replace 视同 forbid，D6）
  runOnStartup      Boolean  @default(false) // D1：启动后延迟派发一次 reason='startup'
  failureThreshold  Int      @default(3) // P1 告警消费
  failureWebhook    String? // P1 告警消费
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  runs              AutomationRun[]
}

// AutomationRun：运行史（G2）。reason: scheduled|manual|startup；status: running|success|failure|skipped
model AutomationRun {
  id         String        @id @default(cuid())
  jobId      String
  job        AutomationJob @relation(fields: [jobId], references: [id], onDelete: Cascade)
  reason     String
  status     String        @default("running")
  startedAt  DateTime      @default(now())
  finishedAt DateTime?
  output     String? // JSON（reapOnce 返回的收尾条数等）
  error      String?

  @@index([jobId, startedAt])
}
```

- [ ] **Step 2: 手写 migration.sql（部署链路 = entrypoint `prisma migrate deploy`，与仓库惯例一致）**

```bash
mkdir -p $SRV/prisma/migrations/20261011150000_add_automation_tables
```

`migration.sql` 内容：

```sql
-- C5 Automations P0：调度配置表 + 运行史表
CREATE TABLE "AutomationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "handlerKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scheduleType" TEXT NOT NULL DEFAULT 'interval',
    "intervalMinutes" INTEGER NOT NULL DEFAULT 5,
    "params" TEXT,
    "concurrencyPolicy" TEXT NOT NULL DEFAULT 'forbid',
    "runOnStartup" BOOLEAN NOT NULL DEFAULT false,
    "failureThreshold" INTEGER NOT NULL DEFAULT 3,
    "failureWebhook" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "output" TEXT,
    "error" TEXT,
    CONSTRAINT "AutomationRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AutomationJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AutomationRun_jobId_startedAt_idx" ON "AutomationRun"("jobId", "startedAt");
```

- [ ] **Step 3: 生成 client 并验证 migration 可部署**

```bash
cd $SRV && pnpm exec prisma generate
TMPDB=$(mktemp -d)/verify.db
DATABASE_URL="file:$TMPDB" pnpm exec prisma migrate deploy
```

Expected: `2 migrations applied`（初始 migration + 本 migration）且无 drift 报错。⚠️ 此步重建共享 prisma client（见执行环境 hazard）。

- [ ] **Step 4: Commit**

```bash
git -C $WT add apps/server/prisma
git -C $WT commit -m "feat(c5-p0): AutomationJob/AutomationRun 两表 + migration"
```

---

### Task 2: AutomationSchedulerService 调度核心

**Files:**
- Create: `apps/server/src/automation/automation-scheduler.service.ts`
- Create: `apps/server/src/automation/automation-scheduler.service.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `prisma.automationJob` / `prisma.automationRun`
- Produces（Task 3/4 依赖，签名逐字）:

```ts
export type AutomationRunReason = 'scheduled' | 'manual' | 'startup'
export interface AutomationRunContext { runId: string; reason: AutomationRunReason }
export type AutomationHandler = (params: Record<string, unknown>, ctx: AutomationRunContext) => Promise<unknown>
export type TriggerResult = { runId: string } | { skipped: true }

class AutomationSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(prisma: PrismaService, opts?: { now?: () => number })
  registerHandler(handlerKey: string, handler: AutomationHandler): void
  async start(): Promise<void>          // ensureDefaultJobs + arm timer + startup runs（幂等）
  async tick(nowMs: number): Promise<void>
  async triggerManual(job: AutomationJobRow): Promise<TriggerResult>
}
export const AUTOMATION_DEFAULT_JOBS: readonly DefaultJobSeed[]
```

- [ ] **Step 1: 写失败测试（完整文件）**

测试 harness 与 `model-catalog.controller.sqlite.integration.test.ts` 同款（临时 SQLite + `prisma db push`）。文件：`apps/server/src/automation/automation-scheduler.service.test.ts`

```ts
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationSchedulerService, STARTUP_RUN_DELAY_MS } from './automation-scheduler.service'
import { PrismaService } from '../prisma/prisma.service'

const serverRoot = path.resolve(__dirname, '../..')

function asService(prisma: PrismaClient): PrismaService {
  return prisma as unknown as PrismaService
}

/** 可控时钟：测试直接改 nowMs 变量驱动 tick/due 计算。 */
function makeClock() {
  const state = { nowMs: 1_700_000_000_000 }
  return { state, now: () => state.nowMs }
}

async function makeScheduler(prisma: PrismaClient, clock: ReturnType<typeof makeClock>) {
  return new AutomationSchedulerService(asService(prisma), { now: clock.now })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('AutomationSchedulerService（C5 P0 调度核心）', () => {
  let dir: string
  let prisma: PrismaClient
  let clock: ReturnType<typeof makeClock>

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-automation-sched-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  })

  beforeEach(async () => {
    clock = makeClock()
    await prisma.automationRun.deleteMany()
    await prisma.automationJob.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  async function insertJob(overrides: Partial<{ id: string; handlerKey: string; enabled: boolean; intervalMinutes: number; concurrencyPolicy: string; runOnStartup: boolean }> = {}) {
    return prisma.automationJob.create({
      data: {
        id: overrides.id ?? 'job-test',
        name: '测试 job',
        handlerKey: overrides.handlerKey ?? 'test-handler',
        enabled: overrides.enabled ?? true,
        intervalMinutes: overrides.intervalMinutes ?? 1,
        concurrencyPolicy: overrides.concurrencyPolicy ?? 'forbid',
        runOnStartup: overrides.runOnStartup ?? false,
        params: '{}',
      },
    })
  }

  it('due job 触发 handler，run 落 running→success 且 output 记录返回值', async () => {
    await insertJob()
    const svc = await makeScheduler(prisma, clock)
    const handler = vi.fn(async () => 42)
    svc.registerHandler('test-handler', handler)
    await svc.tick(clock.state.nowMs)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![1].reason).toBe('scheduled')
    const run = await prisma.automationRun.findFirstOrThrow()
    // execute 是 fire-and-forget，等它结算
    await vi.waitFor(async () => {
      const row = await prisma.automationRun.findUniqueOrThrow({ where: { id: run.id } })
      expect(row.status).toBe('success')
    })
    const row = await prisma.automationRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(row.output).toBe('42')
    expect(row.finishedAt).not.toBeNull()
  })

  it('未到 due（最近一条 run 在间隔内）不触发', async () => {
    const job = await insertJob({ intervalMinutes: 1 })
    await prisma.automationRun.create({
      data: { jobId: job.id, reason: 'scheduled', status: 'success', startedAt: new Date(clock.state.nowMs - 30_000) },
    })
    const svc = await makeScheduler(prisma, clock)
    const handler = vi.fn(async () => null)
    svc.registerHandler('test-handler', handler)
    await svc.tick(clock.state.nowMs)
    expect(handler).not.toHaveBeenCalled()
  })

  it('超过 due（最近一条 run 早于间隔）再次触发；skipped 行同样参与 due 口径（D7）', async () => {
    const job = await insertJob({ intervalMinutes: 1 })
    await prisma.automationRun.create({
      data: { jobId: job.id, reason: 'scheduled', status: 'skipped', startedAt: new Date(clock.state.nowMs - 61_000) },
    })
    const svc = await makeScheduler(prisma, clock)
    svc.registerHandler('test-handler', vi.fn(async () => null))
    await svc.tick(clock.state.nowMs)
    const run = await prisma.automationRun.findFirstOrThrow({ where: { status: { not: 'skipped' } } })
    expect(run.reason).toBe('scheduled')
  })

  it('forbid 并发闸：上一轮 running 时第二轮 skipped，handler 不重入（D8 同步占位）', async () => {
    await insertJob()
    const svc = await makeScheduler(prisma, clock)
    const gate = deferred()
    let entered = 0
    svc.registerHandler('test-handler', async () => {
      entered++
      await gate.promise
      return null
    })
    await svc.tick(clock.state.nowMs) // 第一轮：running 卡在 gate
    expect(entered).toBe(1)
    clock.state.nowMs += 61_000
    await svc.tick(clock.state.nowMs) // 第二轮：due 但 forbid
    expect(entered).toBe(1)
    const skipped = await prisma.automationRun.findFirstOrThrow({ where: { status: 'skipped' } })
    expect(skipped.reason).toBe('scheduled')
    gate.resolve()
    await vi.waitFor(async () => {
      const first = await prisma.automationRun.findFirstOrThrow({ where: { status: { not: 'skipped' } } })
      expect(first.status).toBe('success')
    })
  })

  it('handler 抛异常 → failure 行含 error，同 tick 其他 job 照常（失败隔离）', async () => {
    await insertJob({ id: 'job-bad', handlerKey: 'bad' })
    await insertJob({ id: 'job-good', handlerKey: 'good' })
    const svc = await makeScheduler(prisma, clock)
    svc.registerHandler('bad', vi.fn(async () => { throw new Error('boom') }))
    svc.registerHandler('good', vi.fn(async () => 'ok'))
    await svc.tick(clock.state.nowMs)
    await vi.waitFor(async () => {
      const bad = await prisma.automationRun.findFirstOrThrow({ where: { jobId: 'job-bad' } })
      expect(bad.status).toBe('failure')
      expect(bad.error).toContain('boom')
    })
    const good = await prisma.automationRun.findFirstOrThrow({ where: { jobId: 'job-good' } })
    await vi.waitFor(async () => {
      const row = await prisma.automationRun.findUniqueOrThrow({ where: { id: good.id } })
      expect(row.status).toBe('success')
    })
  })

  it('disabled job 不触发', async () => {
    await insertJob({ enabled: false })
    const svc = await makeScheduler(prisma, clock)
    const handler = vi.fn(async () => null)
    svc.registerHandler('test-handler', handler)
    await svc.tick(clock.state.nowMs)
    expect(handler).not.toHaveBeenCalled()
    expect(await prisma.automationRun.count()).toBe(0)
  })

  it('未注册 handler 的 job 触发 → failure 行（no handler）', async () => {
    await insertJob({ handlerKey: 'nobody' })
    const svc = await makeScheduler(prisma, clock)
    await svc.tick(clock.state.nowMs)
    await vi.waitFor(async () => {
      const run = await prisma.automationRun.findFirstOrThrow()
      expect(run.status).toBe('failure')
      expect(run.error).toContain('no handler')
    })
  })

  it('ensureDefaultJobs 只 create-if-missing：不覆盖 admin/手工调过的配置（D5/Review Focus 1）', async () => {
    const svc = await makeScheduler(prisma, clock)
    await svc.start()
    // 模拟运维调参
    await prisma.automationJob.update({ where: { id: 'job-upstream-probe' }, data: { intervalMinutes: 99, enabled: false } })
    // 再次启动（模拟重启）
    const svc2 = await makeScheduler(prisma, clock)
    await svc2.start()
    const job = await prisma.automationJob.findUniqueOrThrow({ where: { id: 'job-upstream-probe' } })
    expect(job.intervalMinutes).toBe(99)
    expect(job.enabled).toBe(false)
  })

  it('重启孤儿 running 行不阻塞新调度（D9/Review Focus 5）', async () => {
    const job = await insertJob({ intervalMinutes: 1 })
    await prisma.automationRun.create({
      data: { jobId: job.id, reason: 'scheduled', status: 'running', startedAt: new Date(clock.state.nowMs - 10 * 60_000) },
    })
    const svc = await makeScheduler(prisma, clock) // 新进程：内存 Map 为空
    svc.registerHandler('test-handler', vi.fn(async () => null))
    await svc.tick(clock.state.nowMs)
    const runs = await prisma.automationRun.findMany({ where: { jobId: job.id } })
    expect(runs).toHaveLength(2) // 孤儿行保留 + 新 run
  })

  it('triggerManual：空闲 → runId + reason=manual；运行中（forbid）→ skipped', async () => {
    const job = await insertJob()
    const svc = await makeScheduler(prisma, clock)
    const gate = deferred()
    svc.registerHandler('test-handler', async () => { await gate.promise; return null })
    const first = await svc.triggerManual(await prisma.automationJob.findUniqueOrThrow({ where: { id: job.id } }))
    expect('runId' in first && first.runId).toBeTruthy()
    const second = await svc.triggerManual(await prisma.automationJob.findUniqueOrThrow({ where: { id: job.id } }))
    expect(second).toEqual({ skipped: true })
    const manualRun = await prisma.automationRun.findFirstOrThrow({ where: { reason: 'manual', status: 'running' } })
    expect(manualRun.jobId).toBe(job.id)
    gate.resolve()
  })

  it('NODE_ENV=test 时 onApplicationBootstrap 不启动 timer（Review Focus 4），trigger 仍可用', async () => {
    const job = await insertJob()
    const svc = await makeScheduler(prisma, clock)
    svc.registerHandler('test-handler', vi.fn(async () => null))
    svc.onApplicationBootstrap()
    expect((svc as unknown as { timer?: unknown }).timer).toBeUndefined()
    const result = await svc.triggerManual(await prisma.automationJob.findUniqueOrThrow({ where: { id: job.id } }))
    expect('runId' in result).toBe(true)
  })

  it('start() 后 startup run 到延迟点派发（runOnStartup=true，reason=startup）', async () => {
    vi.useFakeTimers()
    try {
      await insertJob({ id: 'job-boot', runOnStartup: true })
      const svc = await makeScheduler(prisma, clock)
      const handler = vi.fn(async (_p, ctx) => ctx.reason)
      svc.registerHandler('test-boot', handler)
      await svc.start()
      expect(handler).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(STARTUP_RUN_DELAY_MS + 100)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler.mock.calls[0]![1].reason).toBe('startup')
    } finally {
      vi.useRealTimers()
    }
  })

  it('start() 幂等：重复调用不叠加 timer / 不重复 startup run', async () => {
    vi.useFakeTimers()
    try {
      await insertJob({ id: 'job-boot', runOnStartup: true })
      const svc = await makeScheduler(prisma, clock)
      const handler = vi.fn(async () => null)
      svc.registerHandler('test-boot', handler)
      await svc.start()
      await svc.start()
      await vi.advanceTimersByTimeAsync(STARTUP_RUN_DELAY_MS + 100)
      expect(handler).toHaveBeenCalledTimes(1)
      svc.onModuleDestroy()
    } finally {
      vi.useRealTimers()
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd $SRV && pnpm exec vitest run src/automation/automation-scheduler.service.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `automation-scheduler.service.ts`**

```ts
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

/** 运行触发原因（spec §4.1；'scheduled'→业务服务内部映射为 'periodic'，D4）。 */
export type AutomationRunReason = 'scheduled' | 'manual' | 'startup'
export interface AutomationRunContext { runId: string; reason: AutomationRunReason }
export type AutomationHandler = (params: Record<string, unknown>, ctx: AutomationRunContext) => Promise<unknown>
export type TriggerResult = { runId: string } | { skipped: true }

/** tick 周期：60s。interval 最小粒度 1 分钟 ⇒ tick 粒度足够。 */
const TICK_INTERVAL_MS = 60_000
/** startup run 统一延迟（原 reaper STARTUP_SWEEP_DELAY_MS 同值）。 */
export const STARTUP_RUN_DELAY_MS = 15_000

/** P0 默认 job 种子（create-if-missing，D5）。interval 默认值=迁移前生产行为。 */
export const AUTOMATION_DEFAULT_JOBS = [
  {
    id: 'job-upstream-probe',
    name: '上游模型探活对账',
    description: '对账各上游 /v1/models 与平台目录镜像（原 UpstreamProbeService 内置 interval，默认 6h）',
    handlerKey: 'upstream-probe',
    intervalMinutes: 360,
    runOnStartup: true,
    params: '{}',
  },
  {
    id: 'job-generation-reaper',
    name: '卡死生成记录回收',
    description: '回收超时 generating 记录并退款（原 GenerationReaperService 内置 interval 5min + 15s 启动首扫）',
    handlerKey: 'generation-reaper',
    intervalMinutes: 5,
    runOnStartup: true,
    params: '{}',
  },
] as const

type AutomationJobRow = Awaited<ReturnType<PrismaService['automationJob']['findUniqueOrThrow']>>

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * C5 Automations 统一调度器（spec docs/superpowers/specs/2026-10-11-automations-design.md）。
 *
 * 进程内唯一 timer 持有者（G1）：60s tick 检查到期 job 并派发；job 执行 fire-and-forget，
 * 绝不阻塞 bootstrap。并发权威 = 进程内 running Map（§6-1 单实例约束）。
 * handler 代码级注册（业务服务 onModuleInit 调 registerHandler）；开关/间隔/参数配置级（DB）。
 */
@Injectable()
export class AutomationSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AutomationSchedulerService.name)
  private readonly handlers = new Map<string, AutomationHandler>()
  /** jobId → runId（'pending' 为同步占位，D8）。并发权威。 */
  private readonly running = new Map<string, string>()
  private timer?: ReturnType<typeof setInterval>
  private readonly startupTimers: ReturnType<typeof setTimeout>[] = []
  private readonly nowFn: () => number

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() opts?: { now?: () => number },
  ) {
    this.nowFn = opts?.now ?? (() => Date.now())
  }

  registerHandler(handlerKey: string, handler: AutomationHandler): void {
    this.handlers.set(handlerKey, handler)
  }

  /** Nest 生命周期：测试环境零 timer（§6-3），但 tick/triggerManual 仍可用。 */
  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return
    void this.start().catch((err) => this.logger.error(`[automation] start 失败: ${errMessage(err)}`))
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const t of this.startupTimers) clearTimeout(t)
    this.startupTimers.length = 0
  }

  /**
   * 启动：种子默认 job（create-if-missing）→ 挂 tick timer（unref）→ 派发 startup run。
   * 幂等：重复调用不叠加 timer / 不重复 startup（测试钉住）。
   */
  async start(): Promise<void> {
    await this.ensureDefaultJobs()
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(this.nowFn()), TICK_INTERVAL_MS)
      this.timer.unref?.()
    }
    const jobs = await this.prisma.automationJob.findMany({ where: { enabled: true, runOnStartup: true } })
    for (const job of jobs) {
      const t = setTimeout(() => {
        void this.dispatch(job, 'startup').catch((err) =>
          this.logger.error(`[automation] startup run ${job.id} 派发失败: ${errMessage(err)}`),
        )
      }, STARTUP_RUN_DELAY_MS)
      t.unref?.()
      this.startupTimers.push(t)
    }
    if (jobs.length > 0) {
      this.logger.log(`[automation] 已排定 ${jobs.length} 个 startup run（延迟 ${STARTUP_RUN_DELAY_MS}ms）`)
    }
  }

  /** 种子：只 create-if-missing（upsert update 空），绝不覆盖运维调过的配置（D5）。 */
  private async ensureDefaultJobs(): Promise<void> {
    for (const seed of AUTOMATION_DEFAULT_JOBS) {
      await this.prisma.automationJob.upsert({
        where: { id: seed.id },
        create: {
          id: seed.id,
          name: seed.name,
          description: seed.description,
          handlerKey: seed.handlerKey,
          enabled: true,
          scheduleType: 'interval',
          intervalMinutes: seed.intervalMinutes,
          params: seed.params,
          concurrencyPolicy: 'forbid',
          runOnStartup: seed.runOnStartup,
        },
        update: {},
      })
    }
  }

  /** tick：查 enabled interval job → due 判定（D7）→ 派发。单 job 异常不拖垮其余。 */
  async tick(nowMs: number): Promise<void> {
    let jobs
    try {
      jobs = await this.prisma.automationJob.findMany({ where: { enabled: true, scheduleType: 'interval' } })
    } catch (err) {
      this.logger.error(`[automation] tick 查询 job 失败: ${errMessage(err)}`)
      return
    }
    for (const job of jobs) {
      try {
        if (!(await this.isDue(job, nowMs))) continue
        await this.dispatch(job, 'scheduled')
      } catch (err) {
        this.logger.error(`[automation] job ${job.id} 派发异常: ${errMessage(err)}`)
      }
    }
  }

  /** due 判据（D7）：最近一条 run（任意 status）的 startedAt + 间隔 ≤ now；无 run ⇒ due。 */
  private async isDue(job: AutomationJobRow, nowMs: number): Promise<boolean> {
    const last = await this.prisma.automationRun.findFirst({
      where: { jobId: job.id },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    })
    if (!last) return true
    const intervalMs = Math.max(1, job.intervalMinutes) * 60_000
    return nowMs >= last.startedAt.getTime() + intervalMs
  }

  /**
   * 手动触发（admin）：与定时触发共用并发闸与 run 记录，reason='manual'。
   * 入参传完整 job 行（controller 已校验存在且 enabled）。
   */
  async triggerManual(job: AutomationJobRow): Promise<TriggerResult> {
    return this.dispatch(job, 'manual')
  }

  /**
   * 派发：forbid/replace 且已有在跑 → skipped 行（D6）；否则同步占位（D8）→
   * 建 running 行 → fire-and-forget 执行。
   */
  private async dispatch(job: AutomationJobRow, reason: AutomationRunReason): Promise<TriggerResult> {
    if (this.running.has(job.id) && job.concurrencyPolicy !== 'allow') {
      await this.prisma.automationRun.create({
        data: { jobId: job.id, reason, status: 'skipped', startedAt: new Date(this.nowFn()), finishedAt: new Date(this.nowFn()) },
      })
      this.logger.warn(`[automation] job ${job.id}（${reason}）上一轮仍在跑，本轮 skipped`)
      return { skipped: true }
    }
    this.running.set(job.id, 'pending')
    let runId: string
    try {
      const run = await this.prisma.automationRun.create({
        data: { jobId: job.id, reason, status: 'running', startedAt: new Date(this.nowFn()) },
      })
      runId = run.id
      this.running.set(job.id, runId)
    } catch (err) {
      this.running.delete(job.id)
      throw err
    }
    void this.execute(job, runId, reason)
    return { runId }
  }

  /** 执行 + 终态回写。handler 缺失/抛异常都折叠为 failure 行；落库失败只记日志（失败隔离）。 */
  private async execute(job: AutomationJobRow, runId: string, reason: AutomationRunReason): Promise<void> {
    let status: 'success' | 'failure' = 'success'
    let output: string | null = null
    let error: string | null = null
    try {
      const handler = this.handlers.get(job.handlerKey)
      if (!handler) throw new Error(`no handler registered for '${job.handlerKey}'`)
      let params: Record<string, unknown> = {}
      if (job.params) {
        try {
          const parsed = JSON.parse(job.params) as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) params = parsed as Record<string, unknown>
        } catch { params = {} }
      }
      const result = await handler(params, { runId, reason })
      output = result === undefined ? null : JSON.stringify(result)
    } catch (err) {
      status = 'failure'
      error = errMessage(err)
      this.logger.error(`[automation] job ${job.id}（${reason}）执行失败: ${error}`)
    }
    try {
      await this.prisma.automationRun.update({
        where: { id: runId },
        data: { status, finishedAt: new Date(this.nowFn()), output, error },
      })
    } catch (err) {
      this.logger.error(`[automation] run ${runId} 终态回写失败: ${errMessage(err)}`)
    }
    if (this.running.get(job.id) === runId) this.running.delete(job.id)
  }
}
```

注意 `AutomationJobRow` 类型取自 PrismaService 推导（`AutomationJob` 表此时已由 Task 1 generate 进 client）。

- [ ] **Step 4: 跑测试确认全绿**

```bash
cd $SRV && pnpm exec vitest run src/automation/automation-scheduler.service.test.ts
```

Expected: 12/12 PASS。

- [ ] **Step 5: 类型检查 + Commit**

```bash
cd $WT && pnpm exec tsc --noEmit -p apps/server
git -C $WT add apps/server/src/automation
git -C $WT commit -m "feat(c5-p0): AutomationSchedulerService 调度核心（tick/forbid/manual/startup/种子）"
```

---

### Task 3: admin 三端点 + 集成测试

**Files:**
- Create: `apps/server/src/admin/automation-admin.controller.ts`
- Create: `apps/server/src/admin/automation-admin.sqlite.integration.test.ts`
- Modify: `apps/server/src/admin/admin.module.ts`

**Interfaces:**
- Consumes: Task 2 的 `AutomationSchedulerService.triggerManual(job)` / Task 1 的两表
- Produces: `GET /admin/automations`（job+lastRun）、`GET /admin/automations/:id/runs`（分页）、`POST /admin/automations/:id/trigger`

- [ ] **Step 1: 写失败测试**（harness 同 Task 2；直接实例化 controller + scheduler，guard 有独立单测文件覆盖）

`apps/server/src/admin/automation-admin.sqlite.integration.test.ts` 关键用例：

```ts
// 结构同 Task 2 harness（mkdtemp + db push + PrismaClient）
// controller 构造：new AutomationAdminController(asService(prisma), scheduler)

it('list：返回 job + lastRun 摘要，响应形状 {code,message,data}', async () => {
  await seedDefaultJobs(svc)                       // svc.start() 或直接插入 job 行
  await prisma.automationRun.create({ data: { jobId: 'job-test', reason: 'manual', status: 'failure', startedAt: past(), error: 'x' } })
  const res = await controller.list()
  expect(res.code).toBe(0)
  const job = res.data.jobs.find((j: { id: string }) => j.id === 'job-test')
  expect(job.lastRun.status).toBe('failure')
  expect(job.lastRun.error).toBe('x')
})

it('runs：按 startedAt 倒序分页；page/pageSize 边界（默认 1/20，上限 100）', async () => {
  // 插 25 条 run → page=1 取 20 条、page=2 取 5 条；pageSize=500 → 钳到 100
})

it('runs：未知 job → 404 NotFoundException', async () => {
  await expect(controller.runs('job-nope')).rejects.toBeInstanceOf(NotFoundException)
})

it('trigger：空闲 → {runId}；运行中（forbid）→ {skipped:true}；disabled/未知 → 404', async () => {
  // handler 用 deferred 卡住第一轮，再 trigger 验证 skipped；disabled job trigger 抛 NotFoundException
})
```

- [ ] **Step 2: 跑测试确认失败**（controller 不存在）

- [ ] **Step 3: 实现 controller**

```ts
import { Controller, Get, Inject, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { AdminTokenGuard } from './admin-token.guard'
import { AutomationSchedulerService, type AutomationJobRow } from '../automation/automation-scheduler.service'

function parseParams(raw: string | null | undefined): unknown {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

/** C5 P0 admin 端点（spec §4.4 的只读 + trigger 子集；PATCH 改配置属 P1）。 */
@Controller('admin/automations')
export class AutomationAdminController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AutomationSchedulerService) private readonly scheduler: AutomationSchedulerService,
  ) {}

  @Get()
  @UseGuards(AdminTokenGuard)
  async list() {
    const jobs = await this.prisma.automationJob.findMany({ orderBy: { id: 'asc' } })
    const data = await Promise.all(
      jobs.map(async (job) => {
        const lastRun = await this.prisma.automationRun.findFirst({
          where: { jobId: job.id },
          orderBy: { startedAt: 'desc' },
        })
        return {
          id: job.id, name: job.name, description: job.description, handlerKey: job.handlerKey,
          enabled: job.enabled, scheduleType: job.scheduleType, intervalMinutes: job.intervalMinutes,
          params: parseParams(job.params), concurrencyPolicy: job.concurrencyPolicy,
          runOnStartup: job.runOnStartup, updatedAt: job.updatedAt,
          lastRun: lastRun && {
            id: lastRun.id, reason: lastRun.reason, status: lastRun.status,
            startedAt: lastRun.startedAt, finishedAt: lastRun.finishedAt, error: lastRun.error,
          },
        }
      }),
    )
    return { code: 0, message: 'ok', data: { jobs: data } }
  }

  @Get(':id/runs')
  @UseGuards(AdminTokenGuard)
  async runs(@Param('id') id: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    const job = await this.prisma.automationJob.findUnique({ where: { id } })
    if (!job) throw new NotFoundException('automation job not found')
    const p = Math.max(1, Number(page) || 1)
    const size = Math.min(100, Math.max(1, Number(pageSize) || 20))
    const [total, runs] = await this.prisma.$transaction([
      this.prisma.automationRun.count({ where: { jobId: id } }),
      this.prisma.automationRun.findMany({
        where: { jobId: id },
        orderBy: { startedAt: 'desc' },
        skip: (p - 1) * size,
        take: size,
      }),
    ])
    return {
      code: 0, message: 'ok',
      data: {
        total, page: p, pageSize: size,
        runs: runs.map((r) => ({ id: r.id, reason: r.reason, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, output: parseParams(r.output), error: r.error })),
      },
    }
  }

  @Post(':id/trigger')
  @UseGuards(AdminTokenGuard)
  async trigger(@Param('id') id: string) {
    const job = await this.prisma.automationJob.findUnique({ where: { id } })
    if (!job || !job.enabled) throw new NotFoundException('automation job not found or disabled')
    const result = await this.scheduler.triggerManual(job as AutomationJobRow)
    return { code: 0, message: 'ok', data: result }
  }
}
```

`admin.module.ts`：`imports: [AutomationModule]`、controllers 数组加 `AutomationAdminController`。

- [ ] **Step 4: 跑测试确认全绿 + 类型检查**

```bash
cd $SRV && pnpm exec vitest run src/admin/automation-admin.sqlite.integration.test.ts
cd $WT && pnpm exec tsc --noEmit -p apps/server
```

- [ ] **Step 5: Commit**

```bash
git -C $WT add apps/server/src/admin apps/server/src/automation/automation.module.ts
git -C $WT commit -m "feat(c5-p0): admin automations 三端点（list/runs/trigger）"
```

---

### Task 4: 服务迁移接线（probe/reaper 去 timer + handler 注册 + 模块装配）

**Files:**
- Modify: `apps/server/src/provider/upstream-probe.service.ts`
- Modify: `apps/server/src/provider/provider.module.ts`
- Modify: `apps/server/src/studio/generation-reaper.service.ts`
- Modify: `apps/server/src/studio/studio.module.ts`
- Modify: `apps/server/src/app.module.ts`

**Interfaces:**
- Consumes: Task 2 的 `AutomationSchedulerService.registerHandler`
- Produces: handlerKey `'upstream-probe'` / `'generation-reaper'`；`UpstreamProbeService.probeOnceWhenRoutesReady()`（public 化，原私有 `startupProbeWhenRoutesReady` 逻辑原样）

- [ ] **Step 1: 改 `upstream-probe.service.ts`**

1. import 调整：加 `AutomationSchedulerService`（`../automation/automation-scheduler.service`）；`OnModuleDestroy` 从 import 与 implements 中移除。
2. 构造函数追加可选注入（既有测试用 Nest TestingModule/mock，不提供 scheduler 也能构造——**已实证 probe 测试零 timer 断言**）：

```ts
@Optional() @Inject(AutomationSchedulerService) private readonly scheduler?: AutomationSchedulerService,
```

3. `onModuleInit` 整体替换（原 interval/env/startup 逻辑全部移除）：

```ts
onModuleInit(): void {
  // C5：定时职责移交 AutomationSchedulerService（spec 2026-10-11-automations-design，
  // 计划裁决 D2/D3/D4）。本方法只注册 handler；单测直接构造时无 scheduler，跳过。
  if (!this.scheduler) return
  this.scheduler.registerHandler('upstream-probe', async (_params, ctx) => {
    if (ctx.reason === 'startup') {
      // B3 语义原样保留：等路由表 bootstrap 落定（带超时上限）再跑启动首轮。
      await this.probeOnceWhenRoutesReady()
      return
    }
    await this.probeOnce(ctx.reason === 'scheduled' ? 'periodic' : ctx.reason)
  })
}
```

4. 私有 `startupProbeWhenRoutesReady` 改名 public `probeOnceWhenRoutesReady`（方法体不动，JSDoc 注明「由 automation handler 在 reason='startup' 时调用」）。
5. `onModuleDestroy` 方法与 `timer` 字段删除；类头 JSDoc 补一行「C5：调度移交 AutomationSchedulerService，本服务不再持有 timer」。
6. `DEFAULT_PROBE_INTERVAL_MINUTES` / `resolveProbeIntervalMinutes` 保留导出，JSDoc 加 `@deprecated C5 P0 起间隔由 AutomationJob.intervalMinutes 配置（D3），本函数仅为兼容保留`。

- [ ] **Step 2: 改 `generation-reaper.service.ts`**

1. import：加 `Optional`、`AutomationSchedulerService`；`OnModuleDestroy` 移除。
2. 构造函数追加 `@Optional() @Inject(AutomationSchedulerService) private readonly scheduler?: AutomationSchedulerService`。
3. `onModuleInit` 替换为 handler 注册；`onModuleDestroy`/`startupTimer`/`timer` 字段删除：

```ts
onModuleInit(): void {
  // C5：15s 启动首扫 + 5min 巡检移交 AutomationSchedulerService（runOnStartup + interval=5，
  // 见 AUTOMATION_DEFAULT_JOBS；D2/D4）。reason 映射：scheduled→periodic。
  if (!this.scheduler) return
  this.scheduler.registerHandler('generation-reaper', async (_params, ctx) => {
    return this.reapOnce(ctx.reason === 'scheduled' ? 'periodic' : ctx.reason)
  })
}
```

`reapOnce` 返回 `number`（成功收尾条数）→ 自动成为 AutomationRun.output（JSON `"3"` 形态）。类头 JSDoc 补 C5 说明。

- [ ] **Step 3: 模块装配（四处）**

- `provider.module.ts`：imports 加 `AutomationModule`；`UpstreamProbeService` 注释改为「C5 起定时职责在 AutomationSchedulerService，此处仅注册 handler」。
- `studio.module.ts`：imports 加 `AutomationModule`。
- 新建 `apps/server/src/automation/automation.module.ts`：

```ts
import { Module } from '@nestjs/common'
import { AutomationSchedulerService } from './automation-scheduler.service'

/** C5 Automations：调度器单例。handler 由业务模块（Provider/Studio）在各自 onModuleInit 注册。 */
@Module({
  providers: [AutomationSchedulerService],
  exports: [AutomationSchedulerService],
})
export class AutomationModule {}
```

- `admin.module.ts` 已在 Task 3 import AutomationModule；`app.module.ts` imports 数组加 `AutomationModule`（放在 ProviderModule 之后、AdminModule 之前）。

依赖方向核查（无环）：Provider→Automation、Studio→{Provider, Automation}、Admin→Automation、Automation→Prisma(global)。

- [ ] **Step 4: 全量回归 + 类型检查**

```bash
cd $SRV && pnpm exec vitest run
cd $WT && pnpm exec tsc --noEmit -p apps/server
```

Expected: 既有 probe/reaper 测试全绿（构造不受可选参数影响）；无回归。

- [ ] **Step 5: Commit**

```bash
git -C $WT add apps/server/src
git -C $WT commit -m "feat(c5-p0): probe/reaper 迁入统一调度器（去 timer + handler 注册 + 模块装配）"
```

---

### Task 5: 收口（G1 断言 + spec 回写 + PR）

- [ ] **Step 1: G1 机检断言——业务级 timer 清零**

```bash
cd $WT && git grep -nE "setInterval|setTimeout" -- apps/server/src | grep -v "automation-scheduler.service" | grep -v "\.test\.ts"
```

Expected 精确命中清单（每处都必须是已注释说明的例外）：
1. `upstream-probe.service.ts` 的 `probeOnceWhenRoutesReady` 内 `Promise.race` 超时 setTimeout（B3 等待上限，非调度 timer）；
2. 其余文件**零命中**（provider.module/studio.module 的旧注释一并改掉）。

若出现清单外命中 ⇒ 违反 G1，回到 Task 4 修。

- [ ] **Step 2: spec 回写 v1.1.0**（`docs/superpowers/specs/2026-10-11-automations-design.md`）

- §4.1 schema 表补 `runOnStartup` 列（裁决 D1）；
- §3.1 表与 §5 P0 记录 D2（startup 首扫归属 scheduler）；
- §6 追加 D3（env 退役）；
- 版本号 → v1.1.0，状态 → P0 已实现。

- [ ] **Step 3: 总体设计状态列同步**（`docs/superpowers/specs/2026-10-09-task-management-module-design.md` §3：C5 → P0 已上线/待部署验证）

- [ ] **Step 4: 全量回归最后一遍 + verify-claims**

```bash
cd $SRV && pnpm exec vitest run
cd $WT && pnpm verify-claims
```

- [ ] **Step 5: Commit + push + PR**

```bash
git -C $WT add docs
git -C $WT commit -m "docs(c5-p0): spec v1.1.0 裁决回写 + 总体设计状态列"
git -C $WT push -c http.proxy=socks5h://127.0.0.1:18081 -c http.version=HTTP/1.1 origin feat/automations-p0
gh pr create --repo sev7n4/pi-lnk --base master --head feat/automations-p0 \
  --title "feat(c5-p0): Automations 统一调度器 P0——probe/reaper 迁入 + admin 三端点" \
  --body "spec: docs/superpowers/specs/2026-10-11-automations-design.md；计划: docs/superpowers/plans/2026-10-11-automations-p0.md"
```

（push 若 SOCKS 隧道已断：`ssh -f -N -D 127.0.0.1:18081 -i ~/.ssh/tencent_cloud_deploy root@119.29.173.89` 重启后重试。）

- [ ] **Step 6: 部署与生产取证（合并后）**

- api 镜像随 deploy.yml 自动部署（apps/server 变更触发）；生产取证：`/api/health` version、`AutomationJob` 两行种子、`GET /admin/automations`（带 admin token）返回 lastRun、手动 trigger 一次 reaper 验证 run 行 success。
