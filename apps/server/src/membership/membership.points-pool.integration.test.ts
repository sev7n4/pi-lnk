import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PrismaService } from '../prisma/prisma.service'
import { MembershipService } from './membership.service'

const serverRoot = path.resolve(__dirname, '../..')

describe('MembershipService points pool & expiry against real SQLite', () => {
  let dir: string
  let prisma: PrismaClient
  let service: MembershipService

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-pool-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync(
      path.join(serverRoot, 'node_modules', '.bin', 'prisma'),
      ['db', 'push', '--skip-generate', '--accept-data-loss'],
      { cwd: serverRoot, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' },
    )
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    service = new MembershipService(prisma as PrismaService)
  }, 120000)

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  async function makeUser(id: string, points = 0) {
    await prisma.user.create({ data: { id, phone: `p-${id}`, nickname: id, points } })
  }

  it('默认池：未指定 pool 的流水归 granted（存量数据零迁移丢失）', async () => {
    await makeUser('u-pool-default', 100)
    const tx = await prisma.pointTransaction.create({
      data: {
        userId: 'u-pool-default',
        amount: 100,
        reason: '注册赠送',
        kind: 'grant',
        category: 'other',
        balanceAfter: 200,
      },
    })
    expect(tx.pool).toBe('granted')
    expect(tx.expiresAt).toBeNull()
    expect(tx.orderId).toBeNull()
  })

  it('claimDaily 写入 granted 池', async () => {
    await makeUser('u-pool-daily', 500)
    const now = new Date('2026-10-17T10:00:00Z')
    await service.claimDaily('u-pool-daily', now)
    const grant = await prisma.pointTransaction.findFirst({
      where: { userId: 'u-pool-daily', reason: '每日签到' },
    })
    expect(grant?.pool).toBe('granted')
    expect(grant?.amount).toBe(100)
  })

  it('按池汇总：跨 purchased/granted/subscription 正确分池净额', async () => {
    await makeUser('u-pool-sum', 0)
    const rows = [
      { userId: 'u-pool-sum', amount: 500, reason: '购买积分包', kind: 'grant', category: 'other', pool: 'purchased', balanceAfter: 500 },
      { userId: 'u-pool-sum', amount: 200, reason: '签到', kind: 'grant', category: 'other', pool: 'granted', balanceAfter: 700 },
      { userId: 'u-pool-sum', amount: 1000, reason: '订阅赠送', kind: 'grant', category: 'other', pool: 'subscription', balanceAfter: 1700 },
      { userId: 'u-pool-sum', amount: -80, reason: '生图', kind: 'consume', category: 'image', pool: 'granted', balanceAfter: 1620 },
      { userId: 'u-pool-sum', amount: 30, reason: '退款', kind: 'refund', category: 'image', pool: 'granted', balanceAfter: 1650 },
    ]
    for (const r of rows) await prisma.pointTransaction.create({ data: r })

    const bd = await service.getPointsBreakdown('u-pool-sum')
    expect(bd.pools.purchased.total).toBe(500)
    expect(bd.pools.granted.total).toBe(200 - 80 + 30) // 150
    expect(bd.pools.subscription.total).toBe(1000)
    expect(bd.expiredTotal).toBe(0)
    expect(bd.totalAvailable).toBe(500 + 150 + 1000)
  })

  it('有效期：过期正额不计入可用、计入 expired；未到期仍可用', async () => {
    await makeUser('u-pool-exp', 0)
    const now = new Date('2026-10-17T12:00:00Z')
    const rows = [
      { userId: 'u-pool-exp', amount: 300, reason: '过期包', kind: 'grant', category: 'other', pool: 'purchased', expiresAt: new Date('2026-10-10T00:00:00Z'), balanceAfter: 300 },
      { userId: 'u-pool-exp', amount: 200, reason: '生效包', kind: 'grant', category: 'other', pool: 'purchased', expiresAt: new Date('2026-11-01T00:00:00Z'), balanceAfter: 500 },
      { userId: 'u-pool-exp', amount: 50, reason: '永久赠送', kind: 'grant', category: 'other', pool: 'granted', balanceAfter: 550 },
    ]
    for (const r of rows) await prisma.pointTransaction.create({ data: r })

    const bd = await service.getPointsBreakdown('u-pool-exp', now)
    expect(bd.pools.purchased.total).toBe(500)
    expect(bd.pools.purchased.expired).toBe(300)
    expect(bd.pools.purchased.available).toBe(200) // 500 − 300
    expect(bd.pools.granted.available).toBe(50)
    expect(bd.expiredTotal).toBe(300)
    expect(bd.totalAvailable).toBe(200 + 50) // 250
  })

  it('一致性不变量：granted 账本净额与 User.points 同步时 breakdown.available == User.points', async () => {
    const id = 'u-pool-inv'
    await prisma.user.create({ data: { id, phone: `p-${id}`, nickname: id, points: 0 } })
    // 模拟真实发放/消费路径：账本流水与 User.points 单一余额同步增减
    await prisma.pointTransaction.create({
      data: { userId: id, amount: 1000, reason: '注册', kind: 'grant', category: 'other', pool: 'granted', balanceAfter: 1000 },
    })
    await prisma.user.update({ where: { id }, data: { points: 1000 } })
    await prisma.pointTransaction.create({
      data: { userId: id, amount: -234, reason: '消费', kind: 'consume', category: 'text', pool: 'granted', balanceAfter: 766 },
    })
    await prisma.user.update({ where: { id }, data: { points: 766 } })

    const bd = await service.getPointsBreakdown(id)
    const user = await prisma.user.findUnique({ where: { id } })
    expect(bd.pools.granted.available).toBe(766)
    expect(user?.points).toBe(766)
    expect(bd.pools.granted.available).toBe(user?.points)
  })
})
