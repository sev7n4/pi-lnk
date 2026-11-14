// Task 9 acceptance（preflight R1）：真 SQLite 全链，走 mkdtemp + db push + PrismaClient 范式。
//
// 覆盖：AC1（成本→利润→物化→发布→计费命中，展示同源）、AC3（缺成本主体 → materialize
// 报 missingCost 且 validatePublish 违规）、AC10（schema 无币种/汇率字段 + 改 FX 环境变量零影响
// + 成本端点拒收币种字段 400）、AC13（发布流六字段透传 + ops-modified 缺 reason 400）；
// 并附 4 处代表性变异（profitBp±1 / 删 CostRate / token unitQuantity 1e6→1 / PRICING_SUBJECT_KEYS=off）
// 证明判据敏感（变异不 RED 先疑伪变异）。
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PricingService } from './pricing.service'
import { PricingController } from './pricing.controller'
import { PricingPublishingService } from './pricing-publishing.service'
import { PricingMaterializerService, creditsOf, ratioOf } from './pricing-materializer.service'
import { PricingCostController } from '../admin/pricing-cost.controller'
import { PricingSubjectController } from '../admin/pricing-subject.controller'
import { PricingMarginController } from '../admin/pricing-margin.controller'
import { PricingMaterializeController } from '../admin/pricing-materialize.controller'
import { PricingSubjectService } from '../pricing/pricing-subject.service'
import { parseEntriesBody } from '../admin/pricing-publishing.controller'
import type { SubjectRow } from './pricing-subject.service'
import type { UnitCostRateRow } from './pricing-unit-cost'
import type { MarginRow } from './pricing-margin.service'

const serverRoot = path.resolve(__dirname, '../..')

let dbUrl: string
let dbDir: string
let prisma: PrismaClient

beforeAll(() => {
  dbDir = mkdtempSync(path.join(tmpdir(), 's1-acc-'))
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

describe('S1 acceptance — AC1/AC3/AC10/AC13', () => {
  it('AC1：新主体 成本→15% 利润→物化→发布→计费命中，且展示同源（无 degraded）', async () => {
    await prisma.pricingSubject.create({
      data: {
        subjectKey: 'image|new-image-model|1K:1|volcengine|apimart',
        capability: 'image', modelKey: 'new-image-model', spec: '1K:1',
        provider: 'volcengine', upstream: 'apimart', channelId: 'platform', status: 'priced',
        billableUnit: 'image_count', unitsPerRequest: 1, source: 'auto',
      },
    })
    await prisma.costRate.create({
      data: { id: 'cr1', channel: 'volcengine', modelKey: 'new-image-model', spec: '1K', unit: 'per_image', unitQuantity: 1, costYuan: 0.3, source: 'official_list' },
    })
    await prisma.marginPolicy.create({
      data: { id: 'mp1', phase: 'launch', scope: 'global', scopeKey: '*', profitBp: 1500, priceFloorBp: 500, status: 'active' },
    })
    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const draft = await pub.createDraftFromActive('ac1-draft', 'ac1')
    const res = await runMaterialize(draft.id)
    expect(res.added).toBeGreaterThanOrEqual(1)
    expect(res.missingCost).toHaveLength(0)
    await pub.publish(draft.id)

    const svc = new PricingService(prisma as unknown as never)
    const q = await svc.quote({ capability: 'image', count: 1, resolution: '1K', modelKey: 'new-image-model', provider: 'volcengine', upstream: 'apimart', spec: '1K:1' })
    const expected = creditsOf(0.3, 1500)
    expect(q.credits).toBe(expected)
    expect(q).toMatchObject({ subjectKey: 'image|new-image-model|1K:1|volcengine|apimart', profitBp: 1500, costYuanPerRequest: 0.3 })
    expect('degraded' in q).toBe(false)

    // 展示端点与计费 quote 同源
    const c = new PricingController(svc)
    const dq = await c.quote({ capability: 'image', count: '1', resolution: '1K', modelKey: 'new-image-model', provider: 'volcengine', upstream: 'apimart', spec: '1K:1' })
    expect(dq.data.credits).toBe(expected)
  })

  it('AC3：缺成本主体 → materialize 报 missingCost 且不写价目行；validatePublish 违规', async () => {
    await prisma.pricingSubject.create({
      data: {
        subjectKey: 'image|orphan|1K:1|volcengine|apimart',
        capability: 'image', modelKey: 'orphan', spec: '1K:1',
        provider: 'volcengine', upstream: 'apimart', channelId: 'platform', status: 'cost_missing',
        billableUnit: 'image_count', unitsPerRequest: 1, source: 'auto',
      },
    })
    // 故意不建 costRate ⇒ 该主体缺成本
    await prisma.marginPolicy.create({
      data: { id: 'mp1', phase: 'launch', scope: 'global', scopeKey: '*', profitBp: 1500, priceFloorBp: 500, status: 'active' },
    })
    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const draft = await pub.createDraftFromActive('ac3-draft', 'ac3')
    const res = await runMaterialize(draft.id)
    expect(res.missingCost).toContain('image|orphan|1K:1|volcengine|apimart')
    // 缺成本主体未落价目行
    const written = await prisma.priceListEntry.findMany({ where: { versionId: draft.id } })
    expect(written).toHaveLength(0)

    const verdict = await pub.validatePublish(draft.id)
    expect(verdict.ok).toBe(false)
    // 缺成本主体 ⇒ materialize 不写价目行 ⇒ draft 为空 ⇒ 空集假绿防线拦截（同为成本类硬拒）
    expect(verdict.violations.join('; ')).toMatch(/draft 条目为空|缺成本主体/)
  })

  it('AC10：schema 无币种/汇率字段；改 FX 环境变量零影响；成本端点拒收币种字段 400', async () => {
    const models = Prisma.dmmf.datamodel.models.filter((m) => ['CostRate', 'PriceListEntry', 'MarginPolicy'].includes(m.name))
    for (const m of models) {
      const fields = m.fields.map((f) => f.name)
      for (const bad of ['currencySrc', 'fxRate', 'fxUsdCny', 'usdPerM', 'costUsd']) {
        expect(fields).not.toContain(bad)
      }
    }
    // 改 FX 环境变量对 creditsOf 零影响（AC10 验收边界：只约束 quote/materialize，不计 USD 兜底）
    const before = creditsOf(2.86, 1000)
    process.env.PRICING_FX_USD_CNY = '9.99'
    expect(creditsOf(2.86, 1000)).toBe(before)
    delete process.env.PRICING_FX_USD_CNY

    // 成本端点拒收币种字段（D9 单一人民币守卫）
    const costCtrl = new PricingCostController(prisma as unknown as never)
    await expect(costCtrl.upsert({ currency: 'USD', channel: 'c', modelKey: 'm', spec: 's', unit: 'per_image', costYuan: 1 } as Record<string, unknown>)).rejects.toThrow(/人民币|currency/)
  })

  it('AC13：发布流六字段透传；ops-modified 缺 reason → 400', async () => {
    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const draft = await pub.createDraftFromActive('ac13-draft', 'ac13')
    await pub.upsertEntries(draft.id, [
      {
        matchKey: 'image|x|1K:3|p|u', capability: 'image', credits: 100,
        subjectKey: 'image|x|1K:3|p|u', costSnapshotYuan: 0.9,
        unitSnapshot: '{"billableUnit":"image_count","unitQuantity":1,"unitsPerRequest":3}',
        profitBpSnapshot: 1000, marginPolicyId: null, reason: 'manual', basis: 'ops-modified',
      },
    ])
    const row = await prisma.priceListEntry.findFirst({ where: { versionId: draft.id, matchKey: 'image|x|1K:3|p|u' } })
    expect(row).toMatchObject({ subjectKey: 'image|x|1K:3|p|u', costSnapshotYuan: 0.9, profitBpSnapshot: 1000, reason: 'manual' })

    // 发布 d 使其成 active（走发布门禁 happy path），再建草案验证六字段复制链：
    // 运营「复制 active 建草案 + 微调」日常路径下成本/计量/利润快照随版本演进保留。
    await pub.publish(draft.id)
    const d2 = await pub.createDraftFromActive('ac13-draft-2', 'copy')
    const copy = await prisma.priceListEntry.findFirst({ where: { versionId: d2.id, matchKey: 'image|x|1K:3|p|u' } })
    expect(copy?.costSnapshotYuan).toBe(0.9)

    // ops-modified 缺 reason → 400（AC13 真源不静默丢；守卫在控制器 parseEntriesBody 层）
    expect(() => parseEntriesBody({
      entries: [{ matchKey: 'image|y|1K:1|p|u', capability: 'image', credits: 50, basis: 'ops-modified' }],
    })).toThrow(/reason/)
  })
})

describe('S1 acceptance — 变异自检（判据必须敏感）', () => {
  it('变异①：profitBp ±1 ⇒ 价格变化（证明利润率真被消费）', async () => {
    // 注：子元级单次成本（如 0.3 元）下 profitBp ±1 落在 ceil 取整分辨率以下，恒不改变积分——
    // 那是「伪变异」（即便不消费 profitBp 也绿）。本变异用 costYuan=100（使 ±1bp 跨整数边界）
    // 证真实消费；等价断言 creditsOf(100,1500)≠creditsOf(100,1499)。
    await prisma.pricingSubject.create({
      data: { subjectKey: 'image|m1|1K:1|v|u', capability: 'image', modelKey: 'm1', spec: '1K:1', provider: 'v', upstream: 'u', channelId: 'platform', status: 'priced', billableUnit: 'image_count', unitsPerRequest: 1, source: 'auto' },
    })
    await prisma.costRate.create({ data: { id: 'cr', channel: 'v', modelKey: 'm1', spec: '1K', unit: 'per_image', unitQuantity: 1, costYuan: 100, source: 'official_list' } })
    await prisma.marginPolicy.create({ data: { id: 'mp', phase: 'launch', scope: 'global', scopeKey: '*', profitBp: 1500, priceFloorBp: 500, status: 'active' } })
    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const d1 = await pub.createDraftFromActive('m1-a', 'a')
    await runMaterialize(d1.id)
    const c1500 = (await prisma.priceListEntry.findFirst({ where: { versionId: d1.id } }))!.credits
    // 变异：profitBp 改为 1499
    await prisma.marginPolicy.update({ where: { phase: 'launch' }, data: { profitBp: 1499 } })
    const d2 = await pub.createDraftFromActive('m1-b', 'b')
    await runMaterialize(d2.id)
    const c1499 = (await prisma.priceListEntry.findFirst({ where: { versionId: d2.id } }))!.credits
    expect(c1500).not.toBe(c1499)
    expect(c1500).toBe(creditsOf(100, 1500))
    expect(c1499).toBe(creditsOf(100, 1499))
  })

  it('变异②：删除一条 CostRate ⇒ 该主体 missingCost（证明成本真被查）', async () => {
    await prisma.pricingSubject.create({
      data: { subjectKey: 'image|m2|1K:1|v|u', capability: 'image', modelKey: 'm2', spec: '1K:1', provider: 'v', upstream: 'u', channelId: 'platform', status: 'priced', billableUnit: 'image_count', unitsPerRequest: 1, source: 'auto' },
    })
    await prisma.costRate.create({ data: { id: 'cr2', channel: 'v', modelKey: 'm2', spec: '1K', unit: 'per_image', unitQuantity: 1, costYuan: 0.3, source: 'official_list' } })
    await prisma.marginPolicy.create({ data: { id: 'mp2', phase: 'launch', scope: 'global', scopeKey: '*', profitBp: 1500, priceFloorBp: 500, status: 'active' } })
    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const d1 = await pub.createDraftFromActive('m2-a', 'a')
    const r1 = await runMaterialize(d1.id)
    expect(r1.missingCost).toHaveLength(0)
    // 变异：删除 CostRate
    await prisma.costRate.delete({ where: { id: 'cr2' } })
    const d2 = await pub.createDraftFromActive('m2-b', 'b')
    const r2 = await runMaterialize(d2.id)
    expect(r2.missingCost).toContain('image|m2|1K:1|v|u')
  })

  it('变异⑥：token 成本行 unitQuantity 1e6→1 ⇒ ratioOf 变化（证明单位归一真被消费）', async () => {
    await prisma.pricingSubject.create({
      data: { subjectKey: 'text|m3|in|v|u', capability: 'text', modelKey: 'm3', spec: 'in', provider: 'v', upstream: 'u', channelId: 'platform', status: 'priced', billableUnit: 'token_in', unitsPerRequest: null, source: 'auto' },
    })
    await prisma.costRate.create({ data: { id: 'cr3', channel: 'v', modelKey: 'm3', spec: 'in', unit: 'per_1m_tokens', unitQuantity: 1e6, costYuan: 2, source: 'official_list' } })
    await prisma.marginPolicy.create({ data: { id: 'mp3', phase: 'launch', scope: 'global', scopeKey: '*', profitBp: 1000, priceFloorBp: 500, status: 'active' } })
    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const d1 = await pub.createDraftFromActive('m3-a', 'a')
    await runMaterialize(d1.id)
    const r1 = (await prisma.priceListEntry.findFirst({ where: { versionId: d1.id } }))!.credits
    // 变异：unitQuantity 1e6 → 1（破坏归一）
    await prisma.costRate.update({ where: { id: 'cr3' }, data: { unitQuantity: 1 } })
    const d2 = await pub.createDraftFromActive('m3-b', 'b')
    await runMaterialize(d2.id)
    const r2 = (await prisma.priceListEntry.findFirst({ where: { versionId: d2.id } }))!.credits
    expect(r1).toBe(ratioOf(2, 1000))
    expect(r2).not.toBe(r1)
  })

  it('变异⑦：PRICING_SUBJECT_KEYS=off ⇒ subjectKey 索引不生效，回落非 subjectMeta 路径（证明双索引真被消费）', async () => {
    await prisma.pricingSubject.create({
      data: { subjectKey: 'image|m4|1K:1|v|u', capability: 'image', modelKey: 'm4', spec: '1K:1', provider: 'v', upstream: 'u', channelId: 'platform', status: 'priced', billableUnit: 'image_count', unitsPerRequest: 1, source: 'auto' },
    })
    await prisma.costRate.create({ data: { id: 'cr4', channel: 'v', modelKey: 'm4', spec: '1K', unit: 'per_image', unitQuantity: 1, costYuan: 0.3, source: 'official_list' } })
    await prisma.marginPolicy.create({ data: { id: 'mp4', phase: 'launch', scope: 'global', scopeKey: '*', profitBp: 1500, priceFloorBp: 500, status: 'active' } })
    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const draft = await pub.createDraftFromActive('m4', 'a')
    await runMaterialize(draft.id)
    await pub.publish(draft.id)
    const svc = new PricingService(prisma as unknown as never)
    const on = await svc.quote({ capability: 'image', count: 1, resolution: '1K', modelKey: 'm4', provider: 'v', upstream: 'u', spec: '1K:1' })
    // on 模式：命中 subjectKey 行，附价格锁快照（costYuanPerRequest / profitBp）
    expect('costYuanPerRequest' in on).toBe(true)
    expect((on as { costYuanPerRequest?: number }).costYuanPerRequest).toBe(0.3)
    // 变异：关 subjectKey 解析 → 不再走 subjectMeta 附加路径
    process.env.PRICING_SUBJECT_KEYS = 'off'
    try {
      const off = await svc.quote({ capability: 'image', count: 1, resolution: '1K', modelKey: 'm4', provider: 'v', upstream: 'u', spec: '1K:1' })
      expect('costYuanPerRequest' in off).toBe(false) // 回落匹配键/legacy 路径，无价格锁快照
    } finally {
      delete process.env.PRICING_SUBJECT_KEYS
    }
  })
})

describe('S1 acceptance — 运维端点（GET 列表 / 物化 / 就绪，前端契约）', () => {
  it('成本 GET 列表 / 主体 GET 列表 / 利润 GET 列表 返回真库行', async () => {
    await prisma.pricingSubject.create({
      data: { subjectKey: 'image|m5|1K:1|v|u', capability: 'image', modelKey: 'm5', spec: '1K:1', provider: 'v', upstream: 'u', channelId: 'platform', status: 'priced', billableUnit: 'image_count', unitsPerRequest: 1, source: 'auto' },
    })
    await prisma.costRate.create({ data: { id: 'cr5', channel: 'v', modelKey: 'm5', spec: '1K', unit: 'per_image', unitQuantity: 1, costYuan: 0.5, source: 'negotiated' } })
    await prisma.marginPolicy.create({ data: { id: 'mp5', phase: 'launch', scope: 'global', scopeKey: '*', profitBp: 1500, priceFloorBp: 500, status: 'active' } })

    const costRows = await new PricingCostController(prisma as unknown as never).list()
    expect(costRows.data.find((r) => r.id === 'cr5' && r.costYuan === 0.5 && r.source === 'negotiated')).toBeTruthy()

    const subjectRows = await new PricingSubjectController(new PricingSubjectService(prisma as unknown as never), prisma as unknown as never).list()
    expect(subjectRows.data.find((r) => r.subjectKey === 'image|m5|1K:1|v|u' && r.status === 'priced')).toBeTruthy()

    const marginRows = await new PricingMarginController(prisma as unknown as never).list()
    expect(marginRows.data.find((r) => r.id === 'mp5' && r.profitBp === 1500)).toBeTruthy()
  })

  it('物化（POST :id/materialize）→ MaterializeResult；就绪（GET :id/readiness）→ 全过可发布', async () => {
    await prisma.pricingSubject.create({
      data: { subjectKey: 'image|m6|1K:1|v|u', capability: 'image', modelKey: 'm6', spec: '1K:1', provider: 'v', upstream: 'u', channelId: 'platform', status: 'priced', billableUnit: 'image_count', unitsPerRequest: 1, source: 'auto' },
    })
    await prisma.costRate.create({ data: { id: 'cr6', channel: 'v', modelKey: 'm6', spec: '1K', unit: 'per_image', unitQuantity: 1, costYuan: 0.5, source: 'negotiated' } })
    await prisma.marginPolicy.create({ data: { id: 'mp6', phase: 'launch', scope: 'global', scopeKey: '*', profitBp: 1500, priceFloorBp: 500, status: 'active' } })

    const pub = new PricingPublishingService(prisma as unknown as never, new PricingService(prisma as unknown as never))
    const draft = await pub.createDraftFromActive('ops-ep', 'ops')
    const materializeCtrl = new PricingMaterializeController(
      prisma as unknown as never,
      new PricingMaterializerService(prisma as unknown as never),
      pub,
    )
    const mat = (await materializeCtrl.materialize(draft.id)).data
    expect(mat.added).toBeGreaterThanOrEqual(1)
    expect(mat.missingCost).toHaveLength(0)

    const verdict = (await materializeCtrl.readiness(draft.id)).data
    expect(verdict.ok).toBe(true)
    expect(verdict.violations).toHaveLength(0)
  })
})
