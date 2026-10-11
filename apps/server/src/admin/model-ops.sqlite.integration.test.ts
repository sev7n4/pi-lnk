import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { UPSTREAM_ROUTE_SEEDS } from '@lnkpi/shared'
import { ModelCatalogAdminController } from './model-catalog.controller'
import { ModelDefaultsAdminController } from './model-catalog.controller'
import { ModelOpsAdminController } from './model-ops.controller'
import { UpstreamRoutesAdminController } from './upstream-routes.controller'
import { PrismaService } from '../prisma/prisma.service'
import {
  refreshModelCatalogCache,
  readModelCatalogVersion,
  __resetModelCatalogStoreForTests,
  __resetModelCatalogVersionForTests,
} from '../provider/model-catalog-store'
import {
  __resetUpstreamRouteStoreForTests,
  __setCachedUpstreamRoutesForTests,
} from '../provider/upstream-route-store'

/**
 * model-ops Task 2 集成测试（临时 SQLite，Task 1 同款 harness）：
 * - onboard：凭据 422 / 路由 409 / 成功创建（审计+bump）/ 软删复活；
 * - offboard：dryRun 缺省 true（材料披露不落库）/ 执行态 X-Confirm 428 / 软删执行 /
 *   默认模型 409；upstream-routes PUT X-Confirm 428。
 * 冒烟不发真实请求（smokeTest 缺省 false）；runOnboardSmoke 的单测在 model-ops-shared.test.ts。
 */

const serverRoot = path.resolve(__dirname, '../..')

function asService(prisma: PrismaClient): PrismaService {
  return prisma as unknown as PrismaService
}

function exceptionStatus(err: unknown): number | undefined {
  return (err as { status?: number } | null)?.status
}

function exceptionSteps(err: unknown): Record<string, unknown> | undefined {
  return (err as { response?: { steps?: Record<string, unknown> } } | null)?.response?.steps
}

const ONBOARD_BODY = {
  modelKey: 'ops-onboard-model',
  displayName: 'Ops Onboard Model',
  gatewayModelId: 'ops-onboard-gateway-id',
  modality: 'text',
  providerBinding: 'gateway-openai-compat',
  upstream: 'agnes_hub',
  params: { model: 'native' },
}

describe('ModelOpsAdminController onboard/offboard（model-ops Task 2）', () => {
  let dir: string
  let prisma: PrismaClient
  let ops: ModelOpsAdminController
  let catalog: ModelCatalogAdminController
  let defaults: ModelDefaultsAdminController
  let routesController: UpstreamRoutesAdminController
  const savedEnv = { ...process.env }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-model-ops-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    // 模拟 migrate deploy 后状态（partial index 不在 Prisma schema 表达面）
    await prisma.$executeRawUnsafe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "ModelCatalogEntry_live_default_per_modality" ON "ModelCatalogEntry"("modality") WHERE "isDefault" = 1 AND "deletedAt" IS NULL',
    )
    ops = new ModelOpsAdminController(asService(prisma))
    catalog = new ModelCatalogAdminController(asService(prisma))
    defaults = new ModelDefaultsAdminController(asService(prisma))
    routesController = new UpstreamRoutesAdminController(asService(prisma))
  }, 120_000)

  afterAll(async () => {
    process.env = savedEnv
    __resetModelCatalogStoreForTests()
    __resetModelCatalogVersionForTests()
    __resetUpstreamRouteStoreForTests()
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    process.env = { ...savedEnv }
    delete process.env.OPENAI_API_KEY
    await prisma.adminAuditLog.deleteMany()
    await prisma.modelCatalogVersion.deleteMany()
    await prisma.modelCatalogEntry.deleteMany({ where: { modelKey: ONBOARD_BODY.modelKey } })
    // 路由种子注入（探活测试同款：不注册 store prisma ⇒ 缓存即测试注入值）；
    // 附加 onboard fixture 的 exact 行（ops-onboard-model → agnes_hub）
    __resetUpstreamRouteStoreForTests()
    __setCachedUpstreamRoutesForTests([
      ...UPSTREAM_ROUTE_SEEDS,
      {
        id: 'seed-test-onboard',
        matchType: 'exact',
        pattern: 'ops-onboard-model',
        capability: 'text',
        upstream: 'agnes_hub',
        priority: 100,
        enabled: true,
        fallbackApiKeyEnvName: null,
      },
    ])
    __resetModelCatalogStoreForTests()
    __resetModelCatalogVersionForTests()
    await refreshModelCatalogCache(prisma)
  })

  it('onboard step1 凭据缺失 → 422 + steps.credential.failed（附 env 名）', async () => {
    // OPENAI_API_KEY 已在 beforeEach 删除（agnes_hub 唯一 key env，无 fallback）
    const err = await ops.onboard({}, { ...ONBOARD_BODY }).catch((e) => e)
    expect(exceptionStatus(err)).toBe(422)
    const steps = exceptionSteps(err)
    expect(steps?.credential?.status).toBe('failed')
    expect(String(steps?.credential?.detail)).toContain('OPENAI_API_KEY')
    // 目录未写
    const count = await prisma.modelCatalogEntry.count({ where: { modelKey: ONBOARD_BODY.modelKey } })
    expect(count).toBe(0)
  })

  it('onboard step2 路由未命中 → 409 + steps.route.failed（提示加路由行，不隐式创建）', async () => {
    process.env.OPENAI_API_KEY = 'k-test'
    // 注入无 default 行的路由集（种子含 default 兜底行，会接棒任何未命中条目）
    __setCachedUpstreamRoutesForTests([
      ...UPSTREAM_ROUTE_SEEDS.filter((r) => r.matchType !== 'default'),
      {
        id: 'seed-test-onboard',
        matchType: 'exact',
        pattern: 'ops-onboard-model',
        capability: 'text',
        upstream: 'agnes_hub',
        priority: 100,
        enabled: true,
        fallbackApiKeyEnvName: null,
      },
    ])
    const err = await ops
      .onboard({}, { ...ONBOARD_BODY, modelKey: 'no-route-model-x', gatewayModelId: 'no-route-model-x' })
      .catch((e) => e)
    expect(exceptionStatus(err)).toBe(409)
    const steps = exceptionSteps(err)
    expect(steps?.route?.status).toBe('failed')
    expect(String(steps?.route?.detail)).toContain('路由')
  })

  it('onboard 成功路径：条目创建 + 审计 model-ops.onboard + 版本 bump + steps 全披露（smoke skipped）', async () => {
    process.env.OPENAI_API_KEY = 'k-test'
    const versionBefore = await readModelCatalogVersion(prisma)
    const res = await ops.onboard({}, { ...ONBOARD_BODY })
    expect(res.data.entry.modelKey).toBe(ONBOARD_BODY.modelKey)
    expect(res.data.version).toBe(versionBefore + 1)
    expect(res.data.steps.credential.status).toBe('ok')
    expect(res.data.steps.route.status).toBe('ok')
    expect(res.data.steps.smoke.status).toBe('skipped')
    expect(res.data.steps.catalog.status).toBe('ok')
    const row = await prisma.modelCatalogEntry.findUnique({ where: { modelKey: ONBOARD_BODY.modelKey } })
    expect(row?.deletedAt).toBeNull()
    expect(row?.isDefault).toBe(false)
    const audit = await prisma.adminAuditLog.findFirst({ where: { action: 'model-ops.onboard' } })
    expect(audit?.resource).toBe(`model-catalog:${ONBOARD_BODY.modelKey}`)
  })

  it('onboard 复活软删行：offboard 后同 key onboard → deletedAt 清空（isDefault 不复活）', async () => {
    process.env.OPENAI_API_KEY = 'k-test'
    await ops.onboard({}, { ...ONBOARD_BODY })
    await ops.offboard({ 'x-confirm': ONBOARD_BODY.modelKey }, { modelKey: ONBOARD_BODY.modelKey, dryRun: false })
    const off = await prisma.modelCatalogEntry.findUnique({ where: { modelKey: ONBOARD_BODY.modelKey } })
    expect(off?.deletedAt).not.toBeNull()

    await ops.onboard({}, { ...ONBOARD_BODY })
    const back = await prisma.modelCatalogEntry.findUnique({ where: { modelKey: ONBOARD_BODY.modelKey } })
    expect(back?.deletedAt).toBeNull()
    expect(back?.isDefault).toBe(false)
    const audits = await prisma.adminAuditLog.findMany({ where: { action: { in: ['model-ops.onboard', 'model-ops.offboard'] } } })
    expect(audits.length).toBeGreaterThanOrEqual(3)
  })

  it('offboard dryRun 缺省 true：材料披露（isDefault/alternatives/traffic/routeImpact）且不落库', async () => {
    process.env.OPENAI_API_KEY = 'k-test'
    await ops.onboard({}, { ...ONBOARD_BODY })
    const res = await ops.offboard({}, { modelKey: ONBOARD_BODY.modelKey })
    expect(res.data.dryRun).toBe(true)
    expect(res.data.isDefault).toBe(false)
    expect(Array.isArray(res.data.alternatives)).toBe(true)
    expect(res.data.alternatives.length).toBeGreaterThan(0)
    expect(Array.isArray(res.data.routeImpact)).toBe(true)
    expect(res.data.traffic ?? null).toBeNull() // 无流量记录 → null（初态）
    const row = await prisma.modelCatalogEntry.findUnique({ where: { modelKey: ONBOARD_BODY.modelKey } })
    expect(row?.deletedAt).toBeNull()
  })

  it('offboard 执行态：无 X-Confirm → 428；带 X-Confirm → 软删 + 审计 + bump + 路由提示', async () => {
    process.env.OPENAI_API_KEY = 'k-test'
    await ops.onboard({}, { ...ONBOARD_BODY })
    await expect(
      ops.offboard({}, { modelKey: ONBOARD_BODY.modelKey, dryRun: false }),
    ).rejects.toSatisfy((err: unknown) => exceptionStatus(err) === 428)

    const versionBefore = await readModelCatalogVersion(prisma)
    const res = await ops.offboard(
      { 'x-confirm': ONBOARD_BODY.modelKey },
      { modelKey: ONBOARD_BODY.modelKey, dryRun: false, reason: '测试下架' },
    )
    expect(res.data.offboarded).toBe(true)
    expect(res.data.version).toBe(versionBefore + 1)
    const row = await prisma.modelCatalogEntry.findUnique({ where: { modelKey: ONBOARD_BODY.modelKey } })
    expect(row?.deletedAt).not.toBeNull()
    const audit = await prisma.adminAuditLog.findFirst({ where: { action: 'model-ops.offboard' } })
    expect(audit?.after).toContain('测试下架')
  })

  it('offboard 默认模型执行态 → 409 + alternatives；upstream-routes PUT 无 X-Confirm → 428', async () => {
    // text 默认 = agnes-2.5-flash（回填）；offboard 执行态 → 409
    await expect(
      ops.offboard({ 'x-confirm': 'agnes-2.5-flash' }, { modelKey: 'agnes-2.5-flash', dryRun: false }),
    ).rejects.toSatisfy((err: unknown) => {
      const conflict = err as ConflictException
      const resp = conflict?.getResponse?.() as { alternatives?: unknown[] } | undefined
      return exceptionStatus(err) === 409 && Array.isArray(resp?.alternatives) && resp!.alternatives!.length > 0
    })
    // offboard dryRun 对默认模型也返回 isDefault=true 的材料（不抛错）
    const dry = await ops.offboard({}, { modelKey: 'agnes-2.5-flash' })
    expect(dry.data.isDefault).toBe(true)

    // upstream-routes PUT：无/错 X-Confirm → 428（路由表由种子播种于服务启动，
    // 集成测试库未跑播种 → 直接造一行）
    const routeRow = await prisma.upstreamRoute.create({
      data: {
        id: 'route-xconfirm-test',
        matchType: 'exact',
        pattern: 'xconfirm-route-model',
        capability: 'text',
        upstream: 'agnes_hub',
        priority: 100,
        enabled: true,
        fallbackApiKeyEnvName: null,
      },
    })
    await expect(routesController.update({}, routeRow.id, { enabled: false })).rejects.toSatisfy(
      (err: unknown) => exceptionStatus(err) === 428,
    )
    await expect(routesController.update({ 'x-confirm': 'wrong' }, routeRow.id, { enabled: false })).rejects.toSatisfy(
      (err: unknown) => exceptionStatus(err) === 428,
    )
    // 正确 X-Confirm → 翻转成功 + 审计
    const put = await routesController.update({ 'x-confirm': routeRow.id }, routeRow.id, { enabled: false })
    expect(put.data.route.enabled).toBe(false)
  })

  it('offboard 不存在的条目 → 404（dryRun 与执行态同形）', async () => {
    await expect(ops.offboard({}, { modelKey: 'no-such-model-zz' })).rejects.toThrow(NotFoundException)
    await expect(
      ops.offboard({ 'x-confirm': 'no-such-model-zz' }, { modelKey: 'no-such-model-zz', dryRun: false }),
    ).rejects.toThrow(NotFoundException)
  })
})
