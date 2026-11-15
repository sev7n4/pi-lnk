// apps/server/src/admin/pricing-cost-record.controller.sqlite.integration.test.ts
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NotFoundException, BadRequestException } from '@nestjs/common'
import { PricingCostRecordController } from './pricing-cost-record.controller'
import { PrismaService } from '../prisma/prisma.service'
import { resolveUnitCost } from '../pricing/pricing-unit-cost'

/**
 * 定价中心聚合端点集成测试（临时 SQLite + prisma db push，S2-1b 同款 harness）。
 * spec: docs/design/2026-11-15-pricing-console-redesign.md §4/§7：
 * - R1/R2：GET 聚合在售条目为一条记录；下架条目不出现；PUT 对下架模型 404；
 * - R3：PUT 写档位 → per_second 行落库 + legacy per_video 退役留底（D-2 自迁移）；
 * - R4：profitPct → model-scope MarginPolicy 落库（自持，无 global 依赖）；
 * - 迁移端点幂等；非线性档位跳过不猜；等价金标准 per_second×dur == per_video 逐元相等。
 */

const serverRoot = path.resolve(__dirname, '../..')

const VIDEO_KEY = 'video-model-a'
const TEXT_KEY = 'text-model-a'

function subjectKey(capability: string, modelKey: string, spec: string): string {
  return [capability, modelKey, spec, 'gateway', 'upstream-a'].join('|')
}

async function seedSubject(prisma: PrismaClient, modelKey: string, spec: string): Promise<void> {
  await prisma.pricingSubject.create({
    data: {
      subjectKey: subjectKey('video', modelKey, spec),
      capability: 'video',
      modelKey,
      spec,
      provider: 'gateway',
      upstream: 'upstream-a',
      status: 'draft',
      billableUnit: 'video_call',
      unitsPerRequest: 1,
    },
  })
}

async function seedRate(
  prisma: PrismaClient,
  o: { modelKey: string; spec: string; unit: string; costYuan: number; unitQuantity?: number },
) {
  await prisma.costRate.create({
    data: {
      channel: 'platform',
      modelKey: o.modelKey,
      spec: o.spec,
      unit: o.unit,
      unitQuantity: o.unitQuantity ?? 1,
      costYuan: o.costYuan,
      source: 'official_list',
      provisional: false,
    },
  })
}

describe('PricingCostRecordController（定价中心聚合/更新/迁移）', () => {
  let dir: string
  let prisma: PrismaClient
  let controller: PricingCostRecordController

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-cost-record-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    controller = new PricingCostRecordController(prisma as unknown as PrismaService)
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await prisma.pricingSubject.deleteMany()
    await prisma.costRate.deleteMany()
    await prisma.marginPolicy.deleteMany()
    await prisma.modelCatalogEntry.deleteMany()
    await prisma.modelCatalogEntry.createMany({
      data: [
        { modelKey: VIDEO_KEY, displayName: '视频 A', gatewayModelId: VIDEO_KEY, modality: 'video', providerBinding: 'gateway-openai-compat', params: '{}' },
        { modelKey: TEXT_KEY, displayName: '文本 A', gatewayModelId: TEXT_KEY, modality: 'text', providerBinding: 'gateway-openai-compat', params: '{}' },
        { modelKey: 'offboarded-model', displayName: '已下架', gatewayModelId: 'offboarded-model', modality: 'video', providerBinding: 'gateway-openai-compat', params: '{}', deletedAt: new Date() },
      ],
    })
  })

  it('R1/R2：GET 聚合在售条目为一条记录；下架条目不出现；状态按缺成本分级', async () => {
    await seedSubject(prisma, VIDEO_KEY, '768p:5s')
    await seedSubject(prisma, VIDEO_KEY, '768p:10s')
    await seedRate(prisma, { modelKey: VIDEO_KEY, spec: '768p', unit: 'per_second', costYuan: 0.572 })
    await prisma.marginPolicy.create({
      data: { phase: 'scope:model:video-model-a', scope: 'model', scopeKey: VIDEO_KEY, profitBp: 1500, priceFloorBp: 500, status: 'active' },
    })

    const res = await controller.list()
    expect(res.code).toBe(0)
    const keys = res.data.map((r) => r.modelKey)
    expect(keys).toContain(VIDEO_KEY)
    expect(keys).toContain(TEXT_KEY)
    expect(keys).not.toContain('offboarded-model')

    const video = res.data.find((r) => r.modelKey === VIDEO_KEY)!
    expect(video.channel).toBe('gateway-openai-compat')
    expect(video.profitPct).toBe(15)
    expect(video.tiers.map((t) => t.spec)).toEqual(['480p', '768p', '2k'])
    expect(video.tiers.find((t) => t.spec === '768p')?.costYuan).toBeCloseTo(0.572)
    expect(video.subjectsTotal).toBe(2)
    expect(video.missingSpecs).toEqual([])
    expect(video.status).toBe('ready')

    const text = res.data.find((r) => r.modelKey === TEXT_KEY)!
    expect(text.tiers.map((t) => t.spec)).toEqual(['in', 'out', 'cache'])
    expect(text.status).toBe('missing')
    expect(text.profitPct).toBeNull()
  })

  it('P1.6：GET 聚合返回物化后扣费积分（active 优先，draft 兜底预览；未物化为 null）', async () => {
    await seedSubject(prisma, VIDEO_KEY, '768p:5s')
    // draft 版本：主体行 + 文本反比率行（预览口径）
    const draft = await prisma.priceListVersion.create({
      data: { version: 'v-draft-p16', status: 'draft' },
    })
    await prisma.priceListEntry.createMany({
      data: [
        { versionId: draft.id, capability: 'video', matchKey: 'video', credits: 315, basis: 'auto-derived', subjectKey: subjectKey('video', VIDEO_KEY, '768p:5s') },
        { versionId: draft.id, capability: 'text', matchKey: `text:${TEXT_KEY}:in`, credits: 20 },
        { versionId: draft.id, capability: 'text', matchKey: `text:${TEXT_KEY}:out`, credits: 60 },
      ],
    })
    const res = await controller.list()
    const video = res.data.find((r) => r.modelKey === VIDEO_KEY)!
    const text = res.data.find((r) => r.modelKey === TEXT_KEY)!
    expect(video.materializedVersion).toBe('v-draft-p16')
    // 视频按秒单价：主体行进 creditsByDuration（时长枚举对象数组），materializedCredits 恒 null
    expect(video.tiers.find((t) => t.spec === '768p')?.creditsByDuration).toEqual([{ duration: 5, credits: 315 }])
    expect(video.tiers.find((t) => t.spec === '480p')?.materializedCredits).toBeNull()
    // 文本反比率行（matchKey `text:<model>:<spec>`）进 textTokenCredits
    expect(text.tiers.find((t) => t.spec === 'in')?.materializedCredits).toBe(20)
    expect(text.tiers.find((t) => t.spec === 'out')?.materializedCredits).toBe(60)

    // active 版本出现后接管（发布语义）：主体行更新为 630
    const active = await prisma.priceListVersion.create({
      data: { version: 'v-active-p16', status: 'active' },
    })
    await prisma.priceListEntry.create({
      data: { versionId: active.id, capability: 'video', matchKey: 'video', credits: 630, basis: 'auto-derived', subjectKey: subjectKey('video', VIDEO_KEY, '768p:5s') },
    })
    const res2 = await controller.list()
    const video2 = res2.data.find((r) => r.modelKey === VIDEO_KEY)!
    expect(video2.materializedVersion).toBe('v-active-p16')
    expect(video2.tiers.find((t) => t.spec === '768p')?.creditsByDuration).toEqual([{ duration: 5, credits: 630 }])
    // 三段前缀索引回归守卫（11-15 生产取证抓出：get 三段 vs set 五段恒 miss ⇒ image/audio 恒 null）
    await prisma.modelCatalogEntry.create({
      data: { modelKey: 'img-p16', displayName: '图像 P16', gatewayModelId: 'img-p16', modality: 'image', providerBinding: 'gateway-openai-compat', params: '{}' },
    })
    await prisma.priceListEntry.create({
      data: { versionId: active.id, capability: 'image', matchKey: 'image', credits: 13, basis: 'auto-derived', subjectKey: `image|img-p16|1K|gateway|upstream-a` },
    })
    const res3 = await controller.list()
    const img = res3.data.find((r) => r.modelKey === 'img-p16')!
    expect(img.tiers.find((t) => t.spec === '1K')?.materializedCredits).toBe(13)
    // draft 的文本行不再可见（active 无文本行）
    const text2 = res2.data.find((r) => r.modelKey === TEXT_KEY)!
    expect(text2.tiers.find((t) => t.spec === 'in')?.materializedCredits).toBeNull()

    await prisma.priceListEntry.deleteMany({ where: { versionId: { in: [draft.id, active.id] } } })
    await prisma.priceListVersion.deleteMany({ where: { id: { in: [draft.id, active.id] } } })
  })

  it('R3+D-2：PUT 落 per_second 行并退役 legacy per_video；等价金标准逐元相等', async () => {
    await seedSubject(prisma, VIDEO_KEY, '768p:5s')
    await seedRate(prisma, { modelKey: VIDEO_KEY, spec: '768p:5s', unit: 'per_video', costYuan: 2.86 })

    const res = await controller.update(VIDEO_KEY, { tiers: [{ spec: '768p', costYuan: 0.572 }], profitPct: 12 })
    expect(res.code).toBe(0)
    expect(res.data.savedTiers).toBe(1)
    expect(res.data.profitBp).toBe(1200)

    const legacy = await prisma.costRate.findFirst({ where: { modelKey: VIDEO_KEY, spec: '768p:5s', unit: 'per_video' } })
    expect(legacy?.effectiveTo).not.toBeNull()
    const ps = await prisma.costRate.findFirst({ where: { modelKey: VIDEO_KEY, spec: '768p', unit: 'per_second' } })
    expect(ps?.costYuan).toBeCloseTo(0.572)

    const margin = await prisma.marginPolicy.findUnique({ where: { phase: 'scope:model:video-model-a' } })
    expect(margin?.profitBp).toBe(1200)
    expect(margin?.scope).toBe('model')

    const rows = await prisma.costRate.findMany()
    const c = resolveUnitCost(
      { capability: 'video', modelKey: VIDEO_KEY, spec: '768p:5s', upstream: 'upstream-a', billableUnit: 'video_call', unitsPerRequest: 1 },
      rows,
      new Date(),
    )
    expect(c?.costYuanPerRequest).toBeCloseTo(2.86, 10)
  })

  it('R2 变异守卫：PUT 对下架模型 404；FORBIDDEN 字段 400', async () => {
    await expect(controller.update('offboarded-model', { tiers: [{ spec: '480p', costYuan: 1 }] })).rejects.toBeInstanceOf(NotFoundException)
    await expect(controller.update(VIDEO_KEY, { tiers: [{ spec: '480p', costYuan: 1 }], currency: 'USD' })).rejects.toBeInstanceOf(BadRequestException)
    await expect(controller.update(VIDEO_KEY, { tiers: [{ spec: '480p', costYuan: -1 }] })).rejects.toBeInstanceOf(BadRequestException)
  })

  it('D-2 迁移端点：线性 per_video → per_second + 退役；非线性跳过不猜；幂等', async () => {
    await seedRate(prisma, { modelKey: 'minimax-h3', spec: '768p:5s', unit: 'per_video', costYuan: 2.86 })
    await seedRate(prisma, { modelKey: 'minimax-h3', spec: '768p:10s', unit: 'per_video', costYuan: 5.72 })
    await seedRate(prisma, { modelKey: 'mm-x', spec: '480p:5s', unit: 'per_video', costYuan: 1.0 })
    await seedRate(prisma, { modelKey: 'mm-x', spec: '480p:10s', unit: 'per_video', costYuan: 1.5 })

    const res = await controller.migrateVideoPerSecond()
    expect(res.data.converted).toBe(1)
    expect(res.data.retired).toBe(2)
    expect((res.data.skipped as { modelKey: string }[]).map((s) => s.modelKey)).toEqual(['mm-x'])

    const ps = await prisma.costRate.findFirst({ where: { modelKey: 'minimax-h3', spec: '768p', unit: 'per_second' } })
    expect(ps?.costYuan).toBeCloseTo(0.572, 10)
    const legacyLeft = await prisma.costRate.findMany({ where: { unit: 'per_video', effectiveTo: null, modelKey: 'minimax-h3' } })
    expect(legacyLeft).toHaveLength(0)

    const idempotent = await controller.migrateVideoPerSecond()
    expect(idempotent.data.converted).toBe(0)

    const rows = await prisma.costRate.findMany()
    const c = resolveUnitCost(
      { capability: 'video', modelKey: 'minimax-h3', spec: '768p:5s', upstream: 'u', billableUnit: 'video_call', unitsPerRequest: 1 },
      rows,
      new Date(),
    )
    expect(c?.costYuanPerRequest).toBeCloseTo(2.86, 10)
  })
})
