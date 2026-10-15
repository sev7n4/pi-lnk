import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PricingService } from './pricing.service'
import { RULE_VERSION_CONSTANTS_FALLBACK, buildMatchKey, legacyPriceOf } from './pricing.core'
import { enumeratePricingSpace } from './pricing.space'
import type { PrismaService } from '../prisma/prisma.service'

const V = 'v1-legacy-equivalent'

function fakePrisma(
  entries: Array<{ matchKey: string; credits: number }> | null,
  opts: {
    throws?: boolean
    counts?: { legacyRows: number; totalRows: number }
    grayRelease?: Record<string, unknown> | null
    grayThrows?: boolean
  } = {},
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
  const legacyRows = opts.counts?.legacyRows ?? (entries ? entries.length : 0)
  const totalRows = opts.counts?.totalRows ?? (entries ? entries.length : 0)
  const count = vi.fn(async (args: { where?: { basis?: string } }) =>
    args?.where?.basis === 'legacy-equivalent' ? legacyRows : totalRows,
  )
  const $transaction = vi.fn(async (ops: Array<Promise<number>>) => Promise.all(ops))
  const grayFindFirst = vi.fn(async () => {
    if (opts.grayThrows) throw new Error('gray db down')
    return opts.grayRelease ?? null
  })
  return {
    prisma: {
      priceListVersion: { findFirst },
      priceListEntry: { count },
      pricingGrayRelease: { findFirst: grayFindFirst },
      $transaction,
    } as unknown as PrismaService,
    findFirst,
    count,
    grayFindFirst,
  }
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

// —— P1-a T3：自检条件化 + quote 灰度解析（brief Step 4 用例 1-8）——

const GRAY_V = 'v2-ops-gray'
const GRAY_ID = 'gray-rel-1'

function grayRelease(over: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    id: GRAY_ID,
    version: { version: GRAY_V, entries: [{ matchKey: 'text', credits: 8 }] },
    whitelist: [{ userId: 'u1', phone: '13800000001' }],
    startsAt: new Date(now - 60_000),
    endsAt: new Date(now + 3_600_000),
    ...over,
  }
}

describe('PricingService.quote 灰度解析（P1-a）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.PRICING_SOURCE
  })

  it('用例 1：quote 不传 userId → 返回对象不含 grayReleaseId 键（等价性锚）', async () => {
    const { prisma } = fakePrisma(entryMap({ text: 5 }))
    const svc = new PricingService(prisma)
    const quote = await svc.quote({ capability: 'text' })
    expect(quote).toEqual({ credits: 5, ruleVersion: V })
    expect(Object.keys(quote)).not.toContain('grayReleaseId')
    // 兜底路径同样不含（degraded/constants 旁路）
    process.env.PRICING_SOURCE = 'constants'
    const bypass = await svc.quote({ capability: 'text' })
    expect(Object.keys(bypass)).not.toContain('grayReleaseId')
  })

  it('用例 2：名单内 userId → 灰度值 + 灰度版本 + grayReleaseId', async () => {
    const { prisma } = fakePrisma(entryMap({ text: 5 }), { grayRelease: grayRelease() })
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'text' }, 'u1')).resolves.toEqual({
      credits: 8,
      ruleVersion: GRAY_V,
      grayReleaseId: GRAY_ID,
    })
  })

  it('用例 3：名单未命中 userId → global 值且无 grayReleaseId', async () => {
    const { prisma } = fakePrisma(entryMap({ text: 5 }), { grayRelease: grayRelease() })
    const svc = new PricingService(prisma)
    const quote = await svc.quote({ capability: 'text' }, 'u2')
    expect(quote).toEqual({ credits: 5, ruleVersion: V })
    expect(Object.keys(quote)).not.toContain('grayReleaseId')
  })

  it('用例 4：窗口外（未开始/已结束）→ 视为无灰度，落 global（非常量兜底）', async () => {
    const now = Date.now()
    const notStarted = fakePrisma(entryMap({ text: 5 }), {
      grayRelease: grayRelease({ startsAt: new Date(now + 60_000), endsAt: new Date(now + 3_600_000) }),
    })
    const svcA = new PricingService(notStarted.prisma)
    await expect(svcA.quote({ capability: 'text' }, 'u1')).resolves.toEqual({ credits: 5, ruleVersion: V })

    const expired = fakePrisma(entryMap({ text: 5 }), {
      grayRelease: grayRelease({ startsAt: new Date(now - 3_600_000), endsAt: new Date(now - 60_000) }),
    })
    const svcB = new PricingService(expired.prisma)
    await expect(svcB.quote({ capability: 'text' }, 'u1')).resolves.toEqual({ credits: 5, ruleVersion: V })
  })

  it('用例 5：灰度表缺行该档 → 落 global 值 + warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { prisma } = fakePrisma(
      entryMap({ text: 5, 'video:default:768p:5:-:ri0:rv0': 30 }),
      { grayRelease: grayRelease() }, // 灰度表只有 text 行
    )
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'video', modelKey: 'seedance-2.0', duration: 5 }, 'u1')).resolves.toEqual({
      credits: 30,
      ruleVersion: V,
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('灰度表缺行'))
  })

  it('用例 6：灰度 DB 查询抛错 → 落 global 值（绝不 throw）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { prisma, grayFindFirst } = fakePrisma(entryMap({ text: 5 }), { grayThrows: true })
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'text' }, 'u1')).resolves.toEqual({ credits: 5, ruleVersion: V })
    expect(grayFindFirst).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
  })
})

describe('PricingService.onModuleInit 自检条件化（P1-a）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.PRICING_SOURCE
  })

  it('用例 7：basis 混入运营价 → 跳过等价自检且 degraded=false（表值可用）', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { prisma, count } = fakePrisma(entryMap({ text: 99 }), { counts: { legacyRows: 0, totalRows: 1 } })
    const svc = new PricingService(prisma)
    await svc.onModuleInit()
    // 若等价自检照跑，text=99 必失配降级；跳过后表值原样可用
    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({ credits: 99, ruleVersion: V })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('跳过全网等价自检'))
    expect(count).toHaveBeenCalledWith({ where: { versionId: 'plv1', basis: 'legacy-equivalent' } })
    expect(count).toHaveBeenCalledWith({ where: { versionId: 'plv1' } })
  })

  it('用例 8：无 active 版本 → degraded=true（boot 不再自播种）', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { prisma, findFirst } = fakePrisma(null)
    const svc = new PricingService(prisma)
    await svc.onModuleInit()
    expect(findFirst).toHaveBeenCalledTimes(1) // 无第二次查询 = 无自播种
    expect(err).toHaveBeenCalledWith(expect.stringContaining('P1 起不再自播种'))
    await expect(svc.quote({ capability: 'audio', audioKind: 'music' })).resolves.toEqual({
      credits: 15,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })
  })

  it('用例 9（C2 自愈）：boot 无 active 版本降级 → 运行中装上 active 版本 → quote 自动恢复，无需重启', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 可变的 active 版本来源：boot 时空，之后运营经发布流建出版本
    let active: { id: string; version: string; status: string; entries: { matchKey: string; credits: number }[] } | null =
      null
    const prisma = {
      priceListVersion: {
        findFirst: vi.fn(async () => active),
      },
      priceListEntry: { count: vi.fn(async () => 0) },
      pricingGrayRelease: { findFirst: vi.fn(async () => null) },
      $transaction: vi.fn(async (ops: Array<Promise<number>>) => Promise.all(ops)),
    } as unknown as PrismaService

    const svc = new PricingService(prisma)
    await svc.onModuleInit()
    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({
      credits: 5,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })

    // 运维事后经发布流装上一个 active 版本。degraded 曾是永久闩锁，必须重启进程；
    // 发布流的所有写路径（publish/rollback/灰度）成功后都会 invalidate()，
    // invalidate 同时解除自愈探测节流 ⇒ 下一笔报价立即接管新表。
    active = {
      id: 'plv1',
      version: V,
      status: 'active',
      entries: [{ matchKey: 'text', credits: 5 }],
    }
    svc.invalidate()

    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({ credits: 5, ruleVersion: V })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('已从降级恢复'))

    // 恢复是持久的：后续报价继续走表，不会退回兜底
    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({ credits: 5, ruleVersion: V })
    err.mockRestore()
    warn.mockRestore()
  })

  it('用例 9b（C2 自愈边界）：绕过发布流直接改库时，恢复延迟上限 = 一个缓存 TTL（30s）', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let active: { id: string; version: string; status: string; entries: { matchKey: string; credits: number }[] } | null =
      null
    const prisma = {
      priceListVersion: { findFirst: vi.fn(async () => active) },
      priceListEntry: { count: vi.fn(async () => 0) },
      pricingGrayRelease: { findFirst: vi.fn(async () => null) },
      $transaction: vi.fn(async (ops: Array<Promise<number>>) => Promise.all(ops)),
    } as unknown as PrismaService

    const svc = new PricingService(prisma)
    await svc.onModuleInit()
    // 这笔降级报价会把自愈探测节流一个 TTL
    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({
      credits: 5,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })

    //绕过发布流直接改库（无invalidate）：仍在 30s 探测窗口内 ⇒ 本笔仍兜底。
    // 这是刻意封顶：降级期间每次 quote 打库会把最热的路径变成 DB-bound。
    // 所有受支持的建版本路径都会 invalidate()，因此真实运维流程零延迟。
    active = { id: 'plv1', version: V, status: 'active', entries: [{ matchKey: 'text', credits: 5 }] }
    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({
      credits: 5,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('已从降级恢复'))
    err.mockRestore()
    warn.mockRestore()
  })

  it('用例 10（C2 边界）：自检失配的降级不可自愈（表在库里也不被信）', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 全legacy-equivalent 但值失配 ⇒ 自检降级；表一直查得到
    const { prisma, findFirst } = fakePrisma(entryMap({ text: 99 }))
    const svc = new PricingService(prisma)
    await svc.onModuleInit()
    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({
      credits: 5,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })
    expect(findFirst).toHaveBeenCalledTimes(1) // 不为自愈额外查库
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('已从降级恢复'))
    err.mockRestore()
    warn.mockRestore()
  })

  it('用例 11（I3）：invalidate() 清缓存，下一笔 quote 立即重查表', async () => {
    const { prisma, findFirst } = fakePrisma(entryMap({ text: 5 }))
    const svc = new PricingService(prisma)
    await svc.quote({ capability: 'text' })
    await svc.quote({ capability: 'text' })
    expect(findFirst).toHaveBeenCalledTimes(1)

    svc.invalidate()
    await svc.quote({ capability: 'text' })
    expect(findFirst).toHaveBeenCalledTimes(2)
  })
})
