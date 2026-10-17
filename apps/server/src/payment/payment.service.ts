import { Injectable, Inject, BadRequestException, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { MembershipService } from '../membership/membership.service'
import {
  PAYMENT_ADAPTER,
  PaymentAdapter,
  type ChargeRequest,
} from './payment.adapter'

/**
 * 支付服务（风险 #2：真实支付闭环 · 支付宝沙箱阶段）。
 *
 * 资损安全核心不变量：
 * 1. 入账唯一入口 = 支付宝异步通知回调（验签通过 + Order CAS + 事务）；
 *    主动查单（syncOrder）与 upgrade 兜底共享同一幂等守卫。
 * 2. Order.status PENDING→PAID 用 updateMany CAS，count===0 即「已入账」，
 *    重复回调/并发回调/查单补偿都不可能重复发分。
 * 3. Payment.orderId @unique + PointTransaction(pool='purchased', orderId)
 *    构成双重幂等锚点；任何一层发现重复都拒绝而非再发。
 * 4. 金额不符（回调金额 ≠ 订单金额）一律拒绝入账并告警。
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name)

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PAYMENT_ADAPTER) private readonly adapter: PaymentAdapter,
    private readonly membership: MembershipService,
  ) {}

  /** 创建订单并返回支付宝收银台跳转 URL（电脑网站支付 page.pay）。 */
  async createOrder(userId: string, plan: string) {
    const selected = this.membership.getPlan(plan)
    if (!selected || plan === 'free') throw new BadRequestException('无效套餐')
    const amountFen = selected.price * 100 // price 单位元 → 分（Int）
    const order = await this.prisma.order.create({
      data: { userId, plan, amount: amountFen },
    })
    const charge: ChargeRequest = {
      orderId: order.id,
      amountFen,
      subject: `lnk π ${selected.name}`,
      body: `升级 ${selected.name}，到账 ${selected.points} 积分`,
    }
    const { payUrl } = await this.adapter.createCharge(charge)
    return { orderId: order.id, payUrl, amountFen }
  }

  /**
   * 支付宝异步通知（notify_url）。form-urlencoded POST。
   * 返回 'success'/'fail' —— 原样返回给支付宝的响应体（不含 sign 的纯文本）。
   */
  async handleAlipayCallback(params: Record<string, string>): Promise<'success' | 'fail'> {
    const verified = this.adapter.verifyCallback(params)
    if (!verified) {
      this.logger.warn(`支付宝回调验签失败: out_trade_no=${params.out_trade_no ?? '?'}`)
      return 'fail'
    }
    const order = await this.prisma.order.findUnique({ where: { id: verified.orderId } })
    if (!order) {
      this.logger.error(`支付宝回调订单不存在: out_trade_no=${verified.orderId}`)
      return 'fail'
    }
    if (verified.amountFen !== order.amount) {
      // 金额不符：可能是伪造通知或串单，绝不入账。
      this.logger.error(
        `支付宝回调金额不符: order=${order.id} expected=${order.amount} got=${verified.amountFen}`,
      )
      return 'fail'
    }
    if (!verified.paid) {
      // 未付款类通知（如 WAIT_BUYER_PAY）：确认收到即可，不入账。
      return 'success'
    }
    return this.settlePaidOrder(order.id, verified.channelTradeNo, params)
  }

  /**
   * 查询订单状态（前端付款后跳回时轮询）。
   * PENDING 订单自动触发一次渠道主动查单作为回调补偿；渠道确认已付则同路径入账。
   */
  async getOrderForUser(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } })
    if (!order || order.userId !== userId) throw new BadRequestException('订单不存在')
    if (order.status === 'PENDING') {
      try {
        const query = await this.adapter.queryTrade(order.id)
        if (query.paid) {
          await this.settlePaidOrder(order.id, query.channelTradeNo ?? null, { source: 'queryTrade' })
          const refreshed = await this.prisma.order.findUnique({ where: { id: order.id } })
          if (refreshed) return this.toOrderDto(refreshed)
        }
      } catch (err) {
        // 查单失败不阻塞状态查询：订单仍显示 PENDING，前端可重试。
        this.logger.warn(`主动查单失败: order=${order.id} err=${(err as Error).message}`)
      }
    }
    return this.toOrderDto(order)
  }

  /** 入账唯一路径：CAS + Payment 记录 + 事务发分。重复调用安全（幂等）。 */
  private async settlePaidOrder(
    orderId: string,
    channelTradeNo: string | null,
    rawParams: Record<string, string>,
  ): Promise<'success' | 'fail'> {
    try {
      await this.prisma.$transaction(async (tx) => {
        // CAS：仅 PENDING → PAID 的调用方负责入账；count===0 说明已入账（幂等短路）。
        const cas = await tx.order.updateMany({
          where: { id: orderId, status: 'PENDING' },
          data: { status: 'PAID', paidAt: new Date() },
        })
        if (cas.count === 0) return
        const order = await tx.order.findUnique({ where: { id: orderId } })
        if (!order) return
        await tx.payment.upsert({
          where: { orderId },
          create: {
            orderId,
            channel: this.adapter.channel,
            channelTradeNo,
            status: 'SUCCESS',
            raw: JSON.stringify(rawParams),
          },
          update: {
            channelTradeNo,
            status: 'SUCCESS',
            raw: JSON.stringify(rawParams),
          },
        })
        await this.membership.grantPaidPlanTx(tx, order.userId, order.plan, order.id)
        this.logger.log(`订单入账成功: order=${order.id} plan=${order.plan} amount=${order.amount}`)
      })
      return 'success'
    } catch (err) {
      // 入账失败（含幂等守卫抛出的已入账）：记录并让渠道重试/查单补偿收敛。
      this.logger.error(`订单入账失败: order=${orderId} err=${(err as Error).message}`)
      return 'fail'
    }
  }

  private toOrderDto(order: {
    id: string
    plan: string
    amount: number
    status: string
    paidAt: Date | null
    createdAt: Date
  }) {
    return {
      id: order.id,
      plan: order.plan,
      amountFen: order.amount,
      status: order.status,
      paidAt: order.paidAt,
      createdAt: order.createdAt,
    }
  }
}

export type { PaymentAdapter } from './payment.adapter'
export { PAYMENT_ADAPTER } from './payment.adapter'
