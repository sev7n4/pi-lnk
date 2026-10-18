import { Inject, Injectable, BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { PointsRangeKey, resolvePointsRange } from '../points/points-range'
import { computePointsInsights, shanghaiDayKey, type PointsInsights } from '../points/points-insights'
import {
  parseShanghaiDay,
  resolveHeatmapRange,
  resolveUsageDaysRange,
  type UsageDaysRangeKey,
} from '../points/points-usage-range'
import {
  fillCalendarDays,
  filterHeatmapDays,
  foldDailyUsage,
  isUsageActivityDay,
  generationCountFromParts,
  netFromKindCategorySums,
  coerceDayKey,
  type DailyAmountRow,
  type DailyGenerationRow,
  type UsageDaysResponse,
  type UsageOverviewResponse,
} from '../points/points-usage'

export type PointKind = 'consume' | 'refund' | 'grant'
export type PointCategory = 'text' | 'image' | 'audio' | 'video' | 'other'
/// 多池记账的池类型（spec 2026-10-13-billing-points-system-design §多池）。
/// purchased=支付购买（可设有效期）· granted=赠送/签到（默认，存量数据归此池）· subscription=订阅赠送。
export type PointPool = 'purchased' | 'granted' | 'subscription'

export interface PointTxDto {
  id: string
  userId: string
  amount: number
  reason: string
  kind: string
  category: string
  status: string | null
  model: string | null
  generationId: string | null
  balanceAfter: number | null
  pool: string
  expiresAt: Date | null
  orderId: string | null
  createdAt: Date
}

/// 单池余额分解：total=净额（含消费/退款）、available=可用（扣除已过期正额）、expired=已过期正额。
export interface PointsPoolBreakdownDto {
  total: number
  available: number
  expired: number
}

/// 按池余额分解（只读聚合，不改动 User.points 结算链路）。
export interface PointsBreakdownDto {
  totalAvailable: number
  expiredTotal: number
  pools: Record<PointPool, PointsPoolBreakdownDto>
}

export interface PointsSummaryDto {
  range: PointsRangeKey
  from: string | null
  to: string
  byCategory: Record<Exclude<PointCategory, 'other'>, number>
  otherNetConsumed: number
  refundTotal: number
  grantTotal: number
  insights: PointsInsights
}

const PLANS = [
  { id: 'free', name: '免费版', points: 1000, price: 0, features: ['每日 100 积分', '基础模型'] },
  { id: 'pro', name: '专业版', points: 5000, price: 99, features: ['每日 500 积分', '高级模型', '优先队列'] },
  { id: 'studio', name: '工作室版', points: 20000, price: 299, features: ['无限画布', '全模型', '团队协作'] },
]

/**
 * 积分充值档位（amountFen 单位：分）。基础汇率 1 元 = 100 积分，
 * 赠送随档位阶梯递增（0%/10%/15%/20%/30%）；自定义金额走基础汇率无赠送。
 */
export const TOPUP_TIERS = [
  { amountFen: 1000, bonusPoints: 0 }, // ¥10 → 1,000
  { amountFen: 2000, bonusPoints: 200 }, // ¥20 → 2,200
  { amountFen: 3000, bonusPoints: 450 }, // ¥30 → 3,450
  { amountFen: 5000, bonusPoints: 1000 }, // ¥50 → 6,000
  { amountFen: 10000, bonusPoints: 3000 }, // ¥100 → 13,000
] as const

export const TOPUP_CUSTOM_MIN_FEN = 500 // 自定义起充 ¥5
export const TOPUP_CUSTOM_MAX_FEN = 1_000_000 // 自定义上限 ¥10,000
export const TOPUP_POINTS_PER_FEN = 1 // 基础汇率：1 分 = 1 积分（= 100 积分/元）
export const TOPUP_EXPIRY_DAYS = 365 // 充值积分有效期：1 年

/** 充值积分解析：档位命中带赠送，否则按基础汇率（含自定义金额与未命中金额）。 */
export function resolveTopupPoints(amountFen: number): {
  basePoints: number
  bonusPoints: number
  totalPoints: number
} {
  const tier = TOPUP_TIERS.find((t) => t.amountFen === amountFen)
  const basePoints = amountFen * TOPUP_POINTS_PER_FEN
  const bonusPoints = tier?.bonusPoints ?? 0
  return { basePoints, bonusPoints, totalPoints: basePoints + bonusPoints }
}

@Injectable()
export class MembershipService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  getPlans() {
    return PLANS
  }

  /** 按 id 查套餐定义（支付下单用）。 */
  getPlan(plan: string) {
    return PLANS.find((p) => p.id === plan)
  }

  async getPoints(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new BadRequestException('用户不存在')
    return { points: user.points, membership: user.membership }
  }

  /// 按池余额分解（多池记账 · 只读聚合）。不改动 User.points 单一权威余额与计费扣减链路，
  /// 仅从 PointTransaction 账本按 pool 汇总，供前端展示与对账。
  /// - total(pool)：该池全部变动净额（grant/consume/refund 相加）。
  /// - expired(pool)：该池中「已到期且为正额」的部分（仅 grant 可带 expiresAt；消费为负恒 NULL 不计入）。
  /// - available(pool)：total − expired（到期部分不计入可用余额，但保留账本供对账）。
  async getPointsBreakdown(userId: string, now: Date = new Date()): Promise<PointsBreakdownDto> {
    const [totalRows, expiredRows] = await Promise.all([
      this.prisma.pointTransaction.groupBy({
        by: ['pool'],
        where: { userId },
        _sum: { amount: true },
      }),
      this.prisma.pointTransaction.groupBy({
        by: ['pool'],
        where: { userId, amount: { gt: 0 }, expiresAt: { lt: now } },
        _sum: { amount: true },
      }),
    ])

    const pools: Record<PointPool, PointsPoolBreakdownDto> = {
      purchased: { total: 0, available: 0, expired: 0 },
      granted: { total: 0, available: 0, expired: 0 },
      subscription: { total: 0, available: 0, expired: 0 },
    }
    for (const row of totalRows) {
      const pool = row.pool as PointPool
      if (pool in pools) pools[pool].total = row._sum.amount ?? 0
    }
    let expiredTotal = 0
    for (const row of expiredRows) {
      const pool = row.pool as PointPool
      if (pool in pools) {
        const expired = row._sum.amount ?? 0
        pools[pool].expired = expired
        expiredTotal += expired
      }
    }
    for (const pool of Object.keys(pools) as PointPool[]) {
      pools[pool].available = pools[pool].total - pools[pool].expired
    }
    const totalAvailable =
      pools.purchased.available + pools.granted.available + pools.subscription.available
    return { totalAvailable, expiredTotal, pools }
  }

  async claimDaily(userId: string, now: Date = new Date()) {
    const bonus = 100
    // 资损止血 F1：按上海自然日幂等，防止脚本重复调用刷分
    const dayKey = shanghaiDayKey(now)
    const day = parseShanghaiDay(dayKey)
    if (!day) throw new BadRequestException('日期解析失败')
    const { from: dayStart, next: dayEnd } = day
    const user = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id: userId } })
      if (!existing) throw new BadRequestException('用户不存在')
      if (
        existing.lastDailyClaimAt &&
        existing.lastDailyClaimAt >= dayStart &&
        existing.lastDailyClaimAt < dayEnd
      ) {
        throw new BadRequestException('今日已签到')
      }
      const updated = await tx.user.update({
        where: { id: userId },
        data: { points: { increment: bonus }, lastDailyClaimAt: now },
      })
      await tx.pointTransaction.create({
        data: {
          userId,
          amount: bonus,
          reason: '每日签到',
          kind: 'grant',
          category: 'other',
          status: null,
          balanceAfter: updated.points,
          pool: 'granted', // 每日签到属赠送池（多池记账）
        },
      })
      return updated
    })
    return { points: user.points, added: bonus }
  }

  /**
   * 支付成功入账（风险 #2）：发放套餐积分 + 升级 membership + 写 purchased 池流水。
   * ⚠️ 幂等锚点：同一 orderId 只允许一条 purchased 流水（grantPaidPlan 内部守卫），
   * 因此回调（PaymentService.settlePaidOrder）与 upgrade 兜底可安全重复调用。
   * tx 变体供支付回调整合进同一事务（避免嵌套交互事务）。
   */
  async grantPaidPlanTx(
    tx: Prisma.TransactionClient,
    userId: string,
    plan: string,
    orderId: string,
    now: Date = new Date(),
  ) {
    const selected = PLANS.find((p) => p.id === plan)
    if (!selected || plan === 'free') throw new BadRequestException('无效套餐')
    const already = await tx.pointTransaction.findFirst({
      where: { orderId, pool: 'purchased' },
    })
    if (already) {
      // 幂等：该订单权益已发放（回调与兜底路径重复调用）。返回当前状态而非报错——
      // 客户端重试/兜底语义下「已入账」不是失败；守卫仍保证绝不二次发分。
      const current = await tx.user.findUnique({ where: { id: userId } })
      return { membership: current?.membership ?? plan, points: current?.points ?? 0 }
    }
    const updated = await tx.user.update({
      where: { id: userId },
      data: { membership: plan, points: { increment: selected.points } },
    })
    await tx.pointTransaction.create({
      data: {
        userId,
        amount: selected.points,
        reason: `购买 ${selected.name}`,
        kind: 'grant',
        category: 'other',
        status: null,
        balanceAfter: updated.points,
        pool: 'purchased', // 支付购买池（多池记账）
        orderId,
        expiresAt: null, // 套餐积分暂不设有效期（过期策略待产品定义）
      },
    })
    return { membership: updated.membership, points: updated.points }
  }

  async grantPaidPlan(userId: string, plan: string, orderId: string, now: Date = new Date()) {
    return this.prisma.$transaction((tx) => this.grantPaidPlanTx(tx, userId, plan, orderId, now))
  }

  /**
   * 积分充值入账（不含会员变更）：发放总积分（基础+赠送）到 purchased 池，1 年有效期。
   * ⚠️ 幂等锚点与 grantPaidPlanTx 同构：同一 orderId 只允许一条 purchased 流水。
   * 有效期为账本级（PointTransaction.expiresAt）：到期后 points-breakdown 的 available
   * 自动扣减，不回改 User.points —— 与 #446 多池机制一致。
   */
  async grantTopupTx(
    tx: Prisma.TransactionClient,
    userId: string,
    totalPoints: number,
    orderId: string,
    now: Date = new Date(),
  ) {
    if (!Number.isInteger(totalPoints) || totalPoints <= 0) {
      throw new BadRequestException('充值积分数额无效')
    }
    const already = await tx.pointTransaction.findFirst({
      where: { orderId, pool: 'purchased' },
    })
    if (already) {
      const current = await tx.user.findUnique({ where: { id: userId } })
      return { membership: current?.membership ?? 'free', points: current?.points ?? 0 }
    }
    const expiresAt = new Date(now.getTime() + TOPUP_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
    const updated = await tx.user.update({
      where: { id: userId },
      data: { points: { increment: totalPoints } },
    })
    await tx.pointTransaction.create({
      data: {
        userId,
        amount: totalPoints,
        reason: '积分充值',
        kind: 'grant',
        category: 'other',
        status: null,
        balanceAfter: updated.points,
        pool: 'purchased', // 支付购买池（多池记账）
        orderId,
        expiresAt, // 充值积分 1 年有效期（账本级过期）
      },
    })
    return { membership: updated.membership, points: updated.points }
  }

  /** 充值档位配置（前端瓦片渲染单一真源）。 */
  topupOptions() {
    return {
      tiers: TOPUP_TIERS.map((t) => {
        const { basePoints, bonusPoints, totalPoints } = resolveTopupPoints(t.amountFen)
        return { amountFen: t.amountFen, basePoints, bonusPoints, totalPoints }
      }),
      customMinFen: TOPUP_CUSTOM_MIN_FEN,
      customMaxFen: TOPUP_CUSTOM_MAX_FEN,
      pointsPerFen: TOPUP_POINTS_PER_FEN,
      expiryDays: TOPUP_EXPIRY_DAYS,
    }
  }

  /**
   * 升级套餐（风险 #2：必须持有已支付订单）。
   * 主入账路径是支付宝异步通知回调；本方法是前端付款跳回后的兜底确认
   * （幂等守卫保证与回调不会重复发分）。
   */
  async upgrade(userId: string, plan: string, orderId?: string) {
    const selected = PLANS.find((p) => p.id === plan)
    if (!selected || plan === 'free') throw new BadRequestException('无效套餐')
    if (!orderId) throw new BadRequestException('缺少支付订单：请先完成支付')
    const order = await this.prisma.order.findUnique({ where: { id: orderId } })
    if (!order || order.userId !== userId) throw new BadRequestException('订单不存在')
    if (order.plan !== plan) throw new BadRequestException('订单与套餐不匹配')
    if (order.status !== 'PAID') throw new BadRequestException('支付订单未完成')
    return this.grantPaidPlan(userId, plan, orderId)
  }

  async pointsSummary(userId: string, range: PointsRangeKey): Promise<PointsSummaryDto> {
    const { from, to } = resolvePointsRange(range)
    const rows = await this.prisma.pointTransaction.groupBy({
      by: ['kind', 'category'],
      where: {
        userId,
        createdAt: from ? { gte: from, lte: to } : { lte: to },
      },
      _sum: { amount: true },
    })

    const consumed = { text: 0, image: 0, audio: 0, video: 0, other: 0 }
    const refunded = { text: 0, image: 0, audio: 0, video: 0, other: 0 }
    let refundTotal = 0
    let grantTotal = 0

    for (const row of rows) {
      const category = row.category in consumed ? (row.category as PointCategory) : 'other'
      const amount = row._sum.amount ?? 0
      if (row.kind === 'consume') consumed[category] += amount
      if (row.kind === 'refund') {
        refunded[category] += amount
        refundTotal += amount
      }
      if (row.kind === 'grant') grantTotal += amount
    }

    const netConsumed = (category: PointCategory) =>
      Math.max(0, -consumed[category] - refunded[category])

    const netConsumedTotal =
      netConsumed('text') +
      netConsumed('image') +
      netConsumed('audio') +
      netConsumed('video') +
      netConsumed('other')

    const consumeRows = await this.prisma.pointTransaction.findMany({
      where: {
        userId,
        kind: 'consume',
        createdAt: from ? { gte: from, lte: to } : { lte: to },
      },
      select: { createdAt: true, amount: true },
    })

    const insights = computePointsInsights({
      netConsumedTotal,
      consumeRows,
      from,
      to,
    })

    return {
      range,
      from: from?.toISOString() ?? null,
      to: to.toISOString(),
      byCategory: {
        text: netConsumed('text'),
        image: netConsumed('image'),
        audio: netConsumed('audio'),
        video: netConsumed('video'),
      },
      otherNetConsumed: netConsumed('other'),
      refundTotal,
      grantTotal,
      insights,
    }
  }

  async listTransactions(
    userId: string,
    opts: {
      range?: PointsRangeKey
      day?: string
      kind?: PointKind
      category?: PointCategory
      cursor?: string
      limit?: number
    },
  ): Promise<{ items: PointTxDto[]; nextCursor: string | null; from: string | null; to: string }> {
    let from: Date | null
    let to: Date
    let createdAt: { gte?: Date; lte?: Date; lt?: Date }
    if (opts.day) {
      const parsed = parseShanghaiDay(opts.day)
      if (!parsed) throw new BadRequestException('无效日期')
      from = parsed.from
      to = parsed.next
      createdAt = { gte: parsed.from, lt: parsed.next }
    } else {
      const resolved = resolvePointsRange(opts.range ?? 'month')
      from = resolved.from
      to = resolved.to
      createdAt = from ? { gte: from, lte: to } : { lte: to }
    }
    const limit = opts.limit ?? 50
    const rows = await this.prisma.pointTransaction.findMany({
      where: {
        userId,
        ...(opts.kind ? { kind: opts.kind } : {}),
        ...(opts.category ? { category: opts.category } : {}),
        createdAt,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    })
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit)
    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
      from: from?.toISOString() ?? null,
      to: to.toISOString(),
    }
  }

  // Prisma SQLite DateTime is unix ms; SQLite datetime(n) treats numbers as seconds.
  private async queryLifetimeStats(userId: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{ distinctGens: number | bigint; nullGens: number | bigint; activeDays: number | bigint }>
    >`
    SELECT
      (SELECT COUNT(DISTINCT generationId) FROM PointTransaction
        WHERE userId = ${userId} AND kind = 'consume'
          AND generationId IS NOT NULL AND generationId != '') AS distinctGens,
      (SELECT COUNT(*) FROM PointTransaction
        WHERE userId = ${userId} AND kind = 'consume'
          AND (generationId IS NULL OR generationId = '')) AS nullGens,
      (SELECT COUNT(DISTINCT date(datetime(createdAt / 1000.0, 'unixepoch', '+8 hours'))) FROM PointTransaction
        WHERE userId = ${userId} AND kind = 'consume') AS activeDays
  `
    const row = rows[0] ?? { distinctGens: 0, nullGens: 0, activeDays: 0 }
    return {
      generationCount: generationCountFromParts({
        distinctGens: Number(row.distinctGens),
        nullGens: Number(row.nullGens),
      }),
      activeDays: Number(row.activeDays),
    }
  }

  private async queryDailyAmountRows(userId: string, from: Date, to: Date): Promise<DailyAmountRow[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ day: string; kind: string; category: string; amountSum: number | bigint }>
    >`
    SELECT date(datetime(createdAt / 1000.0, 'unixepoch', '+8 hours')) AS day,
           kind,
           category,
           SUM(amount) AS amountSum
    FROM PointTransaction
    WHERE userId = ${userId} AND createdAt >= ${from} AND createdAt <= ${to}
    GROUP BY day, kind, category
  `
    return rows.flatMap((row) => {
      const day = coerceDayKey(row.day)
      if (!day) return []
      return [
        {
          day,
          kind: row.kind,
          category: row.category,
          amountSum: Number(row.amountSum),
        },
      ]
    })
  }

  private async queryDailyGenerationRows(userId: string, from: Date, to: Date): Promise<DailyGenerationRow[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ day: string; distinctGens: number | bigint; nullGens: number | bigint }>
    >`
    SELECT date(datetime(createdAt / 1000.0, 'unixepoch', '+8 hours')) AS day,
           COUNT(DISTINCT CASE WHEN generationId IS NOT NULL AND generationId != '' THEN generationId END) AS distinctGens,
           SUM(CASE WHEN generationId IS NULL OR generationId = '' THEN 1 ELSE 0 END) AS nullGens
    FROM PointTransaction
    WHERE userId = ${userId} AND kind = 'consume'
      AND createdAt >= ${from} AND createdAt <= ${to}
    GROUP BY day
  `
    return rows.flatMap((row) => {
      const day = coerceDayKey(row.day)
      if (!day) return []
      return [
        {
          day,
          distinctGens: Number(row.distinctGens),
          nullGens: Number(row.nullGens),
        },
      ]
    })
  }

  async usage(userId: string, now = new Date()): Promise<UsageOverviewResponse> {
    const heatmapRange = resolveHeatmapRange(now)
    const [grouped, lifetime, amountRows, generationRows] = await Promise.all([
      this.prisma.pointTransaction.groupBy({
        by: ['kind', 'category'],
        where: { userId },
        _sum: { amount: true },
      }),
      this.queryLifetimeStats(userId),
      this.queryDailyAmountRows(userId, heatmapRange.from, heatmapRange.to),
      this.queryDailyGenerationRows(userId, heatmapRange.from, heatmapRange.to),
    ])
    const net = netFromKindCategorySums(
      grouped.map((row) => ({
        kind: row.kind,
        category: row.category,
        amountSum: row._sum.amount ?? 0,
      })),
    )
    const folded = foldDailyUsage(amountRows, generationRows)
    const days = filterHeatmapDays(folded)
    return {
      overview: {
        netConsumedTotal: net.netConsumedTotal,
        byCategory: net.byCategory,
        otherNetConsumed: net.otherNetConsumed,
        generationCount: lifetime.generationCount,
        activeDays: lifetime.activeDays,
      },
      heatmap: {
        from: heatmapRange.fromKey,
        to: heatmapRange.toKey,
        activeDays: days.filter((day) => day.generationCount > 0).length,
        days,
      },
    }
  }

  async usageDays(
    userId: string,
    range: UsageDaysRangeKey,
    now = new Date(),
  ): Promise<UsageDaysResponse> {
    const window = resolveUsageDaysRange(range, now)
    const [amountRows, generationRows] = await Promise.all([
      this.queryDailyAmountRows(userId, window.from, window.to),
      this.queryDailyGenerationRows(userId, window.from, window.to),
    ])
    const folded = foldDailyUsage(amountRows, generationRows)
    return {
      range,
      from: window.fromKey,
      to: window.toKey,
      days:
        range === 'all'
          ? folded.filter(isUsageActivityDay)
          : fillCalendarDays(window.fromKey, window.toKey, folded),
    }
  }
}
