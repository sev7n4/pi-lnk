// Task 1 acceptance per preflight R1 (temp-DB harness) + R2 (shape + backfill correctness).
// R2/R8 override the brief's Step 1 production-DB assertions: this workspace has no .env /
// DATABASE_URL, and `db push` creates an empty DB and does NOT run migrations/*.sql. So this test:
//   1) proves the additive shape on a db-push temp DB,
//   2) inserts sample rows and executes ONLY the UPDATE / CREATE UNIQUE INDEX statements
//      read from migration.sql (skipping ALTER TABLE, since db push already built the columns),
//   3) textually asserts migration.sql covers every new schema.prisma column and never
//      UPDATEs PriceListEntry (production v2-launch 341 rows stay byte-for-byte unchanged),
//   4) re-runs the backfill to prove idempotency.
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const serverRoot = path.resolve(__dirname, '../..')
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma')
const migrationSqlPath = path.join(
  serverRoot,
  'prisma/migrations/20261114140000_pricing_s1/migration.sql',
)

// New columns added to EXISTING models: each must have an ALTER TABLE ... ADD COLUMN.
const newColumnsByTable: Record<string, string[]> = {
  PriceListVersion: ['revision'],
  PriceListEntry: [
    'subjectKey', 'costSnapshotYuan', 'unitSnapshot',
    'profitBpSnapshot', 'marginPolicyId', 'reason',
  ],
  CostRate: [
    'provider', 'upstream', 'unitQuantity', 'effectiveFrom',
    'effectiveTo', 'sourceRef', 'provisional',
  ],
  MarginPolicy: [
    'scope', 'scopeKey', 'profitBp', 'priceFloorBp',
    'effectiveFrom', 'effectiveTo', 'status',
  ],
}

// New table's columns: each must appear in CREATE TABLE "PricingSubject".
const pricingSubjectColumns = [
  'id', 'subjectKey', 'capability', 'modelKey', 'spec', 'provider',
  'upstream', 'channelId', 'status', 'billableUnit', 'unitsPerRequest',
  'defaultSubjectKey', 'source', 'createdAt', 'updatedAt',
]

const BACKFILL_VERSION = 's1-backfill-version'
const ENTRY_CREDITS: Record<string, number> = { 'image:1K:1': 33, 'audio:music': 15 }

interface SampleCostRate {
  modelKey: string
  spec: string
  unit: string
  costYuan: number
  note: string | null
  unitQuantity: number
  provisional: boolean
}

// Covers per_1m_tokens / per_image / per_100_chars / per_song / PROVISIONAL / 线性推算.
const SAMPLE_COST_RATES: SampleCostRate[] = [
  { modelKey: 's1-tokens', spec: 'per_1m_tokens_in', unit: 'per_1m_tokens', costYuan: 2, note: null, unitQuantity: 1e6, provisional: false },
  { modelKey: 's1-image', spec: '1K', unit: 'per_image', costYuan: 0.3, note: null, unitQuantity: 1, provisional: false },
  { modelKey: 's1-chars', spec: 'per_100_chars', unit: 'per_call', costYuan: 0.1, note: null, unitQuantity: 100, provisional: true },
  { modelKey: 's1-song', spec: 'per_song', unit: 'per_call', costYuan: 0.5, note: null, unitQuantity: 1, provisional: true },
  { modelKey: 's1-prov', spec: '1K', unit: 'per_video', costYuan: 1, note: 'PROVISIONAL agnes', unitQuantity: 1, provisional: true },
  { modelKey: 's1-linear', spec: '768p:5s', unit: 'per_video', costYuan: 1, note: '视频 4s 线性推算', unitQuantity: 1, provisional: true },
]

function modelBlock(schema: string, model: string): string {
  return schema.match(new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? ''
}

function migrationStatements(): string[] {
  const raw = readFileSync(migrationSqlPath, 'utf8')
  const noComments = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  return noComments.split(';').map((s) => s.trim()).filter(Boolean)
}

// R2: execute only UPDATE + CREATE UNIQUE INDEX (skip ALTER TABLE / CREATE TABLE / CREATE INDEX).
async function runBackfill(prisma: PrismaClient): Promise<void> {
  for (const stmt of migrationStatements()) {
    if (/^(UPDATE|CREATE\s+UNIQUE\s+INDEX)\b/i.test(stmt)) {
      await prisma.$executeRawUnsafe(stmt)
    }
  }
}

async function assertBackfilled(prisma: PrismaClient): Promise<void> {
  for (const r of SAMPLE_COST_RATES) {
    const row = await prisma.costRate.findFirst({ where: { modelKey: r.modelKey } })
    expect(row, r.modelKey).not.toBeNull()
    expect(row!.unitQuantity, r.modelKey).toBe(r.unitQuantity)
    expect(row!.provisional, r.modelKey).toBe(r.provisional)
    expect(row!.source, r.modelKey).toBe('official_list') // 复用现网 source，无 costSource 列
  }
  const policy = await prisma.marginPolicy.findFirst({ where: { phase: 'launch' } })
  expect(policy).not.toBeNull()
  expect(policy).toMatchObject({ scope: 'global', profitBp: 1000, priceFloorBp: 500, status: 'active' })
  const v = await prisma.priceListVersion.findFirst({ where: { version: BACKFILL_VERSION } })
  expect(v?.revision).toBe(0)
  // 行为断言：无任何 UPDATE PriceListEntry（存量行一条不改）
  const entries = await prisma.priceListEntry.findMany({ where: { versionId: v!.id } })
  for (const [matchKey, credits] of Object.entries(ENTRY_CREDITS)) {
    const e = entries.find((x) => x.matchKey === matchKey)
    expect(e?.credits, matchKey).toBe(credits)
    expect(e?.subjectKey, matchKey).toBeNull()
  }
}

describe('S1 additive schema + idempotent backfill (R1/R2)', () => {
  let dir: string
  let prisma: PrismaClient

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-pricing-s1-'))
    const databaseUrl = `file:${path.join(dir, 'test.db')}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  }, 180_000)

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  it('db push 形状：PricingSubject 可写 / channelId 默认 platform / PriceListEntry 新列可写 / revision 默认 0', async () => {
    const subject = await prisma.pricingSubject.create({
      data: {
        subjectKey: 'image|seedream-5.0-pro|1K:1|volcengine|apimart',
        capability: 'image', modelKey: 'seedream-5.0-pro', spec: '1K:1',
        provider: 'volcengine', upstream: 'apimart', billableUnit: 'image_count',
      },
    })
    expect(subject.channelId).toBe('platform')
    expect(subject.status).toBe('draft')
    expect(subject.source).toBe('auto')
    await prisma.pricingSubject.delete({ where: { id: subject.id } })

    const v = await prisma.priceListVersion.create({ data: { version: 's1-shape-version', status: 'draft' } })
    expect(v.revision).toBe(0)
    const entry = await prisma.priceListEntry.create({
      data: {
        versionId: v.id, capability: 'image',
        matchKey: 'image|seedream-5.0-pro|1K:1|volcengine|apimart', credits: 42,
        subjectKey: 'image|seedream-5.0-pro|1K:1|volcengine|apimart',
        costSnapshotYuan: 0.9, unitSnapshot: '{"billableUnit":"image_count","unitQuantity":1,"unitsPerRequest":1}',
        profitBpSnapshot: 1000, marginPolicyId: 'mp-s1', reason: 'ops',
      },
    })
    expect(entry.subjectKey).toBe('image|seedream-5.0-pro|1K:1|volcengine|apimart')
    expect(entry.costSnapshotYuan).toBeCloseTo(0.9)
    expect(entry.unitSnapshot).toContain('billableUnit')
    expect(entry.profitBpSnapshot).toBe(1000)
    expect(entry.marginPolicyId).toBe('mp-s1')
    expect(entry.reason).toBe('ops')
    await prisma.priceListEntry.delete({ where: { id: entry.id } })
    await prisma.priceListVersion.delete({ where: { id: v.id } })
  })

  it('migration.sql 的 UPDATE 回填在 db-push 库上正确', async () => {
    for (const r of SAMPLE_COST_RATES) {
      await prisma.costRate.create({
        data: {
          channel: 'platform', modelKey: r.modelKey, spec: r.spec,
          unit: r.unit, costYuan: r.costYuan, note: r.note,
        },
      })
    }
    // pre-backfill 哨兵值：证明 UPDATE 语句确实把值写成口径值（而非恰好等于缺省）。
    await prisma.marginPolicy.create({
      data: {
        phase: 'launch', anchorCents: 1, marginBp: 11000,
        scope: 'pre-backfill', profitBp: 0, priceFloorBp: 0, status: 'pre-backfill',
      },
    })
    await prisma.priceListVersion.create({
      data: { version: BACKFILL_VERSION, status: 'active', revision: 7 },
    })
    const v = await prisma.priceListVersion.findFirstOrThrow({ where: { version: BACKFILL_VERSION } })
    for (const [matchKey, credits] of Object.entries(ENTRY_CREDITS)) {
      await prisma.priceListEntry.create({
        data: { versionId: v.id, capability: 'image', matchKey, credits },
      })
    }

    const preTokens = await prisma.costRate.findFirstOrThrow({ where: { modelKey: 's1-tokens' } })
    expect(preTokens.unitQuantity).toBe(1) // @default(1) → 回填才有工作可做
    expect(preTokens.provisional).toBe(false)
    const prePolicy = await prisma.marginPolicy.findFirstOrThrow({ where: { phase: 'launch' } })
    expect(prePolicy.scope).toBe('pre-backfill')
    expect((await prisma.priceListVersion.findFirstOrThrow({ where: { version: BACKFILL_VERSION } })).revision).toBe(7)

    await runBackfill(prisma)
    await assertBackfilled(prisma)

    // CREATE UNIQUE INDEX 语句确实被执行（部分唯一索引已建立）
    const idx = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='PriceListEntry_versionId_subjectKey_key'",
    )
    expect(idx.map((r) => r.name)).toContain('PriceListEntry_versionId_subjectKey_key')
  })

  it('文本断言：migration.sql 覆盖每个新列、不 UPDATE PriceListEntry、无币种/汇率列', () => {
    expect(existsSync(migrationSqlPath), 'migration.sql 必须存在').toBe(true)
    const schema = readFileSync(schemaPath, 'utf8')
    const sql = readFileSync(migrationSqlPath, 'utf8')

    for (const [table, columns] of Object.entries(newColumnsByTable)) {
      const block = modelBlock(schema, table)
      expect(block.length, `schema.prisma 缺少 model ${table}`).toBeGreaterThan(0)
      for (const col of columns) {
        expect(new RegExp(`^\\s*${col}\\s+\\S`, 'm').test(block), `schema.prisma ${table}.${col} 缺字段`).toBe(true)
        expect(
          new RegExp(`ALTER TABLE "${table}" ADD COLUMN "${col}"`, 'i').test(sql),
          `migration.sql 缺 ${table}.${col} 的 ALTER`,
        ).toBe(true)
      }
    }
    const alterCount = (sql.match(/ALTER TABLE/gi) ?? []).length
    const expectedAlters = Object.values(newColumnsByTable).reduce((n, c) => n + c.length, 0)
    expect(alterCount, 'ALTER TABLE 数量必须与新列数一致（无多余/遗漏）').toBe(expectedAlters)

    // 新表 CREATE TABLE 覆盖 PricingSubject 全部列
    expect(sql).toContain('CREATE TABLE "PricingSubject"')
    expect(schema).toContain('model PricingSubject {')
    const createTableBlock = sql.match(/CREATE TABLE "PricingSubject" \(([\s\S]*?)\);/)?.[1] ?? ''
    for (const col of pricingSubjectColumns) {
      expect(createTableBlock, `CREATE TABLE 缺 PricingSubject.${col}`).toContain(`"${col}"`)
    }

    // 存量 341 行一条不改：不含任何 UPDATE PriceListEntry（带/不带引号）
    expect(/UPDATE\s+"?PriceListEntry\b/i.test(sql), 'migration.sql 不得 UPDATE PriceListEntry').toBe(false)

    // 全局约束：不新增币种/汇率/costSource 列
    for (const forbidden of ['currencySrc', 'fxRate', 'fxUsdCny', 'costSource']) {
      expect(schema.includes(forbidden), `schema.prisma 不得出现 ${forbidden}`).toBe(false)
      expect(sql.includes(forbidden), `migration.sql 不得出现 ${forbidden}`).toBe(false)
    }
  })

  it('回填幂等：重跑 UPDATE / CREATE UNIQUE INDEX 值不变且不报错', async () => {
    await expect(runBackfill(prisma)).resolves.toBeUndefined()
    await assertBackfilled(prisma)
  })
})
