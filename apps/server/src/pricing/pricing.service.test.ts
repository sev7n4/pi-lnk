import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PricingService } from './pricing.service'
import { RULE_VERSION_CONSTANTS_FALLBACK, buildMatchKey, legacyPriceOf } from './pricing.core'
import { enumeratePricingSpace } from './pricing.space'
import type { PrismaService } from '../prisma/prisma.service'

const V = 'v1-legacy-equivalent'

function fakePrisma(
  entries: Array<{ matchKey: string; credits: number }> | null,
  opts: { throws?: boolean } = {},
) {
  const findFirst = vi.fn(async () => {
    if (opts.throws) throw new Error('db down')
    if (!entries) return null
    return {
      id: 'plv1',
      version: V,
      status: 'active',
      entries: entries.map((e, i) => ({ id: `e${i}`, ...e })),
    }
  })
  return { prisma: { priceListVersion: { findFirst } } as unknown as PrismaService, findFirst }
}

function entryMap(credits: Record<string, number>) {
  return Object.entries(credits).map(([matchKey, c]) => ({ matchKey, credits: c }))
}

describe('PricingService.quote', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.PRICING_SOURCE
  })

  it('表命中返回表值与版本号', async () => {
    const { prisma } = fakePrisma(entryMap({ text: 5, 'video:default:768p:5:-:ri0:rv0': 30 }))
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({ credits: 5, ruleVersion: V })
    await expect(svc.quote({ capability: 'video', modelKey: 'seedance-2.0', duration: 5 })).resolves.toEqual({
      credits: 30,
      ruleVersion: V,
    })
  })

  it('image_edit 未命中具体键时落 capability 默认行 *', async () => {
    const { prisma } = fakePrisma(entryMap({ 'image_edit:*': 10 }))
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'image_edit', modelKey: 'ch9::x' })).resolves.toEqual({
      credits: 10,
      ruleVersion: V,
    })
  })

  it('表缺行 → 常量兜底 + warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { prisma } = fakePrisma(entryMap({ text: 5 }))
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'video', modelKey: 'seedance-2.0', duration: 5 })).resolves.toEqual({
      credits: 30,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })
    expect(warn).toHaveBeenCalled()
  })

  it('DB 抛错 → 常量兜底 + warn（绝不抛给调用方）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { prisma } = fakePrisma(null, { throws: true })
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({
      credits: 5,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })
    expect(warn).toHaveBeenCalled()
  })

  it('无 active 版本 → 常量兜底', async () => {
    const { prisma } = fakePrisma(null)
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'audio', audioKind: 'music' })).resolves.toEqual({
      credits: 15,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })
  })

  it('PRICING_SOURCE=constants 旁路 DB 且不调 findFirst', async () => {
    process.env.PRICING_SOURCE = 'constants'
    const { prisma, findFirst } = fakePrisma(entryMap({ text: 999 }))
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({
      credits: 5,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('30s 内重复查询命中缓存（findFirst 只调一次）', async () => {
    const { prisma, findFirst } = fakePrisma(entryMap({ text: 5 }))
    const svc = new PricingService(prisma)
    await svc.quote({ capability: 'text' })
    await svc.quote({ capability: 'text' })
    expect(findFirst).toHaveBeenCalledTimes(1)
  })
})

describe('PricingService.onModuleInit 启动自检', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.PRICING_SOURCE
  })

  it('表与 legacy 全网一致 → 不降级 + 日志通过', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const space = enumeratePricingSpace()
    const entries = space.map((q) => ({ matchKey: buildMatchKey(q), credits: legacyPriceOf(q) }))
    const { prisma } = fakePrisma(entries)
    const svc = new PricingService(prisma)
    await svc.onModuleInit()
    const quote = await svc.quote({ capability: 'text' })
    expect(quote.ruleVersion).toBe(V)
    expect(log).toHaveBeenCalled()
  })

  it('表值与 legacy 失配 → 自动降级常量（后续 quote 不再信表）', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { prisma } = fakePrisma(entryMap({ text: 99, 'video:default:768p:5:-:ri0:rv0': 30 }))
    const svc = new PricingService(prisma)
    await svc.onModuleInit()
    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({
      credits: 5,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })
    expect(err).toHaveBeenCalled()
  })

  it('PRICING_SOURCE=constants → 自检直接跳过', async () => {
    process.env.PRICING_SOURCE = 'constants'
    const { prisma, findFirst } = fakePrisma(null)
    const svc = new PricingService(prisma)
    await svc.onModuleInit()
    expect(findFirst).not.toHaveBeenCalled()
  })
})
