import { api } from './api'
import type { SubscriptionDto } from './users-api'

/** 充值档位（服务端单一真源，GET /payment/topup/options 下发）。 */
export interface TopupTier {
  amountFen: number
  basePoints: number
  bonusPoints: number
  totalPoints: number
}

export interface TopupOptions {
  tiers: TopupTier[]
  customMinFen: number
  customMaxFen: number
  pointsPerFen: number
  expiryDays: number
}

/** 支付下单凭据：qrcode 渠道返回 qrCode，page 渠道返回 payUrl。 */
export interface PayOrderResult {
  orderId: string
  payUrl?: string
  qrCode?: string
  amountFen: number
}

/** 支付订单状态（GET /payment/order/:id）。 */
export interface PayOrderStatus {
  id: string
  plan: string
  kind: 'subscription' | 'topup'
  points: number | null
  amountFen: number
  status: 'PENDING' | 'PAID' | 'CLOSED' | 'REFUNDED'
  paidAt: string | null
  createdAt: string
}

export type PayChannel = 'page' | 'qrcode'

/** 支付域 API（真实支付宝沙箱闭环：下单 → 扫码 → 轮询 → 入账）。 */
export const paymentApi = {
  /** 充值档位配置（免登录静态配置）。 */
  topupOptions: () => api.get<{ data: TopupOptions }>('/payment/topup/options'),
  /** 创建积分充值订单（amountFen 单位分，¥5–¥10,000）。 */
  createTopup: (amountFen: number, channel: PayChannel = 'qrcode') =>
    api.post<{ data: PayOrderResult }>('/payment/topup', { amountFen, channel }),
  /** 创建套餐订阅订单（plan: experience | standard | premium | flagship）。 */
  createSubscriptionOrder: (plan: string, channel: PayChannel = 'qrcode') =>
    api.post<{ data: PayOrderResult }>('/payment/order', { plan, channel }),
  /** 查询订单状态（服务端对 PENDING 订单自动做渠道查单补偿）。 */
  getOrder: (orderId: string) => api.get<{ data: PayOrderStatus }>(`/payment/order/${orderId}`),
  // ── 自动续费（支付宝周期扣款）───────────────────────────────────────────
  // ⚠️ 渠道能力默认关闭（生产 env 未开 = 手动续期模式），前端据此决定是否展示入口，
  // 绝不展示「已开通自动续费」这种不成立的状态。
  /** 能力探测（免登录）。 */
  autoRenewCapability: () => api.get<{ data: { supported: boolean } }>('/payment/auto-renew/capability'),
  /** 生成支付宝签约跳转 URL（需已订阅）。 */
  createAutoRenewSign: () =>
    api.post<{ data: { signUrl: string; executeTime: string } }>('/payment/auto-renew/sign'),
  /** 签约回跳后确认（服务端向渠道查真实签约号后落库）。 */
  confirmAutoRenew: () =>
    api.post<{ data: { agreementNo: string; status?: string } }>('/payment/auto-renew/confirm'),
  /** 取消自动续期：服务端先渠道解约再改本地，当前周期内仍可用。 */
  cancelAutoRenew: () =>
    api.post<{ data: { changed: boolean; subscription: SubscriptionDto | null } }>(
      '/payment/auto-renew/cancel',
    ),
}
