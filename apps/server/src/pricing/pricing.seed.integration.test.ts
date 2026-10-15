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
    expect(rates).toBeGreaterThanOrEqual(20) // 18 原始行 + 4s 推算 2 行（2026-10-15 收尾包）
    // 4s 推算行内容锚（spec §6.2：vendor 无 4s SKU，按 5s 锚点×4/5 线性推算，
    // P2 渠道对账以真实账单校准）
    const r768p4s = await prisma.costRate.findUnique({
      where: { channel_modelKey_spec: { channel: 'platform', modelKey: 'minimax-h3', spec: '768p:4s' } },
    })
    expect(r768p4s?.costYuan).toBe(2.288) // 2.86 × 4/5
    expect(r768p4s?.note).toContain('推算')
    const r2k4s = await prisma.costRate.findUnique({
      where: { channel_modelKey_spec: { channel: 'platform', modelKey: 'minimax-h3', spec: '2k:4s' } },
    })
    expect(r2k4s?.costYuan).toBe(3.72) // 4.65 × 4/5
    expect(r2k4s?.note).toContain('推算')
  })

  it('单active 不变量（承重，勿删）：已有其它 active 版本时 seed 拒绝播种，不造第二个 active', async () => {
    // P1-a 删掉了原「归档非 v1 的 active 版本」updateMany（归档运营版本状态属越权），
    // 但删掉后seed 只保证 v1 自身幂等 —— 若库里已有别的 active 版本，重跑 seed 会
    // 造出第二个 active，而 loadActiveTable 用无序 findFirst，取到哪个不确定
    // ⇒ 扣费金额随机漂。改为 fail-closed：拒绝并报错，改价/发布走发布流。
    await prisma.priceListVersion.create({
      data: { version: 'v9-other-active', status: 'active', note: '运营发布流建出的版本', publishedAt: new Date() },
    })

    const beforeEntries = await prisma.priceListEntry.count({
      where: { version: { version: PRICING_VERSION_V1 } },
    })

    const err = await seedPricing(prisma).catch((e) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('v9-other-active')
    expect(err.message).toContain('拒绝造第二个 active')

    // 既有状态零变化：其它 active 不被 seed 越权归档，v1 条目数不变
    const other = await prisma.priceListVersion.findUnique({ where: { version: 'v9-other-active' } })
    expect(other?.status).toBe('active')
    const v1Entries = await prisma.priceListEntry.count({
      where: { version: { version: PRICING_VERSION_V1 } },
    })
    expect(v1Entries).toBe(beforeEntries)
  }, 180_000) // 同首个 it：本机高负载下 318 档 upsert 一轮超 vitest 默认 5s testTimeout

  it('幂等：把别的 active 撤下后重跑 seed 仍成功且 v1 自身幂等（拒绝逻辑不误伤正常重跑）', async () => {
    await prisma.priceListVersion.update({
      where: { version: 'v9-other-active' },
      data: { status: 'archived' },
    })
    const before = await prisma.priceListEntry.count({
      where: { version: { version: PRICING_VERSION_V1 } },
    })
    const seeded = await seedPricing(prisma)
    expect(seeded.entries).toBe(before)
    expect(seeded.version).toBe(PRICING_VERSION_V1)
  }, 180_000)
})
