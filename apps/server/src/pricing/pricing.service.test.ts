import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PricingService } from './pricing.service'
import { PricingController } from './pricing.controller'
import {
  RULE_VERSION_CONSTANTS_FALLBACK,
  TEXT_TOKEN_MODELS,
  buildMatchKey,
  legacyPriceOf,
} from './pricing.core'
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
    /** Task 7：pricingSubject 主体行（isKnownTokenModel 数据化白名单查此表）。 */
    pricingSubjects?: Array<{ modelKey: string; spec: string; status?: string }>
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
  // Task 7：isKnownTokenModel 查 pricingSubject 中 in/out 双行。默认池回灌 8 个
  // TEXT_TOKEN_MODELS（各带 in/out、status 'priced'），使既有 token 测试在无显式
  // pricingSubjects 时仍认作已知模型；AC7 用 opts.pricingSubjects 覆盖（只含新模型）。
  const subjectPool: Array<{ modelKey: string; spec: string; status: string }> =
    opts.pricingSubjects ??
    TEXT_TOKEN_MODELS.flatMap((m) => [
      { modelKey: m, spec: 'in', status: 'priced' },
      { modelKey: m, spec: 'out', status: 'priced' },
    ])
  const pricingSubject = {
    findMany: vi.fn(async (args: { where?: { modelKey?: string; status?: { not?: string } } }) => {
      const model = args?.where?.modelKey
      const statusNot = args?.where?.status?.not
      return subjectPool.filter(
        (r) => r.modelKey === model && (statusNot ? r.status !== statusNot : true),
      )
    }),
  }
  return {
    prisma: {
      priceListVersion: { findFirst },
      priceListEntry: { count },
      pricingGrayRelease: { findFirst: grayFindFirst },
      pricingSubject,
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
      degraded: true,
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
      degraded: true,
    })
    expect(warn).toHaveBeenCalled()
  })

  it('无 active 版本 → 常量兜底', async () => {
    const { prisma } = fakePrisma(null)
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'audio', audioKind: 'music' })).resolves.toEqual({
      credits: 15,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
      degraded: true,
    })
  })

  it('PRICING_SOURCE=constants 旁路 DB 且不调 findFirst', async () => {
    process.env.PRICING_SOURCE = 'constants'
    const { prisma, findFirst } = fakePrisma(entryMap({ text: 999 }))
    const svc = new PricingService(prisma)
    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({
      credits: 5,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
      degraded: true,
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

  it('AC12：新增 model 级策略后 readCurrentMarginBp 仍 pin 到 global（11000，不被 3000 污染）', async () => {
    // R4：pricing.service.test.ts 用 fakePrisma，无真实 marginPolicy.create；此处用 scope-aware 桩
    // 模拟「存在一条 model 级策略（3000bp）」与「global 缺省（11000bp）」，断言全局 read 只捞 global。
    const marginFindFirst = vi.fn(async (args?: { where?: { scope?: string } }) => {
      if (args?.where?.scope === 'model') return { marginBp: 3000 }
      if (args?.where?.scope === 'global') return { marginBp: 11000 }
      return null
    })
    const prisma = {
      marginPolicy: { findFirst: marginFindFirst },
      priceListVersion: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaService
    const svc = new PricingService(prisma)
    const q = await svc.quoteTextTokens(undefined, 'gpt-unknown-x', {
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      costUsd: 0.01,
    })
    expect(q.ruleVersion).toBe(RULE_VERSION_CONSTANTS_FALLBACK)
    // 11000bp 推导：ceil(0.01 × 7.2 × 110) = 8；若 model 级 3000bp 泄漏则应为 3。
    expect(q.credits).toBe(8)
    // 真正可证伪点：防御读必须以 scope:'global' 查询，绝不捞到 model 级策略
    // （old 代码 orderBy createdAt desc 不传 where ⇒ 此断言 RED）。
    expect(marginFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { scope: 'global', status: 'active' } }))
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

  it('AC7/AC11④：新登记模型（不在 8 白名单）走精确反比率，且预估 === 结算', async () => {
    // 数据化白名单：pricingSubject 中登记 new-model 的 in/out 双行即可认作已知 token 模型，
    // 不再依赖硬编码 TEXT_TOKEN_MODELS.includes（覆盖新上架模型零代码改动）。
    const { prisma } = fakePrisma(
      entryMap({
        'text:new-model:in': 5000,
        'text:new-model:out': 1000,
      }),
      {
        pricingSubjects: [
          { modelKey: 'new-model', spec: 'in', status: 'priced' },
          { modelKey: 'new-model', spec: 'out', status: 'priced' },
        ],
      },
    )
    const svc = new PricingService(prisma)
    const usage = { inputTokens: 10000, cacheReadTokens: 0, outputTokens: 2000 }
    const settle = await svc.quoteTextTokens(undefined, 'new-model', usage)
    expect(settle.ruleVersion).toBe(V)
    expect(settle.credits).toBe(Math.ceil(10000 / 5000) + Math.ceil(2000 / 1000))
    const plan = await svc.prepareTextTokenQuote(undefined, 'new-model')
    expect(plan?.compute(usage)).toBe(settle.credits)
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
      degraded: true,
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
      degraded: true,
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
      degraded: true,
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
      degraded: true,
    })

    //绕过发布流直接改库（无invalidate）：仍在 30s 探测窗口内 ⇒ 本笔仍兜底。
    // 这是刻意封顶：降级期间每次 quote 打库会把最热的路径变成 DB-bound。
    // 所有受支持的建版本路径都会 invalidate()，因此真实运维流程零延迟。
    active = { id: 'plv1', version: V, status: 'active', entries: [{ matchKey: 'text', credits: 5 }] }
    await expect(svc.quote({ capability: 'text' })).resolves.toEqual({
      credits: 5,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
      degraded: true,
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
      degraded: true,
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

describe('PricingService.prepareTextTokenQuote（v2 单一真相源：流式预估==结算同引擎）', () => {
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

  it('核心契约：plan.compute(usage) === quoteTextTokens(usage).credits（预估与结算同一公式）', async () => {
    const { prisma } = fakePrisma(entryMap({ text: 5, ...TOKEN_RATIOS }))
    const svc = new PricingService(prisma)
    const plan = await svc.prepareTextTokenQuote(undefined, 'step-3.5-flash')
    expect(plan).not.toBeNull()
    const settle = await svc.quoteTextTokens(undefined, 'step-3.5-flash', USAGE)
    expect(plan!.compute(USAGE)).toBe(settle.credits)
    expect(plan!.ruleVersion).toBe(settle.ruleVersion)
  })

  it('多档 usage 抽样逐笔相等（含 cacheWrite 并入 in 项口径）', async () => {
    const { prisma } = fakePrisma(entryMap({ text: 5, ...TOKEN_RATIOS }))
    const svc = new PricingService(prisma)
    const plan = await svc.prepareTextTokenQuote(undefined, 'step-3.5-flash')
    expect(plan).not.toBeNull()
    const samples = [
      { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 },
      { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 7777, outputTokens: 42 },
      { inputTokens: 500_000, cacheReadTokens: 120_000, cacheWriteTokens: 3_000, outputTokens: 8_000 },
    ]
    for (const u of samples) {
      const settle = await svc.quoteTextTokens(undefined, 'step-3.5-flash', u)
      expect(plan!.compute(u)).toBe(settle.credits)
    }
  })

  it('cache 行缺：cacheRead 并入 in 项，两引擎仍逐笔相等', async () => {
    const { prisma } = fakePrisma(
      entryMap({ 'text:step-3.5-flash:in': 1000, 'text:step-3.5-flash:out': 500 }),
    )
    const svc = new PricingService(prisma)
    const plan = await svc.prepareTextTokenQuote(undefined, 'step-3.5-flash')
    expect(plan).not.toBeNull()
    const u = { inputTokens: 2001, cacheReadTokens: 10001, outputTokens: 999 }
    const settle = await svc.quoteTextTokens(undefined, 'step-3.5-flash', u)
    expect(plan!.compute(u)).toBe(settle.credits)
  })

  it('非 token 计费模型 / PRICING_SOURCE=constants / DB 异常 → null（静默 fail-soft，不刷 warn）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { prisma } = fakePrisma(entryMap({ text: 5 }))
    const svc = new PricingService(prisma)
    await expect(svc.prepareTextTokenQuote(undefined, 'unknown-model')).resolves.toBeNull()

    process.env.PRICING_SOURCE = 'constants'
    const { prisma: p2 } = fakePrisma(entryMap({ text: 5, ...TOKEN_RATIOS }))
    await expect(
      new PricingService(p2).prepareTextTokenQuote(undefined, 'step-3.5-flash'),
    ).resolves.toBeNull()
    delete process.env.PRICING_SOURCE

    const { prisma: p3 } = fakePrisma(null, { throws: true })
    await expect(
      new PricingService(p3).prepareTextTokenQuote(undefined, 'step-3.5-flash'),
    ).resolves.toBeNull()
    // 回合级预读逐 turn 触发，降级态是合法常态（degradedTextTokenQuote 已在上游 warn）⇒
    // 这里刻意静默：不刷日志（fail-soft 纪律）
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('PricingController.active 端点防污染（Task 7 AC11③）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.PRICING_SOURCE
  })

  it('subjectKey 六段键与带 | 的异常 text 键不混入 GET /api/pricing/active 的 textTokenRatios', async () => {
    // getActiveTextTokenRatios 只返回正常 `text:<model>:<spec>` 键；subject 六段键
    // （image|x|1K:1|p|u 与 text|model|in|... 形态）及任何含 | 的异常键都不应污染 ratios。
    // `text:polluted|key:in` 这一项专门证伪 `if (key.includes('|')) continue` 守卫——
    // 移除该守卫会被误解析成带 | 的 model 键导致 ratios 出现脏键（移除即红）。
    const { prisma } = fakePrisma(
      entryMap({
        'text:agnes-2.5-flash:in': 2000,
        'text:agnes-2.5-flash:out': 500,
        'image|x|1K:1|p|u': 9,
        'text:polluted|key:in': 111,
      }),
    )
    const c = new PricingController(new PricingService(prisma))
    const ratios = (await c.active()).data.textTokenRatios
    expect(Object.keys(ratios).every((k) => !k.includes('|'))).toBe(true)
    expect(ratios['agnes-2.5-flash']).toEqual({ in: 2000, out: 500 })
  })
})
