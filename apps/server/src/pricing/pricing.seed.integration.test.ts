import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildMatchKey, legacyPriceOf } from './pricing.core'
import { enumeratePricingSpace } from './pricing.space'
import { PRICING_VERSION_V1, seedPricing } from '../../prisma/seed-pricing'

const serverRoot = path.resolve(__dirname, '../..')

describe('seedPricing against real SQLite', () => {
  let dir: string
  let prisma: PrismaClient

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-pricing-seed-'))
    const databaseUrl = `file:${path.join(dir, 'test.db')}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  }, 180_000) // 本机 pnpm exec 启动实测 ~70s（db push 本身 <1s），默认 10s hook 超时不够；同 pricing.schema.integration.test.ts 约定

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  it('seeds every enumerated case with legacy-identical credits (idempotent)', async () => {
    const first = await seedPricing(prisma)
    const space = enumeratePricingSpace()
    expect(first.version).toBe(PRICING_VERSION_V1)
    expect(first.entries).toBe(new Set(space.map(buildMatchKey)).size)

    const rows = await prisma.priceListEntry.findMany({
      where: { version: { version: PRICING_VERSION_V1 } },
    })
    expect(rows.length).toBe(first.entries)
    for (const q of space) {
      const row = rows.find((r) => r.matchKey === buildMatchKey(q))
      expect(row, buildMatchKey(q)).toBeDefined()
      expect(row!.credits).toBe(legacyPriceOf(q))
    }

    const second = await seedPricing(prisma)
    expect(second.entries).toBe(first.entries)
    const after = await prisma.priceListEntry.count()
    expect(after).toBe(first.entries)
  }, 180_000) // 裁决偏离（T4-b 同根因延伸）：318 档 ×2 轮 upsert 超 vitest 默认 5s testTimeout；只放宽超时，断言体 verbatim

  it('seeds exactly one active version and launch margin policy', async () => {
    const active = await prisma.priceListVersion.findMany({ where: { status: 'active' } })
    expect(active.length).toBe(1)
    const policy = await prisma.marginPolicy.findUnique({ where: { phase: 'launch' } })
    expect(policy?.marginBp).toBe(11000)
    expect(policy?.anchorCents).toBe(1)
    const rates = await prisma.costRate.count()
    expect(rates).toBeGreaterThanOrEqual(15)
  })

  it('archives any other active version when re-seeding (单一 active 不变量)', async () => {
    // 预置第二个 active 版本——静态断言 active.length === 1 覆盖不到的分叉：
    // seedPricing 的 updateMany 归档分支（seed-pricing.ts 末段）零覆盖，
    // Task 5 PricingService 只读 THE active 版本，该不变量是承重的。
    await prisma.priceListVersion.create({
      data: { version: 'v9-other-active', status: 'active', note: '覆盖归档分支：非 v1 的 active 版本', publishedAt: new Date() },
    })
    const preActive = await prisma.priceListVersion.findMany({ where: { status: 'active' } })
    expect(preActive.length).toBe(2)

    const beforeEntries = await prisma.priceListEntry.count({
      where: { version: { version: PRICING_VERSION_V1 } },
    })

    const seeded = await seedPricing(prisma)

    const other = await prisma.priceListVersion.findUnique({ where: { version: 'v9-other-active' } })
    expect(other?.status).toBe('archived')
    const postActive = await prisma.priceListVersion.findMany({ where: { status: 'active' } })
    expect(postActive.length).toBe(1)
    expect(postActive[0]!.version).toBe(PRICING_VERSION_V1)
    const v1Entries = await prisma.priceListEntry.count({
      where: { version: { version: PRICING_VERSION_V1 } },
    })
    expect(v1Entries).toBe(beforeEntries)
    expect(seeded.entries).toBe(beforeEntries)
  }, 180_000) // 同首个 it：318 档 upsert 一轮超 vitest 默认 5s testTimeout；本机高负载下 pnpm exec 之外 seed 本身也慢
})
