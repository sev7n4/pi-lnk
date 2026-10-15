import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common'
import { PointHold, Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import type { PointTxMeta } from './point-tx.types'
import { mapReasonToPointFields } from './reason-map'

/** reaper 扫描周期（终审 C-1）：10 分钟一轮，窗口 30min 由 releaseExpiredHolds 缺省承担。 */
const HOLD_REAPER_INTERVAL_MS = 10 * 60_000

/**
 * 余额不足专用异常（P2 T6 修复轮 F1）：调用方以 instanceof 做「余额不足」分类
 * （如 agent 层 fail-open vs 402 拒绝），取代 message 字符串匹配——points 层改文案
 * 不再造成静默失配。仅 freeze 抛出；consume 的既有文案被大量测试断言，保持不动。
 */
export class InsufficientPointsError extends BadRequestException {
  readonly code = 'INSUFFICIENT_POINTS'
  constructor() {
    super('可用积分不足')
  }
}

@Injectable()
export class PointsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private reaperTimer: NodeJS.Timeout | undefined

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 兜底 reaper 定时接线（P2 终审 C-1）：崩溃 hold 泄漏的唯一兜底。
   *
   * 除进程崩溃外的全部 run 终止路径（settle / error release / 中断 finally /
   * 结算失败 release）已在调用方闭合，但进程崩溃时这些路径全部不可达——
   * 冻结额将永久滞留（用户余额永久变少）。本定时器与 TEXT_TOKEN_BILLING
   * flag **无关**：余额卫生，off 也跑。
   *
   * 故障纪律：sweep 任何异常只 warn，绝不冒泡（定时器故障不得影响业务）；
   * 本轮失败下个周期自然重试。
   */
  onApplicationBootstrap(): void {
    this.reaperTimer = setInterval(() => {
      this.releaseExpiredHolds().catch((err: unknown) => {
        console.warn(
          '[points] 过期 hold 兜底 sweep 失败（下个周期重试）：',
          err instanceof Error ? err.message : err,
        )
      })
    }, HOLD_REAPER_INTERVAL_MS)
    // 不阻止进程退出
    this.reaperTimer.unref?.()
  }

  onApplicationShutdown(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer)
      this.reaperTimer = undefined
    }
  }

  async consume(userId: string, cost: number, reason: string, meta?: PointTxMeta): Promise<void> {
    if (cost <= 0) return
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: userId, points: { gte: cost } },
        data: { points: { decrement: cost } },
      })
      if (updated.count === 0) {
        throw new BadRequestException('积分不足')
      }
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { points: true },
      })
      const fields = meta ?? mapReasonToPointFields(reason, -cost)
      await tx.pointTransaction.create({
        data: {
          userId,
          amount: -cost,
          reason,
          kind: fields.kind,
          category: fields.category,
          status: fields.status !== undefined ? fields.status : 'success',
          model: meta?.model ?? null,
          generationId: meta?.generationId ?? null,
          balanceAfter: user?.points ?? null,
          ruleVersion: meta?.ruleVersion ?? null,
          ...(meta?.grayReleaseId ? { grayReleaseId: meta.grayReleaseId } : {}),
        },
      })
    })
  }

  async refund(userId: string, amount: number, reason: string, meta?: PointTxMeta): Promise<void> {
    if (amount <= 0) return
    await this.prisma.$transaction(async (tx) => {
      await this.refundInTx(tx, userId, amount, reason, meta)
    })
  }

  /**
   * 在调用方的事务里执行退款。
   *
   * 存在场景：退款必须与另一条记录的状态迁移原子化（如 generation reaper 把卡死
   * 记录标记 failed 并同时退款——updateMany 状态守卫在事务内，谁迁走 status 谁
   * 负责收尾，保证 exactly-once）。普通路径请用 refund()。
   */
  async refundInTx(
    tx: Prisma.TransactionClient,
    userId: string,
    amount: number,
    reason: string,
    meta?: PointTxMeta,
  ): Promise<void> {
    await tx.user.updateMany({
      where: { id: userId },
      data: { points: { increment: amount } },
    })
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { points: true },
    })
    const fields = meta ?? mapReasonToPointFields(reason, amount)
    await tx.pointTransaction.create({
      data: {
        userId,
        amount,
        reason,
        kind: fields.kind,
        category: fields.category,
        status: fields.status !== undefined ? fields.status : 'success',
        model: meta?.model ?? null,
        generationId: meta?.generationId ?? null,
        balanceAfter: user?.points ?? null,
        ruleVersion: meta?.ruleVersion ?? null,
        ...(meta?.grayReleaseId ? { grayReleaseId: meta.grayReleaseId } : {}),
      },
    })
  }

  /**
   * 冻结积分（P2 token 计费回合预扣）：points 余额不动，只增加 pointsFrozen。
   *
   * 单事务：先读后判（可用 = points - pointsFrozen）再以 updateMany 条件守卫
   * increment（与既有 consume 同构，SQLite 单写者下事务内读可见前序提交，
   * 条件更新兜底防并发超扣）。
   */
  async freeze(userId: string, amount: number, reason: string): Promise<PointHold> {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('冻结积分必须为正整数')
    }
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { points: true, pointsFrozen: true },
      })
      if (!user || user.points - user.pointsFrozen < amount) {
        throw new InsufficientPointsError()
      }
      const updated = await tx.user.updateMany({
        where: { id: userId, points: { gte: user.pointsFrozen + amount } },
        data: { pointsFrozen: { increment: amount } },
      })
      if (updated.count === 0) {
        throw new InsufficientPointsError()
      }
      const hold = await tx.pointHold.create({
        data: { userId, amount, status: 'held', reason },
      })
      await tx.pointTransaction.create({
        data: {
          userId,
          // points 余额未变（冻结只动 pointsFrozen），流水 amount 恒等于余额增量 → 0
          amount: 0,
          reason,
          kind: 'freeze',
          category: 'other',
          status: 'held',
          model: null,
          generationId: null,
          balanceAfter: user.points,
          ruleVersion: null,
        },
      })
      return hold
    })
  }

  /**
   * 从冻结单结算：解冻 hold.amount，按实际用量扣 points（差额自然留在余额）。
   *
   * 单事务 + hold 状态条件迁移（held → settled）作为 exactly-once 守卫；
   * 已终结的 hold 幂等返回既记录值，不再动账。
   */
  async settleFromHold(
    holdId: string,
    actualCredits: number,
    reason: string,
    meta?: PointTxMeta,
  ): Promise<{ settled: number; released: number }> {
    if (!Number.isInteger(actualCredits) || actualCredits < 0) {
      throw new BadRequestException('结算积分必须为非负整数')
    }
    return this.prisma.$transaction(async (tx) => {
      const hold = await tx.pointHold.findUnique({ where: { id: holdId } })
      if (!hold) {
        throw new ConflictException('冻结单不存在')
      }
      if (hold.status !== 'held') {
        // 幂等：已终结不再动账，返回既有记录值
        return {
          settled: hold.status === 'settled' ? (hold.settledCredits ?? 0) : 0,
          released: 0,
        }
      }
      const marked = await tx.pointHold.updateMany({
        where: { id: holdId, status: 'held' },
        data: { status: 'settled', settledCredits: actualCredits, settledAt: new Date() },
      })
      if (marked.count === 0) {
        // 状态被并发迁移（与 release/reaper 竞态）——按幂等返回
        return { settled: 0, released: 0 }
      }
      await tx.user.updateMany({
        where: { id: hold.userId },
        data: { pointsFrozen: { decrement: hold.amount } },
      })
      if (actualCredits > 0) {
        const spent = await tx.user.updateMany({
          where: { id: hold.userId, points: { gte: actualCredits } },
          data: { points: { decrement: actualCredits } },
        })
        if (spent.count === 0) {
          // 不变量被破坏（points < 实际用量）——整事务回滚，hold 保持 held
          throw new ConflictException('积分状态异常，结算中止')
        }
      }
      const user = await tx.user.findUnique({
        where: { id: hold.userId },
        select: { points: true },
      })
      await tx.pointTransaction.create({
        data: {
          userId: hold.userId,
          amount: -actualCredits,
          reason,
          kind: 'consume',
          category: meta?.category ?? 'other',
          status: meta?.status !== undefined ? meta.status : 'success',
          model: meta?.model ?? null,
          generationId: meta?.generationId ?? null,
          balanceAfter: user?.points ?? null,
          ruleVersion: meta?.ruleVersion ?? null,
          ...(meta?.grayReleaseId ? { grayReleaseId: meta.grayReleaseId } : {}),
        },
      })
      return { settled: actualCredits, released: 0 }
    })
  }

  /**
   * 释放冻结单（error/超时路径全退）：解冻 hold.amount，points 余额不动。
   *
   * 单事务 + hold 状态条件迁移（held → released）作为 exactly-once 守卫；
   * 已终结的 hold 幂等 no-op。
   */
  async release(holdId: string, reason: string): Promise<void> {
    await this.releaseOnce(holdId, reason)
  }

  /**
   * release 的可观测变体：返回是否发生了真实状态迁移（held → released）。
   * sweep（releaseExpiredHolds）据此计数——幂等 no-op 不计数（终审 C-1，
   * T3 deferred 的「过报无害」计数语义修正为「实际 released 数」）。
   */
  private async releaseOnce(holdId: string, reason: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const hold = await tx.pointHold.findUnique({ where: { id: holdId } })
      if (!hold) {
        throw new ConflictException('冻结单不存在')
      }
      if (hold.status !== 'held') {
        return false
      }
      const marked = await tx.pointHold.updateMany({
        where: { id: holdId, status: 'held' },
        data: { status: 'released' },
      })
      if (marked.count === 0) {
        return false
      }
      await tx.user.updateMany({
        where: { id: hold.userId },
        data: { pointsFrozen: { decrement: hold.amount } },
      })
      const user = await tx.user.findUnique({
        where: { id: hold.userId },
        select: { points: true },
      })
      await tx.pointTransaction.create({
        data: {
          userId: hold.userId,
          // points 余额未变（释放只回退 pointsFrozen），amount 恒等于余额增量 → 0
          amount: 0,
          reason,
          kind: 'release',
          category: 'other',
          status: 'released',
          model: null,
          generationId: null,
          balanceAfter: user?.points ?? null,
          ruleVersion: null,
        },
      })
      return true
    })
  }

  /**
   * 兜底 reaper：释放超时未结算的 hold（防 hold 泄漏——进程崩溃/回调丢失时
   * 冻结额永不解冻导致用户余额永久变少）。复用 release 的幂等语义。
   *
   * 返回值 = **实际 released 数**（终审 C-1）：幂等 no-op（扫描与释放间隙被
   * settle/release 抢先终结）不计数；单笔异常只 warn 不阻塞其余笔（下个周期
   * 自然重试），异常绝不冒泡到调用方定时器。
   */
  async releaseExpiredHolds(olderThanMs = 30 * 60_000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs)
    const expired = await this.prisma.pointHold.findMany({
      where: { status: 'held', createdAt: { lt: cutoff } },
      select: { id: true },
    })
    let released = 0
    for (const hold of expired) {
      try {
        if (await this.releaseOnce(hold.id, '冻结超时自动释放')) {
          released += 1
        }
      } catch (err) {
        console.warn(
          `[points] 过期 hold 释放失败（hold=${hold.id}，下个周期重试）：`,
          err instanceof Error ? err.message : err,
        )
      }
    }
    return released
  }
}
