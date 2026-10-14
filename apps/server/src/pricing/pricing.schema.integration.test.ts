import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const serverRoot = path.resolve(__dirname, '../..')

describe('pricing schema against real SQLite', () => {
  let dir: string
  let prisma: PrismaClient

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-pricing-schema-'))
    const databaseUrl = `file:${path.join(dir, 'test.db')}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  }, 180_000) // 本机 pnpm exec 启动实测 ~70s（db push 本身 <1s），默认 10s hook 超时不够；同 audit-logs.controller.sqlite.integration.test.ts 约定

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates pricing tables and PointTransaction.ruleVersion', async () => {
    const v = await prisma.priceListVersion.create({
      data: { version: 'v1-legacy-equivalent', status: 'active', note: 't' },
    })
    const entry = await prisma.priceListEntry.create({
      data: { versionId: v.id, capability: 'text', matchKey: 'text', credits: 5 },
    })
    expect(entry.credits).toBe(5)
    const user = await prisma.user.create({ data: { phone: '17300000001', nickname: 'p' } })
    const tx = await prisma.pointTransaction.create({
      data: { userId: user.id, amount: -5, reason: '文本生成', ruleVersion: 'v1-legacy-equivalent' },
    })
    expect(tx.ruleVersion).toBe('v1-legacy-equivalent')
    const rate = await prisma.costRate.create({
      data: { channel: 'platform', modelKey: 'seedream-5.0-pro', spec: '1K', unit: 'per_image', costYuan: 0.3 },
    })
    expect(rate.costYuan).toBeCloseTo(0.3)
    const policy = await prisma.marginPolicy.create({
      data: { phase: 'launch', anchorCents: 1, marginBp: 11000 },
    })
    expect(policy.marginBp).toBe(11000)
  })
})
