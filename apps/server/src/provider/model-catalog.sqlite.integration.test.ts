import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  STUDIO_MODEL_CATALOG,
  resolveModelKey,
  type StudioModality,
} from '@lnkpi/shared'
import {
  loadModelCatalogRows,
  refreshModelCatalogCache,
  resolveModelKey as resolveModelKeyServer,
  seedModelCatalogEntries,
  __registerModelCatalogPrismaForTests,
  __resetModelCatalogStoreForTests,
} from './model-catalog-store'

/**
 * S2-1a A1 集成测试（临时 SQLite + prisma db push，真实表结构；B1
 * model-health.sqlite.integration.test.ts 同款 harness）：
 * - 播种幂等：连续两次 bootstrap，行数不变、无重复 modelKey、第二次新插 0 条；
 * - 种子只插不改：人工改动 / 后台新增条目不被覆盖；
 * - 软删行算存在：下架条目不因重启复活，且装载被过滤；
 * - 双层对拍：DB 装载 rows 经 resolveModelKeyFromRows 解析 ≡ 常量版 resolveModelKey。
 */

const serverRoot = path.resolve(__dirname, '../..')

describe('ModelCatalogEntry 播种幂等 + DB 路径对拍（S2-1a A1）', () => {
  let dir: string
  let prisma: PrismaClient

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-catalog-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  })

  afterAll(async () => {
    __resetModelCatalogStoreForTests()
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  it('A1：空库首播 25 条，二次播种行数不变、无重复 modelKey、新插 0 条', async () => {
    expect(await seedModelCatalogEntries(prisma)).toBe(25)
    expect(await seedModelCatalogEntries(prisma)).toBe(0)
    const rows = await prisma.modelCatalogEntry.findMany()
    expect(rows).toHaveLength(25)
    const keys = rows.map((r) => r.modelKey)
    expect(new Set(keys).size).toBe(25)
    // 内容逐条与种子常量一致（insert-only 的直接后果）
    for (const entry of STUDIO_MODEL_CATALOG) {
      const row = rows.find((r) => r.modelKey === entry.modelKey)
      expect(row, entry.modelKey).toBeDefined()
      expect(row!.displayName).toBe(entry.displayName)
      expect(row!.gatewayModelId).toBe(entry.gatewayModelId)
      expect(row!.modality).toBe(entry.modality)
      expect(row!.providerBinding).toBe(entry.providerBinding)
      expect(JSON.parse(row!.params)).toEqual(entry.params)
    }
  })

  it('种子只插不改：人工改 displayName / 后台新增条目，重播后原样存活', async () => {
    // ⚠️ 选 midjourney-8.1 做人工改动样本：后续「双层对拍」用例要求 DB 与常量逐条一致，
    // 不能污染任何参与对拍的条目（displayName 是对拍字段之一）。
    await prisma.modelCatalogEntry.update({
      where: { modelKey: 'midjourney-8.1' },
      data: { displayName: '人工改名-不覆盖' },
    })
    await prisma.modelCatalogEntry.create({
      data: {
        modelKey: 'admin-added-model',
        displayName: '后台新增',
        gatewayModelId: 'admin-added-model',
        modality: 'text',
        providerBinding: 'gateway-openai-compat',
        params: JSON.stringify({ model: 'native' }),
      },
    })
    expect(await seedModelCatalogEntries(prisma)).toBe(0)
    const kept = await prisma.modelCatalogEntry.findUnique({ where: { modelKey: 'midjourney-8.1' } })
    expect(kept!.displayName).toBe('人工改名-不覆盖')
    expect(await prisma.modelCatalogEntry.findUnique({ where: { modelKey: 'admin-added-model' } })).not.toBeNull()
  })

  it('软删行算存在：下架条目重播不复活，装载（软删过滤）不可见', async () => {
    await prisma.modelCatalogEntry.update({
      where: { modelKey: 'navo-pro' },
      data: { deletedAt: new Date() },
    })
    expect(await seedModelCatalogEntries(prisma)).toBe(0)
    const row = await prisma.modelCatalogEntry.findUnique({ where: { modelKey: 'navo-pro' } })
    expect(row!.deletedAt).not.toBeNull() // 未被复活
    const entries = await loadModelCatalogRows(prisma)
    expect(entries.find((e) => e.modelKey === 'navo-pro')).toBeUndefined() // 装载被过滤
  })

  it('双层对拍：DB 装载 rows 解析 ≡ 常量版 resolveModelKey（25 条 × modelKey/gatewayId/未知/默认）', async () => {
    const rows = await loadModelCatalogRows(prisma)
    // 25 条种子 - 1 软删（navo-pro，上一用例留下）+ 1 后台新增（admin-added-model）= 25
    expect(rows).toHaveLength(25)
    expect(rows.find((e) => e.modelKey === 'navo-pro')).toBeUndefined()
    expect(rows.find((e) => e.modelKey === 'admin-added-model')).toBeDefined()
    for (const entry of STUDIO_MODEL_CATALOG) {
      const modality = entry.modality as StudioModality
      expect(resolveModelKey(modality, entry.modelKey)).toEqual(
        resolveModelKeyServer(modality, entry.modelKey),
      )
      expect(resolveModelKey(modality, entry.gatewayModelId)).toEqual(
        resolveModelKeyServer(modality, entry.gatewayModelId),
      )
    }
    for (const modality of ['text', 'image', 'video', 'audio'] as const) {
      expect(resolveModelKey(modality, undefined)).toEqual(resolveModelKeyServer(modality, undefined))
      expect(resolveModelKey(modality, 'no-such-model')).toEqual(resolveModelKeyServer(modality, 'no-such-model'))
    }
  })

  it('server 包装器端到端：注册 prisma + bootstrap 后，DB 行进入缓存参与解析', async () => {
    __registerModelCatalogPrismaForTests(prisma)
    await refreshModelCatalogCache(prisma)
    const r = resolveModelKeyServer('video', 'doubao-seedance-2.0-mini')
    expect(r.fallback).toBe(false)
    expect(r.modelKey).toBe('seedance-2.0-min')
    expect(r.entry.params.generateAudio).toBe('native')
    // 常量内条目经 DB 路径与常量版结果一致
    expect(resolveModelKeyServer('image', 'image2')).toEqual(resolveModelKey('image', 'image2'))
    // 软删的 navo-pro 不可见（缓存已过滤）
    expect(resolveModelKeyServer('image', 'navo-pro').fallback).toBe(true)
  })
})
