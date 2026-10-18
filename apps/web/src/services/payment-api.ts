import { api } from './api'

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
  /** 创建套餐订阅订单（plan: pro | studio）。 */
  createSubscriptionOrder: (plan: string, channel: PayChannel = 'qrcode') =>
    api.post<{ data: PayOrderResult }>('/payment/order', { plan, channel }),
  /** 查询订单状态（服务端对 PENDING 订单自动做渠道查单补偿）。 */
  getOrder: (orderId: string) => api.get<{ data: PayOrderStatus }>(`/payment/order/${orderId}`),
}
