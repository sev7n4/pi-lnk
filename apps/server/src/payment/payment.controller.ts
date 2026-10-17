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
   * 创建支付订单（需登录）。返回支付宝收银台跳转 URL。
   * body: { plan: 'pro' | 'studio' }
   */
  @Post('order')
  @UseGuards(AuthGuard)
  async createOrder(@Req() req: { user: { sub: string } }, @Body() body: { plan?: string }) {
    if (!body?.plan) throw new BadRequestException('缺少套餐参数')
    const data = await this.paymentService.createOrder(req.user.sub, body.plan)
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
