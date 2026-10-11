import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import { STUDIO_MODEL_CATALOG } from '@lnkpi/shared'
import {
  ModelCatalogAdminController,
  ModelDefaultsAdminController,
} from './model-catalog.controller'
import { PrismaService } from '../prisma/prisma.service'
import {
  refreshModelCatalogCache,
  readModelCatalogVersion,
  resolveModelKey,
  __resetModelCatalogStoreForTests,
  __resetModelCatalogVersionForTests,
} from '../provider/model-catalog-store'

/**
 * model-ops Task 1 集成测试（临时 SQLite，B1/S2-1b 同款 harness）：
 * - 部分唯一索引 `ModelCatalogEntry_live_default_per_modality`：每模态至多一个活默认
 *   （软删行不占坑）。⚠️ Prisma schema 无法表达 partial index（prd #6974）——
 *   索引由手写 migration 20261011130000 建，本测试 setup 手动执行同款 DDL
 *   模拟 `prisma migrate deploy` 后的真实状态；
 * - PUT model-defaults：切换 + 审计 + 版本 bump + X-Confirm 428；
 * - DELETE 防呆升级：DB isDefault 命中 → 409 + alternatives 非空；
 * - 软删恢复（POST 同 key）不复活 isDefault。
 */

const serverRoot = path.resolve(__dirname, '../..')

/** 与 migration 20261011130000 的 DDL 逐字节同款（drift 双写防线：测试挂 = 两处漂移）。 */
const PARTIAL_INDEX_SQL =
  'CREATE UNIQUE INDEX "ModelCatalogEntry_live_default_per_modality" ON "ModelCatalogEntry"("modality") WHERE "isDefault" = 1 AND "deletedAt" IS NULL'

function asService(prisma: PrismaClient): PrismaService {
  return prisma as unknown as PrismaService
}

function exceptionStatus(err: unknown): number | undefined {
  return (err as { status?: number } | null)?.status
}

describe('ModelDefaultsAdminController + 部分唯一索引（model-ops Task 1）', () => {
  let dir: string
  let prisma: PrismaClient
  let catalog: ModelCatalogAdminController
  let defaults: ModelDefaultsAdminController

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-model-defaults-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    // 模拟 migrate deploy：schema push 后补上 partial index（Prisma schema 无法表达）
    await prisma.$executeRawUnsafe(PARTIAL_INDEX_SQL)
    catalog = new ModelCatalogAdminController(asService(prisma))
    defaults = new ModelDefaultsAdminController(asService(prisma))
  }, 120_000)

  afterAll(async () => {
    __resetModelCatalogStoreForTests()
    __resetModelCatalogVersionForTests()
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await prisma.adminAuditLog.deleteMany()
    await prisma.modelCatalogVersion.deleteMany()
    await prisma.modelCatalogEntry.updateMany({ where: { isDefault: true }, data: { isDefault: false } })
    // 用例①会软删 agnes-2.5-flash（索引腾坑验证）——恢复所有种子行的软删，
    // 保证每个用例从「全量在架」初态出发（仅种子 modelKey，不碰其他数据）。
    await prisma.modelCatalogEntry.updateMany({
      where: { deletedAt: { not: null }, modelKey: { in: STUDIO_MODEL_CATALOG.map((e) => e.modelKey) } },
      data: { deletedAt: null },
    })
    await prisma.$executeRawUnsafe(
      `UPDATE "ModelCatalogEntry" SET "isDefault" = 1 WHERE "deletedAt" IS NULL AND "modelKey" IN ('agnes-2.5-flash','agnes-image-2.1-flash','agnes-video-2.5-flash','minimax-speech-2.8-hd')`,
    )
    __resetModelCatalogStoreForTests()
    __resetModelCatalogVersionForTests()
    await refreshModelCatalogCache(prisma)
  })

  it('回填 + 索引有效性：回填恰 4 行；同模态双活默认第二行 UPDATE 报 UNIQUE；软删行不占坑', async () => {
    const backfilled = await prisma.modelCatalogEntry.findMany({ where: { isDefault: true } })
    expect(backfilled).toHaveLength(4)
    console.log(
      '[backfill] isDefault rows =',
      backfilled.map((r) => `${r.modality}:${r.modelKey}`).join(', '),
    )
    // 双默认：text 模态再置一行活默认 → 撞 partial unique index
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "ModelCatalogEntry" SET "isDefault" = 1 WHERE "deletedAt" IS NULL AND "modelKey" = 'agnes-2.0-flash'`,
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/)
    // 软删行不占坑：软删 text 当前默认后，同模态另一行可置默认（不再撞索引）
    await prisma.modelCatalogEntry.update({
      where: { modelKey: 'agnes-2.5-flash' },
      data: { deletedAt: new Date() },
    })
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "ModelCatalogEntry" SET "isDefault" = 1 WHERE "deletedAt" IS NULL AND "modelKey" = 'agnes-2.0-flash'`,
      ),
    ).resolves.toBe(1)
  })

  it('PUT 切默认：旧默认清 false、新默认置 true、审计 + 版本 bump；resolveModelKey 消费新默认', async () => {
    const versionBefore = await readModelCatalogVersion(prisma)
    const res = await defaults.setDefault(
      { 'x-confirm': 'agnes-2.0-flash' },
      { modality: 'text', modelKey: 'agnes-2.0-flash' },
    )
    expect(res.data.previousDefault).toBe('agnes-2.5-flash')
    expect(res.data.default.modelKey).toBe('agnes-2.0-flash')
    expect(res.data.version).toBe(versionBefore + 1)
    // DB 实态
    const old = await prisma.modelCatalogEntry.findUnique({ where: { modelKey: 'agnes-2.5-flash' } })
    const neu = await prisma.modelCatalogEntry.findUnique({ where: { modelKey: 'agnes-2.0-flash' } })
    expect(old?.isDefault).toBe(false)
    expect(neu?.isDefault).toBe(true)
    // 审计
    const audit = await prisma.adminAuditLog.findFirst({ where: { action: 'model-defaults.set' } })
    expect(audit?.resource).toBe('model-defaults:text')
    expect(audit?.before).toContain('agnes-2.5-flash')
    expect(audit?.after).toContain('agnes-2.0-flash')
    // 缓存消费（resolveModelKeyFromRows fallback 链走 DB isDefault）
    expect(resolveModelKey('text', 'not-a-real-model').modelKey).toBe('agnes-2.0-flash')
  })

  it('X-Confirm：缺失/不匹配 → 428；modality 不匹配 → 400；目标不在架 → 404', async () => {
    await expect(defaults.setDefault({}, { modality: 'text', modelKey: 'agnes-2.0-flash' })).rejects.toSatisfy(
      (err: unknown) => exceptionStatus(err) === 428,
    )
    await expect(
      defaults.setDefault({ 'x-confirm': 'wrong-key' }, { modality: 'text', modelKey: 'agnes-2.0-flash' }),
    ).rejects.toSatisfy((err: unknown) => exceptionStatus(err) === 428)
    await expect(
      defaults.setDefault({ 'x-confirm': 'agnes-2.0-flash' }, { modality: 'video', modelKey: 'agnes-2.0-flash' }),
    ).rejects.toThrow(BadRequestException)
    await expect(
      defaults.setDefault({ 'x-confirm': 'no-such-model' }, { modality: 'text', modelKey: 'no-such-model' }),
    ).rejects.toThrow(NotFoundException)
  })

  it('DELETE 防呆升级：默认模型 → 409 + alternatives 非空；切走后旧默认可下架且 resolve 消费新默认', async () => {
    const old = await prisma.modelCatalogEntry.findUnique({ where: { modelKey: 'agnes-2.5-flash' } })
    expect(old).not.toBeNull()
    let conflictResponse: { alternatives?: unknown[] } | undefined
    try {
      await catalog.remove(old!.id)
      throw new Error('DELETE 默认模型应被 409 拦截（有效性断言）')
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictException)
      conflictResponse = (err as ConflictException).getResponse() as { alternatives?: unknown[] }
    }
    expect(Array.isArray(conflictResponse?.alternatives)).toBe(true)
    expect(conflictResponse?.alternatives?.length ?? 0).toBeGreaterThan(0)
    console.log('[alternatives] text 候选 =', JSON.stringify(conflictResponse?.alternatives?.map((a) => (a as { modelKey: string }).modelKey)))

    // 切默认到 agnes-2.0-flash 后，旧默认可下架
    await defaults.setDefault({ 'x-confirm': 'agnes-2.0-flash' }, { modality: 'text', modelKey: 'agnes-2.0-flash' })
    const res = await catalog.remove(old!.id)
    expect(res.data.modelKey).toBe('agnes-2.5-flash')
    const after = await prisma.modelCatalogEntry.findUnique({ where: { modelKey: 'agnes-2.5-flash' } })
    expect(after?.deletedAt).not.toBeNull()
    // 下架后 resolveModelKey 消费新默认（不在架条目不再兜底）
    expect(resolveModelKey('text', undefined).modelKey).toBe('agnes-2.0-flash')
  })

  it('软删恢复（POST 同 key）不复活 isDefault：恢复后 isDefault=false（安全侧，需显式 PUT）', async () => {
    // text 种子仅 2 条（agnes-2.0/2.5-flash）；victim 取非默认的 agnes-2.0-flash
    const victim = await prisma.modelCatalogEntry.findUnique({ where: { modelKey: 'agnes-2.0-flash' } })
    if (!victim) throw new Error('fixture 缺 agnes-2.0-flash（有效性断言失败）')
    expect(victim.isDefault).toBe(false) // 前置：非默认（默认=agnes-2.5-flash，beforeEach 回填）
    await catalog.remove(victim.id)
    await catalog.create({
      modelKey: 'agnes-2.0-flash',
      displayName: victim.displayName,
      gatewayModelId: victim.gatewayModelId,
      modality: victim.modality,
      providerBinding: victim.providerBinding,
      params: JSON.parse(victim.params),
    })
    const restored = await prisma.modelCatalogEntry.findUnique({ where: { modelKey: 'agnes-2.0-flash' } })
    expect(restored?.deletedAt).toBeNull()
    expect(restored?.isDefault).toBe(false)
  })
})
