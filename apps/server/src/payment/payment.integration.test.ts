import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { MembershipService, resolveTopupPoints } from '../membership/membership.service'
import { PaymentService } from './payment.service'
import type { PaymentAdapter, ChargeRequest, CallbackVerifyResult } from './payment.adapter'

const serverRoot = resolve(__dirname, '../..')

/**
 * 支付闭环集成测试（真实 SQLite + FakePaymentAdapter）。
 * 资损核心不变量全覆盖：验签失败/金额不符拒绝、CAS 幂等（重复回调/查单/upgrade
 * 三条入账路径均不重复发分）、他人订单拒绝。
 */
describe('支付闭环（真实 SQLite + FakePaymentAdapter）', () => {
  let dir: string
  let prisma: PrismaClient
  let service: PaymentService
  let membership: MembershipService
  let fake: FakePaymentAdapter

  class FakePaymentAdapter implements PaymentAdapter {
    readonly channel = 'alipay'
    createChargeCalls: ChargeRequest[] = []
    createQrChargeCalls: ChargeRequest[] = []
    verifyCallbackCalls: Record<string, string>[] = []
    queryTradeCalls: string[] = []
    /// 可编排的响应
    nextVerify: CallbackVerifyResult | null = null
    nextQueryPaid = false
    nextQrCode: string | null = null

    async createCharge(req: ChargeRequest) {
      this.createChargeCalls.push(req)
      return { payUrl: `https://openapi.alipaydev.com/gateway.do?fake=1&out_trade_no=${req.orderId}` }
    }

    async createQrCharge(req: ChargeRequest) {
      this.createQrChargeCalls.push(req)
      if (this.nextQrCode === null) throw new Error('precreate 渠道拒绝（未编排）')
      return { qrCode: this.nextQrCode }
    }

    verifyCallback(params: Record<string, string>) {
      this.verifyCallbackCalls.push(params)
      return this.nextVerify
    }

    async queryTrade(orderId: string) {
      this.queryTradeCalls.push(orderId)
      return { paid: this.nextQueryPaid, channelTradeNo: '202610172200009999' }
    }
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lnkpi-payment-'))
    const dbPath = join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync(join(serverRoot, 'node_modules', '.bin', 'prisma'), ['db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    membership = new MembershipService(prisma as unknown as PrismaService)
    fake = new FakePaymentAdapter()
    service = new PaymentService(prisma as unknown as PrismaService, fake, membership)
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await prisma.pointTransaction.deleteMany()
    await prisma.payment.deleteMany()
    await prisma.order.deleteMany()
    await prisma.user.deleteMany()
    fake.createChargeCalls = []
    fake.createQrChargeCalls = []
    fake.verifyCallbackCalls = []
    fake.queryTradeCalls = []
    fake.nextVerify = null
    fake.nextQueryPaid = false
    fake.nextQrCode = null
  })

  async function seedUser(id: string, points = 1000, membership = 'free') {
    return prisma.user.create({
      data: { id, phone: `p-${id}`, nickname: id, points, membership },
    })
  }

  it('createOrder：创建 PENDING 订单并产出收银台 URL（standard = 9900 分）', async () => {
    await seedUser('u-pay-1')
    const result = await service.createOrder('u-pay-1', 'standard')

    expect(result.orderId).toBeTruthy()
    expect(result.amountFen).toBe(9900)
    expect(result.payUrl).toContain('out_trade_no=' + result.orderId)
    expect(fake.createChargeCalls[0]).toMatchObject({ orderId: result.orderId, amountFen: 9900 })

    const order = await prisma.order.findUnique({ where: { id: result.orderId } })
    expect(order?.status).toBe('PENDING')
    expect(order?.amount).toBe(9900)
  })

  it('createOrder channel=qrcode：返回二维码串且不走收银台路径', async () => {
    await seedUser('u-pay-qr')
    fake.nextQrCode = 'https://qr.alipay.com/bax000000000001'
    const result = await service.createOrder('u-pay-qr', 'standard', 'qrcode')

    expect(result.qrCode).toBe('https://qr.alipay.com/bax000000000001')
    expect(result.amountFen).toBe(9900)
    expect(result.payUrl).toBeUndefined()
    expect(fake.createQrChargeCalls[0]).toMatchObject({ orderId: result.orderId, amountFen: 9900 })
    expect(fake.createChargeCalls).toHaveLength(0) // 不应同时发起收银台下单

    const order = await prisma.order.findUnique({ where: { id: result.orderId } })
    expect(order?.status).toBe('PENDING')
  })

  it('createOrder channel=qrcode 且渠道拒绝 → 响亮失败（订单不落库成功假象）', async () => {
    await seedUser('u-pay-qr-fail')
    fake.nextQrCode = null // 未编排 = precreate 抛错
    await expect(service.createOrder('u-pay-qr-fail', 'standard', 'qrcode')).rejects.toThrow()
    // 订单已创建但无凭据；PENDING 未付——不存在「已付」假象
    const orders = await prisma.order.findMany({ where: { userId: 'u-pay-qr-fail' } })
    expect(orders.every((o) => o.status === 'PENDING')).toBe(true)
  })

  it('回调验签通过且金额匹配 → 入账发分（purchased 池 + orderId）', async () => {
    await seedUser('u-pay-2')
    const { orderId } = await service.createOrder('u-pay-2', 'standard')
    fake.nextVerify = {
      orderId,
      channelTradeNo: '202610172200001234',
      paid: true,
      amountFen: 9900,
    }

    const result = await service.handleAlipayCallback({ sign: 'x', out_trade_no: orderId })
    expect(result).toBe('success')

    const order = await prisma.order.findUnique({ where: { id: orderId } })
    expect(order?.status).toBe('PAID')
    expect(order?.paidAt).toBeTruthy()

    const user = await prisma.user.findUnique({ where: { id: 'u-pay-2' } })
    expect(user?.points).toBe(12000) // 1000 + 11000
    expect(user?.membership).toBe('standard')

    const tx = await prisma.pointTransaction.findFirst({ where: { orderId } })
    expect(tx).toMatchObject({ pool: 'purchased', amount: 11000, kind: 'grant', orderId })

    const payment = await prisma.payment.findUnique({ where: { orderId } })
    expect(payment?.status).toBe('SUCCESS')
    expect(payment?.channelTradeNo).toBe('202610172200001234')
  })

  it('重复回调 → CAS 幂等，不重复发分', async () => {
    await seedUser('u-pay-3')
    const { orderId } = await service.createOrder('u-pay-3', 'standard')
    fake.nextVerify = { orderId, channelTradeNo: 'tn-1', paid: true, amountFen: 9900 }

    expect(await service.handleAlipayCallback({ out_trade_no: orderId })).toBe('success')
    // 渠道重试 / 前端重复触发
    expect(await service.handleAlipayCallback({ out_trade_no: orderId })).toBe('success')
    expect(await service.handleAlipayCallback({ out_trade_no: orderId })).toBe('success')

    const user = await prisma.user.findUnique({ where: { id: 'u-pay-3' } })
    expect(user?.points).toBe(12000) // 仍只发一次
    const txs = await prisma.pointTransaction.findMany({ where: { orderId } })
    expect(txs).toHaveLength(1)
  })

  it('验签失败（伪造通知）→ fail 且零入账', async () => {
    await seedUser('u-pay-4')
    const { orderId } = await service.createOrder('u-pay-4', 'standard')
    fake.nextVerify = null // 验签不通过

    expect(await service.handleAlipayCallback({ out_trade_no: orderId })).toBe('fail')
    const order = await prisma.order.findUnique({ where: { id: orderId } })
    expect(order?.status).toBe('PENDING')
    const user = await prisma.user.findUnique({ where: { id: 'u-pay-4' } })
    expect(user?.points).toBe(1000)
  })

  it('回调金额与订单金额不符 → fail 且零入账（防篡改）', async () => {
    await seedUser('u-pay-5')
    const { orderId } = await service.createOrder('u-pay-5', 'flagship') // 49900 分
    fake.nextVerify = { orderId, channelTradeNo: 'tn-2', paid: true, amountFen: 1 } // 1 分

    expect(await service.handleAlipayCallback({ out_trade_no: orderId })).toBe('fail')
    const order = await prisma.order.findUnique({ where: { id: orderId } })
    expect(order?.status).toBe('PENDING')
    const user = await prisma.user.findUnique({ where: { id: 'u-pay-5' } })
    expect(user?.points).toBe(1000)
  })

  it('未知订单号回调 → fail', async () => {
    fake.nextVerify = { orderId: 'no-such-order', channelTradeNo: 'tn', paid: true, amountFen: 9900 }
    expect(await service.handleAlipayCallback({ out_trade_no: 'no-such-order' })).toBe('fail')
  })

  it('PENDING 订单查询触发主动查单补偿 → 渠道已付则同路径入账', async () => {
    await seedUser('u-pay-6')
    const { orderId } = await service.createOrder('u-pay-6', 'standard')
    fake.nextQueryPaid = true

    const dto = await service.getOrderForUser('u-pay-6', orderId)
    expect(dto.status).toBe('PAID')
    expect(fake.queryTradeCalls).toContain(orderId)

    const user = await prisma.user.findUnique({ where: { id: 'u-pay-6' } })
    expect(user?.points).toBe(12000)
  })

  it('查单补偿后再来回调 → 不重复发分（双路径共享 CAS）', async () => {
    await seedUser('u-pay-7')
    const { orderId } = await service.createOrder('u-pay-7', 'standard')
    fake.nextQueryPaid = true
    await service.getOrderForUser('u-pay-7', orderId) // 查单入账

    fake.nextVerify = { orderId, channelTradeNo: 'tn-7', paid: true, amountFen: 9900 }
    expect(await service.handleAlipayCallback({ out_trade_no: orderId })).toBe('success')

    const user = await prisma.user.findUnique({ where: { id: 'u-pay-7' } })
    expect(user?.points).toBe(12000)
    const txs = await prisma.pointTransaction.findMany({ where: { orderId } })
    expect(txs).toHaveLength(1)
  })

  it('upgrade：未支付订单拒绝；已支付订单幂等确认不重复发分', async () => {
    await seedUser('u-pay-8')
    const { orderId } = await service.createOrder('u-pay-8', 'standard')

    // 未支付 → 拒绝
    await expect(service.getOrderForUser('u-pay-8', orderId)).resolves.toMatchObject({ status: 'PENDING' })
    await expect(membership.upgrade('u-pay-8', 'standard', orderId)).rejects.toThrow(/支付订单未完成/)

    // 入账（回调）
    fake.nextVerify = { orderId, channelTradeNo: 'tn-8', paid: true, amountFen: 9900 }
    await service.handleAlipayCallback({ out_trade_no: orderId })

    // 兜底确认 → 幂等（已入账守卫）
    const result = await membership.upgrade('u-pay-8', 'standard', orderId)
    expect(result.points).toBe(12000)
    const txs = await prisma.pointTransaction.findMany({ where: { orderId } })
    expect(txs).toHaveLength(1)
  })

  it('upgrade：他人订单 / 缺失订单 / 套餐不匹配均拒绝', async () => {
    await seedUser('u-pay-9')
    await seedUser('u-attacker')
    const { orderId } = await service.createOrder('u-pay-9', 'standard')
    fake.nextVerify = { orderId, channelTradeNo: 'tn-9', paid: true, amountFen: 9900 }
    await service.handleAlipayCallback({ out_trade_no: orderId })

    await expect(membership.upgrade('u-attacker', 'standard', orderId)).rejects.toThrow(/订单不存在/)
    await expect(membership.upgrade('u-pay-9', 'flagship', orderId)).rejects.toThrow(/订单与套餐不匹配/)
    const attacker = await prisma.user.findUnique({ where: { id: 'u-attacker' } })
    expect(attacker?.points).toBe(1000)
    expect(attacker?.membership).toBe('free')
  })

  it('getOrderForUser：他人订单拒绝（越权防护）', async () => {
    await seedUser('u-pay-10')
    await seedUser('u-other')
    const { orderId } = await service.createOrder('u-pay-10', 'standard')
    await expect(service.getOrderForUser('u-other', orderId)).rejects.toThrow(/订单不存在/)
  })

  it('未付款类通知（WAIT_BUYER_PAY）→ success 但零入账', async () => {
    await seedUser('u-pay-11')
    const { orderId } = await service.createOrder('u-pay-11', 'standard')
    fake.nextVerify = { orderId, channelTradeNo: 'tn-11', paid: false, amountFen: 9900 }

    expect(await service.handleAlipayCallback({ out_trade_no: orderId })).toBe('success')
    const order = await prisma.order.findUnique({ where: { id: orderId } })
    expect(order?.status).toBe('PENDING')
    const user = await prisma.user.findUnique({ where: { id: 'u-pay-11' } })
    expect(user?.points).toBe(1000)
  })

  it('topup：档位 ¥50 下单 → kind=topup + points=6000（含赠送），qrcode 返回凭据', async () => {
    await seedUser('u-topup-1')
    fake.nextQrCode = 'https://qr.alipay.com/bax000000000topup'
    const result = await service.createTopup('u-topup-1', 5000, 'qrcode')

    expect(result.amountFen).toBe(5000)
    expect(result.qrCode).toBe('https://qr.alipay.com/bax000000000topup')
    expect(fake.createQrChargeCalls[0]).toMatchObject({ orderId: result.orderId, amountFen: 5000 })

    const order = await prisma.order.findUnique({ where: { id: result.orderId } })
    expect(order?.kind).toBe('topup')
    expect(order?.plan).toBe('topup')
    expect(order?.points).toBe(6000) // 5000 基础 + 1000 赠送
    expect(order?.status).toBe('PENDING')
  })

  it('topup：自定义金额按基础汇率（1 分 = 1 积分，无赠送）', async () => {
    await seedUser('u-topup-2')
    const result = await service.createTopup('u-topup-2', 1234)
    const order = await prisma.order.findUnique({ where: { id: result.orderId } })
    expect(order?.points).toBe(1234)
    expect(order?.kind).toBe('topup')
  })

  it('topup：金额校验（低于 ¥5 / 超上限 / 非整数均拒绝）', async () => {
    await seedUser('u-topup-3')
    await expect(service.createTopup('u-topup-3', 400)).rejects.toThrow(/最低/)
    await expect(service.createTopup('u-topup-3', 1_000_001)).rejects.toThrow(/上限/)
    await expect(service.createTopup('u-topup-3', 500.5)).rejects.toThrow(/无效/)
    expect(await prisma.order.count({ where: { userId: 'u-topup-3' } })).toBe(0)
  })

  it('topup：回调入账 → 仅发积分（purchased 池 + 1 年有效期），不改会员', async () => {
    await seedUser('u-topup-4')
    const { orderId } = await service.createTopup('u-topup-4', 1000) // ¥10 → 1,000 无赠送
    fake.nextVerify = { orderId, channelTradeNo: 'tn-topup-1', paid: true, amountFen: 1000 }

    const before = Date.now()
    expect(await service.handleAlipayCallback({ out_trade_no: orderId })).toBe('success')

    const user = await prisma.user.findUnique({ where: { id: 'u-topup-4' } })
    expect(user?.points).toBe(2000) // 1000 + 1000
    expect(user?.membership).toBe('free') // 充值不改会员档位

    const tx = await prisma.pointTransaction.findFirst({ where: { orderId } })
    expect(tx).toMatchObject({ pool: 'purchased', amount: 1000, kind: 'grant', orderId })
    // 有效期 = 入账时刻 + 365 天（±1 分钟容差）
    const expectedExpiry = before + 365 * 24 * 60 * 60 * 1000
    expect(Math.abs(tx!.expiresAt!.getTime() - expectedExpiry)).toBeLessThan(60_000)

    const payment = await prisma.payment.findUnique({ where: { orderId } })
    expect(payment?.status).toBe('SUCCESS')
  })

  it('topup：重复回调 + 查单补偿 → CAS 幂等不重复发分', async () => {
    await seedUser('u-topup-5')
    const { orderId } = await service.createTopup('u-topup-5', 10000) // ¥100 → 13,000
    fake.nextVerify = { orderId, channelTradeNo: 'tn-topup-2', paid: true, amountFen: 10000 }

    expect(await service.handleAlipayCallback({ out_trade_no: orderId })).toBe('success')
    expect(await service.handleAlipayCallback({ out_trade_no: orderId })).toBe('success')

    // 查单补偿路径再入账一次（订单已 PAID，不会再触发，但守卫必须兜住）
    const dto = await service.getOrderForUser('u-topup-5', orderId)
    expect(dto.status).toBe('PAID')

    const user = await prisma.user.findUnique({ where: { id: 'u-topup-5' } })
    expect(user?.points).toBe(14000) // 1000 + 13000，仍只发一次
    const txs = await prisma.pointTransaction.findMany({ where: { orderId } })
    expect(txs).toHaveLength(1)
  })

  it('topup：查单补偿路径可直接入账（PENDING 订单）', async () => {
    await seedUser('u-topup-6')
    const { orderId } = await service.createTopup('u-topup-6', 2000) // ¥20 → 2,200
    fake.nextQueryPaid = true

    const dto = await service.getOrderForUser('u-topup-6', orderId)
    expect(dto.status).toBe('PAID')

    const user = await prisma.user.findUnique({ where: { id: 'u-topup-6' } })
    expect(user?.points).toBe(3200) // 1000 + 2200
    expect(user?.membership).toBe('free')
  })

  it('topup：resolveTopupPoints 档位映射正确', async () => {
    const cases: Array<[number, number]> = [
      [1000, 1000],
      [2000, 2200],
      [3000, 3450],
      [5000, 6000],
      [10000, 13000],
      [500, 500], // 自定义无赠送
      [9999, 9999],
    ]
    for (const [fen, total] of cases) {
      expect(resolveTopupPoints(fen).totalPoints).toBe(total)
    }
  })

  // ── 一个用户同时只持有一个套餐（换购必须先退订）────────────────────────────
  it('已持付费档 + 买不同档 → 建单拒绝（换购必须先退订），零订单落库', async () => {
    await seedUser('u-single-1', 1000, 'premium')
    await expect(service.createOrder('u-single-1', 'flagship')).rejects.toThrow(/退订/)
    await expect(service.createOrder('u-single-1', 'standard')).rejects.toThrow(/退订/)

    const orders = await prisma.order.findMany({ where: { userId: 'u-single-1' } })
    expect(orders).toHaveLength(0)
    expect(fake.createChargeCalls).toHaveLength(0)
    expect(fake.createQrChargeCalls).toHaveLength(0)

    const user = await prisma.user.findUnique({ where: { id: 'u-single-1' } })
    expect(user?.membership).toBe('premium')
  })

  it('已持付费档 + 买同档 → 放行（连续包月每月一笔同档续费订单）', async () => {
    await seedUser('u-single-2', 1000, 'premium')
    const result = await service.createOrder('u-single-2', 'premium')
    expect(result.orderId).toBeTruthy()
    expect(result.amountFen).toBe(19900)
  })

  it('入账兜底：已持 premium 时结算 standard 订单 → 不覆盖档位、积分照发（不吞已付款）', async () => {
    // 模拟竞态：订单在 free 时创建，付款前用户又买了 premium
    await seedUser('u-single-3', 1000, 'free')
    const order = await prisma.order.create({
      data: { userId: 'u-single-3', plan: 'standard', amount: 9900, status: 'PAID', paidAt: new Date() },
    })
    await prisma.user.update({ where: { id: 'u-single-3' }, data: { membership: 'premium' } })

    const result = await membership.grantPaidPlan('u-single-3', 'standard', order.id)
    expect(result.membership).toBe('premium') // 保住更高档，绝不静默降级
    expect(result.points).toBe(12000) // 1000 + 11000，积分照发

    const user = await prisma.user.findUnique({ where: { id: 'u-single-3' } })
    expect(user?.membership).toBe('premium')
    expect(user?.points).toBe(12000)
  })

  it('退订：清档位、积分保留；重复退订幂等', async () => {
    await seedUser('u-cancel-1', 5000, 'flagship')

    const first = await membership.cancelSubscription('u-cancel-1')
    expect(first).toMatchObject({ membership: 'free', changed: true })
    expect(first.points).toBe(5000) // 积分保留

    const second = await membership.cancelSubscription('u-cancel-1')
    expect(second).toMatchObject({ membership: 'free', changed: false })
  })

  it('退订后可正常建单换购（原阻塞路径解除）', async () => {
    await seedUser('u-cancel-2', 1000, 'standard')
    await expect(service.createOrder('u-cancel-2', 'flagship')).rejects.toThrow(/退订/)

    await membership.cancelSubscription('u-cancel-2')
    const result = await service.createOrder('u-cancel-2', 'flagship')
    expect(result.orderId).toBeTruthy()
  })
})
