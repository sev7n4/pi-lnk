import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildHealthSql,
  flagHealthAnomalies,
  rowsToHealth,
  type RawHealthRow,
} from '@lnkpi/shared/modelHealth'
import type { PrismaService } from '../prisma/prisma.service'

const serverRoot = path.resolve(__dirname, '../..')

/**
 * A1/A4 集成测试（内存/临时 SQLite 真实表结构）：GenerationRecord 生产形态 fixture，
 * 三种 metadata 形态（成功 / 失败含 errorCode+userMessage+退款 / BYOK originalModel），
 * 全部合成数据（userId 脱敏为 u-health-redacted），无任何真实用户信息。
 */

const HEALTH_USER = 'u-health-redacted'

/** 失败行 metadata（生产形态拷贝，503 model_not_found 事故文案，B0 取证同构）。 */
const FAILED_META_MODEL_UNAVAILABLE = JSON.stringify({
  errorCode: 'model_unavailable',
  userMessage: 'Text API 503: {"error":{"code":"model_not_found"},"message":"No available channel"}',
  chargedPoints: 20,
  refundedPoints: 20,
  refundReason: 'platform_failed',
})

/** 402 余额不足失败行（S0-2 已知线上实例文案）。 */
const FAILED_META_402 = JSON.stringify({
  errorCode: 'upstream_error',
  userMessage: 'Image edit API 402: insufficient balance (current: 0.013570 USD, required: 0.050000 USD)',
  chargedPoints: 20,
  refundedPoints: 20,
  refundReason: 'platform_failed',
})

/** 成功行 metadata。 */
const COMPLETED_META = JSON.stringify({ chargedPoints: 20, text: 'ok' })

/** BYOK fallback_pending 行 metadata（originalModel 带 userId 前缀，生产形态）。 */
const BYOK_PENDING_META = JSON.stringify({
  originalModel: 'cmrrxageh::deepseek-v4-pro',
  errorCode: 'upstream_error',
  userMessage: 'fetch failed',
  chargedPoints: 0,
})

describe('model-health aggregation against real SQLite GenerationRecord（A1/A4）', () => {
  let dir: string
  let prisma: PrismaClient

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-health-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    await prisma.user.create({ data: { id: HEALTH_USER, phone: '17200009999', nickname: 'health-fixture' } })
    await seedRecords()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  async function seedRecords() {
    const now = Date.now()
    const create = (data: Parameters<typeof prisma.generationRecord.create>[0]['data']) =>
      prisma.generationRecord.create({ data })
    // 平台 deepseek-v4：6 连败（A3 同构 → R2 ghost_suspect + R1 degraded）
    for (let i = 0; i < 6; i++) {
      await create({
        userId: HEALTH_USER,
        type: 'text',
        prompt: 'prompt-redacted',
        model: 'deepseek-v4',
        status: 'failed',
        metadata: FAILED_META_MODEL_UNAVAILABLE,
        createdAt: new Date(now - 10 * 60_000),
      })
    }
    // 平台 agnes-image-2.0-flash：1 成功 + 1 次 402 欠费失败（R3 upstream_balance）
    await create({
      userId: HEALTH_USER,
      type: 'image',
      prompt: 'prompt-redacted',
      model: 'agnes-image-2.0-flash',
      status: 'completed',
      metadata: COMPLETED_META,
      createdAt: new Date(now - 20 * 60_000),
    })
    await create({
      userId: HEALTH_USER,
      type: 'image',
      prompt: 'prompt-redacted',
      model: 'agnes-image-2.0-flash',
      status: 'failed',
      metadata: FAILED_META_402,
      createdAt: new Date(now - 20 * 60_000),
    })
    // BYOK 前缀模型：1 成功 + 1 fallback_pending（channelId=userId 前缀段，A1）
    await create({
      userId: HEALTH_USER,
      type: 'text',
      prompt: 'prompt-redacted',
      model: 'cmrrxageh::deepseek-v4-pro',
      status: 'completed',
      metadata: COMPLETED_META,
      createdAt: new Date(now - 30 * 60_000),
    })
    await create({
      userId: HEALTH_USER,
      type: 'text',
      prompt: 'prompt-redacted',
      model: 'cmrrxageh::deepseek-v4-pro',
      status: 'fallback_pending',
      metadata: BYOK_PENDING_META,
      createdAt: new Date(now - 30 * 60_000),
    })
    // 窗口外老记录（2h 前）：windowHours=1 必须排除（整数毫秒比较）
    await create({
      userId: HEALTH_USER,
      type: 'text',
      prompt: 'prompt-redacted',
      model: 'old-model',
      status: 'failed',
      metadata: FAILED_META_MODEL_UNAVAILABLE,
      createdAt: new Date(now - 2 * 3_600_000),
    })
  }

  async function queryHealth(windowHours: number) {
    const { sql, params } = buildHealthSql(windowHours)
    const rawRows = (await prisma.$queryRawUnsafe(sql, ...params)) as RawHealthRow[]
    const rows = rowsToHealth(rawRows, windowHours)
    return { rawRows, rows, alerts: flagHealthAnomalies(rows) }
  }

  it('A1：BYOK 前缀剥前缀分行，不与平台同名族合并；fallback_pending 计数', async () => {
    const { rows } = await queryHealth(1)
    const byok = rows.find((r) => r.model === 'deepseek-v4-pro')!
    expect(byok).toMatchObject({
      channelId: 'cmrrxageh',
      total: 2,
      completed: 1,
      fallbackPending: 1,
      refunded: 0,
    })
    // 平台 deepseek-v4 行保持 6 条，未被 BYOK 行并入
    const platform = rows.find((r) => r.model === 'deepseek-v4' && r.channelId === 'platform')!
    expect(platform.total).toBe(6)
  })

  it('A4：JSON 双引号坑回归 —— metadata errorCode 经 REPLACE SQL 正确计数 + 退款计数', async () => {
    const { rows, alerts } = await queryHealth(1)
    const deepseek = rows.find((r) => r.model === 'deepseek-v4')!
    // userMessage 内嵌双引号 JSON 的失败行被正确归类 model_unavailable（REPLACE 写法生效）
    expect(deepseek.errorCodeCounts).toEqual({ model_unavailable: 6 })
    expect(deepseek).toMatchObject({ failed: 6, refunded: 6, successRate: 0 })
    // 402 文案族（含 "402" + "insufficient balance"）在 SQL LIKE 层命中
    const agnes = rows.find((r) => r.model === 'agnes-image-2.0-flash')!
    expect(agnes).toMatchObject({ total: 2, completed: 1, failed: 1, balance402Count: 1, refunded: 1 })
    expect(alerts.map((a) => `${a.rule}:${a.model}:${a.channelId}`).sort()).toEqual(
      [
        'degraded:deepseek-v4:platform',
        'ghost_suspect:deepseek-v4:platform',
        'upstream_balance:agnes-image-2.0-flash:platform',
      ].sort(),
    )
  })

  it('时间窗口：windowHours=1 排除 2h 前老记录（整数毫秒比较，非 strftime）', async () => {
    const inWindow = await queryHealth(1)
    expect(inWindow.rows.some((r) => r.model === 'old-model')).toBe(false)
    // 放宽到 6h 窗口后老记录出现
    const wide = await queryHealth(6)
    const oldRow = wide.rows.find((r) => r.model === 'old-model')!
    expect(oldRow).toMatchObject({ channelId: 'platform', total: 1, failed: 1 })
  })

  it('bigInt 计数兼容：Prisma 聚合返回 bigint，rowsToHealth 归一为 number', async () => {
    const { rawRows } = await queryHealth(1)
    const deepseekRaw = rawRows.find((r) => r.model === 'deepseek-v4' && r.status === 'failed')!
    expect(typeof deepseekRaw.cnt).toBe('bigint')
  })
})
