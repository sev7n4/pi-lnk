import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AuditLogsAdminController } from './audit-logs.controller'

// B1/S2-1a 同款 harness：临时 SQLite + prisma db push。
const serverRoot = path.resolve(__dirname, '../..')

describe('AuditLogsAdminController（Ops Console §5.1）', () => {
  let dir: string
  let prisma: PrismaClient
  let controller: AuditLogsAdminController

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-audit-admin-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    controller = new AuditLogsAdminController(prisma as never)
  }, 60_000) // 本机高负载时 pnpm exec 启动可达 30s+，默认 10s hook 超时不够

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await prisma.adminAuditLog.deleteMany()
  })

  // 顺序播种（createdAt 由 DB 默认 now()，逐条插入天然递增）
  async function seedRows() {
    await prisma.adminAuditLog.create({
      data: { actor: 'admin', action: 'model-catalog.create', resource: 'model-catalog:a', after: '{}' },
    })
    await prisma.adminAuditLog.create({
      data: { actor: 'admin', action: 'upstream-routes.update', resource: 'upstream-routes:r1', before: '{}', after: '{}' },
    })
    await prisma.adminAuditLog.create({
      data: { actor: 'admin', action: 'platform-channel.pricing.set', resource: 'platform-channel:m1', after: '{"inputPerM":1}' },
    })
  }

  it('默认 createdAt 倒序分页，返回 rows/total/page/pageSize', async () => {
    await seedRows()
    const res = await controller.list({})
    expect(res.code).toBe(0)
    expect(res.data.total).toBe(3)
    expect(res.data.page).toBe(1)
    expect(res.data.pageSize).toBe(20)
    expect(res.data.rows.map((r) => r.action)).toEqual([
      'platform-channel.pricing.set',
      'upstream-routes.update',
      'model-catalog.create',
    ])
  })

  it('action / resource 精确过滤', async () => {
    await seedRows()
    const byAction = await controller.list({ action: 'upstream-routes.update' })
    expect(byAction.data.total).toBe(1)
    expect(byAction.data.rows[0]!.resource).toBe('upstream-routes:r1')

    const byResource = await controller.list({ resource: 'model-catalog:a' })
    expect(byResource.data.total).toBe(1)

    const none = await controller.list({ action: 'nope' })
    expect(none.data.rows).toEqual([])
    expect(none.data.total).toBe(0)
  })

  it('分页 skip/take 生效；pageSize 越界截到 100，page 越界回落 1', async () => {
    await seedRows()
    const p2 = await controller.list({ page: '2', pageSize: '2' })
    expect(p2.data.rows).toHaveLength(1)
    expect(p2.data.rows[0]!.action).toBe('model-catalog.create')

    const clipped = await controller.list({ pageSize: '5000' })
    expect(clipped.data.pageSize).toBe(100)

    const badPage = await controller.list({ page: '-3' })
    expect(badPage.data.page).toBe(1)

    const junk = await controller.list({ page: 'abc', pageSize: 'xyz' })
    expect(junk.data.page).toBe(1)
    expect(junk.data.pageSize).toBe(20)
  })

  it('before/after 原样透传（字符串）', async () => {
    await seedRows()
    const res = await controller.list({ action: 'platform-channel.pricing.set' })
    expect(res.data.rows[0]!.after).toBe('{"inputPerM":1}')
    expect(res.data.rows[0]!.actor).toBe('admin')
  })
})
