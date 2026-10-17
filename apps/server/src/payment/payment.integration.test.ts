import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { MembershipService } from '../membership/membership.service'
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

  async function seedUser(id: string, points = 1000) {
    return prisma.user.create({
      data: { id, phone: `p-${id}`, nickname: id, points, membership: 'free' },
    })
  }

  it('createOrder：创建 PENDING 订单并产出收银台 URL（pro = 9900 分）', async () => {
    await seedUser('u-pay-1')
    const result = await service.createOrder('u-pay-1', 'pro')

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
    const result = await service.createOrder('u-pay-qr', 'pro', 'qrcode')

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
    await expect(service.createOrder('u-pay-qr-fail', 'pro', 'qrcode')).rejects.toThrow()
    // 订单已创建但无凭据；PENDING 未付——不存在「已付」假象
    const orders = await prisma.order.findMany({ where: { userId: 'u-pay-qr-fail' } })
    expect(orders.every((o) => o.status === 'PENDING')).toBe(true)
  })

  it('回调验签通过且金额匹配 → 入账发分（purchased 池 + orderId）', async () => {
    await seedUser('u-pay-2')
    const { orderId } = await service.createOrder('u-pay-2', 'pro')
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
    expect(user?.points).toBe(6000) // 1000 + 5000
    expect(user?.membership).toBe('pro')

    const tx = await prisma.pointTransaction.findFirst({ where: { orderId } })
    expect(tx).toMatchObject({ pool: 'purchased', amount: 5000, kind: 'grant', orderId })

    const payment = await prisma.payment.findUnique({ where: { orderId } })
    expect(payment?.status).toBe('SUCCESS')
    expect(payment?.channelTradeNo).toBe('202610172200001234')
  })

  it('重复回调 → CAS 幂等，不重复发分', async () => {
    await seedUser('u-pay-3')
    const { orderId } = await service.createOrder('u-pay-3', 'pro')
    fake.nextVerify = { orderId, channelTradeNo: 'tn-1', paid: true, amountFen: 9900 }

    expect(await service.handleAlipayCallback({ out_trade_no: orderId })).toBe('success')
    // 渠道重试 / 前端重复触发
    expect(await service.handleAlipayCallback({ out_trade_no: orderId })).toBe('success')
    expect(await service.handleAlipayCallback({ out_trade_no: orderId })).toBe('success')

    const user = await prisma.user.findUnique({ where: { id: 'u-pay-3' } })
    expect(user?.points).toBe(6000) // 仍只发一次
    const txs = await prisma.pointTransaction.findMany({ where: { orderId } })
    expect(txs).toHaveLength(1)
  })

  it('验签失败（伪造通知）→ fail 且零入账', async () => {
    await seedUser('u-pay-4')
    const { orderId } = await service.createOrder('u-pay-4', 'pro')
    fake.nextVerify = null // 验签不通过

    expect(await service.handleAlipayCallback({ out_trade_no: orderId })).toBe('fail')
    const order = await prisma.order.findUnique({ where: { id: orderId } })
    expect(order?.status).toBe('PENDING')
    const user = await prisma.user.findUnique({ where: { id: 'u-pay-4' } })
    expect(user?.points).toBe(1000)
  })

  it('回调金额与订单金额不符 → fail 且零入账（防篡改）', async () => {
    await seedUser('u-pay-5')
    const { orderId } = await service.createOrder('u-pay-5', 'studio') // 29900 分
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
    const { orderId } = await service.createOrder('u-pay-6', 'pro')
    fake.nextQueryPaid = true

    const dto = await service.getOrderForUser('u-pay-6', orderId)
    expect(dto.status).toBe('PAID')
    expect(fake.queryTradeCalls).toContain(orderId)

    const user = await prisma.user.findUnique({ where: { id: 'u-pay-6' } })
    expect(user?.points).toBe(6000)
  })

  it('查单补偿后再来回调 → 不重复发分（双路径共享 CAS）', async () => {
    await seedUser('u-pay-7')
    const { orderId } = await service.createOrder('u-pay-7', 'pro')
    fake.nextQueryPaid = true
    await service.getOrderForUser('u-pay-7', orderId) // 查单入账

    fake.nextVerify = { orderId, channelTradeNo: 'tn-7', paid: true, amountFen: 9900 }
    expect(await service.handleAlipayCallback({ out_trade_no: orderId })).toBe('success')

    const user = await prisma.user.findUnique({ where: { id: 'u-pay-7' } })
    expect(user?.points).toBe(6000)
    const txs = await prisma.pointTransaction.findMany({ where: { orderId } })
    expect(txs).toHaveLength(1)
  })

  it('upgrade：未支付订单拒绝；已支付订单幂等确认不重复发分', async () => {
    await seedUser('u-pay-8')
    const { orderId } = await service.createOrder('u-pay-8', 'pro')

    // 未支付 → 拒绝
    await expect(service.getOrderForUser('u-pay-8', orderId)).resolves.toMatchObject({ status: 'PENDING' })
    await expect(membership.upgrade('u-pay-8', 'pro', orderId)).rejects.toThrow(/支付订单未完成/)

    // 入账（回调）
    fake.nextVerify = { orderId, channelTradeNo: 'tn-8', paid: true, amountFen: 9900 }
    await service.handleAlipayCallback({ out_trade_no: orderId })

    // 兜底确认 → 幂等（已入账守卫）
    const result = await membership.upgrade('u-pay-8', 'pro', orderId)
    expect(result.points).toBe(6000)
    const txs = await prisma.pointTransaction.findMany({ where: { orderId } })
    expect(txs).toHaveLength(1)
  })

  it('upgrade：他人订单 / 缺失订单 / 套餐不匹配均拒绝', async () => {
    await seedUser('u-pay-9')
    await seedUser('u-attacker')
    const { orderId } = await service.createOrder('u-pay-9', 'pro')
    fake.nextVerify = { orderId, channelTradeNo: 'tn-9', paid: true, amountFen: 9900 }
    await service.handleAlipayCallback({ out_trade_no: orderId })

    await expect(membership.upgrade('u-attacker', 'pro', orderId)).rejects.toThrow(/订单不存在/)
    await expect(membership.upgrade('u-pay-9', 'studio', orderId)).rejects.toThrow(/订单与套餐不匹配/)
    const attacker = await prisma.user.findUnique({ where: { id: 'u-attacker' } })
    expect(attacker?.points).toBe(1000)
    expect(attacker?.membership).toBe('free')
  })

  it('getOrderForUser：他人订单拒绝（越权防护）', async () => {
    await seedUser('u-pay-10')
    await seedUser('u-other')
    const { orderId } = await service.createOrder('u-pay-10', 'pro')
    await expect(service.getOrderForUser('u-other', orderId)).rejects.toThrow(/订单不存在/)
  })

  it('未付款类通知（WAIT_BUYER_PAY）→ success 但零入账', async () => {
    await seedUser('u-pay-11')
    const { orderId } = await service.createOrder('u-pay-11', 'pro')
    fake.nextVerify = { orderId, channelTradeNo: 'tn-11', paid: false, amountFen: 9900 }

    expect(await service.handleAlipayCallback({ out_trade_no: orderId })).toBe('success')
    const order = await prisma.order.findUnique({ where: { id: orderId } })
    expect(order?.status).toBe('PENDING')
    const user = await prisma.user.findUnique({ where: { id: 'u-pay-11' } })
    expect(user?.points).toBe(1000)
  })
})
