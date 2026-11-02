// apps/server/src/pricing/pricing.controller.quote.sqlite.integration.test.ts
// 修复规格 2026-11-02-points-display-single-source：展示层 quote 端点（与计费同源读价目表）。
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PricingController } from './pricing.controller'
import { PricingService } from './pricing.service'

const serverRoot = path.resolve(__dirname, '../..')

async function seedActiveVersion(
  prisma: PrismaClient,
  version: string,
  entries: Array<{ matchKey: string; capability: string; credits: number }>,
) {
  return prisma.priceListVersion.create({
    data: {
      version,
      status: 'active',
      note: '测试',
      publishedAt: new Date(),
      entries: { create: entries.map((e) => ({ ...e, basis: 'legacy-equivalent' })) },
    },
    include: { entries: true },
  })
}

describe('PricingController GET /pricing/quote（展示层单一真相源）', () => {
  let dir: string
  let prisma: PrismaClient
  let service: PricingService
  let controller: PricingController

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-pricing-quote-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    service = new PricingService(prisma as never)
    controller = new PricingController(service)
  }, 180_000)

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await prisma.priceListEntry.deleteMany()
    await prisma.priceListVersion.deleteMany()
    service.invalidate()
  })

  it('image:1K:1 经 quote 端点返回价目表值 33（degraded:false）', async () => {
    await seedActiveVersion(prisma, 'v2-launch', [
      { matchKey: 'image:1K:1', capability: 'image', credits: 33 },
    ])
    const res = await controller.quote({ capability: 'image', resolution: '1K', count: '1' })
    expect(res.code).toBe(0)
    expect(res.data.credits).toBe(33)
    expect(res.data.degraded).toBe(false)
    expect(res.data.ruleVersion).toBe('v2-launch')
  })

  it('image_edit:<model> 行经 quote 端点返回价目表值（覆盖硬编码 IMAGE_EDIT_MODEL_PRICING）', async () => {
    await seedActiveVersion(prisma, 'v2-launch', [
      { matchKey: 'image_edit:p1-edit', capability: 'image_edit', credits: 12 },
    ])
    const res = await controller.quote({ capability: 'image_edit', modelKey: 'p1-edit' })
    expect(res.code).toBe(0)
    expect(res.data.credits).toBe(12)
    expect(res.data.degraded).toBe(false)
  })

  it('空表：quote 端点返回 degraded:true + 常量兜底（image 1K = 10），绝不 throw', async () => {
    const res = await controller.quote({ capability: 'image', resolution: '1K', count: '1' })
    expect(res.code).toBe(0)
    expect(res.data.credits).toBe(10)
    expect(res.data.degraded).toBe(true)
    expect(res.data.ruleVersion).toBe('constants-fallback')
  })

  it('公开只读：quote 处理器不挂任何 guard', () => {
    const guards = Reflect.getMetadata('__guards__', PricingController.prototype.quote)
    expect(guards).toBeUndefined()
  })
})
