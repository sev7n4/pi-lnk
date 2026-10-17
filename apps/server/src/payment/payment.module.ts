import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { MembershipModule } from '../membership/membership.module'
import { PaymentController } from './payment.controller'
import { PaymentService } from './payment.service'
import { PAYMENT_ADAPTER, AlipayAdapter, type AlipayConfig } from './payment.adapter'

/** 从环境变量装配支付宝配置；缺任一必需项时返回 null（支付端点显式报错，不阻塞启动）。 */
function alipayConfigFromEnv(): AlipayConfig | null {
  const appId = process.env.ALIPAY_APP_ID
  const privateKey = process.env.ALIPAY_PRIVATE_KEY
  const alipayPublicKey = process.env.ALIPAY_PUBLIC_KEY
  if (!appId || !privateKey || !alipayPublicKey) return null
  return {
    appId,
    privateKey,
    alipayPublicKey,
    // 默认沙箱网关；生产切换为 https://openapi.alipay.com/gateway.do
    gateway: process.env.ALIPAY_GATEWAY ?? 'https://openapi.alipaydev.com/gateway.do',
    notifyUrl: process.env.ALIPAY_NOTIFY_URL ?? '',
    returnUrl: process.env.ALIPAY_RETURN_URL ?? '',
  }
}

@Module({
  imports: [MembershipModule],
  controllers: [PaymentController],
  providers: [
    PrismaService,
    PaymentService,
    {
      provide: PAYMENT_ADAPTER,
      useFactory: () => {
        const cfg = alipayConfigFromEnv()
        if (!cfg) {
          // 未配置沙箱/生产凭证：返回禁用适配器——createCharge 显式报错，
          // 绝不「静默降级」成假支付成功（silent-degrade-triage 纪律）。
          return {
            channel: 'alipay',
            createCharge: async () => {
              throw new Error('支付渠道未配置（ALIPAY_APP_ID/ALIPAY_PRIVATE_KEY/ALIPAY_PUBLIC_KEY）')
            },
            verifyCallback: () => null,
            queryTrade: async () => ({ paid: false }),
          }
        }
        return new AlipayAdapter(cfg)
      },
    },
  ],
})
export class PaymentModule {}
