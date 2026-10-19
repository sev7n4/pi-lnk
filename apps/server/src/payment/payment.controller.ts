import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { PaymentService } from './payment.service'

@Controller('payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  /**
   * 创建支付订单（需登录）。返回支付凭据：
   * - channel 缺省/'page'：payUrl（收银台跳转，支持账号密码登录付款）
   * - channel='qrcode'：qrCode（支付宝 App 扫码即付）
   * body: { plan: 'experience' | 'standard' | 'premium' | 'flagship', channel?: 'page' | 'qrcode' }
   */
  @Post('order')
  @UseGuards(AuthGuard)
  async createOrder(
    @Req() req: { user: { sub: string } },
    @Body() body: { plan?: string; channel?: string },
  ) {
    if (!body?.plan) throw new BadRequestException('缺少套餐参数')
    if (body.channel && body.channel !== 'page' && body.channel !== 'qrcode') {
      throw new BadRequestException('channel 仅支持 page | qrcode')
    }
    const data = await this.paymentService.createOrder(
      req.user.sub,
      body.plan,
      body.channel === 'qrcode' ? 'qrcode' : 'page',
    )
    return { code: 0, message: 'ok', data }
  }

  // ── 自动续费（周期扣款）───────────────────────────────────────────────────
  // ⚠️ 支付宝周期扣款不支持沙箱 ⇒ 能力默认关闭（ALIPAY_AGREEMENT_ENABLED=1 才开）。
  // 未开启时前端展示「手动续期」口径，不谎称已开通自动续费。

  /** 能力探测（免登录）：前端据此决定是否展示「开通自动续费」入口。 */
  @Get('auto-renew/capability')
  autoRenewCapability() {
    return { code: 0, message: 'ok', data: this.paymentService.autoRenewCapability() }
  }

  /** 生成签约跳转 URL（需登录、需已订阅）。 */
  @Post('auto-renew/sign')
  @UseGuards(AuthGuard)
  async createAutoRenewSign(@Req() req: { user: { sub: string } }) {
    const data = await this.paymentService.createAutoRenewSign(req.user.sub)
    return { code: 0, message: 'ok', data }
  }

  /** 签约回跳后确认（需登录）：向渠道查真实签约号并落库。 */
  @Post('auto-renew/confirm')
  @UseGuards(AuthGuard)
  async confirmAutoRenew(@Req() req: { user: { sub: string } }) {
    const data = await this.paymentService.confirmAutoRenew(req.user.sub)
    return { code: 0, message: 'ok', data }
  }

  /** 取消自动续期（需登录）：先渠道解约再改本地，当前周期内仍可用。 */
  @Post('auto-renew/cancel')
  @UseGuards(AuthGuard)
  async cancelAutoRenew(@Req() req: { user: { sub: string } }) {
    const data = await this.paymentService.cancelAutoRenew(req.user.sub)
    return { code: 0, message: 'ok', data }
  }

  /**
   * 积分充值档位配置（免登录，静态配置）。前端瓦片渲染单一真源：
   * tiers[{amountFen, basePoints, bonusPoints, totalPoints}] + customMinFen/customMaxFen/pointsPerFen/expiryDays。
   */
  @Get('topup/options')
  topupOptions() {
    return { code: 0, message: 'ok', data: this.paymentService.topupOptions() }
  }

  /**
   * 创建积分充值订单（需登录）。¥5–¥10,000：档位金额带赠送、自定义按基础汇率（1 分 = 1 积分）。
   * channel 语义与 /payment/order 一致：缺省/'page' 返回 payUrl，'qrcode' 返回 qrCode。
   * body: { amountFen: number, channel?: 'page' | 'qrcode' }
   */
  @Post('topup')
  @UseGuards(AuthGuard)
  async createTopup(
    @Req() req: { user: { sub: string } },
    @Body() body: { amountFen?: number; channel?: string },
  ) {
    if (typeof body?.amountFen !== 'number' || !Number.isInteger(body.amountFen)) {
      throw new BadRequestException('缺少充值金额（amountFen，单位分）')
    }
    if (body.channel && body.channel !== 'page' && body.channel !== 'qrcode') {
      throw new BadRequestException('channel 仅支持 page | qrcode')
    }
    const data = await this.paymentService.createTopup(
      req.user.sub,
      body.amountFen,
      body.channel === 'qrcode' ? 'qrcode' : 'page',
    )
    return { code: 0, message: 'ok', data }
  }

  /**
   * 查询订单状态（需登录，限本人）。PENDING 订单服务端会自动做一次渠道查单补偿。
   */
  @Get('order/:id')
  @UseGuards(AuthGuard)
  async getOrder(@Req() req: { user: { sub: string } }, @Param('id') id: string) {
    const data = await this.paymentService.getOrderForUser(req.user.sub, id)
    return { code: 0, message: 'ok', data }
  }

  /**
   * 支付宝异步通知（notify_url）。⚠️ 无 AuthGuard —— 由支付宝服务器调用，
   * 安全性完全依赖 RSA2 验签 + 金额比对 + CAS 幂等（见 PaymentService）。
   * 响应体必须是纯文本 'success' / 'fail'（支付宝据此判断是否重试通知）。
   */
  @Post('callback/alipay')
  async alipayCallback(@Body() body: Record<string, string>) {
    const result = await this.paymentService.handleAlipayCallback(body)
    // 直接返回纯文本（绕过全局响应包装）
    return result === 'success' ? 'success' : 'fail'
  }
}
