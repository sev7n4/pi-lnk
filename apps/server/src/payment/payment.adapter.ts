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

/**
 * 参数按 key 字典序拼接（排除空值）。
 * - excludeSignType=true：异步通知验签口径（官方 rsaCheckV1：除 sign、sign_type）。
 * - excludeSignType=false：网关请求签名口径（page.pay / 网关 API：只排除 sign，
 *   sign_type 参与签名）。⚠️ 实证：2026-10-17 沙箱网关 invalid-signature 调试页
 *   回显的验签串包含 sign_type=RSA2；此前把两者都排除导致验签必败（本地签/验
 *   同用一套错误规则而自洽，单测抓不住）。
 */
function sortedQuery(
  params: Record<string, string | undefined>,
  excludeSignType: boolean,
): string {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && (!excludeSignType || k !== 'sign_type'))
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&')
}

/**
 * 支付宝要求「yyyy-MM-dd HH:mm:ss」且为**东八区**时间。
 * toISOString() 是 UTC——与北京时间差 8 小时会超出容忍窗口触发
 * isv.invalid-timestamp。这里显式 +8h。
 */
export function alipayTimestamp(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * 验签网关 JSON 响应（alipay.*.response 对象内容，已 JSON 解析）。
 * 口径：除 sign 外全字段字典序拼接（响应体无 sign_type 字段，排除与否等价）；
 * 字符串值为原文（JSON 解析后已去引号），数字为十进制表示。响应不验签 =
 * 查单补偿路径可被伪造「已付款」欺骗入账（资损链路，零信任）。
 */
export function verifyResponseSign(
  res: Record<string, unknown>,
  sign: unknown,
  alipayPublicKeyPem: string,
): boolean {
  if (typeof sign !== 'string' || !sign) return false
  const content = Object.keys(res)
    .filter((k) => k !== 'sign' && k !== 'sign_type')
    .sort()
    .map((k) => {
      const v = res[k]
      const s =
        v === null || v === undefined
          ? ''
          : typeof v === 'object'
            ? JSON.stringify(v)
            : String(v)
      return `${k}=${s}`
    })
    .join('&')
  try {
    return createVerify('RSA-SHA256')
      .update(content, 'utf8')
      .verify(alipayPublicKeyPem, sign, 'base64')
  } catch {
    return false
  }
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
      timestamp: alipayTimestamp(),
      version: '1.0',
      notify_url: this.cfg.notifyUrl,
      return_url: this.cfg.returnUrl,
      biz_content: JSON.stringify(biz),
    }
    params.sign = this.sign(sortedQuery(params, false))
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
      timestamp: alipayTimestamp(),
      version: '1.0',
      biz_content: biz,
    }
    params.sign = this.sign(sortedQuery(params, false))
    let json: Record<string, unknown>
    try {
      const res = await fetch(this.cfg.gateway, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(15000),
      })
      json = (await res.json()) as Record<string, unknown>
    } catch {
      return { paid: false } // 网络故障不当已付（宁可漏放，不可错放）
    }
    const r = json.alipay_trade_query_response
    if (!r || typeof r !== 'object') return { paid: false }
    const resp = r as Record<string, unknown>
    // 响应验签：不验签的查单补偿可被伪造响应欺骗入账。
    if (!verifyResponseSign(resp, json.sign, normalizeKey(this.cfg.alipayPublicKey, 'public'))) {
      return { paid: false }
    }
    if (resp.code !== '10000') return { paid: false }
    const paid = resp.trade_status === 'TRADE_SUCCESS' || resp.trade_status === 'TRADE_FINISHED'
    return { paid, channelTradeNo: typeof resp.trade_no === 'string' ? resp.trade_no : undefined }
  }

  private sign(content: string): string {
    return createSign('RSA-SHA256').update(content, 'utf8').sign(normalizeKey(this.cfg.privateKey, 'private'), 'base64')
  }

  private verifySign(params: Record<string, string>): boolean {
    const sign = params.sign
    if (!sign) return false
    // 验签内容：异步通知口径——除 sign/sign_type 外全部参数（已 URL 解码后的值）字典序拼接。
    return createVerify('RSA-SHA256')
      .update(sortedQuery(params, true), 'utf8')
      .verify(normalizeKey(this.cfg.alipayPublicKey, 'public'), sign, 'base64')
  }
}
