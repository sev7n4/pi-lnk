/**
 * P0 出口判据（spec §9）：全网枚举空间内，价目表服务与现行常量**逐档相等**，
 * 且命中时 ruleVersion 指向表版本（证明表是真来源，不是常量旁路）。
 */
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RULE_VERSION_CONSTANTS_FALLBACK, legacyPriceOf } from './pricing.core'
import {
  enumerateAliasCases,
  enumerateOutOfSpaceCases,
  enumeratePricingSpace,
} from './pricing.space'
import { PRICING_VERSION_V1, seedPricing } from '../../prisma/seed-pricing'
import { PricingService } from './pricing.service'
import type { PrismaService } from '../prisma/prisma.service'

const serverRoot = path.resolve(__dirname, '../..')

describe('金标准：价目表 ≡ 现行常量（全网枚举）', () => {
  let dir: string
  let prisma: PrismaClient
  let svc: PricingService

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-pricing-equiv-'))
    const databaseUrl = `file:${path.join(dir, 'test.db')}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    await seedPricing(prisma)
    svc = new PricingService(prisma as unknown as PrismaService)
    await svc.onModuleInit()
  }, 180_000) // 裁决偏离（T6-a）：本机 pnpm exec 启动实测 ~70s（高负载下达 280s），默认 10s hook 超时不够；同 pricing.schema/pricing.seed.integration.test.ts 约定

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  it('枚举空间非空（空集假绿防线）', () => {
    expect(enumeratePricingSpace().length).toBeGreaterThan(300)
    // tripwire：枚举是确定性的；扩空间（新时长/新家族）必须显式改此数并重新 seed
    expect(enumeratePricingSpace().length).toBe(318)
  })

  it('全网逐档：quote === legacy 且 ruleVersion 指向表版本', async () => {
    for (const q of enumeratePricingSpace()) {
      const quote = await svc.quote(q)
      expect(quote.credits, JSON.stringify(q)).toBe(legacyPriceOf(q))
      expect(quote.ruleVersion, JSON.stringify(q)).toBe(PRICING_VERSION_V1)
    }
  })

  it('别名拼写：quote === legacy（命中同一行）', async () => {
    expect(enumerateAliasCases().length).toBeGreaterThan(0)
    for (const q of enumerateAliasCases()) {
      const quote = await svc.quote(q)
      expect(quote.credits, JSON.stringify(q)).toBe(legacyPriceOf(q))
      expect(quote.ruleVersion, JSON.stringify(q)).toBe(PRICING_VERSION_V1)
    }
  })

  it('表外组合：走 fallback 且 quote === legacy', async () => {
    expect(enumerateOutOfSpaceCases().length).toBeGreaterThan(0)
    for (const q of enumerateOutOfSpaceCases()) {
      const quote = await svc.quote(q)
      expect(quote.credits, JSON.stringify(q)).toBe(legacyPriceOf(q))
      expect(quote.ruleVersion, JSON.stringify(q)).toBe(RULE_VERSION_CONSTANTS_FALLBACK)
    }
  })
})
