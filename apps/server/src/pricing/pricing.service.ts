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
 */
import { Inject, Injectable, OnModuleInit } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import {
  RULE_VERSION_CONSTANTS_FALLBACK,
  buildMatchKey,
  legacyPriceOf,
  type PricingQuery,
  type PricingQuote,
} from './pricing.core'
import { enumeratePricingSpace } from './pricing.space'

const CACHE_TTL_MS = 30_000

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

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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
    if (this.degraded || process.env.PRICING_SOURCE === 'constants') {
      return { credits: legacy, ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK }
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
