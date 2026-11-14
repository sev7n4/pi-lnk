// Task 6 acceptance (preflight R1): temp-DB harness via `prisma db push`（本工作区无 .env /
// DATABASE_URL，裸 `new PrismaService()` 必 env 报错 ⇒ 判据失效；故改用 mkdtemp + db push +
// PrismaClient(datasources)，照 Task 1 集成测范式）。
//
// 验证：subjectKey 行必须被命中（AC11①）；删 subjectKey 列后回落 **legacy 行**（非
// 常量兜底——用 degraded 缺位证伪）；PRICING_SUBJECT_KEYS=off 逐字回落 legacy 行
// （AC11② / AC5）；constants-fallback 返回 degraded=true（AC8）。
//
// 关键判据：legacy 行命中路径**不**置 degraded，常量兜底路径**置** degraded=true。
// 因此「删 subjectKey 后 credits 回到 legacy 值」与「degraded 缺位」共同证伪「落回了
// 常量兜底」，确认六级解析确实在 subject 索引落空后穿透到第四/五级 legacy 行。
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const serverRoot = path.resolve(__dirname, '../..')

let dbUrl: string
let dbDir: string
let prisma: PrismaClient

beforeAll(() => {
  dbDir = mkdtempSync(path.join(tmpdir(), 's1-res-'))
  const dbFile = path.join(dbDir, 'test.db')
  dbUrl = `file:${dbFile}`
  execFileSync(
    'pnpm',
    ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: serverRoot, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' },
  )
  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })
})

afterAll(() => {
  rmSync(dbDir, { recursive: true, force: true })
})

async function seedActiveVersion() {
  // 幂等：测试间共享一个 active 版本；id/version 固定。
  await prisma.priceListVersion.upsert({
    where: { id: 's1-active' },
    update: { status: 'active' },
    create: { id: 's1-active', version: 's1-active', status: 'active' },
  })
  return 's1-active'
}

// legacy 行（真实发布流会种满；本测试只种命中项）。basis 为普通 String，无枚举约束。
async function seedLegacyEntry(versionId: string, matchKey: string, credits: number, capability: string) {
  return prisma.priceListEntry.create({
    data: {
      versionId,
      capability,
      matchKey,
      credits,
      basis: 'legacy-equivalent',
      subjectKey: null,
      costRateId: null,
    },
  })
}

async function seedSubjectRow(versionId: string, subjectKey: string, credits: number, capability = 'image') {
  return prisma.priceListEntry.create({
    data: {
      versionId,
      capability,
      // 注意：subject 行的 matchKey 用六段 subjectKey，不占用 legacy 的 `image:1K:1` 键，
      // 避免删 subjectKey 后该行的 credits 仍经 legacy 键被命中（污染判据）。
      matchKey: subjectKey,
      subjectKey,
      credits,
      basis: 'auto-derived',
      costRateId: null,
    },
  })
}

// 绕过 NestJS DI：PricingService 仅存储 prisma 字段，裸 PrismaClient 可直接注入。
async function makeService() {
  const svc = new (await import('./pricing.service')).PricingService(prisma as never)
  return svc as InstanceType<typeof import('./pricing.service').PricingService>
}

describe('subjectKey resolution (S1 six-level quote)', () => {
  beforeAll(async () => {
    await seedActiveVersion()
    // 共享 legacy 行：text 用精确键 `text`，image 1K 用 `image:1K:1`。
    await seedLegacyEntry('s1-active', 'text', 5, 'text')
    await seedLegacyEntry('s1-active', 'image:1K:1', 10, 'image')
  })

  it('AC11①：subjectKey 行命中；删 subjectKey 后回落 legacy 行（非常量兜底）', async () => {
    const v = await prisma.priceListVersion.findFirst({ where: { status: 'active' } })
    const key = 'image|seedream-5.0-pro|1K:1|volcengine|apimart'
    const row = await seedSubjectRow(v!.id, key, 77)
    const svc = await makeService()
    const q = {
      capability: 'image' as const,
      count: 1,
      resolution: '1K',
      modelKey: 'seedream-5.0-pro',
      provider: 'volcengine',
      upstream: 'apimart',
      spec: '1K:1',
    }
    const r1 = await svc.quote(q)
    expect(r1.credits).toBe(77) // ① subject 索引命中
    expect(r1.subjectKey).toBe(key) // 附带价格锁快照（成本/利润/来源）
    // 删 subjectKey：subject 索引落空 → 穿透到第四/五级 legacy 行（image:1K:1=10）
    await prisma.priceListEntry.update({ where: { id: row.id }, data: { subjectKey: null } })
    const svc2 = await makeService()
    const r2 = await svc2.quote(q)
    expect(r2.credits).toBe(10) // 回落 legacy 行
    expect(r2.degraded).toBeUndefined() // 真命中 legacy 行，非常量兜底
    await prisma.priceListEntry.delete({ where: { id: row.id } })
  })

  it('AC11② / AC5：PRICING_SUBJECT_KEYS=off 时逐字回落 legacy 行', async () => {
    process.env.PRICING_SUBJECT_KEYS = 'off'
    const svc = await makeService()
    const rT = await svc.quote({ capability: 'text' })
    expect(rT.credits).toBe(5)
    expect(rT.degraded).toBeUndefined() // 命中 legacy 行，非常量兜底
    const rI = await svc.quote({ capability: 'image', count: 1, resolution: '1K' })
    expect(rI.credits).toBe(10)
    expect(rI.degraded).toBeUndefined()
    delete process.env.PRICING_SUBJECT_KEYS
  })

  it('AC8：constants-fallback 返回 degraded=true 且计数 +1', async () => {
    process.env.PRICING_SOURCE = 'constants'
    const svc = await makeService()
    const r = await svc.quote({ capability: 'text' })
    expect(r).toMatchObject({ credits: 5, ruleVersion: 'constants-fallback', degraded: true })
    delete process.env.PRICING_SOURCE
  })
})
