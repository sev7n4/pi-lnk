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
   * body: { plan: 'pro' | 'studio', channel?: 'page' | 'qrcode' }
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
