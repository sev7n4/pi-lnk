import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import type { PointTxMeta } from './point-tx.types'
import { mapReasonToPointFields } from './reason-map'

@Injectable()
export class PointsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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
      },
    })
  }
}
