// Task 8 acceptance（preflight R1）：真 SQLite 全链，走 mkdtemp + db push + PrismaClient
// 范式（本工作区无 .env / DATABASE_URL，裸 `new PrismaService()` 必 env 报错 ⇒ 判据失效）。
//
// 验证：AC13 六字段读回 + createDraftFromActive 复制清单；AC14 地板按 costSnapshotYuan
// 归一成本判、credits=40 被硬拒；AC3 / revision 缺成本主体 validatePublish 返回违规清单、
// publish 400 且版本状态零变化。
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PricingPublishingService } from './pricing-publishing.service'
import { PricingService } from './pricing.service'

const serverRoot = path.resolve(__dirname, '../..')

let dbUrl: string
let dbDir: string
let prisma: PrismaClient

beforeAll(() => {
  dbDir = mkdtempSync(path.join(tmpdir(), 's1-pub-'))
  const dbFile = path.join(dbDir, 'test.db')
  dbUrl = `file:${dbFile}`
  execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
  })
  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })
}, 180_000)

afterAll(async () => {
  await prisma.$disconnect()
  rmSync(dbDir, { recursive: true, force: true })
})

// 每个用例重置后种一棵基线 active 版本（createDraftFromActive 需可复制）+ CostRate + MarginPolicy。
beforeEach(async () => {
  await prisma.priceListEntry.deleteMany()
  await prisma.priceListVersion.deleteMany()
  await prisma.costRate.deleteMany()
  await prisma.marginPolicy.deleteMany()
  await prisma.adminAuditLog.deleteMany()
  const v = await prisma.priceListVersion.create({
    data: { id: 'base-active', version: 'base-active', status: 'active' },
  })
  await prisma.priceListEntry.create({
    data: { versionId: v.id, capability: 'image', matchKey: 'image:1K:1', credits: 10, basis: 'legacy-equivalent' },
  })
  await prisma.costRate.create({
    data: {
      id: 'cr1',
      channel: 'volcengine',
      modelKey: 'seedream-5.0-pro',
      spec: '1K',
      unit: 'image_count',
      costYuan: 0.5,
      source: 'official_list',
    },
  })
  await prisma.marginPolicy.create({
    data: { id: 'mp1', phase: 's1-pub-test', scope: 'global', scopeKey: '*', marginBp: 1000, status: 'active' },
  })
})

function svc() {
  return new PricingPublishingService(prisma, new PricingService(prisma as unknown as never))
}

describe('S1 publishing wiring', () => {
  it('AC13：PUT /:id/entries 六字段读回非空；createDraftFromActive 复制清单齐全', async () => {
    const d = await svc().createDraftFromActive('s1-test-draft', 'wiring test')
    await svc().upsertEntries(d.id, [
      {
        matchKey: 'image|x|1K:3|p|u',
        capability: 'image',
        credits: 100,
        subjectKey: 'image|x|1K:3|p|u',
        costSnapshotYuan: 0.9,
        unitSnapshot: '{"billableUnit":"image_count","unitQuantity":1,"unitsPerRequest":3}',
        profitBpSnapshot: 1000,
        marginPolicyId: 'mp1',
        reason: 'manual',
        basis: 'ops-modified',
      },
    ])
    const row = await prisma.priceListEntry.findFirst({
      where: { versionId: d.id, matchKey: 'image|x|1K:3|p|u' },
    })
    expect(row).toMatchObject({
      subjectKey: 'image|x|1K:3|p|u',
      costSnapshotYuan: 0.9,
      profitBpSnapshot: 1000,
      marginPolicyId: 'mp1',
      reason: 'manual',
    })
    // 发布 d 使其成 active（同时走过发布门禁 happy path），再建草案验证六字段复制链：
    // 运营「复制 active 建草案 + 微调」日常路径下，成本/计量/利润快照必须随版本演进保留。
    await svc().publish(d.id)
    const d2 = await svc().createDraftFromActive('s1-test-draft-2', 'copy test')
    const copy = await prisma.priceListEntry.findFirst({
      where: { versionId: d2.id, matchKey: 'image|x|1K:3|p|u' },
    })
    expect(copy?.costSnapshotYuan).toBe(0.9)
    expect(copy?.unitSnapshot).toContain('image_count')
  })

  it('AC14：地板按 costSnapshotYuan=0.9 归一成本判，credits=40 必须被硬拒', async () => {
    const d = await svc().createDraftFromActive('s1-floor-draft', 'floor test')
    await prisma.priceListEntry.upsert({
      where: {
        versionId_matchKey: { versionId: d.id, matchKey: 'image|seedream-5.0-pro|1K:3|volcengine|apimart' },
      },
      update: {
        credits: 40,
        costSnapshotYuan: 0.9,
        costRateId: 'cr1',
        subjectKey: 'image|seedream-5.0-pro|1K:3|volcengine|apimart',
      },
      create: {
        versionId: d.id,
        capability: 'image',
        matchKey: 'image|seedream-5.0-pro|1K:3|volcengine|apimart',
        subjectKey: 'image|seedream-5.0-pro|1K:3|volcengine|apimart',
        credits: 40,
        basis: 'auto-derived',
        costSnapshotYuan: 0.9,
        costRateId: 'cr1',
      },
    })
    // 地板：limit=ceil(0.9×10500/100)=95，credits=40<95 ⇒ 硬拒（发布校验未通过）
    await expect(svc().publish(d.id)).rejects.toThrow(/发布校验未通过|地板校验失败/)
    expect((await prisma.priceListVersion.findUnique({ where: { id: d.id } }))!.status).toBe('draft')
  })

  it('AC3 / revision：缺成本主体 validatePublish 返回违规清单，publish 400 且版本状态零变化', async () => {
    const v = await prisma.priceListVersion.findFirst({ where: { status: 'active' } })
    const before = v!.revision
    const d = await svc().createDraftFromActive('s1-gate-draft', 'gate test')
    // 注入一个缺 costSnapshotYuan 的 subject 条目（S1 成本主体缺失 ⇒ 硬拒）
    await svc().upsertEntries(d.id, [
      {
        matchKey: 'image|missing|1K:1|p|u',
        capability: 'image',
        credits: 50,
        subjectKey: 'image|missing|1K:1|p|u',
        basis: 'ops-modified',
      },
    ])
    const r = await svc().validatePublish(d.id)
    expect(r.ok).toBe(false)
    expect(r.violations.length).toBeGreaterThan(0)
    await expect(svc().publish(d.id)).rejects.toThrow(/发布校验未通过/)
    // 版本状态零变化（事务回滚）+ 基线 revision 零变化
    expect((await prisma.priceListVersion.findUnique({ where: { id: d.id } }))!.status).toBe('draft')
    expect((await prisma.priceListVersion.findUnique({ where: { id: v!.id } }))!.revision).toBe(before)
  })
})
