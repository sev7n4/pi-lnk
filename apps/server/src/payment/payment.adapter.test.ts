import { describe, it, expect, beforeAll } from 'vitest'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { AlipayAdapter, type AlipayConfig } from './payment.adapter'

/**
 * RSA2 签名/验签正确性（无 DB 纯函数测试）。
 * 用「支付宝官方签名规则」（排除 sign/sign_type，字典序拼接，RSA-SHA256）手工构造
 * 合法/伪造回调，验证 AlipayAdapter.verifyCallback 的判定，防止自造签名规则偏离官方。
 */
describe('AlipayAdapter RSA2 验签', () => {
  let appPrivateKeyPem: string
  let adapter: AlipayAdapter

  beforeAll(() => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    appPrivateKeyPem = privateKey
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
})
