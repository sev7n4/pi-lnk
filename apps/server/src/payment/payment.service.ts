import { Injectable, Inject, BadRequestException, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { MembershipService } from '../membership/membership.service'
import {
  TOPUP_CUSTOM_MAX_FEN,
  TOPUP_CUSTOM_MIN_FEN,
  resolveTopupPoints,
} from '../membership/membership.service'
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

  /**
   * 创建订单并返回支付凭据。
   * channel='page'（默认）：电脑网站支付收银台跳转 URL（支持账号密码登录付款）。
   * channel='qrcode'：当面扫码预下单，返回二维码串（支付宝 App 扫码即付，一步到位）。
   */
  async createOrder(userId: string, plan: string, channel: 'page' | 'qrcode' = 'page') {
    const selected = this.membership.getPlan(plan)
    if (!selected || plan === 'free') throw new BadRequestException('无效套餐')
    // 【一个用户同时只持有一个套餐】已有付费套餐时只允许续费同档，换购必须先退订。
    // ⚠️ 不能拦「≤」：连续包月每月一笔同档订单，拦了等于把自动续费整片打死。
    // 这里拦的是「持有其它付费档 + 买不同档」= 静默降级/换档。
    const holder = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { membership: true },
    })
    const heldPlan = holder?.membership ?? 'free'
    if (heldPlan !== 'free' && heldPlan !== plan) {
      throw new BadRequestException('你已持有其他套餐，需先退订后才能订购新套餐')
    }
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
    return this.createChargeForOrder(order.id, amountFen, charge, channel)
  }

  /**
   * 创建积分充值订单（kind='topup'）：¥5–¥10,000，档位金额带赠送、自定义按基础汇率。
   * 结算仅发积分（1 年有效期，purchased 池），不改会员档位。
   */
  async createTopup(userId: string, amountFen: number, channel: 'page' | 'qrcode' = 'page') {
    if (!Number.isInteger(amountFen)) throw new BadRequestException('充值金额无效')
    if (amountFen < TOPUP_CUSTOM_MIN_FEN) throw new BadRequestException('充值金额最低 ¥5')
    if (amountFen > TOPUP_CUSTOM_MAX_FEN) throw new BadRequestException('充值金额超出上限')
    const { totalPoints } = resolveTopupPoints(amountFen)
    const order = await this.prisma.order.create({
      data: { userId, plan: 'topup', kind: 'topup', points: totalPoints, amount: amountFen },
    })
    const charge: ChargeRequest = {
      orderId: order.id,
      amountFen,
      subject: 'lnk π 积分充值',
      body: `充值 ${totalPoints} 积分`,
    }
    return this.createChargeForOrder(order.id, amountFen, charge, channel)
  }

  /** 按渠道发起下单：qrcode 返回二维码串，page 返回收银台跳转 URL。 */
  private async createChargeForOrder(
    orderId: string,
    amountFen: number,
    charge: ChargeRequest,
    channel: 'page' | 'qrcode',
  ) {
    if (channel === 'qrcode') {
      const { qrCode } = await this.adapter.createQrCharge(charge)
      return { orderId, qrCode, amountFen }
    }
    const { payUrl } = await this.adapter.createCharge(charge)
    return { orderId, payUrl, amountFen }
  }

  /** 充值档位配置（前端瓦片渲染单一真源）。 */
  topupOptions() {
    return this.membership.topupOptions()
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
        // 按 Order.kind 分流入账：topup 仅发积分（1 年有效期），subscription 发套餐积分+升档。
        if (order.kind === 'topup') {
          await this.membership.grantTopupTx(tx, order.userId, order.points ?? 0, order.id)
        } else {
          await this.membership.grantPaidPlanTx(tx, order.userId, order.plan, order.id)
        }
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
    kind: string
    points: number | null
    amount: number
    status: string
    paidAt: Date | null
    createdAt: Date
  }) {
    return {
      id: order.id,
      plan: order.plan,
      kind: order.kind,
      points: order.points,
      amountFen: order.amount,
      status: order.status,
      paidAt: order.paidAt,
      createdAt: order.createdAt,
    }
  }
}

export type { PaymentAdapter } from './payment.adapter'
export { PAYMENT_ADAPTER } from './payment.adapter'
