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

  it('P1-a 起不再归档其他 active 版本（发布流接管，P0 遗物 updateMany 已移除）', async () => {
    // 原断言「seedPricing 归档非 v1 的 active 版本」——该 updateMany 分支已随
    // P1-a 发布流接管删除（seed-pricing.ts），非 v1 版本由发布流/promote 管理，
    // seed 只保证 v1 自身幂等，不再碰其他版本的状态。
    await prisma.priceListVersion.create({
      data: { version: 'v9-other-active', status: 'active', note: '验证 seed 不再越权归档', publishedAt: new Date() },
    })

    const beforeEntries = await prisma.priceListEntry.count({
      where: { version: { version: PRICING_VERSION_V1 } },
    })

    const seeded = await seedPricing(prisma)

    const other = await prisma.priceListVersion.findUnique({ where: { version: 'v9-other-active' } })
    expect(other?.status).toBe('active')
    const v1Entries = await prisma.priceListEntry.count({
      where: { version: { version: PRICING_VERSION_V1 } },
    })
    expect(v1Entries).toBe(beforeEntries)
    expect(seeded.entries).toBe(beforeEntries)
  }, 180_000) // 同首个 it：318 档 upsert 一轮超 vitest 默认 5s testTimeout；本机高负载下 pnpm exec 之外 seed 本身也慢
})
