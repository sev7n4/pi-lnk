import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { createSign, createVerify, generateKeyPairSync } from 'node:crypto'
import {
  AlipayAdapter,
  alipayTimestamp,
  extractRawResponseNode,
  verifyResponseSignRaw,
  type AlipayConfig,
} from './payment.adapter'

/**
 * RSA2 签名/验签正确性（无 DB 纯函数测试）。
 * 两种口径（勿混淆）：
 * - 异步通知验签（verifyCallback）：除 sign/sign_type 外字典序拼接（官方 rsaCheckV1）；
 * - 网关请求签名（createCharge/queryTrade）：只排除 sign，sign_type 参与签名
 *   （2026-10-17 沙箱 invalid-signature 调试页回显实证，见回归测试）。
 */
describe('AlipayAdapter RSA2 验签', () => {
  let appPrivateKeyPem: string
  let appPublicKeyPemRaw: string
  let adapter: AlipayAdapter

  beforeAll(() => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    appPrivateKeyPem = privateKey
    appPublicKeyPemRaw = publicKey
      .replace(/-----(BEGIN|END)[^-]*-----/g, '')
      .replace(/\s+/g, '')
    const cfg: AlipayConfig = {
      appId: '2021000000000001',
      privateKey,
      alipayPublicKey: publicKey, // 测试里「支付宝公钥」即同一对公钥
      gateway: 'https://openapi.alipaydev.com/gateway.do',
      notifyUrl: 'https://example.com/api/payment/callback/alipay',
      returnUrl: 'https://example.com/pay/return',
    }
    adapter = new AlipayAdapter(cfg)
  })

  /// 按支付宝官方规则签名（用「支付宝私钥」签——测试里与应用私钥同对）。
  function signLikeAlipay(params: Record<string, string>): string {
    const content = Object.keys(params)
      .filter((k) => k !== 'sign' && k !== 'sign_type')
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&')
    return createSign('RSA-SHA256').update(content, 'utf8').sign(appPrivateKeyPem, 'base64')
  }

  function validCallbackParams(): Record<string, string> {
    return {
      app_id: '2021000000000001',
      out_trade_no: 'order-abc',
      trade_no: '202610172200001234',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '99.00',
      seller_id: '2088xxxx',
      timestamp: '2026-10-17 20:00:00',
    }
  }

  it('接受按官方规则正确签名的已付通知', () => {
    const params = validCallbackParams()
    params.sign = signLikeAlipay(params)
    params.sign_type = 'RSA2'
    const result = adapter.verifyCallback(params)
    expect(result).not.toBeNull()
    expect(result!.orderId).toBe('order-abc')
    expect(result!.channelTradeNo).toBe('202610172200001234')
    expect(result!.paid).toBe(true)
    expect(result!.amountFen).toBe(9900)
  })

  it('拒绝被篡改金额的通知（签名不匹配）', () => {
    const params = validCallbackParams()
    params.sign = signLikeAlipay(params)
    params.total_amount = '0.01' // 篡改：99.00 → 0.01
    expect(adapter.verifyCallback(params)).toBeNull()
  })

  it('拒绝缺失 sign 的通知', () => {
    expect(adapter.verifyCallback(validCallbackParams())).toBeNull()
  })

  it('拒绝 app_id 不匹配的通知（防串应用）', () => {
    const params = validCallbackParams()
    params.app_id = '2099999999999999'
    params.sign = signLikeAlipay(params)
    expect(adapter.verifyCallback(params)).toBeNull()
  })

  it('TRADE_FINISHED 视为已付；WAIT_BUYER_PAY 视为未付', () => {
    const finished = validCallbackParams()
    finished.trade_status = 'TRADE_FINISHED'
    finished.sign = signLikeAlipay(finished)
    expect(adapter.verifyCallback(finished)!.paid).toBe(true)

    const waiting = validCallbackParams()
    waiting.trade_status = 'WAIT_BUYER_PAY'
    waiting.sign = signLikeAlipay(waiting)
    expect(adapter.verifyCallback(waiting)!.paid).toBe(false)
  })

  it('createCharge 产出含全部公共参数与签名的收银台 URL', async () => {
    const { payUrl } = await adapter.createCharge({
      orderId: 'order-xyz',
      amountFen: 9900,
      subject: 'lnk π 专业版',
    })
    const url = new URL(payUrl)
    expect(url.origin + url.pathname).toBe('https://openapi.alipaydev.com/gateway.do')
    const q = url.searchParams
    expect(q.get('app_id')).toBe('2021000000000001')
    expect(q.get('method')).toBe('alipay.trade.page.pay')
    expect(q.get('sign_type')).toBe('RSA2')
    expect(q.get('sign')).toBeTruthy()
    const biz = JSON.parse(q.get('biz_content')!)
    expect(biz.out_trade_no).toBe('order-xyz')
    expect(biz.total_amount).toBe('99.00') // 9900 分 → 99.00 元
    expect(biz.product_code).toBe('FAST_INSTANT_TRADE_PAY')
  })

  it('请求签名串必须包含 sign_type（网关验签口径）——回归测试', async () => {
    // 2026-10-17 生产事故：签名串误排除 sign_type → 沙箱网关 isv.invalid-signature。
    // 支付宝调试页回显的验签串包含 sign_type=RSA2 ⇒ 请求侧签名内容 = 除 sign 外全部参数。
    const { payUrl } = await adapter.createCharge({
      orderId: 'order-sign-type',
      amountFen: 100,
      subject: '回归',
    })
    const q = new URL(payUrl).searchParams
    const signed: Record<string, string> = {}
    for (const [k, v] of q) if (k !== 'sign') signed[k] = v
    const content = Object.keys(signed)
      .sort()
      .map((k) => `${k}=${signed[k]}`)
      .join('&')
    // 用支付宝视角验证：包含 sign_type 的串必须验签通过
    const pubPem = `-----BEGIN PUBLIC KEY-----\n${(appPublicKeyPemRaw.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PUBLIC KEY-----`
    expect(
      createVerify('RSA-SHA256').update(content, 'utf8').verify(pubPem, q.get('sign')!, 'base64'),
    ).toBe(true)
    // 反向断言：排除 sign_type 的串必须验签失败（钉死旧错误不再回归）
    const withoutSignType = Object.keys(signed)
      .filter((k) => k !== 'sign_type')
      .sort()
      .map((k) => `${k}=${signed[k]}`)
      .join('&')
    expect(
      createVerify('RSA-SHA256').update(withoutSignType, 'utf8').verify(pubPem, q.get('sign')!, 'base64'),
    ).toBe(false)
  })

  it('构造时拒绝不可加载的密钥（配置错误启动即暴露）', () => {
    expect(
      () =>
        new AlipayAdapter({
          appId: 'x',
          privateKey: 'not-a-key',
          alipayPublicKey: 'not-a-key',
          gateway: 'https://openapi.alipaydev.com/gateway.do',
          notifyUrl: '',
          returnUrl: '',
        }),
    ).toThrow()
  })

  it('接受开放平台风格的裸 base64 密钥（无 PEM 头，PKCS#8/SPKI DER）', async () => {
    // 支付宝控制台导出的「应用私钥/支付宝公钥」即裸 base64（MIIEvg.../MIIBIj...）。
    const rawPrivate = appPrivateKeyPem
      .replace(/-----(BEGIN|END)[^-]*-----/g, '')
      .replace(/\s+/g, '')
    const rawPublic = appPublicKeyPemRaw
    const cfg: AlipayConfig = {
      appId: '2021000000000001',
      privateKey: rawPrivate,
      alipayPublicKey: rawPublic,
      gateway: 'https://openapi.alipaydev.com/gateway.do',
      notifyUrl: '',
      returnUrl: '',
    }
    const rawAdapter = new AlipayAdapter(cfg)
    const params = validCallbackParams()
    params.sign = createSign('RSA-SHA256')
      .update(
        Object.keys(params)
          .filter((k) => k !== 'sign' && k !== 'sign_type')
          .sort()
          .map((k) => `${k}=${params[k]}`)
          .join('&'),
        'utf8',
      )
      .sign(appPrivateKeyPem, 'base64')
    expect(rawAdapter.verifyCallback(params)).not.toBeNull()
    // 裸 base64 私钥签出的 URL 同样可用
    const { payUrl } = await rawAdapter.createCharge({ orderId: 'o1', amountFen: 100, subject: 's' })
    expect(payUrl).toContain('sign=')
  })
})

describe('alipayTimestamp 东八区', () => {
  it('UTC 15:00 → 北京时间 23:00（防 isv.invalid-timestamp）', () => {
    const utc = new Date('2026-10-17T15:00:00.000Z')
    expect(alipayTimestamp(utc)).toBe('2026-10-17 23:00:00')
  })

  it('跨日边界正确（UTC 16:30 → 北京次日 00:30）', () => {
    const utc = new Date('2026-10-17T16:30:00.000Z')
    expect(alipayTimestamp(utc)).toBe('2026-10-18 00:30:00')
  })
})

describe('createQrCharge 当面扫码预下单（alipay.trade.precreate）', () => {
  let appPrivateKeyPem: string
  let appPublicKeyPemRaw: string
  let adapter: AlipayAdapter

  beforeAll(() => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    appPrivateKeyPem = privateKey
    appPublicKeyPemRaw = publicKey.replace(/-----(BEGIN|END)[^-]*-----/g, '').replace(/\s+/g, '')
    adapter = new AlipayAdapter({
      appId: '2021000000000001',
      privateKey,
      alipayPublicKey: publicKey, // 测试里「支付宝公钥」即同一对公钥
      gateway: 'https://openapi.alipaydev.com/gateway.do',
      notifyUrl: 'https://example.com/api/payment/callback/alipay',
      returnUrl: 'https://example.com/pay/return',
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /// 用「支付宝私钥」签 precreate 响应——**原始节点文本**口径（官方）。
  function signPrecreateResponse(res: Record<string, unknown>): string {
    return createSign('RSA-SHA256')
      .update(JSON.stringify(res), 'utf8')
      .sign(appPrivateKeyPem, 'base64')
  }

  function mockFetchWith(body: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
  }

  it('合法签名响应 → 返回 qr_code', async () => {
    const res = { code: '10000', msg: 'Success', out_trade_no: 'order-qr', qr_code: 'https://qr.alipay.com/bax123' }
    mockFetchWith({ alipay_trade_precreate_response: res, sign: signPrecreateResponse(res) })

    const { qrCode } = await adapter.createQrCharge({ orderId: 'order-qr', amountFen: 9900, subject: 's' })
    expect(qrCode).toBe('https://qr.alipay.com/bax123')
  })

  it('请求头必须带 charset=UTF-8 且签名串包含 sign_type（网关口径）——回归测试', async () => {
    // 2026-10-18 生产实证：网关按 Content-Type 的 charset 解码 POST 体，
    // 不带 charset 时中文 subject 被 GBK 解码 → isv.invalid-signature。
    const res = { code: '10000', msg: 'Success', out_trade_no: 'o', qr_code: 'q' }
    mockFetchWith({ alipay_trade_precreate_response: res, sign: signPrecreateResponse(res) })
    await adapter.createQrCharge({ orderId: 'o', amountFen: 100, subject: 's' })

    const fetchMock = vi.mocked(globalThis.fetch)
    const called = fetchMock.mock.calls[0]
    const headers = (called[1] as RequestInit).headers as Record<string, string>
    expect(headers['Content-Type']).toContain('charset=UTF-8')
    const sent = new URLSearchParams(String((called[1] as RequestInit).body))
    expect(sent.get('method')).toBe('alipay.trade.precreate')
    const signed: Record<string, string> = {}
    for (const [k, v] of sent) if (k !== 'sign') signed[k] = v
    const content = Object.keys(signed).sort().map((k) => `${k}=${signed[k]}`).join('&')
    const pubPem = `-----BEGIN PUBLIC KEY-----\n${(appPublicKeyPemRaw.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PUBLIC KEY-----`
    // 用支付宝视角验证请求签名（含 sign_type 的串必须验签通过——与 page.pay 回归同口径）
    expect(
      createVerify('RSA-SHA256').update(content, 'utf8').verify(pubPem, sent.get('sign')!, 'base64'),
    ).toBe(true)
  })

  it('响应验签失败 → 抛错（不返回假二维码）', async () => {
    const res = { code: '10000', msg: 'Success', out_trade_no: 'o', qr_code: 'q' }
    mockFetchWith({ alipay_trade_precreate_response: res, sign: ' forging' })
    await expect(adapter.createQrCharge({ orderId: 'o', amountFen: 100, subject: 's' })).rejects.toThrow('验签失败')
  })

  it('渠道拒绝（code!=10000）→ 抛错并携带错误码（不误报验签失败）', async () => {
    const res = { code: '40004', msg: 'Business Failed', sub_code: 'ACQ.TRADE_NOT_EXIST' }
    mockFetchWith({ alipay_trade_precreate_response: res, sign: signPrecreateResponse(res) })
    await expect(adapter.createQrCharge({ orderId: 'o', amountFen: 100, subject: 's' })).rejects.toThrow('40004')
  })

  it('成功响应但缺 qr_code → 抛错', async () => {
    const res = { code: '10000', msg: 'Success', out_trade_no: 'o' }
    mockFetchWith({ alipay_trade_precreate_response: res, sign: signPrecreateResponse(res) })
    await expect(adapter.createQrCharge({ orderId: 'o', amountFen: 100, subject: 's' })).rejects.toThrow('qr_code')
  })
})

describe('网关响应验签（原始节点文本口径）', () => {
  let appPrivateKeyPem: string
  let alipayPublicKeyPem: string

  beforeAll(() => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    appPrivateKeyPem = privateKey
    alipayPublicKeyPem = publicKey
  })

  function signRaw(rawNode: string): string {
    return createSign('RSA-SHA256').update(rawNode, 'utf8').sign(appPrivateKeyPem, 'base64')
  }

  function paidResponse(): Record<string, unknown> {
    return {
      code: '10000',
      msg: 'Success',
      buyer_logon_id: 'buy***@sandbox.com',
      trade_status: 'TRADE_SUCCESS',
      out_trade_no: 'order-abc',
      trade_no: '202610172200001234',
      total_amount: '99.00',
    }
  }

  function wrapRaw(res: Record<string, unknown>): string {
    // 模拟支付宝响应：response 节点原样嵌入（键序即对象键序，不做重排）
    return `{"alipay_trade_query_response":${JSON.stringify(res)},"sign":"SIGN_HERE"}`
  }

  it('extractRawResponseNode：从原始报文截取 response 节点原文（含嵌套与转义）', () => {
    const raw = `{"alipay_trade_query_response":{"a":"x\\"y{z}","b":{"n":1}},"sign":"s"}`
    const node = extractRawResponseNode(raw, 'alipay_trade_query_response')
    expect(node).toBe('{"a":"x\\"y{z}","b":{"n":1}}')
    expect(extractRawResponseNode('{"other":{}}', 'alipay_trade_query_response')).toBeNull()
  })

  it('接受合法签名的已付响应（原文口径，键序不重排）', () => {
    const raw = wrapRaw(paidResponse())
    const node = extractRawResponseNode(raw, 'alipay_trade_query_response')!
    expect(verifyResponseSignRaw(node, signRaw(node), alipayPublicKeyPem)).toBe(true)
  })

  it('拒绝被篡改的响应原文（签名对应原文，改动后必败）', () => {
    const res = paidResponse()
    const node = JSON.stringify(res)
    const tampered = JSON.stringify({ ...res, total_amount: '0.01' })
    expect(node).not.toBe(tampered)
    expect(verifyResponseSignRaw(tampered, signRaw(node), alipayPublicKeyPem)).toBe(false)
  })

  it('拒绝缺失/非字符串 sign', () => {
    const node = extractRawResponseNode(wrapRaw(paidResponse()), 'alipay_trade_query_response')!
    expect(verifyResponseSignRaw(node, undefined, alipayPublicKeyPem)).toBe(false)
    expect(verifyResponseSignRaw(node, '', alipayPublicKeyPem)).toBe(false)
  })

  it('中文字段按原文参与验签（JSON 内联 unicode 不重编码）', () => {
    const raw = `{"alipay_trade_query_response":{"code":"10000","subject":"lnk π 专业版"},"sign":"S"}`
    const node = extractRawResponseNode(raw, 'alipay_trade_query_response')!
    expect(node).toBe('{"code":"10000","subject":"lnk π 专业版"}')
    expect(verifyResponseSignRaw(node, signRaw(node), alipayPublicKeyPem)).toBe(true)
  })
})
