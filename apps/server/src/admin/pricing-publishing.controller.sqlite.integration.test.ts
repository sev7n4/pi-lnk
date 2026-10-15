// apps/server/src/admin/pricing-publishing.controller.sqlite.integration.test.ts
// P1-a T4：发布流 admin controller 集成测试（照 platform-channel 模式：真实 sqlite + 真实 guard）。
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { PricingPublishingController } from './pricing-publishing.controller'
import { PricingPublishingService } from '../pricing/pricing-publishing.service'
import { PricingService } from '../pricing/pricing.service'
import { AdminTokenGuard } from './admin-token.guard'

const serverRoot = path.resolve(__dirname, '../..')

async function seedActiveVersion(
  prisma: PrismaClient,
  version: string,
  entries: Array<{ matchKey: string; capability: string; credits: number; costRateId?: string }>,
) {
  return prisma.priceListVersion.create({
    data: {
      version,
      status: 'active',
      note: '基线',
      publishedAt: new Date(Date.now() - 60_000), // 早于后续 publish 的 publishedAt，保证 rollback「最新 archived」判定
      entries: { create: entries.map((e) => ({ ...e, basis: 'legacy-equivalent' })) },
    },
    include: { entries: true },
  })
}

describe('PricingPublishingController（P1-a T4）', () => {
  let dir: string
  let prisma: PrismaClient
  let service: PricingPublishingService
  let controller: PricingPublishingController

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-pricing-publishing-admin-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    service = new PricingPublishingService(prisma as never, new PricingService(prisma as never))
    controller = new PricingPublishingController(service)
  }, 180_000) // 集成 harness 高负载下 beforeAll 超 vitest 默认 10s，本文件局部放宽

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await prisma.pricingGrayWhitelist.deleteMany()
    await prisma.pricingGrayRelease.deleteMany()
    await prisma.adminAuditLog.deleteMany()
    await prisma.priceListEntry.deleteMany()
    await prisma.priceListVersion.deleteMany()
    await prisma.costRate.deleteMany()
  })

  describe('POST /draft', () => {
    it('幸福路径：从 active 复制建 draft，返回 id/version/entries 数', async () => {
      await seedActiveVersion(prisma, 'v1', [
        { matchKey: 'm-a', capability: 'text', credits: 100 },
        { matchKey: 'm-b', capability: 'image', credits: 500 },
      ])
      const res = await controller.createDraft({ version: 'v2', note: '首轮调价' })
      expect(res.code).toBe(0)
      expect(res.data.version).toBe('v2')
      expect(res.data.entries).toBe(2)
      const row = await prisma.priceListVersion.findUniqueOrThrow({ where: { id: res.data.id } })
      expect(row.status).toBe('draft')
      expect(row.note).toBe('首轮调价')
    })

    it('DTO 负例：缺 version/note、空字符串、非字符串 → 400，不建行', async () => {
      await seedActiveVersion(prisma, 'v1', [{ matchKey: 'm-a', capability: 'text', credits: 100 }])
      await expect(controller.createDraft({})).rejects.toThrow(BadRequestException)
      await expect(controller.createDraft({ version: '', note: 'x' })).rejects.toThrow(BadRequestException)
      await expect(controller.createDraft({ version: 'v2', note: '' })).rejects.toThrow(BadRequestException)
      await expect(controller.createDraft({ version: 'v2' })).rejects.toThrow(BadRequestException)
      await expect(controller.createDraft({ version: 42, note: 'x' })).rejects.toThrow(BadRequestException)
      expect(await prisma.priceListVersion.count()).toBe(1)
    })
  })

  describe('GET /（listVersions）', () => {
    it('返回版本列表（含 entryCount/publishedAt，不含 entries 明细）', async () => {
      await seedActiveVersion(prisma, 'v1', [{ matchKey: 'm-a', capability: 'text', credits: 100 }])
      await service.createDraftFromActive('v2', '草稿')
      const res = await controller.list()
      expect(res.code).toBe(0)
      expect(res.data).toHaveLength(2)
      const v1 = res.data.find((v) => v.version === 'v1')!
      expect(v1).toMatchObject({ status: 'active', entryCount: 1 })
      expect(v1.publishedAt).toBeInstanceOf(Date)
      expect(JSON.stringify(v1)).not.toContain('"entries"')
    })
  })

  describe('GET /:id（getDraft）', () => {
    it('返回 draft 详情含 entries；未知 id → 404', async () => {
      const v1 = await seedActiveVersion(prisma, 'v1', [{ matchKey: 'm-a', capability: 'text', credits: 100 }])
      const res = await controller.show(v1.id)
      expect(res.data).toMatchObject({ id: v1.id, version: 'v1', status: 'active' })
      expect(res.data.entries).toEqual([
        { matchKey: 'm-a', capability: 'text', credits: 100, basis: 'legacy-equivalent', costRateId: null },
      ])
      await expect(controller.show('nope')).rejects.toThrow(NotFoundException)
    })
  })

  describe('PUT /:id/entries（upsertEntries）', () => {
    it('幸福路径：更新既有 + 新增条目，返回写入数，落库生效', async () => {
      const v1 = await seedActiveVersion(prisma, 'v1', [{ matchKey: 'm-a', capability: 'text', credits: 100 }])
      const draft = await service.createDraftFromActive('v2', '调价')
      const res = await controller.updateEntries(draft.id, {
        entries: [
          { matchKey: 'm-a', capability: 'text', credits: 150 },
          { matchKey: 'm-c', capability: 'video', credits: 2000, costRateId: null },
        ],
      })
      expect(res.data.written).toBe(2)
      const entries = await prisma.priceListEntry.findMany({ where: { versionId: draft.id } })
      const a = entries.find((e) => e.matchKey === 'm-a')!
      expect(a.credits).toBe(150)
      expect(entries.find((e) => e.matchKey === 'm-c')).toMatchObject({ credits: 2000, capability: 'video' })
      expect(v1.id).toBeTruthy()
    })

    it('未知版本 → 404；非 draft → 400', async () => {
      await expect(
        controller.updateEntries('nope', { entries: [{ matchKey: 'm-a', capability: 'text', credits: 1 }] }),
      ).rejects.toThrow(NotFoundException)
      const v1 = await seedActiveVersion(prisma, 'v1', [])
      await expect(
        controller.updateEntries(v1.id, { entries: [{ matchKey: 'm-a', capability: 'text', credits: 1 }] }),
      ).rejects.toThrow(BadRequestException)
    })

    it('DTO 负例：entries 非数组 / matchKey 空 / credits 非正整数 → 400，零写入', async () => {
      const draft = await seedActiveVersion(prisma, 'v1', [])
      await expect(controller.updateEntries(draft.id, {})).rejects.toThrow(BadRequestException)
      await expect(controller.updateEntries(draft.id, { entries: 'nope' })).rejects.toThrow(BadRequestException)
      await expect(
        controller.updateEntries(draft.id, { entries: [{ matchKey: '', capability: 'text', credits: 1 }] }),
      ).rejects.toThrow(BadRequestException)
      await expect(
        controller.updateEntries(draft.id, { entries: [{ matchKey: 'm-a', capability: '', credits: 1 }] }),
      ).rejects.toThrow(BadRequestException)
      for (const bad of [0, -1, 1.5, '10', null]) {
        await expect(
          controller.updateEntries(draft.id, { entries: [{ matchKey: 'm-a', capability: 'text', credits: bad }] }),
        ).rejects.toThrow(BadRequestException)
      }
      expect(await prisma.priceListEntry.count()).toBe(0)
    })
  })

  describe('GET /:id/diff（diffSummary）', () => {
    it('返回对比摘要：changed/added/maxIncrease + 全表无成本覆盖（无 removed 字段）', async () => {
      await seedActiveVersion(prisma, 'v1', [
        { matchKey: 'm-a', capability: 'text', credits: 100 },
        { matchKey: 'm-b', capability: 'image', credits: 500 },
      ])
      const draft = await service.createDraftFromActive('v2', '调价')
      await service.upsertEntries(draft.id, [
        { matchKey: 'm-a', capability: 'text', credits: 150 },
        { matchKey: 'm-c', capability: 'video', credits: 2000 },
      ])
      const res = await controller.diff(draft.id)
      // draft 复制自 v1（m-a/m-b），改 m-a、增 m-c → changed:1 added:1 unchanged:1
      expect(res.data).toMatchObject({
        draftVersion: 'v2',
        activeVersion: 'v1',
        changed: 1,
        added: 1,
        unchanged: 1,
      })
      // 死计数 removed 已删（upsertEntries 不提供删条目）
      expect(Object.keys(res.data)).not.toContain('removed')
      // 全表口径无成本覆盖：m-b 未改但也无 costRateId，必须被列出（终审 I4）
      expect(res.data.noCostCoverage.sort()).toEqual(['m-a', 'm-b', 'm-c'])
      expect(res.data.maxIncrease).toMatchObject({ matchKey: 'm-a', from: 100, to: 150 })
      await expect(controller.diff('nope')).rejects.toThrow(NotFoundException)
    })
  })

  describe('POST /:id/publish', () => {
    it('幸福路径：draft→active、旧 active→archived，audit 落 action=pricing-version.publish', async () => {
      await seedActiveVersion(prisma, 'v1', [{ matchKey: 'm-a', capability: 'text', credits: 100 }])
      const draft = await service.createDraftFromActive('v2', '调价')
      await service.upsertEntries(draft.id, [{ matchKey: 'm-a', capability: 'text', credits: 150 }])

      const res = await controller.publish(draft.id)
      expect(res.code).toBe(0)
      expect(res.data).toEqual({ version: 'v2' })

      const v1 = await prisma.priceListVersion.findUniqueOrThrow({ where: { version: 'v1' } })
      const v2 = await prisma.priceListVersion.findUniqueOrThrow({ where: { version: 'v2' } })
      expect(v1.status).toBe('archived')
      expect(v2.status).toBe('active')
      expect(v2.publishedAt).toBeInstanceOf(Date)

      const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'pricing-version.publish' } })
      expect(audit.actor).toBe('admin')
      expect(audit.resource).toBe('price-list-version:v2')
      expect(JSON.parse(audit.before!)).toMatchObject({ version: 'v1', status: 'active' })
      expect(JSON.parse(audit.after!)).toMatchObject({ version: 'v2', status: 'active', entryCount: 1 })
    })

    it('400 穿透①：空 draft → 400，状态零变化，audit 不留痕', async () => {
      await seedActiveVersion(prisma, 'v1', [{ matchKey: 'm-a', capability: 'text', credits: 100 }])
      const empty = await prisma.priceListVersion.create({
        data: { version: 'v-empty', status: 'draft', note: '空' },
      })
      await expect(controller.publish(empty.id)).rejects.toThrow(BadRequestException)
      expect((await prisma.priceListVersion.findUniqueOrThrow({ where: { id: empty.id } })).status).toBe('draft')
      expect(await prisma.adminAuditLog.count()).toBe(0)
    })

    it('400 穿透②：地板违规（credits < ceil(costYuan×105)）→ 400，状态零变化', async () => {
      const rate = await prisma.costRate.create({
        data: { channel: 'platform', modelKey: 'm-a', spec: 'standard', unit: '1M', costYuan: 1 },
      })
      await seedActiveVersion(prisma, 'v1', [
        { matchKey: 'm-a', capability: 'text', credits: 100, costRateId: rate.id },
      ])
      const draft = await service.createDraftFromActive('v2', '跌破地板')
      await service.upsertEntries(draft.id, [{ matchKey: 'm-a', capability: 'text', credits: 50, costRateId: rate.id }])
      // 预览：diffSummary 披露违规但不抛
      const preview = await controller.diff(draft.id)
      expect(preview.data.floorViolations).toEqual([{ matchKey: 'm-a', credits: 50, floor: 105 }])
      // 发布：400 拒绝
      await expect(controller.publish(draft.id)).rejects.toThrow(BadRequestException)
      expect((await prisma.priceListVersion.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('draft')
      expect(await prisma.adminAuditLog.count()).toBe(0)
    })

    it('400 穿透③：重复发布（非 draft）→ 400', async () => {
      await seedActiveVersion(prisma, 'v1', [{ matchKey: 'm-a', capability: 'text', credits: 100 }])
      const v1 = await prisma.priceListVersion.findUniqueOrThrow({ where: { version: 'v1' } })
      await expect(controller.publish(v1.id)).rejects.toThrow(BadRequestException)
    })
  })

  describe('POST /rollback', () => {
    it('幸福路径：当前 active→archived，上一个已发布版本→active，audit 落 rollback', async () => {
      await seedActiveVersion(prisma, 'v1', [{ matchKey: 'm-a', capability: 'text', credits: 100 }])
      const draft = await service.createDraftFromActive('v2', '调价')
      await controller.publish(draft.id)

      const res = await controller.rollback()
      expect(res.data).toEqual({ version: 'v1' })
      expect((await prisma.priceListVersion.findUniqueOrThrow({ where: { version: 'v1' } })).status).toBe('active')
      expect((await prisma.priceListVersion.findUniqueOrThrow({ where: { version: 'v2' } })).status).toBe('archived')
      const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'pricing-version.rollback' } })
      expect(audit.resource).toBe('price-list-version:v1')
    })

    it('400：无 active 或无可回滚目标 → 400', async () => {
      // 仅 active、无更早已发布版本
      await seedActiveVersion(prisma, 'v1', [{ matchKey: 'm-a', capability: 'text', credits: 100 }])
      await expect(controller.rollback()).rejects.toThrow(BadRequestException)
      // 完全无版本
      await prisma.priceListVersion.deleteMany()
      await expect(controller.rollback()).rejects.toThrow(BadRequestException)
    })
  })
})

describe('PricingPublishingController guard 401', () => {
  const originalToken = process.env.LNKPI_ADMIN_TOKEN

  afterAll(() => {
    if (originalToken === undefined) delete process.env.LNKPI_ADMIN_TOKEN
    else process.env.LNKPI_ADMIN_TOKEN = originalToken
  })

  it('全部 7 个处理器都挂 AdminTokenGuard（路由级元数据断言）', () => {
    const proto = PricingPublishingController.prototype
    const handlers = [proto.list, proto.createDraft, proto.show, proto.updateEntries, proto.diff, proto.publish, proto.rollback]
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
