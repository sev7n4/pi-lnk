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

export interface QrChargeResult {
  /** 当面扫码（precreate）：二维码内容串，前端渲染成 QR 图。 */
  qrCode: string
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
  /**
   * 当面扫码预下单（alipay.trade.precreate）：返回二维码串。
   * 用户用支付宝 App（沙箱用沙箱 App）扫码即付——比收银台登录少两步。
   * 沙箱 buyer 场景 code 可能返回 10000 + qr_code；失败/验签不过必须抛错（响亮失败），
   * 严禁静默降级成「看似成功但没有二维码」。
   */
  createQrCharge(req: ChargeRequest): Promise<QrChargeResult>
  /** 验签 + 解析异步通知；验签失败/字段缺失返回 null（调用方必须按失败处理）。 */
  verifyCallback(params: Record<string, string>): CallbackVerifyResult | null
  /** 主动查单（回调丢失补偿）：返回该订单在渠道的真实状态。 */
  queryTrade(orderId: string): Promise<{ paid: boolean; channelTradeNo?: string }>
  // ── 周期扣款（自动续费）：能力型接口，未开启时业务侧走手动续期 ──────────
  /** 渠道是否支持签约/解约。false ⇒ 业务不得声称「已开通自动续费」。 */
  readonly agreementSupported: boolean
  /**
   * 生成签约跳转 URL（用户在支付宝页面完成签约）。
   * ⚠️ 支付宝「周期扣款不支持沙箱调试」，此链路只能在生产灰度验证；
   *    沙箱/未签约环境一律走手动续期。
   */
  createAgreementSign(req: AgreementSignRequest): Promise<AgreementSignResult>
  /**
   * 解约。**幂等**：协议不存在 / 状态非法（AGREEMENT_NOT_EXIST 等）视为已解约返回成功，
   * 否则抛错——用户点了取消却没解约 = 渠道继续扣款 = 投诉与资损。
   */
  unsignAgreement(agreementNo: string): Promise<{ unsubscribed: boolean }>
  /** 查签约状态（对账/补偿用）。查不到返回空对象，不抛错。 */
  queryAgreement(externalAgreementNo: string): Promise<{ agreementNo?: string; status?: string }>
}

/** 签约请求（周期扣款）。executeTime 为东八区 yyyy-MM-dd。 */
export interface AgreementSignRequest {
  /** 商户侧唯一签约号（≤32 位字母数字）；后续解约/查询都以它为准。 */
  externalAgreementNo: string
  /** 单期金额（元，保留两位）。 */
  amountYuan: number
  periodType: 'MONTH' | 'DAY'
  period: number
  /**
   * 首次扣款日 yyyy-MM-dd。
   * ⚠️ 支付宝硬约束：period_type=MONTH 时不得超过 28 号（避免 2 月/小月无对应日）。
   */
  executeTime: string
  subject: string
}

export interface AgreementSignResult {
  /** 支付宝签约页跳转 URL（前端引导用户前往完成签约）。 */
  signUrl: string
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
  // ── 周期扣款（自动续费）能力：全部可选，缺省 = 手动续期模式 ──────────────
  /** 签约/解约能力开关。false 时业务侧降级为「手动续期」，功能完整、仅无自动扣款。 */
  agreementEnabled?: boolean
  /** 周期扣款签约产品码（生产/沙箱各自的签约产品，默认官方通用值）。 */
  agreementProductCode?: string
  /** 个人产品码（周期扣款固定 CYCLE_PAY_AUTH_P）。 */
  agreementPersonalProductCode?: string
  /** 签约场景（必须与商户签约产品合约里的场景一致；缺失时拒绝签约而非瞎猜）。 */
  agreementSignScene?: string
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
 * 从网关原始响应文本中截取 response 节点的**原文**子串（官方验签口径）。
 * ⚠️ 官方规则：sign 是对「响应报文中 response 节点的 JSON 原文字符串」签的——
 * 重新序列化（键序/空格/unicode 转义）任何一点不一致都会验签必败。
 * 2026-10-18 生产实证：precreate 响应验签失败即此坑（本地签/验同用自造
 * 序列化而自洽，真实支付宝 JSON 才暴露）。
 * 实现：定位 `<nodeName>":` 后第一个 `{`，做括号配对截取（字符串字面量内的
 * 引号/转义已由 JSON 语法保证，只统计不在字符串内的花括号）。
 */
export function extractRawResponseNode(raw: string, nodeName: string): string | null {
  const keyIdx = raw.indexOf(`"${nodeName}"`)
  if (keyIdx < 0) return null
  const colonIdx = raw.indexOf(':', keyIdx + nodeName.length + 2)
  if (colonIdx < 0) return null
  let i = colonIdx + 1
  while (i < raw.length && raw[i] !== '{') i++
  if (i >= raw.length) return null
  let depth = 0
  let inStr = false
  let escaped = false
  for (; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return raw.slice(raw.indexOf('{', colonIdx + 1), i + 1)
    }
  }
  return null
}

/**
 * 验签网关 JSON 响应——**原始节点文本**口径（官方）。
 * 响应不验签 = 查单/预下单路径可被伪造响应欺骗（资损链路，零信任）。
 */
export function verifyResponseSignRaw(
  rawNodeText: string,
  sign: unknown,
  alipayPublicKeyPem: string,
): boolean {
  if (typeof sign !== 'string' || !sign) return false
  try {
    return createVerify('RSA-SHA256')
      .update(rawNodeText, 'utf8')
      .verify(alipayPublicKeyPem, sign, 'base64')
  } catch {
    return false
  }
}

/** 分 → 元字符串（两位小数），支付宝 total_amount 口径。 */
export function fenToYuan(amountFen: number): string {
  return (amountFen / 100).toFixed(2)
}

/**
 * 网关 POST 公共头。⚠️ 必须显式带 charset=UTF-8：
 * 2026-10-18 生产实证——网关按 **Content-Type 的 charset**（而非请求里的
 * charset 参数）解码 POST 体；不带时 UTF-8 中文（如 subject「标准版」）被
 * 按 GBK 解码 → 签名内容错乱 → isv.invalid-signature（纯 ASCII 请求不受
 * 影响所以单测/首探全绿，中文订单才暴露）。
 */
/**
 * 解约的「幂等成功」业务码：协议不存在 / 状态非法 都等价于**已经没有签约了**。
 * 不当成功处理的话，用户重复点取消会一直报错，而实际早已解约。
 */
const AGREEMENT_ALREADY_GONE_CODES = [
  'AGREEMENT_NOT_EXIST',
  'AGREEMENT_NOT_EXSIT', // 官方文档里两种拼写都存在
  'USER_AGREEMENT_STATUS_NOT_NORMAL',
  'USER_AGREEMENT_STATUS_IS_NOT_NORMAL',
]

const GATEWAY_HEADERS: Record<string, string> = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
}

/**
 * 读取网关响应为文本。网关错误页常为 `text/html;charset=GBK`，而
 * Response.text() 恒按 UTF-8 解码 → 中文错误信息乱码且原文验签必败。
 * 这里按响应头 charset 解码（不识别则回退 utf-8）。
 */
async function readGatewayText(res: Response): Promise<string> {
  const buf = await res.arrayBuffer()
  const m = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')
  let dec: TextDecoder
  try {
    dec = new TextDecoder(m?.[1] ?? 'utf-8')
  } catch {
    dec = new TextDecoder('utf-8')
  }
  return dec.decode(buf)
}

/** 元字符串 → 分（整数，四舍五入到分）。 */
export function yuanToFen(yuan: string): number {
  const n = Number(yuan)
  if (!Number.isFinite(n)) throw new Error(`非法金额字符串: ${yuan}`)
  return Math.round(n * 100)
}

export class AlipayAdapter implements PaymentAdapter {
  readonly channel = 'alipay'
  /** 周期扣款能力开关（env 驱动）。false ⇒ 业务侧走手动续期，不声称自动续费。 */
  readonly agreementSupported: boolean

  constructor(private readonly cfg: AlipayConfig) {
    // 构造即校验密钥可加载——配置错误必须在启动时暴露，而非首笔交易时。
    createSign('RSA-SHA256').update('probe').sign(normalizeKey(cfg.privateKey, 'private'))
    createVerify('RSA-SHA256').update('probe').verify(normalizeKey(cfg.alipayPublicKey, 'public'), Buffer.alloc(0))
    this.agreementSupported = cfg.agreementEnabled === true
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

  async createQrCharge(req: ChargeRequest): Promise<QrChargeResult> {
    const biz: Record<string, string> = {
      out_trade_no: req.orderId,
      total_amount: fenToYuan(req.amountFen),
      subject: req.subject,
    }
    if (req.body) biz.body = req.body

    const params: Record<string, string> = {
      app_id: this.cfg.appId,
      method: 'alipay.trade.precreate',
      charset: 'utf-8',
      format: 'JSON',
      sign_type: 'RSA2',
      timestamp: alipayTimestamp(),
      version: '1.0',
      notify_url: this.cfg.notifyUrl,
      biz_content: JSON.stringify(biz),
    }
    params.sign = this.sign(sortedQuery(params, false))

    let rawText: string
    try {
      const res = await fetch(this.cfg.gateway, {
        method: 'POST',
        headers: GATEWAY_HEADERS,
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(15000),
      })
      rawText = await readGatewayText(res)
    } catch (err) {
      throw new Error(`precreate 网关请求失败: ${(err as Error).message}`)
    }
    let json: Record<string, unknown>
    try {
      json = JSON.parse(rawText) as Record<string, unknown>
    } catch {
      throw new Error('precreate 响应非法 JSON')
    }
    const r = json.alipay_trade_precreate_response
    if (!r || typeof r !== 'object') throw new Error('precreate 响应缺失业务体')
    const resp = r as Record<string, unknown>
    if (resp.code !== '10000') {
      // 渠道拒绝：错误响应不驱动任何资损决策，直接报渠道语义（不验签）。
      throw new Error(
        `precreate 渠道拒绝: code=${resp.code} msg=${resp.msg ?? '?'} sub_code=${resp.sub_code ?? '-'} sub_msg=${resp.sub_msg ?? '-'}`,
      )
    }
    // 成功响应必须验签（原始节点文本口径，见 extractRawResponseNode）：不验签的
    // 预下单响应可被伪造二维码/金额（资损链路，零信任）。
    const rawNode = extractRawResponseNode(rawText, 'alipay_trade_precreate_response')
    if (
      !rawNode ||
      !verifyResponseSignRaw(rawNode, json.sign, normalizeKey(this.cfg.alipayPublicKey, 'public'))
    ) {
      throw new Error('precreate 响应验签失败')
    }
    if (typeof resp.qr_code !== 'string' || !resp.qr_code) {
      throw new Error('precreate 响应缺失 qr_code')
    }
    return { qrCode: resp.qr_code }
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
    let rawText: string
    try {
      const res = await fetch(this.cfg.gateway, {
        method: 'POST',
        headers: GATEWAY_HEADERS,
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(15000),
      })
      rawText = await readGatewayText(res)
    } catch {
      return { paid: false } // 网络故障不当已付（宁可漏放，不可错放）
    }
    let json: Record<string, unknown>
    try {
      json = JSON.parse(rawText) as Record<string, unknown>
    } catch {
      return { paid: false }
    }
    const r = json.alipay_trade_query_response
    if (!r || typeof r !== 'object') return { paid: false }
    const resp = r as Record<string, unknown>
    if (resp.code !== '10000') return { paid: false } // 查无此交易等：不当已付
    // 已付判定驱动资损 → 该响应必须验签（原始节点文本口径）。
    const rawNode = extractRawResponseNode(rawText, 'alipay_trade_query_response')
    if (
      !rawNode ||
      !verifyResponseSignRaw(rawNode, json.sign, normalizeKey(this.cfg.alipayPublicKey, 'public'))
    ) {
      return { paid: false }
    }
    const paid = resp.trade_status === 'TRADE_SUCCESS' || resp.trade_status === 'TRADE_FINISHED'
    return { paid, channelTradeNo: typeof resp.trade_no === 'string' ? resp.trade_no : undefined }
  }

  // ── 周期扣款：签约 / 解约 / 查签约 ────────────────────────────────────────
  // ⚠️ 支付宝官方明确「周期扣款产品暂不支持沙箱调试」⇒ 这些方法在沙箱必然失败。
  // 因此 agreementEnabled 默认关闭：未开启时业务侧走「手动续期」，
  // 生产只需替换 env（ENABLED=1 + 产品码 + 场景）即可启用，业务代码零改动。

  async createAgreementSign(req: AgreementSignRequest): Promise<AgreementSignResult> {
    if (!this.agreementSupported) throw new Error('周期扣款未启用（ALIPAY_AGREEMENT_ENABLED != 1）')
    if (!this.cfg.agreementSignScene) {
      throw new Error('周期扣款签约场景未配置（ALIPAY_AGREEMENT_SIGN_SCENE），拒绝瞎猜')
    }
    if (req.periodType === 'MONTH' && Number(req.executeTime.slice(8, 10)) > 28) {
      // 支付宝会直接拒绝；提前抛错给出可读原因（2 月/小月无对应日）
      throw new Error('周期扣款首次扣款日不得超过 28 号')
    }
    const biz: Record<string, unknown> = {
      product_code: this.cfg.agreementProductCode ?? 'CYCLE_PAY_AUTH',
      personal_product_code: this.cfg.agreementPersonalProductCode ?? 'CYCLE_PAY_AUTH_P',
      sign_scene: this.cfg.agreementSignScene,
      external_agreement_no: req.externalAgreementNo,
      access_params: { channel: 'ALIPAYAPP' },
      // 周期管控规则：周期扣款产品必传，否则签约直接参数错误
      period_rule_params: {
        period_type: req.periodType,
        period: String(req.period),
        execute_time: req.executeTime,
        single_amount: req.amountYuan.toFixed(2),
      },
    }
    const params: Record<string, string> = {
      app_id: this.cfg.appId,
      method: 'alipay.user.agreement.page.sign',
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
    const query = Object.keys(params)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join('&')
    return { signUrl: `${this.cfg.gateway}?${query}` }
  }

  async unsignAgreement(agreementNo: string): Promise<{ unsubscribed: boolean }> {
    const node = await this.postAgreement('alipay.user.agreement.unsign', 'alipay_user_agreement_unsign_response', {
      agreement_no: agreementNo,
    })
    const code = String(node.code ?? '')
    const subCode = String(node.sub_code ?? '')
    if (code === '10000') return { unsubscribed: true }
    // 幂等：协议不存在/状态非法 = 已经解约过了，按成功处理
    if (AGREEMENT_ALREADY_GONE_CODES.includes(subCode)) return { unsubscribed: true }
    throw new Error(`支付宝解约失败: ${code}/${subCode} ${String(node.sub_msg ?? '')}`)
  }

  async queryAgreement(externalAgreementNo: string): Promise<{ agreementNo?: string; status?: string }> {
    const node = await this.postAgreement('alipay.user.agreement.query', 'alipay_user_agreement_query_response', {
      external_agreement_no: externalAgreementNo,
    })
    return {
      agreementNo: typeof node.agreement_no === 'string' ? node.agreement_no : undefined,
      status: typeof node.status === 'string' ? node.status : undefined,
    }
  }

  /**
   * 网关 POST + **响应验签**（与查单/预下单同口径：零信任）。
   * 不验签 = 解约结果可被伪造响应欺骗，用户以为已解约而渠道继续扣款。
   */
  private async postAgreement(
    method: string,
    nodeName: string,
    bizContent: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.agreementSupported) throw new Error('周期扣款未启用（ALIPAY_AGREEMENT_ENABLED != 1）')
    const params: Record<string, string> = {
      app_id: this.cfg.appId,
      method,
      charset: 'utf-8',
      format: 'JSON',
      sign_type: 'RSA2',
      timestamp: alipayTimestamp(),
      version: '1.0',
      biz_content: JSON.stringify(bizContent),
    }
    params.sign = this.sign(sortedQuery(params, false))

    let rawText: string
    try {
      const res = await fetch(this.cfg.gateway, {
        method: 'POST',
        headers: GATEWAY_HEADERS,
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(15000),
      })
      rawText = await readGatewayText(res)
    } catch (err) {
      throw new Error(`${method} 网关请求失败: ${(err as Error).message}`)
    }
    let json: Record<string, unknown>
    try {
      json = JSON.parse(rawText) as Record<string, unknown>
    } catch {
      throw new Error(`${method} 响应解析失败`)
    }
    const rawNode = extractRawResponseNode(rawText, nodeName)
    if (!rawNode || !verifyResponseSignRaw(rawNode, json.sign, normalizeKey(this.cfg.alipayPublicKey, 'public'))) {
      throw new Error(`${method} 响应验签失败`)
    }
    const node = json[nodeName]
    return (typeof node === 'object' && node !== null ? node : {}) as Record<string, unknown>
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
