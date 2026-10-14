// apps/server/src/admin/pricing-gray.controller.sqlite.integration.test.ts
// P1-a T5：白名单灰度 admin controller 集成测试（照 pricing-publishing T4 模式：真实 sqlite + 真实 guard）。
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import { PricingGrayController } from './pricing-gray.controller'
import { PricingGrayReleaseService } from '../pricing/pricing-gray-release.service'
import { PricingPublishingService } from '../pricing/pricing-publishing.service'
import { PricingService } from '../pricing/pricing.service'
import { AdminTokenGuard } from './admin-token.guard'

const serverRoot = path.resolve(__dirname, '../..')

async function seedUser(prisma: PrismaClient, phone: string) {
  return prisma.user.create({ data: { phone, nickname: `用户${phone.slice(-4)}` } })
}

async function seedVersion(
  prisma: PrismaClient,
  version: string,
  status: string,
  entries: Array<{ matchKey: string; capability: string; credits: number }>,
) {
  return prisma.priceListVersion.create({
    data: {
      version,
      status,
      note: `${status} 基线`,
      publishedAt: status === 'active' ? new Date(Date.now() - 60_000) : null,
      entries: { create: entries.map((e) => ({ ...e, basis: 'legacy-equivalent' })) },
    },
    include: { entries: true },
  })
}

describe('PricingGrayController（P1-a T5）', () => {
  let dir: string
  let prisma: PrismaClient
  let controller: PricingGrayController

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-pricing-gray-admin-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    const publishing = new PricingPublishingService(prisma as never)
    const gray = new PricingGrayReleaseService(prisma as never, publishing)
    controller = new PricingGrayController(gray)
  }, 180_000) // 集成 harness 高负载下 beforeAll 超 vitest 默认 10s，本文件局部放宽

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await prisma.pricingGrayWhitelist.deleteMany()
    await prisma.pricingGrayRelease.deleteMany()
    await prisma.adminAuditLog.deleteMany()
    await prisma.pointTransaction.deleteMany()
    await prisma.priceListEntry.deleteMany()
    await prisma.priceListVersion.deleteMany()
    await prisma.user.deleteMany()
    await prisma.costRate.deleteMany()
  })

  describe('POST /preview', () => {
    it('幸福路径：切分/去重 + 命中/未命中显式返回', async () => {
      const u1 = await seedUser(prisma, '13800000001')
      await seedUser(prisma, '13800000002')
      const res = await controller.preview({ rawInput: '13800000001, 13800000002\n13800000001 19999999999' })
      expect(res.code).toBe(0)
      expect(res.data.hits).toEqual([
        { userId: u1.id, phone: '13800000001' },
        { userId: (await prisma.user.findUniqueOrThrow({ where: { phone: '13800000002' } })).id, phone: '13800000002' },
      ])
      expect(res.data.misses).toEqual(['19999999999'])
    })

    it('DTO 负例：缺 rawInput / 空串 / 非字符串 → 400', async () => {
      await expect(controller.preview({})).rejects.toThrow(BadRequestException)
      await expect(controller.preview({ rawInput: '' })).rejects.toThrow(BadRequestException)
      await expect(controller.preview({ rawInput: 42 })).rejects.toThrow(BadRequestException)
    })
  })

  describe('POST /（createRelease）', () => {
    it('幸福路径：draft + 名单 → release/whitelist/audit 落库，默认窗口 now~now+7d', async () => {
      await seedUser(prisma, '13800000001')
      await seedUser(prisma, '13800000002')
      const draft = await seedVersion(prisma, 'v2', 'draft', [
        { matchKey: 'text', capability: 'text', credits: 8 },
      ])
      const before = Date.now()

      const res = await controller.create({
        versionId: draft.id,
        rawInput: '13800000001, 13800000002\n13800000001',
        note: '首轮灰度',
      })
      expect(res.code).toBe(0)
      expect(res.data).toMatchObject({ version: 'v2', hits: 2 })
      expect(res.data.window.startsAt.getTime()).toBeGreaterThanOrEqual(before - 1000)
      expect(res.data.window.endsAt.getTime() - res.data.window.startsAt.getTime()).toBeCloseTo(
        7 * 24 * 3600 * 1000,
        -5,
      )

      const release = await prisma.pricingGrayRelease.findUniqueOrThrow({ where: { id: res.data.releaseId } })
      expect(release).toMatchObject({ versionId: draft.id, status: 'active', note: '首轮灰度' })
      const wl = await prisma.pricingGrayWhitelist.findMany({ where: { releaseId: release.id } })
      expect(wl).toHaveLength(2)
      const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'pricing-gray.create' } })
      expect(audit.actor).toBe('admin')
      expect(JSON.parse(audit.after!)).toMatchObject({ version: 'v2', hits: 2 })
    })

    it('空命中 → 400 且信息含每个未命中号码；零落库（空集假绿防线）', async () => {
      await seedVersion(prisma, 'v2', 'draft', [{ matchKey: 'text', capability: 'text', credits: 8 }])
      const err = await controller
        .create({ versionId: (await prisma.priceListVersion.findFirstOrThrow()).id, rawInput: '19999999999, 18888888888' })
        .catch((e) => e)
      expect(err).toBeInstanceOf(BadRequestException)
      expect(err.message).toContain('19999999999')
      expect(err.message).toContain('18888888888')
      expect(await prisma.pricingGrayRelease.count()).toBe(0)
      expect(await prisma.pricingGrayWhitelist.count()).toBe(0)
      expect(await prisma.adminAuditLog.count()).toBe(0)
    })

    it('约束：已有 active → 409；active 版本 → 400；版本不存在 → 404；endsAt ≤ startsAt → 400', async () => {
      await seedUser(prisma, '13800000001')
      const v1 = await seedVersion(prisma, 'v1', 'active', [{ matchKey: 'text', capability: 'text', credits: 5 }])
      const draft = await seedVersion(prisma, 'v2', 'draft', [{ matchKey: 'text', capability: 'text', credits: 8 }])
      await controller.create({ versionId: draft.id, phones: ['13800000001'] })

      await expect(controller.create({ versionId: draft.id, phones: ['13800000001'] })).rejects.toThrow(
        ConflictException,
      )
      await expect(controller.create({ versionId: v1.id, phones: ['13800000001'] })).rejects.toThrow(
        BadRequestException,
      )
      await expect(controller.create({ versionId: 'nope', phones: ['13800000001'] })).rejects.toThrow(
        NotFoundException,
      )
      const now = Date.now()
      await expect(
        controller.create({
          versionId: draft.id,
          phones: ['13800000001'],
          startsAt: new Date(now).toISOString(),
          endsAt: new Date(now - 1000).toISOString(),
        }),
      ).rejects.toThrow(BadRequestException)
      expect(await prisma.pricingGrayRelease.count()).toBe(1)
    })

    it('DTO 负例：缺 versionId / 名单两者皆缺 / phones 形态非法 / 时间字符串非法 → 400', async () => {
      const draft = await seedVersion(prisma, 'v2', 'draft', [])
      await expect(controller.create({ rawInput: '13800000001' })).rejects.toThrow(BadRequestException)
      await expect(controller.create({ versionId: draft.id })).rejects.toThrow(BadRequestException)
      await expect(controller.create({ versionId: draft.id, phones: [] })).rejects.toThrow(BadRequestException)
      await expect(controller.create({ versionId: draft.id, phones: [42] })).rejects.toThrow(BadRequestException)
      await expect(
        controller.create({ versionId: draft.id, rawInput: '13800000001', startsAt: 'not-a-date' }),
      ).rejects.toThrow(BadRequestException)
      expect(await prisma.pricingGrayRelease.count()).toBe(0)
    })
  })

  describe('GET /（list）', () => {
    it('返回列表（version/hits/note）；惰性过期：过期 active 返回前已置 expired', async () => {
      await seedUser(prisma, '13800000001')
      const draft = await seedVersion(prisma, 'v2', 'draft', [{ matchKey: 'text', capability: 'text', credits: 8 }])
      const now = Date.now()
      await controller.create({
        versionId: draft.id,
        phones: ['13800000001'],
        startsAt: new Date(now - 2 * 24 * 3600 * 1000).toISOString(),
        endsAt: new Date(now - 24 * 3600 * 1000).toISOString(), // 已过期
        note: '过期灰度',
      })

      const res = await controller.list()
      expect(res.code).toBe(0)
      expect(res.data).toHaveLength(1)
      expect(res.data[0]).toMatchObject({ status: 'expired', version: 'v2', hits: 1, note: '过期灰度' })
      expect((await prisma.pricingGrayRelease.findFirstOrThrow()).status).toBe('expired')
    })
  })

  describe('GET /:id/report', () => {
    it('按 grayReleaseId 聚合：txCount/txAmountByCategory/refundCount/byUser；未知 id → 404', async () => {
      const u1 = await seedUser(prisma, '13800000001')
      const u2 = await seedUser(prisma, '13800000002')
      const draft = await seedVersion(prisma, 'v2', 'draft', [{ matchKey: 'text', capability: 'text', credits: 8 }])
      const rel = await controller.create({ versionId: draft.id, phones: ['13800000001', '13800000002'] })
      const rid = rel.data.releaseId

      await prisma.pointTransaction.createMany({
        data: [
          { userId: u1.id, amount: 10, kind: 'consume', category: 'text', grayReleaseId: rid, reason: '文本生成' },
          { userId: u1.id, amount: 20, kind: 'consume', category: 'image', grayReleaseId: rid, reason: '图像生成' },
          { userId: u2.id, amount: 5, kind: 'refund', category: 'other', grayReleaseId: rid, reason: '退款' },
          { userId: u1.id, amount: 99, kind: 'consume', category: 'text', grayReleaseId: 'other-release', reason: '别的 release' },
        ],
      })

      const res = await controller.report(rid)
      expect(res.code).toBe(0)
      expect(res.data).toMatchObject({
        releaseId: rid,
        version: 'v2',
        status: 'active',
        hits: 2,
        txCount: 3,
        txAmountByCategory: { text: 10, image: 20, other: 5 },
        refundCount: 1,
      })
      expect(res.data.byUser).toEqual([{ userId: u1.id, consumeCount: 2, consumeTotal: 30 }])

      await expect(controller.report('nope')).rejects.toThrow(NotFoundException)
    })
  })

  describe('POST /:id/promote', () => {
    it('幸福路径：灰度版本转 active、旧 active 归档、release=promoted、audit 三条（create+publish+promote）', async () => {
      await seedVersion(prisma, 'v1', 'active', [{ matchKey: 'text', capability: 'text', credits: 5 }])
      await seedUser(prisma, '13800000001')
      const draft = await seedVersion(prisma, 'v2', 'draft', [{ matchKey: 'text', capability: 'text', credits: 8 }])
      const rel = await controller.create({ versionId: draft.id, phones: ['13800000001'] })

      const res = await controller.promote(rel.data.releaseId)
      expect(res.code).toBe(0)
      expect(res.data).toEqual({ version: 'v2' })

      expect((await prisma.priceListVersion.findUniqueOrThrow({ where: { version: 'v1' } })).status).toBe('archived')
      expect((await prisma.priceListVersion.findUniqueOrThrow({ where: { version: 'v2' } })).status).toBe('active')
      expect((await prisma.pricingGrayRelease.findUniqueOrThrow({ where: { id: rel.data.releaseId } })).status).toBe(
        'promoted',
      )
      const actions = (await prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'asc' } })).map((a) => a.action)
      expect(actions).toEqual(['pricing-gray.create', 'pricing-version.publish', 'pricing-gray.promote'])
    })

    it('非 active release → 400（重复 promote）；未知 id → 404', async () => {
      await seedUser(prisma, '13800000001')
      const draft = await seedVersion(prisma, 'v2', 'draft', [{ matchKey: 'text', capability: 'text', credits: 8 }])
      const rel = await controller.create({ versionId: draft.id, phones: ['13800000001'] })
      await controller.promote(rel.data.releaseId)

      await expect(controller.promote(rel.data.releaseId)).rejects.toThrow(BadRequestException)
      await expect(controller.promote('nope')).rejects.toThrow(NotFoundException)
    })
  })

  describe('POST /:id/rollback', () => {
    it('幸福路径：release 置 rolled_back + audit；名单用户 quote 立即回 global 值', async () => {
      const u1 = await seedUser(prisma, '13800000001')
      await seedVersion(prisma, 'v1', 'active', [{ matchKey: 'text', capability: 'text', credits: 5 }])
      const draft = await seedVersion(prisma, 'v2', 'draft', [{ matchKey: 'text', capability: 'text', credits: 8 }])
      const rel = await controller.create({ versionId: draft.id, phones: ['13800000001'] })

      // 灰度窗口内：名单用户走灰度价 8
      const grayQuote = await new PricingService(prisma as never).quote({ capability: 'text' }, u1.id)
      expect(grayQuote).toMatchObject({ credits: 8, ruleVersion: 'v2', grayReleaseId: rel.data.releaseId })

      const res = await controller.rollback(rel.data.releaseId)
      expect(res.code).toBe(0)
      expect((await prisma.pricingGrayRelease.findUniqueOrThrow({ where: { id: rel.data.releaseId } })).status).toBe(
        'rolled_back',
      )
      const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'pricing-gray.rollback' } })
      expect(audit.actor).toBe('admin')

      // rollback 后（新 PricingService 实例 = 无缓存）：名单用户回 global 价 5
      const globalQuote = await new PricingService(prisma as never).quote({ capability: 'text' }, u1.id)
      expect(globalQuote).toEqual({ credits: 5, ruleVersion: 'v1' })
      expect(Object.keys(globalQuote)).not.toContain('grayReleaseId')
      // 版本本身不动（仍 draft；版本回退走 publishing.rollback）
      expect((await prisma.priceListVersion.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('draft')
    })

    it('未知 id → 404', async () => {
      await expect(controller.rollback('nope')).rejects.toThrow(NotFoundException)
    })
  })
})

describe('PricingGrayController guard 401', () => {
  const originalToken = process.env.LNKPI_ADMIN_TOKEN

  afterAll(() => {
    if (originalToken === undefined) delete process.env.LNKPI_ADMIN_TOKEN
    else process.env.LNKPI_ADMIN_TOKEN = originalToken
  })

  it('全部 6 个处理器都挂 AdminTokenGuard（路由级元数据断言）', () => {
    const proto = PricingGrayController.prototype
    const handlers = [proto.preview, proto.create, proto.list, proto.report, proto.promote, proto.rollback]
    for (const handler of handlers) {
      const guards = Reflect.getMetadata('__guards__', handler) as unknown[] | undefined
      expect(guards).toEqual([AdminTokenGuard])
    }
  })

  it('env 未设置 → 恒 401（fail-closed）；token 不匹配 → 401；匹配 → 放行', () => {
    const guard = new AdminTokenGuard()
    const ctx = (authorization?: string) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ headers: authorization ? { authorization } : {} }) }),
      }) as never

    delete process.env.LNKPI_ADMIN_TOKEN
    expect(() => guard.canActivate(ctx('Bearer anything'))).toThrow(UnauthorizedException)
    expect(() => guard.canActivate(ctx(undefined))).toThrow(UnauthorizedException)

    process.env.LNKPI_ADMIN_TOKEN = 'secret-token'
    expect(() => guard.canActivate(ctx('Bearer wrong-token'))).toThrow(UnauthorizedException)
    expect(guard.canActivate(ctx('Bearer secret-token'))).toBe(true)
  })
})
