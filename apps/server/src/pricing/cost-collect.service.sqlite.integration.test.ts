// apps/server/src/pricing/cost-collect.service.sqlite.integration.test.ts
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PrismaService } from '../prisma/prisma.service'
import { CostCollectService, type CollectFetchResponse } from './cost-collect.service'
import { resolveUnitCost } from './pricing-unit-cost'

/**
 * 采集服务落库路径集成测试（临时 SQLite，S2-1b 同款 harness）：
 * - dryRun=true 绝不写库；dryRun=false 落 official_list 行（含 D1 显式 0 价）；
 * - manual / channel_actual 生效行不被覆盖（R2 人工优先）；
 * - 视频 per_second 落库顺带退役同族 legacy per_video 行；
 * - 无路由/无适配器模型进 uncovered；写完后引擎对 0 价主体可解析（免费模型出价）。
 */

const serverRoot = path.resolve(__dirname, '../..')

const ZHIPU_KEY = 'cogvideox-flash'
const FAL_KEY = 'h3-max'
const STEP_KEY = 'step-tts-mini'
const AGNES_KEY = 'agnes-video-2.5-flash'

const FAL_PAGE = 'Video costs <b>$0.05</b> per second at <b>480p</b>, <b>$0.08</b> per second at <b>768p</b> and <b>$0.32</b> per second at <b>2K</b>.'

function fakeFetch(url: string): Promise<CollectFetchResponse> {
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(url.includes('fal.ai') ? FAL_PAGE : 'unrelated') })
}

describe('CostCollectService（采集落库 sqlite 集成）', () => {
  let dir: string
  let prisma: PrismaClient
  let svc: CostCollectService

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-cost-collect-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    svc = new CostCollectService(prisma as unknown as PrismaService, fakeFetch)
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await prisma.costRate.deleteMany()
    await prisma.modelCatalogEntry.deleteMany()
    await prisma.upstreamRoute.deleteMany()
    await prisma.modelCatalogEntry.createMany({
      data: [
        { modelKey: ZHIPU_KEY, displayName: '智谱视频', gatewayModelId: 'cogvideox-flash', modality: 'video', providerBinding: 'zhipu-http', params: '{}' },
        { modelKey: FAL_KEY, displayName: 'fal视频', gatewayModelId: 'minimax/h3-max', modality: 'video', providerBinding: 'fal-http', params: '{}' },
        { modelKey: STEP_KEY, displayName: '阶跃TTS', gatewayModelId: STEP_KEY, modality: 'audio', audioKind: 'voice', providerBinding: 'gateway-openai-compat', params: '{}' },
        { modelKey: AGNES_KEY, displayName: 'agnes视频', gatewayModelId: AGNES_KEY, modality: 'video', providerBinding: 'gateway-openai-compat', params: '{}' },
      ],
    })
    await prisma.upstreamRoute.createMany({
      data: [
        { matchType: 'default', pattern: null, capability: '*', upstream: 'agnes_hub', priority: 0, enabled: true },
        { matchType: 'prefix', pattern: 'cogvideox-', capability: '*', upstream: 'zhipu', priority: 10, enabled: true },
        { matchType: 'regex', pattern: 'h3-max', capability: '*', upstream: 'fal', priority: 40, enabled: true },
        { matchType: 'prefix', pattern: 'step', capability: '*', upstream: 'stepfun', priority: 20, enabled: true },
      ],
    })
  })

  it('dryRun=true 只产出预览，绝不写库；agnes 进 uncovered', async () => {
    const rep = await svc.run({ dryRun: true })
    expect(rep.dryRun).toBe(true)
    expect(rep.written).toBe(0)
    const ups = rep.adapters.map((a) => a.upstream)
    expect(ups).toEqual(expect.arrayContaining(['zhipu', 'fal', 'stepfun']))
    expect(rep.uncovered).toEqual([{ upstream: 'agnes_hub', modelKeys: [AGNES_KEY] }])
    const zhipu = rep.adapters.find((a) => a.upstream === 'zhipu')!
    expect(zhipu.candidates).toHaveLength(3)
    expect(zhipu.candidates.every((c) => c.costYuan === 0)).toBe(true)
    const fal = rep.adapters.find((a) => a.upstream === 'fal')!
    expect(fal.candidates.map((c) => c.costYuan)).toEqual(expect.arrayContaining([0.3575, 0.572, 2.288]))
    const step = rep.adapters.find((a) => a.upstream === 'stepfun')!
    expect(step.candidates[0]!.costYuan).toBe(0.009)
    expect(await prisma.costRate.count()).toBe(0)
  })

  it('dryRun=false 落库：0 价 official_list 行生效、引擎可解析免费主体；legacy per_video 退役', async () => {
    await prisma.costRate.create({
      data: { channel: 'platform', modelKey: ZHIPU_KEY, spec: '480p:5s', unit: 'per_video', unitQuantity: 1, costYuan: 0.1, source: 'official_list', provisional: false },
    })
    const rep = await svc.run({ dryRun: false })
    expect(rep.written).toBeGreaterThan(0)
    const zero = await prisma.costRate.findFirst({ where: { modelKey: ZHIPU_KEY, spec: '480p', unit: 'per_second' } })
    expect(zero).not.toBeNull()
    expect(zero!.costYuan).toBe(0)
    expect(zero!.source).toBe('official_list')
    expect(zero!.provisional).toBe(false)
    // legacy per_video 已退役（effectiveTo 非空）
    const legacy = await prisma.costRate.findFirst({ where: { modelKey: ZHIPU_KEY, spec: '480p:5s' } })
    expect(legacy!.effectiveTo).not.toBeNull()
    // 引擎：免费主体（D1 显式 0 价）可解析
    const c = resolveUnitCost(
      { capability: 'video', modelKey: ZHIPU_KEY, spec: '480p:5s', upstream: 'zhipu', billableUnit: 'video_call', unitsPerRequest: 1 },
      (await prisma.costRate.findMany()) as unknown as Parameters<typeof resolveUnitCost>[1],
      new Date(),
    )
    expect(c).not.toBeNull()
    expect(c!.costYuanPerRequest).toBe(0)
    // fal 直价行已落
    const fal768 = await prisma.costRate.findFirst({ where: { modelKey: FAL_KEY, spec: '768p' } })
    expect(fal768!.costYuan).toBeCloseTo(0.572, 6)
  })

  it('manual 生效行不被采集覆盖（keptManual），official_list 行可被刷新', async () => {
    await prisma.costRate.create({
      data: { channel: 'platform', modelKey: STEP_KEY, spec: 'per_100_chars', unit: 'per_call', unitQuantity: 100, costYuan: 0.5, source: 'manual', provisional: false },
    })
    await prisma.costRate.create({
      data: { channel: 'platform', modelKey: ZHIPU_KEY, spec: '480p', unit: 'per_second', unitQuantity: 1, costYuan: 0.9, source: 'official_list', provisional: false },
    })
    const rep = await svc.run({ dryRun: false })
    expect(rep.keptManual).toEqual([{ modelKey: STEP_KEY, rowSpec: 'per_100_chars' }])
    const stepRow = await prisma.costRate.findFirst({ where: { modelKey: STEP_KEY, spec: 'per_100_chars' } })
    expect(stepRow!.costYuan).toBe(0.5)
    expect(stepRow!.source).toBe('manual')
    const zRow = await prisma.costRate.findFirst({ where: { modelKey: ZHIPU_KEY, spec: '480p' } })
    expect(zRow!.costYuan).toBe(0)
    expect(zRow!.source).toBe('official_list')
  })
})
