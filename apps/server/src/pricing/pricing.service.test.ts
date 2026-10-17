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
    marginBp?: number
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
      // P2 T4：marginBp 防御读桩（quoteTextTokens degraded 路径）；不传则 mock 缺
      // marginPolicy —— 与 agent.service 手写局部 mock 同形态，走缺省 11000bp。
      ...(opts.marginBp !== undefined
        ? { marginPolicy: { findFirst: vi.fn(async () => ({ marginBp: opts.marginBp })) } }
        : {}),
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

// —— P2 T4：quoteTextTokens（文本 token 反比率计价，Task 6 结算消费）——

describe('PricingService.quoteTextTokens（P2 T4）', () => {
  // mock 反比率行（brief Step 1 ① 固定数字）：rIn=1000 / rCache=5000 / rOut=500
  const TOKEN_RATIOS = {
    'text:step-3.5-flash:in': 1000,
    'text:step-3.5-flash:cache': 5000,
    'text:step-3.5-flash:out': 500,
  }
  const USAGE = { inputTokens: 2001, cacheReadTokens: 10001, outputTokens: 999 }

  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.PRICING_SOURCE
  })

  it('①三行齐：ceil(in/rIn)+ceil(cache/rCache)+ceil(out/rOut)，带 breakdown 与表版本', async () => {
    const { prisma } = fakePrisma(entryMap({ text: 5, ...TOKEN_RATIOS }))
    const svc = new PricingService(prisma)
    const q = await svc.quoteTextTokens(undefined, 'step-3.5-flash', USAGE)
    expect(q.credits).toBe(8) // ceil(2001/1000)=3 + ceil(10001/5000)=3 + ceil(999/500)=2
    expect(q.breakdown).toEqual({ in: 3, cache: 3, out: 2 })
    expect(q.ruleVersion).toBe(V)
    // global 路径不含 grayReleaseId 键（与 quote 等价性锚同纪律）
    expect(Object.keys(q)).not.toContain('grayReleaseId')
  })

  it('①b：渠道前缀 key（platform::step-3.5-flash）归一后与裸 key 完全同结果（防静默降级）', async () => {
    // 生产 modelKey 带渠道前缀（普通用户默认 platform::agnes-2.5-flash 等）。若不剥前缀，
    // TEXT_TOKEN_MODELS.includes 判否 → 落 USD 兜底（constants-fallback），精确 token 计费
    // 对普通用户静默失效（P2 上线生产验证实测 Bug）。此处锁定：prefixed == bare。
    const { prisma } = fakePrisma(entryMap({ text: 5, ...TOKEN_RATIOS }))
    const svc = new PricingService(prisma)
    const q = await svc.quoteTextTokens(undefined, 'platform::step-3.5-flash', USAGE)
    expect(q.credits).toBe(8) // 与裸 key ① 完全一致：ceil(2001/1000)+ceil(10001/5000)+ceil(999/500)
    expect(q.breakdown).toEqual({ in: 3, cache: 3, out: 2 })
    expect(q.ruleVersion).toBe(V)
    expect(Object.keys(q)).not.toContain('grayReleaseId')
  })

  it('①c：BYOK 渠道前缀 key（ch_x::step-3.5-flash）同样归一走精确 token 行', async () => {
    const { prisma } = fakePrisma(entryMap({ text: 5, ...TOKEN_RATIOS }))
    const svc = new PricingService(prisma)
    const q = await svc.quoteTextTokens(undefined, 'ch_byok_1::step-3.5-flash', USAGE)
    expect(q.credits).toBe(8)
    expect(q.ruleVersion).toBe(V)
  })

  it('②cache 行缺（step-2-16k 形态）→ cache tokens 并入 in 项', async () => {
    const { prisma } = fakePrisma(
      entryMap({ 'text:step-3.5-flash:in': 1000, 'text:step-3.5-flash:out': 500 }),
    )
    const svc = new PricingService(prisma)
    const q = await svc.quoteTextTokens(undefined, 'step-3.5-flash', USAGE)
    expect(q.credits).toBe(15) // ceil((2001+10001)/1000)=13 + ceil(999/500)=2
    expect(q.breakdown).toEqual({ in: 13, cache: 0, out: 2 })
  })

  it('③未知模型 → USD 兜底（缺省 marginBp 11000 + FX），不 throw、breakdown 键不出现', async () => {
    const { prisma } = fakePrisma(entryMap({ text: 5 }))
    const svc = new PricingService(prisma)
    const q = await svc.quoteTextTokens(undefined, 'gpt-unknown-x', {
      ...USAGE,
      costUsd: 0.01,
    })
    expect(q.credits).toBe(8) // ceil(0.01 × 7.2 × 110)
    expect(q.ruleVersion).toBe(RULE_VERSION_CONSTANTS_FALLBACK)
    expect(q.breakdown).toBeUndefined()
    expect(Object.keys(q)).not.toContain('breakdown')
  })

  it('③b：无 costUsd 也兜底不 throw（min 1）', async () => {
    const { prisma } = fakePrisma(null)
    const svc = new PricingService(prisma)
    const q = await svc.quoteTextTokens(undefined, 'gpt-unknown-x', {
      inputTokens: 1,
      cacheReadTokens: 1,
      outputTokens: 1,
    })
    expect(q.credits).toBe(1)
    expect(q.ruleVersion).toBe(RULE_VERSION_CONSTANTS_FALLBACK)
  })

  it('③c：marginBp 取当前生效阶段现算（12000bp 桩 → 9 分）', async () => {
    const { prisma } = fakePrisma(null, { marginBp: 12000 })
    const svc = new PricingService(prisma)
    const q = await svc.quoteTextTokens(undefined, 'gpt-unknown-x', {
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      costUsd: 0.01,
    })
    expect(q.credits).toBe(9) // ceil(0.01 × 7.2 × 120)
  })

  it('④min 1：零用量走价目口径仍得 1 分', async () => {
    const { prisma } = fakePrisma(entryMap({ ...TOKEN_RATIOS }))
    const svc = new PricingService(prisma)
    const q = await svc.quoteTextTokens(undefined, 'step-3.5-flash', {
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
    })
    expect(q.credits).toBe(1)
    expect(q.breakdown).toEqual({ in: 0, cache: 0, out: 0 })
  })

  it('⑤回归锚：text 单行 matchKey 不受 token 行影响', async () => {
    const { prisma } = fakePrisma(entryMap({ text: 5, ...TOKEN_RATIOS }))
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({ credits: 5, ruleVersion: V })
  })

  it('⑦cacheWrite 并入 in 项计费（终审 C-2）：cacheWrite 1000 / rIn 1000 → in 项 +1', async () => {
    const { prisma } = fakePrisma(entryMap({ text: 5, ...TOKEN_RATIOS }))
    const svc = new PricingService(prisma)
    // 基线（无 cacheWrite）：credits 8 = in 3 + cache 3 + out 2
    const base = await svc.quoteTextTokens(undefined, 'step-3.5-flash', USAGE)
    expect(base.breakdown).toEqual({ in: 3, cache: 3, out: 2 })
    // +cacheWrite 1000：in 项 ceil((2001+1000)/1000)=4（+1），cache/out 不动
    const q = await svc.quoteTextTokens(undefined, 'step-3.5-flash', {
      ...USAGE,
      cacheWriteTokens: 1000,
    })
    expect(q.credits).toBe(9)
    expect(q.breakdown).toEqual({ in: 4, cache: 3, out: 2 })
  })

  it('⑥DB 抛错 → USD 兜底不 throw + warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { prisma } = fakePrisma(null, { throws: true })
    const svc = new PricingService(prisma)
    const q = await svc.quoteTextTokens(undefined, 'step-3.5-flash', {
      inputTokens: 10,
      cacheReadTokens: 0,
      outputTokens: 0,
      costUsd: 0.01,
    })
    expect(q.credits).toBe(8)
    expect(q.ruleVersion).toBe(RULE_VERSION_CONSTANTS_FALLBACK)
    expect(warn).toHaveBeenCalled()
  })

  it('⑥b：in/out 行缺 → 三行不齐走 USD 兜底（cache 缺行才是受支持形态）', async () => {
    const { prisma } = fakePrisma(entryMap({ 'text:step-3.5-flash:in': 1000 })) // out 缺
    const svc = new PricingService(prisma)
    const q = await svc.quoteTextTokens(undefined, 'step-3.5-flash', {
      inputTokens: 10,
      cacheReadTokens: 0,
      outputTokens: 0,
      costUsd: 0.01,
    })
    expect(q.credits).toBe(8)
    expect(q.ruleVersion).toBe(RULE_VERSION_CONSTANTS_FALLBACK)
    expect(q.breakdown).toBeUndefined()
  })

  it('⑥c：灰度名单命中 → 灰度比率行 + grayReleaseId（与 quote 两参语义一致）', async () => {
    const { prisma } = fakePrisma(entryMap({ ...TOKEN_RATIOS }), {
      grayRelease: grayRelease({
        version: {
          version: GRAY_V,
          entries: [
            { matchKey: 'text:step-3.5-flash:in', credits: 2000 },
            { matchKey: 'text:step-3.5-flash:cache', credits: 5000 },
            { matchKey: 'text:step-3.5-flash:out', credits: 500 },
          ],
        },
      }),
    })
    const svc = new PricingService(prisma)
    const q = await svc.quoteTextTokens('u1', 'step-3.5-flash', USAGE)
    expect(q.credits).toBe(7) // ceil(2001/2000)=2 + ceil(10001/5000)=3 + ceil(999/500)=2
    expect(q.ruleVersion).toBe(GRAY_V)
    expect(q.grayReleaseId).toBe(GRAY_ID)
  })

  it('⑥d：PRICING_SOURCE=constants 旁路 → USD 兜底（token 行无 legacy 常量）', async () => {
    process.env.PRICING_SOURCE = 'constants'
    const { prisma } = fakePrisma(entryMap({ ...TOKEN_RATIOS }))
    const svc = new PricingService(prisma)
    const q = await svc.quoteTextTokens(undefined, 'step-3.5-flash', {
      inputTokens: 10,
      cacheReadTokens: 0,
      outputTokens: 0,
      costUsd: 0.01,
    })
    expect(q.credits).toBe(8)
    expect(q.ruleVersion).toBe(RULE_VERSION_CONSTANTS_FALLBACK)
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
