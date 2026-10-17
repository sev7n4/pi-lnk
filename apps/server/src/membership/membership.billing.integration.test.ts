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

describe('MembershipService billing stop-bleed against real SQLite', () => {
  let dir: string
  let prisma: PrismaClient
  let service: MembershipService

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-billing-'))
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

  it('F1: 每日签到幂等——首日发分，同日重复调用拒绝且不重复发分', async () => {
    const now = new Date('2026-10-17T10:00:00Z')
    await prisma.user.create({ data: { id: 'u-bleed', phone: '17200003333', nickname: 'bleed' } })

    const first = await service.claimDaily('u-bleed', now)
    expect(first.added).toBe(100)
    expect(first.points).toBe(1100)

    const after = await prisma.user.findUnique({ where: { id: 'u-bleed' } })
    expect(after?.lastDailyClaimAt).not.toBeNull()

    // 同一上海自然日内再次领取应被拒绝
    await expect(service.claimDaily('u-bleed', now)).rejects.toThrow('今日已签到')
    const unchanged = await prisma.user.findUnique({ where: { id: 'u-bleed' } })
    expect(unchanged?.points).toBe(1100)
  })

  it('F1: 跨日可再次领取（lastDailyClaimAt 落在昨天窗口）', async () => {
    const now = new Date('2026-10-18T10:00:00Z')
    const second = await service.claimDaily('u-bleed', now)
    expect(second.added).toBe(100)
    expect(second.points).toBe(1200)
  })

  it('F2: 付费套餐未接支付——拒绝且不发放任何积分', async () => {
    const before = await prisma.user.findUnique({ where: { id: 'u-bleed' } })
    await expect(service.upgrade('u-bleed', 'pro')).rejects.toThrow(/支付功能未接入/)
    const after = await prisma.user.findUnique({ where: { id: 'u-bleed' } })
    // 积分不变、会员等级不变
    expect(after?.points).toBe(before?.points)
    expect(after?.membership).toBe('free')
    // 不应产生任何「升级」积分流水（两次签到产生的 grant 不计入）
    const upgradeTxs = await prisma.pointTransaction.findMany({
      where: { userId: 'u-bleed', reason: { startsWith: '升级' } },
    })
    expect(upgradeTxs).toHaveLength(0)
  })
})
