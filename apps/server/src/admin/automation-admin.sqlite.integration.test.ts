import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NotFoundException } from '@nestjs/common'
import { AutomationAdminController } from './automation-admin.controller'
import { AutomationSchedulerService } from '../automation/automation-scheduler.service'
import { PrismaService } from '../prisma/prisma.service'

/**
 * C5 P0 admin 三端点集成测试（临时 SQLite + prisma db push，model-catalog 同款 harness）：
 * - list：job + lastRun 摘要，响应形状 { code, message, data }；
 * - runs：startedAt 倒序分页，page/pageSize 边界钳制（默认 1/20，上限 100）；
 * - trigger：空闲 → { runId }；运行中（forbid）→ { skipped: true }；disabled/未知 → 404。
 */

const serverRoot = path.resolve(__dirname, '../..')

function asService(prisma: PrismaClient): PrismaService {
  return prisma as unknown as PrismaService
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('AutomationAdminController（C5 P0 admin 三端点）', () => {
  let dir: string
  let prisma: PrismaClient
  let scheduler: AutomationSchedulerService
  let controller: AutomationAdminController

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-automation-admin-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    scheduler = new AutomationSchedulerService(asService(prisma))
    controller = new AutomationAdminController(asService(prisma), scheduler)
  }, 120_000)

  beforeEach(async () => {
    await prisma.automationRun.deleteMany()
    await prisma.automationJob.deleteMany()
  })

  afterAll(async () => {
    scheduler.onModuleDestroy()
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
        runOnStartup: false,
        params: '{}',
      },
    })
  }

  it('list：返回 job + lastRun 摘要，响应形状 { code, message, data }', async () => {
    await insertJob()
    await prisma.automationRun.create({
      data: { jobId: 'job-test', reason: 'manual', status: 'failure', startedAt: new Date(Date.now() - 60_000), error: 'x' },
    })
    const res = await controller.list()
    expect(res.code).toBe(0)
    expect(res.message).toBe('ok')
    const job = res.data.jobs.find((j: { id: string }) => j.id === 'job-test')
    expect(job).toBeTruthy()
    expect(job.lastRun.status).toBe('failure')
    expect(job.lastRun.error).toBe('x')
    expect(job.lastRun.reason).toBe('manual')
  })

  it('list：无 run 的 job lastRun=null；params JSON 透出', async () => {
    await prisma.automationJob.create({
      data: { id: 'job-plain', name: 'n', handlerKey: 'h', intervalMinutes: 2, params: '{"k":1}' },
    })
    const res = await controller.list()
    const job = res.data.jobs.find((j: { id: string }) => j.id === 'job-plain')
    expect(job.lastRun).toBeNull()
    expect(job.params).toEqual({ k: 1 })
  })

  it('runs：按 startedAt 倒序分页；page=2 取余量', async () => {
    await insertJob({ id: 'job-runs' })
    for (let i = 0; i < 25; i++) {
      await prisma.automationRun.create({
        data: { jobId: 'job-runs', reason: 'scheduled', status: 'success', startedAt: new Date(Date.now() - (100 - i) * 1000) },
      })
    }
    const page1 = await controller.runs('job-runs')
    expect(page1.data.total).toBe(25)
    expect(page1.data.page).toBe(1)
    expect(page1.data.pageSize).toBe(20)
    expect(page1.data.runs).toHaveLength(20)
    // 倒序：第一条是最晚的
    const times = page1.data.runs.map((r: { startedAt: Date }) => new Date(r.startedAt).getTime())
    expect([...times].sort((a, b) => b - a)).toEqual(times)

    const page2 = await controller.runs('job-runs', '2')
    expect(page2.data.runs).toHaveLength(5)
  })

  it('runs：pageSize=500 钳到 100；page=0 视为 1；非法值回落默认', async () => {
    await insertJob({ id: 'job-runs2' })
    for (let i = 0; i < 3; i++) {
      await prisma.automationRun.create({
        data: { jobId: 'job-runs2', reason: 'scheduled', status: 'success', startedAt: new Date(Date.now() - i * 1000) },
      })
    }
    const clamped = await controller.runs('job-runs2', '1', '500')
    expect(clamped.data.pageSize).toBe(100)
    const pageZero = await controller.runs('job-runs2', '0')
    expect(pageZero.data.page).toBe(1)
    const garbage = await controller.runs('job-runs2', 'abc', 'abc')
    expect(garbage.data.page).toBe(1)
    expect(garbage.data.pageSize).toBe(20)
  })

  it('runs：未知 job → 404 NotFoundException', async () => {
    await expect(controller.runs('job-nope')).rejects.toBeInstanceOf(NotFoundException)
  })

  it('trigger：空闲 → { runId }；运行中（forbid）→ { skipped: true }', async () => {
    await insertJob()
    const gate = deferred()
    scheduler.registerHandler(
      'test-handler',
      async () => {
        await gate.promise
        return null
      },
    )
    const first = await controller.trigger('job-test')
    expect(first.code).toBe(0)
    expect('runId' in first.data).toBe(true)
    const second = await controller.trigger('job-test')
    expect(second.data).toEqual({ skipped: true })
    gate.resolve()
  })

  it('trigger：未知 job → 404；disabled job → 404', async () => {
    await expect(controller.trigger('job-nope')).rejects.toBeInstanceOf(NotFoundException)
    await insertJob({ id: 'job-off', enabled: false })
    await expect(controller.trigger('job-off')).rejects.toBeInstanceOf(NotFoundException)
  })
})
