/**
 * 价目表服务（P0 · spec §4/§9；P1-a 灰度发布 · spec §8.4）。
 *
 * 解析顺序（quote 带 userId 时）：灰度精确行 → 灰度 capability 默认行 →
 * global 精确行 → global capability 默认行（matchKey 以 `:*` 结尾，目前仅
 * image_edit 有，镜像 legacy 的 `?? 10`）→ 常量兜底 + warn。
 *
 * 四条保底路径（全部真实可测，见 pricing.service.test.ts）：
 * 表缺行 / DB 抛错 / 无 active 版本 / 启动自检失配 ⇒ 常量兜底。
 *
 * P1-a 起无 boot 自播种（发布流接管，见 seed-pricing.ts）：无 active 版本 =
 * 告警 + 全量兜底。启动自检条件化——active 版本全部 legacy-equivalent 才做
 * 全网等价自检（v1 路径不放松）；混入运营定价（basis ≠ legacy-equivalent）
 * 则跳过等价自检，避免运营价目上线即被误杀降级。
 *
 * degraded 不是 boot 期永久闩锁：运营随后经发布流建出 active 版本时自愈
 * （loadActiveTable 命中即清 degraded + warn，见 C2）。否则「改价不发版」在
 * 运行中的进程里失效，必须重启才恢复——那正是发布流要消灭的运维动作。
 */
import { Inject, Injectable, OnModuleInit } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import {
  RULE_VERSION_CONSTANTS_FALLBACK,
  TEXT_TOKEN_MODELS,
  buildMatchKey,
  buildTextTokenMatchKey,
  estimateCreditsFromUsdCost,
  legacyPriceOf,
  resolveFxUsdCny,
  type PricingQuery,
  type PricingQuote,
  type TextTokenSpec,
} from './pricing.core'
import { enumeratePricingSpace } from './pricing.space'

const CACHE_TTL_MS = 30_000

/** token 数规范：非有限/负数按 0（usage 来自 vendor 折叠，绝不因脏值 NaN 计价）。 */
function positiveTokens(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 反比率行有效性：正有限数（缺行 = undefined、脏值 0/NaN 都不算比率）。 */
function isPositiveRatio(v: number | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

interface PriceTable {
  id: string
  version: string
  entries: Map<string, number>
  loadedAt: number
}

/** 灰度价目快照：与 global 表各自独立缓存（同 30s TTL），含名单与窗口边界。 */
interface GrayTable {
  releaseId: string
  version: string
  entries: Map<string, number>
  whitelist: Set<string>
  startsAt: number
  endsAt: number
  loadedAt: number
}

@Injectable()
export class PricingService implements OnModuleInit {
  private cache: PriceTable | null = null
  private grayCache: GrayTable | null = null
  private degraded = false
  /**
   * degraded 是否可自愈：仅「boot 时无 active 版本」这一成因置true。
   * 自愈成功后连同本标记一并复位（终审 Critical C2）。
   *
   * 其余降级成因（零条目 / 自检失配 / 自检异常）**不可**自愈——那些 active 版本
   * 本身就不该被信（等价自检失配意味着表与常量口径已经分叉），让它们被「查到就
   * 恢复」会直接绕过 P0 地基的自检防线。
   */
  private degradedHealable = false
  /** 上次自愈探测时间（throttle）：degraded 期间每次 quote 都打 DB 太贵。 */
  private lastSelfHealAt: number | null = null

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 发布/回滚/灰度关停后由写路径显式清缓存。
   *
   * 缓存 TTL 30s 是为「读多写少」的热路径省DB 往返，不是「改了价最长 30s 才生效」
   * 的承诺——紧急回滚/关停场景下继续错扣最多 30s 是可避免的（终审 Important I3）。
   */
  invalidate(): void {
    this.cache = null
    this.grayCache = null
    // 写路径刚变更过 active 版本：解除自愈探测节流，下一笔 quote 立刻复核
    // （否则降级进程刚被 publish 救活却还要再等一个 TTL 才认新表）。
    this.lastSelfHealAt = null
  }

  async onModuleInit(): Promise<void> {
    if (process.env.PRICING_SOURCE === 'constants') {
      console.log('[pricing] PRICING_SOURCE=constants — 价目表旁路，全部走常量兜底')
      return
    }
    try {
      const table = await this.loadActiveTable()
      if (!table) {
        // P1-a 起 boot 不再自播种（发布流接管）：无版本 = 告警 + 全量兜底。
        this.degraded = true
        this.degradedHealable = true // 运营随后经发布流建版本 ⇒ 可自愈（见 loadActiveTable）
        console.error('[pricing] 无 active 价目表版本 — 已降级常量兜底（P1 起不再自播种，请走运营发布流）')
        return
      }
      // 自检条件化：先查 active 版本条目的 basis 构成。混入运营定价（v2+）时
      // 等价自检必然失配，若照跑会把运营价目误杀成降级——只对纯 legacy 版本自检。
      const [legacyRows, totalRows] = await this.prisma.$transaction([
        this.prisma.priceListEntry.count({ where: { versionId: table.id, basis: 'legacy-equivalent' } }),
        this.prisma.priceListEntry.count({ where: { versionId: table.id } }),
      ])
      if (totalRows === 0) {
        this.degraded = true
        console.error('[pricing] active 版本零条目 — 降级常量兜底')
        return
      }
      if (legacyRows === totalRows) {
        // v1 路径：全网等价自检原样保留，不放松一丝。
        const space = enumeratePricingSpace()
        const mismatches = space.filter((q) => {
          const row = table.entries.get(buildMatchKey(q))
          return row === undefined || row !== legacyPriceOf(q)
        })
        if (mismatches.length > 0) {
          this.degraded = true
          console.error(
            `[pricing] 启动自检失配 ${mismatches.length}/${space.length} 例（首例 ${buildMatchKey(mismatches[0])}）— 已降级常量兜底`,
          )
          return
        }
        console.log(`[pricing] 启动自检通过：${space.length} 例全网等价（版本 ${table.version}）`)
      } else {
        console.log(
          `[pricing] active 版本含运营定价（legacy-equivalent ${legacyRows}/${totalRows}）——跳过全网等价自检`,
        )
      }
    } catch (err) {
      this.degraded = true
      console.error('[pricing] 启动自检异常，已降级常量兜底：', err)
    }
  }

  /**
   * 报价。任何失败路径都返回常量兜底值，绝不 throw。
   *
   * @param userId 可选；传入且命中灰度名单时按灰度表解析（灰度优先级：
   * 精确行 → `<capability>:*` 默认行 → 缺行 warn 落 global）。global/兜底
   * 路径的返回对象不含 grayReleaseId 键（等价性锚，既有断言零改动的根基）。
   */
  async quote(q: PricingQuery, userId?: string): Promise<PricingQuote> {
    const legacy = legacyPriceOf(q)
    if (process.env.PRICING_SOURCE === 'constants') {
      return { credits: legacy, ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK }
    }
    if (this.degraded) {
      // 短路前先试一次自愈探测：degraded 因「boot 无 active 版本」而设时，
      // 运营随后经发布流建出的版本应当立即接管，无需重启进程。探测节流到
      // CACHE_TTL_MS（降级期间每笔报价都打 DB 太贵，且 active 版本出现后
      // loadActiveTable 会顺带把 degraded 清掉）。
      await this.trySelfHeal()
      if (this.degraded) {
        return { credits: legacy, ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK }
      }
    }
    try {
      const key = buildMatchKey(q)
      // ① 灰度优先：userId 存在、灰度表可用且名单命中才走灰度。
      if (userId) {
        const gray = await this.loadGrayTable()
        if (gray && gray.whitelist.has(userId)) {
          const hit = gray.entries.get(key) ?? gray.entries.get(`${q.capability}:*`)
          if (hit !== undefined) {
            return { credits: hit, ruleVersion: gray.version, grayReleaseId: gray.releaseId }
          }
          // 灰度表缺行 → 落 global 继续解析（灰度版本必须全量枚举，缺行视为数据事故）。
          console.warn(`[pricing] 灰度表缺行 ${key}（release ${gray.releaseId}）— 落 global`)
        }
      }
      // ② global（无灰度路径，返回对象不含 grayReleaseId 键）。
      const table = await this.loadActiveTable()
      if (!table) throw new Error('no active price list version')
      const hit = table.entries.get(key) ?? table.entries.get(`${q.capability}:*`)
      if (hit === undefined) throw new Error(`no entry for ${key}`)
      return { credits: hit, ruleVersion: table.version }
    } catch (err) {
      console.warn(
        `[pricing] 查询落常量兜底（${buildMatchKey(q)}）：`,
        err instanceof Error ? err.message : err,
      )
      return { credits: legacy, ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK }
    }
  }

  // —— P2 T4：文本 token 反比率计价（Task 6 回合结算消费）——

  /**
   * P2 文本 token 计费的 usage 口径。costUsd = vendor usage.cost 求和（Task 6 传入），
   * 仅 degraded 兜底消费；计划原文表述为「usage.cost 求和」，落为可选字段。
   */
  async quoteTextTokens(
    userId: string | undefined,
    modelKey: string,
    usage: { inputTokens: number; cacheReadTokens: number; outputTokens: number; costUsd?: number },
  ): Promise<PricingQuote & { breakdown?: { in: number; cache: number; out: number } }> {
    try {
      const model = String(modelKey || '').toLowerCase()
      // token 行无 legacy 常量可兜（constants 旁路/未知模型都直接落 USD 成本兜底）
      if (process.env.PRICING_SOURCE === 'constants' || !TEXT_TOKEN_MODELS.includes(model)) {
        return await this.degradedTextTokenQuote(usage)
      }
      // 与 quote() 同构的 degraded 短路 + 自愈探测
      if (this.degraded) {
        await this.trySelfHeal()
        if (this.degraded) return await this.degradedTextTokenQuote(usage)
      }
      const keyOf = (spec: TextTokenSpec) => buildTextTokenMatchKey(model, spec)
      // 解析顺序与 quote() 同构：灰度名单命中优先 → global；灰度缺 in/out 行
      // 视为数据事故整组落 global（cache 行缺是受支持形态，见下）。
      let entries: Map<string, number>
      let ruleVersion: string
      let grayReleaseId: string | undefined
      const gray = userId ? await this.loadGrayTable() : null
      if (userId && gray && gray.whitelist.has(userId)) {
        const gi = gray.entries.get(keyOf('in'))
        const go = gray.entries.get(keyOf('out'))
        if (gi !== undefined && go !== undefined) {
          entries = gray.entries
          ruleVersion = gray.version
          grayReleaseId = gray.releaseId
        } else {
          console.warn(
            `[pricing] 灰度表缺文本 token 行 ${keyOf('in')}/${keyOf('out')}（release ${gray.releaseId}）— 落 global`,
          )
          const table = await this.requireGlobalTable()
          entries = table.entries
          ruleVersion = table.version
        }
      } else {
        const table = await this.requireGlobalTable()
        entries = table.entries
        ruleVersion = table.version
      }
      const rIn = entries.get(keyOf('in'))
      const rOut = entries.get(keyOf('out'))
      const rCache = entries.get(keyOf('cache'))
      if (!isPositiveRatio(rIn) || !isPositiveRatio(rOut)) {
        // 三行齐才走价目口径：in/out 缺行 = 数据事故 → degraded
        return await this.degradedTextTokenQuote(usage)
      }
      // cache 行缺（step-2-16k 上游未公布）→ cache tokens 并入 in 项
      const hasCache = isPositiveRatio(rCache)
      const inTokens = positiveTokens(usage.inputTokens) + (hasCache ? 0 : positiveTokens(usage.cacheReadTokens))
      const bIn = Math.ceil(inTokens / rIn)
      const bCache = hasCache ? Math.ceil(positiveTokens(usage.cacheReadTokens) / rCache) : 0
      const bOut = Math.ceil(positiveTokens(usage.outputTokens) / rOut)
      const quote: PricingQuote & { breakdown: { in: number; cache: number; out: number } } = {
        credits: Math.max(1, bIn + bCache + bOut),
        ruleVersion,
        breakdown: { in: bIn, cache: bCache, out: bOut },
      }
      if (grayReleaseId) quote.grayReleaseId = grayReleaseId // 条件写入（键不出现纪律）
      return quote
    } catch (err) {
      console.warn(
        '[pricing] 文本 token 计价异常 — 落 USD 成本兜底：',
        err instanceof Error ? err.message : err,
      )
      return this.degradedTextTokenQuote(usage)
    }
  }

  /** global 表（无 active 版本抛错 → 由 quoteTextTokens 的 catch 落 degraded）。 */
  private async requireGlobalTable(): Promise<PriceTable> {
    const table = await this.loadActiveTable()
    if (!table) throw new Error('no active price list version')
    return table
  }

  /**
   * degraded 兜底（Q2 展示预估同款公式）：usage.costUsd（vendor cost 求和）× FX
   * × 当前生效阶段 marginBp。marginBp 照 agent.service Q2 预估的防御读模式
   * （mock 替身缺 marginPolicy / 表读失败都不炸，缺省 11000bp）。min 1。
   */
  private async degradedTextTokenQuote(usage: {
    costUsd?: number
  }): Promise<PricingQuote> {
    const [marginBp, fxUsdCny] = await Promise.all([
      this.readCurrentMarginBp(),
      Promise.resolve(resolveFxUsdCny(process.env as NodeJS.ProcessEnv)),
    ])
    const costUsd = positiveTokens(usage.costUsd ?? 0)
    return {
      credits: Math.max(1, estimateCreditsFromUsdCost(costUsd, marginBp, fxUsdCny)),
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    }
  }

  /** MarginPolicy 当前生效系数（防御读，缺省 11000bp——与 agent.service readMarginBp 同源同缺省）。 */
  private async readCurrentMarginBp(): Promise<number> {
    try {
      const row = await this.prisma?.marginPolicy?.findFirst?.({ orderBy: { createdAt: 'desc' } })
      return typeof row?.marginBp === 'number' && row.marginBp > 0 ? row.marginBp : 11000
    } catch {
      return 11000
    }
  }

  /**
   * degraded 期间的主动恢复探测：查一次 active 版本，命中即由 loadActiveTable
   * 复位 degraded（warn 记录）。节流 CACHE_TTL_MS；DB 异常吞掉——降级状态不变，
   * quote 继续走常量兜底。
   */
  private async trySelfHeal(): Promise<void> {
    if (!this.degraded || !this.degradedHealable) return
    const now = Date.now()
    if (this.lastSelfHealAt !== null && now - this.lastSelfHealAt < CACHE_TTL_MS) return
    this.lastSelfHealAt = now
    try {
      await this.loadActiveTable()
    } catch (err) {
      console.warn('[pricing] 降级恢复探测失败（继续常量兜底）：', err instanceof Error ? err.message : err)
    }
  }

  private async loadActiveTable(): Promise<PriceTable | null> {
    if (this.cache && Date.now() - this.cache.loadedAt < CACHE_TTL_MS) return this.cache
    const version = await this.prisma.priceListVersion.findFirst({
      where: { status: 'active' },
      include: { entries: true },
    })
    if (!version) {
      this.cache = null
      return null
    }
    const entries = new Map<string, number>()
    for (const e of version.entries) entries.set(e.matchKey, e.credits)
    this.cache = { id: version.id, version: version.version, entries, loadedAt: Date.now() }
    // 自愈：boot 时因「无 active 版本」降级的进程，运行中经发布流建出版本后
    // 到这里就能恢复——不必重启（终审 Critical C2：degraded 曾是永久闩锁，
    // 使「改价不发版」在运行中的进程失效，而发布成功/审计有记录/价格不生效
    // 且无任何提示）。仅可自愈的降级才复位，自检失配等降级刻意保持闩锁。
    if (this.degraded && this.degradedHealable) {
      this.degraded = false
      this.degradedHealable = false
      console.warn(`[pricing] 已从降级恢复（检测到 active 价目表版本 ${version.version}）`)
    }
    return this.cache
  }

  /**
   * 加载 active 灰度发布（createdAt 最新一条）。窗口外返回 null（惰性过期，
   * 无写路径）；DB 异常返回 null 绝不 throw——灰度永远不影响报价可用性。
   */
  private async loadGrayTable(): Promise<GrayTable | null> {
    if (this.grayCache && Date.now() - this.grayCache.loadedAt < CACHE_TTL_MS) return this.grayCache
    try {
      const rel = await this.prisma.pricingGrayRelease.findFirst({
        where: { status: 'active' },
        orderBy: { createdAt: 'desc' },
        include: { version: { include: { entries: true } }, whitelist: true },
      })
      if (!rel) {
        this.grayCache = null
        return null
      }
      const now = Date.now()
      const startsAt = new Date(rel.startsAt).getTime()
      const endsAt = new Date(rel.endsAt).getTime()
      if (now < startsAt || now > endsAt) {
        this.grayCache = null
        return null
      }
      const entries = new Map<string, number>()
      for (const e of rel.version.entries) entries.set(e.matchKey, e.credits)
      const whitelist = new Set(rel.whitelist.map((w) => w.userId))
      this.grayCache = { releaseId: rel.id, version: rel.version.version, entries, whitelist, startsAt, endsAt, loadedAt: now }
      return this.grayCache
    } catch (err) {
      console.warn('[pricing] 灰度表加载失败 — 本轮按无灰度处理：', err instanceof Error ? err.message : err)
      this.grayCache = null
      return null
    }
  }
}
