/**
 * 价目表服务（P0 · spec §4/§9）。
 *
 * 解析顺序：active 版本精确行 → capability 默认行（matchKey 以 `:*` 结尾，
 * 目前仅 image_edit 有，镜像 legacy 的 `?? 10`）→ 常量兜底 + warn。
 *
 * 四条保底路径（全部真实可测，见 pricing.service.test.ts）：
 * 表缺行 / DB 抛错 / 无 active 版本 / 启动自检失配 ⇒ 常量兜底。
 *
 * ⚠️ P0 专属：boot 时若无 active 版本，调用 seedPricing 自愈（部署零手工步）。
 * P1 运营发布流（spec §8.4）上线后删除自愈分支，改为「无版本 = 告警 + 全量兜底」。
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
import { seedPricing } from '../../prisma/seed-pricing'

const CACHE_TTL_MS = 30_000

interface PriceTable {
  version: string
  entries: Map<string, number>
  loadedAt: number
}

@Injectable()
export class PricingService implements OnModuleInit {
  private cache: PriceTable | null = null
  private degraded = false

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    if (process.env.PRICING_SOURCE === 'constants') {
      console.log('[pricing] PRICING_SOURCE=constants — 价目表旁路，全部走常量兜底')
      return
    }
    try {
      let table = await this.loadActiveTable()
      if (!table) {
        // P0 自愈：无 active 版本时按 legacy 常量播种（幂等；PrismaService extends PrismaClient，无需强转）。
        // P1 删除本分支，改为告警 + 全量兜底。
        const seeded = await seedPricing(this.prisma)
        console.warn(`[pricing] boot 未发现 active 版本，已自播种 ${seeded.version}（${seeded.entries} 行）`)
        table = await this.loadActiveTable()
      }
      if (!table) {
        this.degraded = true
        console.error('[pricing] 无 active 价目表版本 — 已降级常量兜底')
        return
      }
      const space = enumeratePricingSpace()
      const mismatches = space.filter((q) => {
        const row = table!.entries.get(buildMatchKey(q))
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
    } catch (err) {
      this.degraded = true
      console.error('[pricing] 启动自检异常，已降级常量兜底：', err)
    }
  }

  /** 报价。任何失败路径都返回常量兜底值，绝不 throw。 */
  async quote(q: PricingQuery): Promise<PricingQuote> {
    const legacy = legacyPriceOf(q)
    if (this.degraded || process.env.PRICING_SOURCE === 'constants') {
      return { credits: legacy, ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK }
    }
    try {
      const table = await this.loadActiveTable()
      if (!table) throw new Error('no active price list version')
      const key = buildMatchKey(q)
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
    this.cache = { version: version.version, entries, loadedAt: Date.now() }
    return this.cache
  }
}
