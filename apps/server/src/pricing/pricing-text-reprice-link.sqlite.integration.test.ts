// T1 文本 token 物化→扣费链路接通（spec 2026-11-15-text-token-reprice-link-design）。
//
// 真 SQLite 全链，走 mkdtemp + db push + PrismaClient 范式（参照 pricing.s1-acceptance.test.ts）。
// 覆盖：
// - 归一化同源守卫（spec §4.3 核对点 1）：TEXT_TOKEN_MODELS 经 modelOptionName 归一恒等
// - 三段 text:<model>:<spec> 行物化 upsert（spec §4.1）：credits=ratioOf、subjectKey=null、costRateId 必带
// - 跨版本隔离：物化只写 draft，active 逐字不变
// - ops-modified 保护 + 幂等（spec §4.3 核对点 2/3）
// - 端到端核心判据（spec §5.1）：改成本 → 物化 → 发布 → quoteTextTokens 跟随
// - 接线守卫（spec §5.3）：active 表三段行与六段文本主体行 credits 逐一相等
// - 公开反比率端点与扣费同源（spec §5.2）
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { modelOptionName } from '@lnkpi/shared'
import { PricingService } from './pricing.service'
import { PricingPublishingService } from './pricing-publishing.service'
import { PricingMaterializerService, ratioOf } from './pricing-materializer.service'
import { TEXT_TOKEN_MODELS } from './pricing.core'
import type { SubjectRow } from './pricing-subject.service'
import type { UnitCostRateRow } from './pricing-unit-cost'
import type { MarginRow } from './pricing-margin.service'

const serverRoot = path.resolve(__dirname, '../..')

let dbUrl: string
let dbDir: string
let prisma: PrismaClient

beforeAll(() => {
  dbDir = mkdtempSync(path.join(tmpdir(), 't1-reprice-'))
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

beforeEach(async () => {
  await prisma.priceListEntry.deleteMany()
  await prisma.priceListVersion.deleteMany()
  await prisma.costRate.deleteMany()
  await prisma.marginPolicy.deleteMany()
  await prisma.pricingSubject.deleteMany()
  await prisma.adminAuditLog.deleteMany()
  await prisma.priceListVersion.create({ data: { id: 'base-active', version: 'base-active', status: 'active' } })
})

function subjectRowsOf(rows: { subjectKey: string; capability: string; modelKey: string; spec: string; provider: string; upstream: string; channelId: string; status: string; billableUnit: string; unitsPerRequest: number | null; source: string }[]): SubjectRow[] {
  return rows.map((r) => ({ ...r }))
}
function costRowsOf(rows: { id: string; channel: string; modelKey: string; spec: string; unit: string; unitQuantity: number; costYuan: number; source: string; provisional: boolean; effectiveFrom: Date | null; effectiveTo: Date | null }[]): UnitCostRateRow[] {
  return rows.map((r) => ({ ...r }))
}
function marginRowsOf(rows: { id: string; scope: string; scopeKey: string | null; profitBp: number; priceFloorBp: number; effectiveFrom: Date | null; effectiveTo: Date | null; status: string }[]): MarginRow[] {
  return rows.map((r) => ({ ...r }))
}

async function runMaterialize(draftId: string) {
  const subjects = await prisma.pricingSubject.findMany()
  const costRates = await prisma.costRate.findMany()
  const marginRows = await prisma.marginPolicy.findMany()
  return new PricingMaterializerService(prisma as unknown as never).materialize(
    draftId,
    subjectRowsOf(subjects as never),
    costRowsOf(costRates as never),
    marginRowsOf(marginRows as never),
    new Date(),
  )
}

describe('T1 端到端：改成本→物化→发布→文本扣费跟随（spec §5.1 核心判据）', () => {
  const USAGE = { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }
  const SPECS = [
    { spec: 'in', cost: 0.05, crId: 'cr-in' },
    { spec: 'cache', cost: 0.5, crId: 'cr-cache' },
    { spec: 'out', cost: 0.15, crId: 'cr-out' },
  ]

  beforeEach(async () => {
    // fixture 铁律（plan Review Focus）：isKnownTokenModel 要求主体表 in+out 双主体齐备，
    // getActiveTextTokenRatios 同样要求 in/out 两行齐备才成组——三档必须齐建。
    for (const t of SPECS) {
      await prisma.pricingSubject.create({
        data: {
          subjectKey: `text|agnes-2.5-flash|${t.spec}|agnes_hub|default`,
          capability: 'text', modelKey: 'agnes-2.5-flash', spec: t.spec,
          provider: 'agnes_hub', upstream: 'default', channelId: 'platform', status: 'priced',
          billableUnit: `token_${t.spec}`, unitsPerRequest: 1e6, source: 'auto',
        },
      })
      await prisma.costRate.create({
        data: { id: t.crId, channel: 'platform', modelKey: 'agnes-2.5-flash', spec: `per_1m_tokens_${t.spec}`, unit: 'per_1m_tokens', unitQuantity: 1e6, costYuan: t.cost, source: 'official_list', provisional: false, effectiveFrom: null, effectiveTo: null },
      })
    }
    await prisma.marginPolicy.create({
      data: { id: 'mp-global', phase: 'launch', scope: 'global', scopeKey: '*', profitBp: 1000, priceFloorBp: 500, status: 'active' },
    })
  })

  async function materializeAndPublish(tag: string): Promise<void> {
    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const draft = await pub.createDraftFromActive(`${tag}`, `${tag}-draft`)
    await runMaterialize(draft.id)
    await pub.publish(draft.id)
  }

  it('第一轮 in 0.05 → 6 分/百万；改 0.10 再物化发布 → 12 分/百万（价格跟随）', async () => {
    await materializeAndPublish('t1-e2e-a')
    let svc = new PricingService(prisma as unknown as never)
    const q1 = await svc.quoteTextTokens(undefined, 'platform::agnes-2.5-flash', USAGE)
    expect(q1.credits).toBe(Math.ceil(1e6 / ratioOf(0.05, 1000))) // ceil(1e6/181818)=6

    await prisma.costRate.update({ where: { id: 'cr-in' }, data: { costYuan: 0.10 } })
    await materializeAndPublish('t1-e2e-b')
    svc = new PricingService(prisma as unknown as never)
    const q2 = await svc.quoteTextTokens(undefined, 'platform::agnes-2.5-flash', USAGE)
    expect(q2.credits).toBe(Math.ceil(1e6 / ratioOf(0.10, 1000))) // 90909 → 1e6/90909=11.00001 → ceil=12
    expect(q2.credits).not.toBe(q1.credits)
  })

  it('接线守卫：active 表中三段行与六段文本主体行 credits 逐一相等（spec §5.3，防双写漂移）', async () => {
    await materializeAndPublish('t1-guard')
    const active = await prisma.priceListVersion.findFirst({ where: { status: 'active' }, include: { entries: true } })
    const threeSeg = new Map<string, number>()
    for (const e of active!.entries) {
      if (e.matchKey.startsWith('text:') && !e.matchKey.includes('|')) threeSeg.set(e.matchKey, e.credits)
    }
    expect(threeSeg.size).toBeGreaterThanOrEqual(3)
    for (const e of active!.entries) {
      if (e.matchKey.includes('|') && e.matchKey.startsWith('text|')) {
        const [, model, spec] = e.matchKey.split('|')
        expect(threeSeg.get(`text:${model}:${spec}`)).toBe(e.credits)
      }
    }
  })

  it('公开反比率端点读到新值（getActiveTextTokenRatios 与扣费同源）', async () => {
    await materializeAndPublish('t1-ratios')
    const svc = new PricingService(prisma as unknown as never)
    const ratios = await svc.getActiveTextTokenRatios()
    expect(ratios['agnes-2.5-flash']?.in).toBe(ratioOf(0.05, 1000))
    expect(ratios['agnes-2.5-flash']?.out).toBe(ratioOf(0.15, 1000))
  })
})

describe('T1 归一化同源守卫（spec §4.3 核对点 1）', () => {
  it('TEXT_TOKEN_MODELS 每个成员经 modelOptionName 归一后恒等（物化拼 key 与 quoteTextTokens 同形）', () => {
    for (const m of TEXT_TOKEN_MODELS) {
      expect(modelOptionName(m).trim().toLowerCase()).toBe(m)
    }
  })
})

describe('T1 三段 text: 行物化（spec §4.1）', () => {
  beforeEach(async () => {
    await prisma.pricingSubject.create({
      data: {
        subjectKey: 'text|agnes-2.5-flash|in|agnes_hub|default',
        capability: 'text', modelKey: 'agnes-2.5-flash', spec: 'in',
        provider: 'agnes_hub', upstream: 'default', channelId: 'platform', status: 'priced',
        billableUnit: 'token_in', unitsPerRequest: 1e6, source: 'auto',
      },
    })
    await prisma.costRate.create({
      data: { id: 'cr-in', channel: 'platform', modelKey: 'agnes-2.5-flash', spec: 'per_1m_tokens_in', unit: 'per_1m_tokens', unitQuantity: 1e6, costYuan: 0.05, source: 'official_list', provisional: false, effectiveFrom: null, effectiveTo: null },
    })
    await prisma.marginPolicy.create({
      data: { id: 'mp-global', phase: 'launch', scope: 'global', scopeKey: '*', profitBp: 1000, priceFloorBp: 500, status: 'active' },
    })
  })

  it('物化后 draft 含三段行：credits=ratioOf(0.05,1000)=181818、subjectKey=null、costRateId 必带', async () => {
    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const draft = await pub.createDraftFromActive('t1-draft', 't1-v1')
    const res = await runMaterialize(draft.id)
    expect(res.missingCost).toHaveLength(0)
    const row = await prisma.priceListEntry.findFirst({ where: { versionId: draft.id, matchKey: 'text:agnes-2.5-flash:in' } })
    expect(row).not.toBeNull()
    expect(row!.credits).toBe(ratioOf(0.05, 1000)) // floor(1e8/(0.05×11000))=181818；误用 creditsOf 会得 66（数量级负例）
    expect(row!.subjectKey).toBeNull()
    expect(row!.basis).toBe('auto-derived')
    expect(row!.costRateId).toBe('cr-in')
  })

  it('幂等：同输入二次物化，三段行仅一条且 credits 不变', async () => {
    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const draft = await pub.createDraftFromActive('t1-v3', 't1-draft3')
    await runMaterialize(draft.id)
    await runMaterialize(draft.id)
    const rows = await prisma.priceListEntry.findMany({ where: { versionId: draft.id, matchKey: 'text:agnes-2.5-flash:in' } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.credits).toBe(ratioOf(0.05, 1000))
  })

  it('ops-modified 保护：运营手改三段行后，新成本物化不覆盖手改值', async () => {
    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const draft = await pub.createDraftFromActive('t1-v4', 't1-draft4')
    await runMaterialize(draft.id)
    await prisma.priceListEntry.updateMany({ where: { versionId: draft.id, matchKey: 'text:agnes-2.5-flash:in' }, data: { credits: 12345, basis: 'ops-modified', reason: '运营手工调价' } })
    await prisma.costRate.update({ where: { id: 'cr-in' }, data: { costYuan: 0.10 } })
    await runMaterialize(draft.id)
    const row = await prisma.priceListEntry.findFirst({ where: { versionId: draft.id, matchKey: 'text:agnes-2.5-flash:in' } })
    expect(row!.credits).toBe(12345)
    expect(row!.basis).toBe('ops-modified')
  })

  it('跨版本隔离：物化只写 draft，active 版本条目数不变', async () => {
    const before = await prisma.priceListEntry.findMany({ where: { versionId: 'base-active' } })
    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const draft = await pub.createDraftFromActive('t1-v2', 't1-draft2')
    await runMaterialize(draft.id)
    const after = await prisma.priceListEntry.findMany({ where: { versionId: 'base-active' } })
    expect(after.length).toBe(before.length)
  })
})
