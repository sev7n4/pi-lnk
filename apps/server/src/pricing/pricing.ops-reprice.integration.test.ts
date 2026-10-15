/**
 * 跨任务全链回归（终审 Critical C1 + C2 专用防线）。
 *
 * 为什么单 task 评审抓不到：C1 的一端在发布流（basis 缺省），另一端在计价服务
 * 的 boot 自检条件化；C2 的一端在 boot 降级，另一端在 quote 的短路。两处单独看
 * 都"合理"，合起来才构成「运营改的价被静默丢弃」和「发布流在运行中的进程无效」。
 *
 * 本文件走真 SQLite 全链，任何一环回归（basis 又变回 legacy-equivalent / degraded
 * 又变回永久闩锁）都会红。
 */
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RULE_VERSION_CONSTANTS_FALLBACK, legacyPriceOf } from './pricing.core'
import { enumeratePricingSpace } from './pricing.space'
import { seedPricing } from './seed-pricing'
import { PricingPublishingService } from './pricing-publishing.service'
import { PricingService } from './pricing.service'
import type { PrismaService } from '../prisma/prisma.service'

const serverRoot = path.resolve(__dirname, '../..')

describe('运营改价全链：建草案 → 改 credits → publish → 重启自检', () => {
  let dir: string
  let prisma: PrismaClient

  /**
   * 一个「进程」= 一个 PricingService 单例 + 挂在它上面的发布流。
   * 必须复用同一实例：Nest DI 下 PricingPublishingService 注入的就是同一个
   * PricingService，写路径的 invalidate() 也正是作用在它身上（另见 I3 的教训：
   * 造新实例会绕开缓存，把真缺陷一起掩盖）。
   */
  function bootProcess() {
    const pricing = new PricingService(prisma as unknown as PrismaService)
    return { pricing, publishing: new PricingPublishingService(prisma as unknown as PrismaService, pricing) }
  }

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-pricing-ops-reprice-'))
    const databaseUrl = `file:${path.join(dir, 'test.db')}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  }, 180_000) // 同 pricing.equivalence.integration.test.ts：本机 pnpm exec 启动 ~70s，默认 hook 超时不够

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await prisma.adminAuditLog.deleteMany()
    await prisma.priceListEntry.deleteMany()
    await prisma.priceListVersion.deleteMany()
    await prisma.costRate.deleteMany()
  })

  it('C1：改过价的条目不再触发全网等价自检降级，重启后仍返回运营改后的价', async () => {
    // v1 = 全 legacy-equivalent 基线（等价迁移，正宗P0 形态）
    await seedPricing(prisma)
    const space = enumeratePricingSpace()
    expect(space.length).toBe(318)

    const textKey = 'text'
    const before = legacyPriceOf({ capability: 'text' })
    const after = before + 3

    // 运营日常路径（真实 API 序列）：复制 active 建草案 → 手工改 credits → 发布。
    // 服务端不再依赖前端「记得带 basis」：即使请求不带，缺省也落 ops-modified。
    const ops = bootProcess()
    const draft = await ops.publishing.createDraftFromActive('ops-v2', '运营改价')
    await ops.publishing.upsertEntries(draft.id, [
      { matchKey: textKey, capability: 'text', credits: after }, // 不显式给 basis
    ])
    await ops.publishing.publish(draft.id)

    const published = await prisma.priceListVersion.findUniqueOrThrow({ where: { id: draft.id } })
    expect(published.status).toBe('active')
    const row = await prisma.priceListEntry.findUniqueOrThrow({
      where: { versionId_matchKey: { versionId: published.id, matchKey: textKey } },
    })
    expect(row.credits).toBe(after)
    expect(row.basis).toBe('ops-modified')

    // 关键：改价行是全表唯一的非legacy-equivalent 行 ⇒ 跳过等价自检 ⇒ 不降级
    const legacyRows = await prisma.priceListEntry.count({
      where: { versionId: published.id, basis: 'legacy-equivalent' },
    })
    const totalRows = await prisma.priceListEntry.count({ where: { versionId: published.id } })
    expect(legacyRows).toBeLessThan(totalRows)

    // 重启（新实例 onModuleInit）：degraded=false + quote 返回改后的价
    const { pricing } = bootProcess()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await pricing.onModuleInit()
    expect(err).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('跳过全网等价自检'))

    await expect(pricing.quote({ capability: 'text' })).resolves.toEqual({
      credits: after,
      ruleVersion: 'ops-v2',
    })
    // 其余档位仍逐字等价（P0 地基未被放松）
    for (const q of space.filter((x) => x.capability !== 'text')) {
      const quote = await pricing.quote(q)
      expect(quote.credits, JSON.stringify(q)).toBe(legacyPriceOf(q))
    }
    log.mockRestore()
    err.mockRestore()
  }, 120_000)

  it('C1 反证：若改价行仍带 legacy-equivalent，重启必降级且丢弃运营改的价（该缺陷为何真实）', async () => {
    // 本用例把 basis 强行写回 legacy-equivalent（模拟修复前的行为），证明
    // 「静默丢弃运营改的价」不是假想：重启后全站回落常量 5，运营发布的值消失。
    await seedPricing(prisma)
    const version = await prisma.priceListVersion.findFirstOrThrow({ where: { status: 'active' } })
    await prisma.priceListEntry.update({
      where: { versionId_matchKey: { versionId: version.id, matchKey: 'text' } },
      data: { credits: legacyPriceOf({ capability: 'text' }) + 3, basis: 'legacy-equivalent' },
    })
    const legacyRows = await prisma.priceListEntry.count({
      where: { versionId: version.id, basis: 'legacy-equivalent' },
    })
    const totalRows = await prisma.priceListEntry.count({ where: { versionId: version.id } })
    expect(legacyRows).toBe(totalRows) // 满足等价自检的触发条件

    const { pricing } = bootProcess()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await pricing.onModuleInit()
    expect(err).toHaveBeenCalledWith(expect.stringContaining('启动自检失配'))

    // 运营发布的 8 分被无视，退回 5 分 —— 静默改变扣费金额
    await expect(pricing.quote({ capability: 'text' })).resolves.toEqual({
      credits: legacyPriceOf({ capability: 'text' }),
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })
    err.mockRestore()
  }, 120_000)

  it('C2：boot 无 active 版本降级后，发布流建出版本即自愈——不必重启进程', async () => {
    // 库为空 ⇒ boot 降级
    const first = bootProcess()
    const bootErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bootWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await first.pricing.onModuleInit()
    expect(bootErr).toHaveBeenCalledWith(expect.stringContaining('无 active 价目表版本'))
    await expect(first.pricing.quote({ capability: 'text' })).resolves.toEqual({
      credits: 5,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })

    // 同一个仍在运行的进程（同一 PricingService 单例，未重启、未再 onModuleInit）
    // 内经发布流建版本：先造active 基线，再建草案 → publish。
    await seedPricing(prisma)
    const draft = await first.publishing.createDraftFromActive('ops-v2', '降级期间建版本')
    await first.publishing.upsertEntries(draft.id, [
      { matchKey: 'text', capability: 'text', credits: 8, basis: 'ops-modified' },
    ])
    await first.publishing.publish(draft.id)

    // 同一个仍在运行的进程（未onModuleInit、未重启）：报价必须切到新表
    await expect(first.pricing.quote({ capability: 'text' })).resolves.toEqual({
      credits: 8,
      ruleVersion: 'ops-v2',
    })
    expect(bootWarn).toHaveBeenCalledWith(expect.stringContaining('已从降级恢复'))

    // 自愈是持久的：后续报价继续走表，不会退回兜底
    await expect(first.pricing.quote({ capability: 'text' })).resolves.toEqual({
      credits: 8,
      ruleVersion: 'ops-v2',
    })
    bootErr.mockRestore()
    bootWarn.mockRestore()
  }, 120_000)

  it('C2 边界：自检失配造成的降级不自愈（否则绕过 P0 等价防线）', async () => {
    await seedPricing(prisma)
    const version = await prisma.priceListVersion.findFirstOrThrow({ where: { status: 'active' } })
    await prisma.priceListEntry.update({
      where: { versionId_matchKey: { versionId: version.id, matchKey: 'text' } },
      data: { credits: 999, basis: 'legacy-equivalent' },
    })

    const { pricing } = bootProcess()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await pricing.onModuleInit()
    expect(err).toHaveBeenCalledWith(expect.stringContaining('启动自检失配'))

    // 表就在库里、查得到，但那张表本身不该被信 ⇒ 降级保持
    await expect(pricing.quote({ capability: 'text' })).resolves.toEqual({
      credits: 5,
      ruleVersion: RULE_VERSION_CONSTANTS_FALLBACK,
    })
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('已从降级恢复'))
    err.mockRestore()
    warn.mockRestore()
  }, 120_000)
})