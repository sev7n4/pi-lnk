import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationSchedulerService } from './automation-scheduler.service'
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

async function makeScheduler(
  prisma: PrismaClient,
  clock: ReturnType<typeof makeClock>,
  opts?: { startupDelayMs?: number },
) {
  return new AutomationSchedulerService(asService(prisma), { now: clock.now, ...opts })
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
  }, 120_000)

  beforeEach(async () => {
    clock = makeClock()
    await prisma.automationRun.deleteMany()
    await prisma.automationJob.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  async function insertJob(
    overrides: Partial<{
      id: string
      handlerKey: string
      enabled: boolean
      intervalMinutes: number
      concurrencyPolicy: string
      runOnStartup: boolean
    }> = {},
  ) {
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
    svc.registerHandler(
      'bad',
      vi.fn(async () => {
        throw new Error('boom')
      }),
    )
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
    await prisma.automationJob.update({
      where: { id: 'job-upstream-probe' },
      data: { intervalMinutes: 99, enabled: false },
    })
    // 再次启动（模拟重启）
    const svc2 = await makeScheduler(prisma, clock)
    await svc2.start()
    const job = await prisma.automationJob.findUniqueOrThrow({ where: { id: 'job-upstream-probe' } })
    expect(job.intervalMinutes).toBe(99)
    expect(job.enabled).toBe(false)
    svc2.onModuleDestroy()
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
    svc.registerHandler('test-handler', async () => {
      await gate.promise
      return null
    })
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
    // 真实时钟 + 短延迟：fake timers 会冻结 Prisma 引擎内部 timer，run 行永远建不出来
    await insertJob({ id: 'job-boot', handlerKey: 'test-boot', runOnStartup: true })
    const svc = await makeScheduler(prisma, clock, { startupDelayMs: 50 })
    const handler = vi.fn(async (_p, ctx) => ctx.reason)
    svc.registerHandler('test-boot', handler)
    await svc.start()
    expect(handler).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    expect(handler.mock.calls[0]![1].reason).toBe('startup')
    svc.onModuleDestroy()
  })

  it('start() 幂等：重复调用不叠加 timer / 不重复 startup run', async () => {
    await insertJob({ id: 'job-boot', handlerKey: 'test-boot', runOnStartup: true })
    const svc = await makeScheduler(prisma, clock, { startupDelayMs: 50 })
    const handler = vi.fn(async () => null)
    svc.registerHandler('test-boot', handler)
    await svc.start()
    await svc.start()
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    // 再给第二个（不存在的）startup timer 留足窗口，确认没有重复派发
    await new Promise((r) => setTimeout(r, 100))
    expect(handler).toHaveBeenCalledTimes(1)
    svc.onModuleDestroy()
  })
})
