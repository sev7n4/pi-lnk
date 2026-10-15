// apps/server/src/pricing/pricing.controller.sqlite.integration.test.ts
// P2 T8：公开活动价目端点 GET /pricing/active（照 pricing-publishing.controller 测试 harness：真实 sqlite）。
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

describe('PricingController GET /pricing/active（P2 T8）', () => {
  let dir: string
  let prisma: PrismaClient
  let service: PricingService
  let controller: PricingController

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-pricing-public-sqlite-'))
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
  }, 180_000) // 集成 harness 高负载下 beforeAll 超 vitest 默认 10s，本文件局部放宽

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await prisma.priceListEntry.deleteMany()
    await prisma.priceListVersion.deleteMany()
    service.invalidate() // 清 30s TTL 表缓存，避免上一用例快照泄漏
  })

  it('空态：无 active 版本 → code 0 + textTokenRatios 空对象（绝不 throw）', async () => {
    const res = await controller.active()
    expect(res.code).toBe(0)
    expect(res.message).toBe('ok')
    expect(res.data.textTokenRatios).toEqual({})
  })

  it('空态②：active 版本只有 legacy text 单行（无 token 行）→ 空对象', async () => {
    await seedActiveVersion(prisma, 'v1', [{ matchKey: 'text', capability: 'text', credits: 5 }])
    const res = await controller.active()
    expect(res.data.textTokenRatios).toEqual({})
  })

  it('有数态：text:<model>:in|cache|out 三行组装 map；cache 缺行不出现键；modelKey 小写规范化；非 text 行忽略', async () => {
    await seedActiveVersion(prisma, 'v1', [
      { matchKey: 'text', capability: 'text', credits: 5 },
      { matchKey: 'text:step-3.5-flash:in', capability: 'text', credits: 143 },
      { matchKey: 'text:step-3.5-flash:cache', capability: 'text', credits: 714 },
      { matchKey: 'text:step-3.5-flash:out', capability: 'text', credits: 48 },
      { matchKey: 'text:STEP-2-16K:in', capability: 'text', credits: 17 },
      { matchKey: 'text:step-2-16k:out', capability: 'text', credits: 6 },
      { matchKey: 'image:10', capability: 'image', credits: 10 },
    ])
    const res = await controller.active()
    expect(res.code).toBe(0)
    expect(res.data.textTokenRatios).toEqual({
      'step-3.5-flash': { in: 143, cache: 714, out: 48 },
      'step-2-16k': { in: 17, out: 6 },
    })
  })

  it('公开只读：active 处理器不挂任何 guard', () => {
    const guards = Reflect.getMetadata('__guards__', PricingController.prototype.active)
    expect(guards).toBeUndefined()
  })
})
