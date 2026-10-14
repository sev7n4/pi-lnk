import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { BadRequestException } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildMatchKey,
  canonicalImageResolution,
  canonicalVideoResolution,
  legacyPriceOf,
  videoPriceFamily,
} from './pricing.core'
import type { PricingQuery } from './pricing.core'
import { enumeratePricingSpace } from './pricing.space'
import { assertLaunchFloor, PRICING_VERSION_V2_DRAFT, seedPricingV2Draft } from './seed-pricing-v2-draft'
import type { PlannedEntry } from './seed-pricing-v2-draft'
import { seedPricing } from '../../prisma/seed-pricing'

/**
 * v2 拉新期价目草案种子测试（P1-a T7）。
 *
 * 桩模式照 pricing.seed.integration.test.ts（真 SQLite：tmpdir + prisma db push）。
 * v1 基线与 CostRate 行由 P0 seedPricing 入库（v1 值断言走 legacyPriceOf 同源，不读库）。
 */

const serverRoot = path.resolve(__dirname, '../..')

/** 本任务改价判据（与实现同规则）：image 全部 + minimax-h3 768p/2k 全部档（含 ref）。 */
const isRemapped = (q: PricingQuery) =>
  q.capability === 'image' ||
  (q.capability === 'video' &&
    videoPriceFamily(q.modelKey) === 'minimax-h3' &&
    canonicalVideoResolution(q.resolution) !== '480p')

describe('seedPricingV2Draft against real SQLite', () => {
  let dir: string
  let prisma: PrismaClient
  let v2VersionId: string
  let entryOf: (matchKey: string) => Promise<{ credits: number; basis: string; costRateId: string | null } | null>
  let rateIdOf: (modelKey: string, spec: string) => Promise<string>

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-pricing-v2draft-'))
    const databaseUrl = `file:${path.join(dir, 'test.db')}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    entryOf = async (matchKey) => {
      const row = await prisma.priceListEntry.findUnique({
        where: { versionId_matchKey: { versionId: v2VersionId, matchKey } },
      })
      return row ? { credits: row.credits, basis: row.basis, costRateId: row.costRateId } : null
    }
    rateIdOf = async (modelKey, spec) => {
      const row = await prisma.costRate.findUnique({
        where: { channel_modelKey_spec: { channel: 'platform', modelKey, spec } },
      })
      expect(row, `CostRate ${modelKey}:${spec} 应已由 P0 seed 入库`).toBeDefined()
      return row!.id
    }
  }, 180_000) // 同 pricing.seed.integration.test.ts：pnpm exec 启动 ~70s，默认 hook 超时不够

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  it('映射/计数/抽样值/ref delta/未映射逐字/状态/地板正向/perSec 一致性', async () => {
    // P0 seed 先行：v1 基线 + CostRate 行入库（种子应可在空库跑，v1 值不从库读——
    // 断言里的 v1 一律现场调 legacyPriceOf）
    await seedPricing(prisma)

    const space = enumeratePricingSpace()
    const result = await seedPricingV2Draft(prisma)
    expect(result.version).toBe(PRICING_VERSION_V2_DRAFT)

    // ── 断言 1：变更计数精确（期望值现场从枚举空间算，不硬编码）──
    const expectedChanged = space.filter(isRemapped).length
    expect(result.changed).toBe(expectedChanged)
    expect(result.copied).toBe(space.length - expectedChanged)

    const v2 = await prisma.priceListVersion.findUnique({ where: { version: PRICING_VERSION_V2_DRAFT } })
    expect(v2).toBeDefined()
    v2VersionId = v2!.id

    // ── 断言 5：status='draft'、未发布（publishedAt 空）、对 active 无影响（v1 仍 active）──
    expect(v2!.status).toBe('draft')
    expect(v2!.publishedAt).toBeNull()
    const v1 = await prisma.priceListVersion.findUnique({ where: { version: 'v1-legacy-equivalent' } })
    expect(v1?.status).toBe('active')

    const rows = await prisma.priceListEntry.findMany({ where: { versionId: v2VersionId } })
    expect(rows.length).toBe(space.length)

    // ── 断言 2：抽样值（computeCreditsFromCost 口径）──
    // image（锚 CostRate 现算，不硬编码 33/66/322）：
    expect((await entryOf('image:1K:1'))!.credits).toBe(33) // ceil(0.30×110)
    expect((await entryOf('image:2K:1'))!.credits).toBe(66) // ceil(0.60×110)
    // spec §6.1 拍板 322 系手算舍入差：2.93×110 = 322.3，ceil = 323——同 §6.2 表 629 的
    // 处理原则，以 computeCreditsFromCost 函数口径为准（实现禁止硬编码 322）
    expect((await entryOf('image:4K:1'))!.credits).toBe(323) // ceil(2.93×110)
    // video minimax-h3（perSec × d 现算）：
    expect((await entryOf('video:minimax-h3:768p:5:-:ri0:rv0'))!.credits).toBe(315) // ceil(0.572×5×110)
    expect((await entryOf('video:minimax-h3:2k:5:-:ri0:rv0'))!.credits).toBe(512) // ceil(0.93×5×110)
    // spec §6.2 表 629 系手算舍入差（0.572×10×110 = 629.2 → ceil 630），以函数口径为准
    expect((await entryOf('video:minimax-h3:768p:10:-:ri0:rv0'))!.credits).toBe(630)

    // basis / costRateId 抽样：改价条目挂 launch-reprice + 对应 CostRate 行
    const img1k = await entryOf('image:1K:1')
    expect(img1k!.basis).toBe('launch-reprice')
    expect(img1k!.costRateId).toBe(await rateIdOf('seedream-5.0-pro', '1K'))
    const img4k = await entryOf('image:4K:1')
    expect(img4k!.costRateId).toBe(await rateIdOf('gpt-image-2', '4K'))
    const vid768 = await entryOf('video:minimax-h3:768p:5:-:ri0:rv0')
    expect(vid768!.basis).toBe('launch-reprice')
    expect(vid768!.costRateId).toBe(await rateIdOf('minimax-h3', '768p:5s'))
    const vid2k = await entryOf('video:minimax-h3:2k:5:-:ri0:rv0')
    expect(vid2k!.costRateId).toBe(await rateIdOf('minimax-h3', '2k:5s'))
    // 4s 档改价但不挂 costRateId：锚点行（5s 成本）地板 ceil(2.86×105)=301 > 4s 售价 252，
    // 挂上会让发布流 checkFloors（挂接行成本口径）硬 400——上游无 4s 成本行，
    // 4s 档走 diffSummary noCostCoverage 标注（Task 2 既有出口）
    const vid4s = await entryOf('video:minimax-h3:768p:4:-:ri0:rv0')
    expect(vid4s!.basis).toBe('launch-reprice')
    expect(vid4s!.credits).toBe(252) // ceil(0.572×4×110)
    expect(vid4s!.costRateId).toBeNull()

    // ── 断言 3：ref 加价 delta 保留（逐档：v2ref − v2base === v1ref − v1base）──
    const refQueries = space.filter(
      (q) =>
        q.capability === 'video' &&
        videoPriceFamily(q.modelKey) === 'minimax-h3' &&
        q.videoMode === 'reference_to_video' &&
        canonicalVideoResolution(q.resolution) !== '480p',
    )
    expect(refQueries.length).toBeGreaterThan(0)
    for (const q of refQueries) {
      const key = buildMatchKey(q)
      const baseKey = `video:minimax-h3:${canonicalVideoResolution(q.resolution)}:${q.duration}:-:ri0:rv0`
      const v2ref = (await entryOf(key))!.credits
      const v2base = (await entryOf(baseKey))!.credits
      const v1ref = legacyPriceOf(q)
      const v1base = legacyPriceOf({
        capability: 'video',
        modelKey: 'minimax-h3',
        resolution: q.resolution,
        duration: q.duration,
      })
      expect(v2ref - v2base, key).toBe(v1ref - v1base)
    }

    // ── 断言 4：未映射档位逐字 = v1（含 minimax-h3 480p 照抄分支）──
    for (const q of space.filter((q) => !isRemapped(q))) {
      const key = buildMatchKey(q)
      const row = (await entryOf(key))!
      expect(row.credits, key).toBe(legacyPriceOf(q))
      expect(row.basis, key).toBe('legacy-equivalent')
      expect(row.costRateId, key).toBeNull()
    }

    // image 全部 12 条 launch-reprice + 挂对 CostRate 行（1K/2K→seedream、4K→gpt-image-2）
    for (const q of space.filter((x) => x.capability === 'image')) {
      const key = buildMatchKey(q)
      const row = (await entryOf(key))!
      expect(row.basis, key).toBe('launch-reprice')
      const res = canonicalImageResolution(q.resolution)
      expect(row.costRateId, key).toBe(
        await rateIdOf(res === '4K' ? 'gpt-image-2' : 'seedream-5.0-pro', res),
      )
    }

    // ── 断言 7（正向）：有 costRateId 者全部过地板 credits ≥ ceil(costYuan×105) ──
    const rates = await prisma.costRate.findMany()
    const rateCost = new Map(rates.map((r) => [r.id, r.costYuan]))
    for (const r of rows.filter((x) => x.costRateId)) {
      const floor = Math.ceil(rateCost.get(r.costRateId!)! * 105)
      expect(r.credits, r.matchKey).toBeGreaterThanOrEqual(floor)
    }

    // ── perSec 上游线性一致性（brief：与 10s/15s 行反推差 ≤ 0.001）──
    // 2k 上游官方价仅 5s 锚点行（无 10s/15s CostRate），无反推校验对象
    const a5 = await prisma.costRate.findUnique({
      where: { channel_modelKey_spec: { channel: 'platform', modelKey: 'minimax-h3', spec: '768p:5s' } },
    })
    const a10 = await prisma.costRate.findUnique({
      where: { channel_modelKey_spec: { channel: 'platform', modelKey: 'minimax-h3', spec: '768p:10s' } },
    })
    const a15 = await prisma.costRate.findUnique({
      where: { channel_modelKey_spec: { channel: 'platform', modelKey: 'minimax-h3', spec: '768p:15s' } },
    })
    const perSec = a5!.costYuan / 5
    expect(Math.abs(perSec - a10!.costYuan / 10)).toBeLessThanOrEqual(0.001)
    expect(Math.abs(perSec - a15!.costYuan / 15)).toBeLessThanOrEqual(0.001)
  }, 240_000) // 234 档 × seedPricing + seedPricingV2Draft 两轮 upsert，同 P0 集成测试放宽超时

  it('幂等：同名 draft 重跑重新 upsert 全部条目，计数与值不变', async () => {
    const before = await prisma.priceListEntry.count({
      where: { version: { version: PRICING_VERSION_V2_DRAFT } },
    })
    const second = await seedPricingV2Draft(prisma)
    expect(second.changed + second.copied).toBe(before)
    const after = await prisma.priceListEntry.count({
      where: { version: { version: PRICING_VERSION_V2_DRAFT } },
    })
    expect(after).toBe(before)
    // 抽样值重跑后不变
    expect((await entryOf('image:4K:1'))!.credits).toBe(323)
    expect((await entryOf('video:minimax-h3:768p:10:-:ri0:rv0'))!.credits).toBe(630)
  }, 240_000)

  it('断言 6：同名版本已存在且非 draft → 400 拒绝（不许偷改已发布版本）', async () => {
    await prisma.priceListVersion.create({
      data: { version: 'v2-conflict', status: 'active', note: 'test', publishedAt: new Date() },
    })
    await expect(seedPricingV2Draft(prisma, { version: 'v2-conflict' })).rejects.toBeInstanceOf(
      BadRequestException,
    )
    // archived 同样拒绝
    await prisma.priceListVersion.create({
      data: { version: 'v2-conflict-arch', status: 'archived', note: 'test' },
    })
    await expect(seedPricingV2Draft(prisma, { version: 'v2-conflict-arch' })).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('断言 7（throw 路径）：地板违规即 throw（纯函数直测）', () => {
    // 当前映射下 credits 全部由同源 CostRate 现算（ceil(cost×110) ≥ ceil(cost×105) 恒真），
    // 数据级探针（抬 costYuan）无法触发违规——该防线防的是未来映射改动，
    // 故对 assertLaunchFloor 纯函数直测；种子内它在写库前调用 ⇒ 违规零落库。
    const rates = new Map([['rate-768p5s', 2.86]])
    const ok: PlannedEntry[] = [
      { matchKey: 'video:minimax-h3:768p:5:-:ri0:rv0', capability: 'video', credits: 315, basis: 'launch-reprice', costRateId: 'rate-768p5s' },
    ]
    expect(() => assertLaunchFloor(ok, rates)).not.toThrow()
    const bad: PlannedEntry[] = [
      { matchKey: 'video:minimax-h3:768p:5:-:ri0:rv0', capability: 'video', credits: 250, basis: 'launch-reprice', costRateId: 'rate-768p5s' },
    ]
    expect(() => assertLaunchFloor(bad, rates)).toThrow(/地板/)
    // 无 costRateId 条目跳过地板（4s 档 / legacy-equivalent 的既有出口）
    const skipped: PlannedEntry[] = [
      { matchKey: 'video:minimax-h3:768p:4:-:ri0:rv0', capability: 'video', credits: 1, basis: 'launch-reprice', costRateId: null },
    ]
    expect(() => assertLaunchFloor(skipped, rates)).not.toThrow()
  })
})
