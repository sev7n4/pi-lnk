import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const serverRoot = path.resolve(__dirname, '../..')

describe('PricingGrayRelease schema', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-pricing-gray-schema-'))
    const databaseUrl = `file:${path.join(dir, 'test.db')}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    process.env.DATABASE_URL = databaseUrl // brief 用例内为原样 new PrismaClient()，靠环境变量连临时库
  }, 180_000) // 本机 pnpm exec 启动实测 ~70s，默认 10s hook 超时不够；同 pricing.schema.integration.test.ts 约定

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('release 创建 + 名单唯一约束 + 级联删除', async () => {
    const prisma = new PrismaClient()
    try {
      const ver = await prisma.priceListVersion.create({
        data: { version: 'gray-schema-test', status: 'draft',
          entries: { create: { capability: 'text', matchKey: 'text', credits: 5 } } },
      })
      const rel = await prisma.pricingGrayRelease.create({
        data: { versionId: ver.id, status: 'active', startsAt: new Date(), endsAt: new Date(Date.now() + 864e5) },
      })
      await prisma.pricingGrayWhitelist.create({ data: { releaseId: rel.id, userId: 'u1', phone: '13800000001' } })
      await expect(prisma.pricingGrayWhitelist.create({
        data: { releaseId: rel.id, userId: 'u1', phone: '13800000001' } })).rejects.toThrow()
      await prisma.pricingGrayRelease.delete({ where: { id: rel.id } })
      expect(await prisma.pricingGrayWhitelist.count({ where: { releaseId: rel.id } })).toBe(0)
      await prisma.priceListVersion.delete({ where: { id: ver.id } })
    } finally { await prisma.$disconnect() }
  }, 30_000) // 冷启动 engine 可能 >5s 默认超时（首跑实测 9s）
  it('PointTransaction 可写 grayReleaseId', async () => {
    const prisma = new PrismaClient()
    try {
      // brief 原用例直接用 userId 'gray-schema-u'，但 PointTransaction.userId 是 User 外键，缺 User 行会 FK 报错——补建后清理
      await prisma.user.create({ data: { id: 'gray-schema-u', phone: '13800000099', nickname: 'gray-schema' } })
      const tx = await prisma.pointTransaction.create({
        data: { userId: 'gray-schema-u', amount: -5, reason: 't', kind: 'consume', grayReleaseId: 'rel_x' },
      })
      expect(tx.grayReleaseId).toBe('rel_x')
      await prisma.pointTransaction.delete({ where: { id: tx.id } })
      await prisma.user.delete({ where: { id: 'gray-schema-u' } })
    } finally { await prisma.$disconnect() }
  }, 30_000)
})
