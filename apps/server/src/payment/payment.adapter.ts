import { createSign, createVerify } from 'node:crypto'

/**
 * 支付渠道抽象（风险 #2：真实支付闭环）。
 * 沙箱与生产同代码：仅 gateway + 凭证不同（见 AlipayConfig）。
 * 严禁任何「未校验 Payment 即发放积分」的调用方——入账唯一入口是
 * PaymentService.handleAlipayCallback（验签 + Order CAS + 事务入账）。
 */
/**
 * DI token：支付渠道适配器（沙箱/生产同接口，仅配置不同）。
 */
export const PAYMENT_ADAPTER = 'PAYMENT_ADAPTER'

export interface ChargeRequest {
  /** 我方订单 id，同时作为支付宝 out_trade_no（幂等锚点）。 */
  orderId: string
  /** 金额，单位：分（Int，杜绝浮点）。 */
  amountFen: number
  /** 订单标题，展示在支付宝收银台。 */
  subject: string
  body?: string
}

export interface ChargeResult {
  /** 电脑网站支付：前端 location.href 跳转至此 URL（GET，参数已含签名）。 */
  payUrl: string
}

export interface CallbackVerifyResult {
  /** out_trade_no（我方订单 id）。 */
  orderId: string
  /** 支付宝交易号。 */
  channelTradeNo: string
  /** 是否已付款（TRADE_SUCCESS / TRADE_FINISHED）。 */
  paid: boolean
  /** 回调金额换算回「分」，供调用方与 Order.amount 比对。 */
  amountFen: number
}

export interface PaymentAdapter {
  readonly channel: string
  createCharge(req: ChargeRequest): Promise<ChargeResult>
  /** 验签 + 解析异步通知；验签失败/字段缺失返回 null（调用方必须按失败处理）。 */
  verifyCallback(params: Record<string, string>): CallbackVerifyResult | null
  /** 主动查单（回调丢失补偿）：返回该订单在渠道的真实状态。 */
  queryTrade(orderId: string): Promise<{ paid: boolean; channelTradeNo?: string }>
}

// ---------------------------------------------------------------------------
// 支付宝电脑网站支付（alipay.trade.page.pay）适配器
// 签名算法 RSA2（SHA256WithRSA）。不引第三方 SDK：node:crypto 自实现，
// 签名/验签逻辑透明可控（资损链路，拒绝黑盒依赖）。
// ---------------------------------------------------------------------------

export interface AlipayConfig {
  appId: string
  /** 应用私钥 PEM（开放平台生成的 RSA2 私钥；接受带/不带 PEM 头、PKCS#1/PKCS#8）。 */
  privateKey: string
  /** 支付宝公钥 PEM（上传应用公钥后从平台换取；注意不是「应用公钥」）。 */
  alipayPublicKey: string
  /** 沙箱 https://openapi.alipaydev.com/gateway.do；生产 https://openapi.alipay.com/gateway.do */
  gateway: string
  /** 异步通知地址（必须公网可达，POST form-urlencoded）。 */
  notifyUrl: string
  /** 同步跳回地址（用户付款后浏览器 redirect）。 */
  returnUrl: string
}

/** 把「裸 base64」或任意 PEM 变体归一化为 node:crypto 可用的 PEM。 */
function normalizeKey(raw: string, type: 'private' | 'public'): string {
  const body = raw
    .replace(/-----(BEGIN|END)[^-]*-----/g, '')
    .replace(/\s+/g, '')
  if (!body) throw new Error(`支付密钥为空（${type}）`)
  const header =
    type === 'private' ? '-----BEGIN PRIVATE KEY-----' : '-----BEGIN PUBLIC KEY-----'
  const footer =
    type === 'private' ? '-----END PRIVATE KEY-----' : '-----END PUBLIC KEY-----'
  return `${header}\n${body.match(/.{1,64}/g)!.join('\n')}\n${footer}`
}

/** 参数按 key 字典序拼接（排除空值与 sign 家族），与支付宝开放规范一致。 */
function sortedQuery(params: Record<string, string | undefined>): string {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type')
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&')
}

/** 分 → 元字符串（两位小数），支付宝 total_amount 口径。 */
export function fenToYuan(amountFen: number): string {
  return (amountFen / 100).toFixed(2)
}

/** 元字符串 → 分（整数，四舍五入到分）。 */
export function yuanToFen(yuan: string): number {
  const n = Number(yuan)
  if (!Number.isFinite(n)) throw new Error(`非法金额字符串: ${yuan}`)
  return Math.round(n * 100)
}

export class AlipayAdapter implements PaymentAdapter {
  readonly channel = 'alipay'

  constructor(private readonly cfg: AlipayConfig) {
    // 构造即校验密钥可加载——配置错误必须在启动时暴露，而非首笔交易时。
    createSign('RSA-SHA256').update('probe').sign(normalizeKey(cfg.privateKey, 'private'))
    createVerify('RSA-SHA256').update('probe').verify(normalizeKey(cfg.alipayPublicKey, 'public'), Buffer.alloc(0))
  }

  async createCharge(req: ChargeRequest): Promise<ChargeResult> {
    const biz: Record<string, string> = {
      out_trade_no: req.orderId,
      total_amount: fenToYuan(req.amountFen),
      subject: req.subject,
      product_code: 'FAST_INSTANT_TRADE_PAY', // 电脑网站支付
    }
    if (req.body) biz.body = req.body

    const params: Record<string, string> = {
      app_id: this.cfg.appId,
      method: 'alipay.trade.page.pay',
      charset: 'utf-8',
      format: 'JSON',
      sign_type: 'RSA2',
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
      version: '1.0',
      notify_url: this.cfg.notifyUrl,
      return_url: this.cfg.returnUrl,
      biz_content: JSON.stringify(biz),
    }
    params.sign = this.sign(sortedQuery(params))
    // page.pay 为 GET 跳转：参数整体 URL 编码后拼接网关。
    const query = Object.keys(params)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join('&')
    return { payUrl: `${this.cfg.gateway}?${query}` }
  }

  verifyCallback(params: Record<string, string>): CallbackVerifyResult | null {
    try {
      if (!this.verifySign(params)) return null
      if (params.app_id !== this.cfg.appId) return null
      const tradeStatus = params.trade_status
      const paid = tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED'
      const outTradeNo = params.out_trade_no
      const channelTradeNo = params.trade_no
      if (!outTradeNo || !channelTradeNo || !params.total_amount) return null
      return {
        orderId: outTradeNo,
        channelTradeNo,
        paid,
        amountFen: yuanToFen(params.total_amount),
      }
    } catch {
      return null
    }
  }

  async queryTrade(orderId: string): Promise<{ paid: boolean; channelTradeNo?: string }> {
    const biz = JSON.stringify({ out_trade_no: orderId })
    const params: Record<string, string> = {
      app_id: this.cfg.appId,
      method: 'alipay.trade.query',
      charset: 'utf-8',
      format: 'JSON',
      sign_type: 'RSA2',
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
      version: '1.0',
      biz_content: biz,
    }
    params.sign = this.sign(sortedQuery(params))
    const res = await fetch(this.cfg.gateway, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    })
    const json = (await res.json()) as {
      alipay_trade_query_response?: {
        code?: string
        trade_status?: string
        trade_no?: string
        out_trade_no?: string
      }
    }
    const r = json.alipay_trade_query_response
    if (!r || r.code !== '10000') return { paid: false }
    const paid = r.trade_status === 'TRADE_SUCCESS' || r.trade_status === 'TRADE_FINISHED'
    return { paid, channelTradeNo: r.trade_no }
  }

  private sign(content: string): string {
    return createSign('RSA-SHA256').update(content, 'utf8').sign(normalizeKey(this.cfg.privateKey, 'private'), 'base64')
  }

  private verifySign(params: Record<string, string>): boolean {
    const sign = params.sign
    if (!sign) return false
    // 验签内容：除 sign/sign_type 外全部参数（已 URL 解码后的值）字典序拼接。
    return createVerify('RSA-SHA256')
      .update(sortedQuery(params), 'utf8')
      .verify(normalizeKey(this.cfg.alipayPublicKey, 'public'), sign, 'base64')
  }
}
