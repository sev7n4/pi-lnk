import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ModelCatalogAdminController } from './model-catalog.controller'
import type { PrismaService } from '../prisma/prisma.service'
import { PLATFORM_CHANNEL_ID } from '../provider/provider.service'
import { refreshUpstreamRouteCache, seedUpstreamRoutes } from '../provider/upstream-route-store'
import {
  __resetModelCatalogStoreForTests,
  __resetModelCatalogVersionForTests,
} from '../provider/model-catalog-store'

const serverRoot = path.resolve(__dirname, '../..')

/**
 * 目录页【上游端点 + 链路状态】集成测试（临时 SQLite + prisma db push，catalog/health
 * 同款 harness）：GET /admin/model-catalog 的 ops 字段四源组装——
 * - availability：平台渠道镜像（name=modelKey，探活器写入形态）；
 * - 24h 流量：GenerationRecord 真聚合（buildHealthSql 原语），BYOK 前缀行必须被剔除；
 * - 端点：seedUpstreamRoutes 后 agnes-* 走 default 行 → agnes_hub，baseUrl=OPENAI_BASE_URL。
 */

const LINK_USER = 'u-link-status-redacted'

const COMPLETED_META = JSON.stringify({ chargedPoints: 20, text: 'ok' })
const FAILED_META_402 = JSON.stringify({
  errorCode: 'upstream_error',
  userMessage: 'Text API 402: insufficient balance (current: 0.01 USD, required: 0.05 USD)',
  chargedPoints: 20,
  refundedPoints: 20,
  refundReason: 'platform_failed',
})

/** 平台渠道镜像 fixture：探活器写入形态（name=modelKey + availability 三态）。 */
const MIRROR_MODELS = JSON.stringify([
  { name: 'agnes-2.5-flash', capability: 'text', availability: 'unavailable' },
  { name: 'agnes-image-2.0-flash', capability: 'image', availability: 'available' },
])

describe('GET /admin/model-catalog ops 字段（端点 + availability + 24h 流量）', () => {
  let dir: string
  let prisma: PrismaClient
  let controller: ModelCatalogAdminController
  let savedAgnesBaseUrl: string | undefined

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-catalog-link-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    controller = new ModelCatalogAdminController(prisma as unknown as PrismaService)
    savedAgnesBaseUrl = process.env.OPENAI_BASE_URL
    process.env.OPENAI_BASE_URL = 'https://apihub.agnes-ai.cn/v1'

    await prisma.user.create({ data: { id: LINK_USER, phone: '17200009998', nickname: 'link-fixture' } })
    // 手工建 3 个目录条目（不走 seedModelCatalogEntries：其写 isDefault，本地符号链接
    // 的旧 prisma client 缺该字段；CI 全新 generate 不受影响，但本地要能独立跑绿）。
    for (const e of [
      { modelKey: 'agnes-2.5-flash', displayName: 'Agnes 2.5 Flash', gatewayModelId: 'agnes-2.5-flash', modality: 'text', providerBinding: 'gateway-openai-compat', params: '{}' },
      { modelKey: 'agnes-image-2.0-flash', displayName: 'Agnes Image 2.0', gatewayModelId: 'agnes-image-2.0-flash', modality: 'image', providerBinding: 'gateway-openai-compat', params: '{}' },
      { modelKey: 'link-fixture-other', displayName: 'Link Fixture Other', gatewayModelId: 'link-fixture-other', modality: 'text', providerBinding: 'gateway-openai-compat', params: '{}' },
    ]) {
      await prisma.modelCatalogEntry.create({ data: e })
    }
    await seedUpstreamRoutes(prisma)
    await refreshUpstreamRouteCache(prisma)
    // ⛔ 不调 refreshModelCatalogCache：其内部先 seedModelCatalogEntries（写 isDefault，
    // 本地符号链接的旧 prisma client 缺该字段）；list() 直读 DB，不依赖目录缓存。
    await prisma.providerChannel.create({
      data: { id: PLATFORM_CHANNEL_ID, name: '平台渠道', apiFormat: 'openai', baseUrl: 'https://apihub.agnes-ai.cn/v1', models: MIRROR_MODELS },
    })
  }, 120_000) // prisma db push + 播种在本机 4 核 Mac 上可超默认 10s hook 超时

  afterAll(async () => {
    if (savedAgnesBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = savedAgnesBaseUrl
    __resetModelCatalogStoreForTests()
    __resetModelCatalogVersionForTests()
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    // 流量行每用例重建（beforeEach 清理会删掉 beforeAll 的播种，两者必须同处一层）
    await prisma.generationRecord.deleteMany({ where: { model: { contains: 'agnes-2.5-flash' } } })
    await seedTraffic()
  })

  async function seedTraffic() {
    const now = Date.now()
    const create = (data: Parameters<typeof prisma.generationRecord.create>[0]['data']) =>
      prisma.generationRecord.create({ data })
    // 平台 agnes-2.5-flash：2 成功 + 1 次 402 欠费
    for (let i = 0; i < 2; i++) {
      await create({
        userId: LINK_USER, type: 'text', prompt: 'prompt-redacted',
        model: 'agnes-2.5-flash', status: 'completed', metadata: COMPLETED_META,
        createdAt: new Date(now - 30 * 60_000),
      })
    }
    await create({
      userId: LINK_USER, type: 'text', prompt: 'prompt-redacted',
      model: 'agnes-2.5-flash', status: 'failed', metadata: FAILED_META_402,
      createdAt: new Date(now - 30 * 60_000),
    })
    // BYOK 前缀行：5 成功 —— 链路状态看平台侧，必须剔除
    for (let i = 0; i < 5; i++) {
      await create({
        userId: LINK_USER, type: 'text', prompt: 'prompt-redacted',
        model: `byok-user::agnes-2.5-flash`, status: 'completed', metadata: COMPLETED_META,
        createdAt: new Date(now - 30 * 60_000),
      })
    }
  }

  it('ops 四源组装：端点解析 + 镜像 availability + 平台流量（BYOK 剔除）', async () => {
    const res = await controller.list()
    const ops = (res.data as { ops: Record<string, Record<string, unknown>> }).ops
    expect(ops).not.toBeNull()

    // 在镜像 + 有流量：unavailable（探活判定红灯原料）+ 平台侧 2 成功/1 欠费
    expect(ops['agnes-2.5-flash']).toEqual({
      upstream: 'agnes_hub',
      baseUrl: 'https://apihub.agnes-ai.cn/v1',
      availability: 'unavailable',
      completed24h: 2,
      balance40224h: 1,
    })
    // 在镜像 + 无流量：available + 补零
    expect(ops['agnes-image-2.0-flash']).toMatchObject({
      upstream: 'agnes_hub',
      availability: 'available',
      completed24h: 0,
      balance40224h: 0,
    })
  })

  it('不在镜像的在架条目 → availability null；每条目都有 ops', async () => {
    const res = await controller.list()
    const { entries, ops } = res.data as { entries: { modelKey: string }[]; ops: Record<string, { availability: string | null }> }
    const live = entries.filter((e) => e.modelKey !== 'agnes-2.5-flash' && e.modelKey !== 'agnes-image-2.0-flash')
    expect(live.length).toBeGreaterThan(0)
    for (const e of live) {
      expect(ops[e.modelKey]).toBeDefined()
      expect(ops[e.modelKey]!.availability).toBeNull()
    }
  })

  it('镜像条目旧格式（无 availability 字段）→ unknown，与「不在镜像」的 null 区分', async () => {
    await prisma.providerChannel.update({
      where: { id: PLATFORM_CHANNEL_ID },
      data: { models: JSON.stringify([{ name: 'agnes-2.5-flash', capability: 'text' }]) },
    })
    try {
      const res = await controller.list()
      const ops = (res.data as { ops: Record<string, { availability: string | null }> }).ops
      expect(ops['agnes-2.5-flash']!.availability).toBe('unknown')
      expect(ops['agnes-image-2.0-flash']!.availability).toBeNull()
    } finally {
      await prisma.providerChannel.update({
        where: { id: PLATFORM_CHANNEL_ID },
        data: { models: MIRROR_MODELS },
      })
    }
  })
})
