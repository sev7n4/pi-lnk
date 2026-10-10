import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STUDIO_MODEL_CATALOG, resolveModelKey as resolveModelKeyConstant } from '@lnkpi/shared'
import {
  MODEL_CATALOG_CACHE_TTL_MS,
  loadModelCatalogRows,
  modelCatalogRowToEntry,
  refreshModelCatalogCache,
  resolveModelKey,
  seedModelCatalogEntries,
  __expireModelCatalogCacheForTests,
  __modelCatalogRefreshInFlightForTests,
  __registerModelCatalogPrismaForTests,
  __resetModelCatalogStoreForTests,
  type ModelCatalogEntryRow,
} from './model-catalog-store'

/**
 * S2-1a server 端包装器单测（纯 mock prisma，无 DB）：
 * 行→条目校验（脏行跳过）、种子 insert-if-absent（软删行算存在）、
 * 软删过滤装载、5s TTL 惰性刷新、同签名 resolve 与常量版逐 case 对拍。
 * A1 播种幂等的真 DB 验证见 model-catalog.sqlite.integration.test.ts。
 */

function makeRow(overrides: Partial<ModelCatalogEntryRow> = {}): ModelCatalogEntryRow {
  const seed = STUDIO_MODEL_CATALOG[0]!
  return {
    id: 'row-1',
    modelKey: seed.modelKey,
    displayName: seed.displayName,
    gatewayModelId: seed.gatewayModelId,
    modality: seed.modality,
    providerBinding: seed.providerBinding,
    audioKind: null,
    voices: null,
    params: JSON.stringify(seed.params),
    defaults: null,
    deletedAt: null,
    ...overrides,
  }
}

/** 最小 prisma 桩：只实现 store 用到的 modelCatalogEntry.findMany/create。 */
function makeFakePrisma(initialRows: ModelCatalogEntryRow[] = []) {
  const state = { rows: [...initialRows], created: [] as Record<string, unknown>[] }
  const prisma = {
    modelCatalogEntry: {
      findMany: vi.fn(async (args?: { where?: { deletedAt?: null }; select?: unknown }) => {
        let out = state.rows
        if (args?.where && 'deletedAt' in args.where && args.where.deletedAt === null) {
          out = out.filter((r) => (r as { deletedAt?: unknown }).deletedAt == null)
        }
        return out.map((r) => ({ ...r }))
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `cuid-${state.created.length + 1}`, ...data }
        state.rows.push(row as ModelCatalogEntryRow)
        state.created.push(data)
        return row
      }),
    },
  }
  return { prisma, state }
}

describe('modelCatalogRowToEntry（行 → 条目校验）', () => {
  it('合法行完整还原（audioKind/voices/defaults 可选字段 roundtrip）', () => {
    const seed = STUDIO_MODEL_CATALOG.find((e) => e.modelKey === 'seed-audio-1.0')!
    const row = makeRow({
      modelKey: seed.modelKey,
      displayName: seed.displayName,
      gatewayModelId: seed.gatewayModelId,
      modality: seed.modality,
      providerBinding: seed.providerBinding,
      audioKind: seed.audioKind ?? null,
      voices: JSON.stringify(seed.voices ?? null),
      params: JSON.stringify(seed.params),
      defaults: JSON.stringify(seed.defaults ?? null),
    })
    expect(modelCatalogRowToEntry(row)).toEqual(seed)
  })

  it('脏行跳过：非法 modality / providerBinding / params 或 voices JSON 损坏 → null', () => {
    expect(modelCatalogRowToEntry(makeRow({ modality: '3d' }))).toBeNull()
    expect(modelCatalogRowToEntry(makeRow({ providerBinding: 'grpc' }))).toBeNull()
    expect(modelCatalogRowToEntry(makeRow({ params: '{not-json' }))).toBeNull()
    expect(modelCatalogRowToEntry(makeRow({ params: '["array"]' }))).toBeNull()
    expect(modelCatalogRowToEntry(makeRow({ voices: '{broken' }))).toBeNull()
    expect(modelCatalogRowToEntry(makeRow({ defaults: '[1,2]' }))).toBeNull()
  })
})

describe('seedModelCatalogEntries（insert-if-absent，只插不改）', () => {
  beforeEach(() => __resetModelCatalogStoreForTests())

  it('空库首播 25 条；二次播种 0 条（幂等，create 不再被调用）', async () => {
    const { prisma, state } = makeFakePrisma()
    expect(await seedModelCatalogEntries(prisma)).toBe(25)
    expect(state.created).toHaveLength(25)
    expect(await seedModelCatalogEntries(prisma)).toBe(0)
    expect(state.created).toHaveLength(25)
  })

  it('存在即跳过：人工改过 displayName 的行不被覆盖；软删行算存在（下架不复活）', async () => {
    const { prisma, state } = makeFakePrisma([
      makeRow({ modelKey: 'image2', displayName: '人工改名', params: JSON.stringify({ model: 'native' }) }),
      makeRow({ modelKey: 'navo-pro', deletedAt: new Date() }),
    ])
    const inserted = await seedModelCatalogEntries(prisma)
    expect(inserted).toBe(23)
    // 两条已存在（含软删）都不重插
    expect(state.created.find((d) => d.modelKey === 'image2')).toBeUndefined()
    expect(state.created.find((d) => d.modelKey === 'navo-pro')).toBeUndefined()
    // 人工改名仍在（未 UPDATE）
    const image2 = state.rows.find((r) => r.modelKey === 'image2')
    expect(image2?.displayName).toBe('人工改名')
  })
})

describe('loadModelCatalogRows（软删过滤 + 排序）', () => {
  beforeEach(() => __resetModelCatalogStoreForTests())

  it('软删行被过滤；合法行全量还原；params JSON 正确解析', async () => {
    const rows = STUDIO_MODEL_CATALOG.map((e, i) =>
      makeRow({
        id: `row-${i}`,
        modelKey: e.modelKey,
        displayName: e.displayName,
        gatewayModelId: e.gatewayModelId,
        modality: e.modality,
        providerBinding: e.providerBinding,
        audioKind: e.audioKind ?? null,
        voices: e.voices ? JSON.stringify(e.voices) : null,
        params: JSON.stringify(e.params),
        defaults: e.defaults ? JSON.stringify(e.defaults) : null,
      }),
    )
    rows[3]!.deletedAt = new Date()
    const { prisma } = makeFakePrisma(rows)
    const entries = await loadModelCatalogRows(prisma as never)
    expect(entries).toHaveLength(24)
    expect(entries.find((e) => e.modelKey === STUDIO_MODEL_CATALOG[3]!.modelKey)).toBeUndefined()
  })
})

describe('resolveModelKey（server 包装器：TTL 惰性刷新 + 同签名对拍）', () => {
  beforeEach(() => __resetModelCatalogStoreForTests())

  it('未注册 prisma（bootstrap 前）→ 回落种子常量，与 shared 常量版逐 case 一致', () => {
    expect(resolveModelKey('video', 'doubao-seedance-2.0-mini')).toEqual(
      resolveModelKeyConstant('video', 'doubao-seedance-2.0-mini'),
    )
    expect(resolveModelKey('image', 'not-a-real-model').fallback).toBe(true)
    expect(resolveModelKey('image', 'not-a-real-model').modelKey).toBe(
      resolveModelKeyConstant('image', 'not-a-real-model').modelKey,
    )
  })

  it('播种装载后新条目可解析（DB 是唯一真源）；缓存 TTL 过期后惰性刷新生效', async () => {
    const { prisma, state } = makeFakePrisma()
    __registerModelCatalogPrismaForTests(prisma as never)
    await refreshModelCatalogCache(prisma as never)
    // 常量内条目经 DB 路径解析结果与常量版一致
    expect(resolveModelKey('video', 'doubao-seedance-2.0-mini')).toEqual(
      resolveModelKeyConstant('video', 'doubao-seedance-2.0-mini'),
    )
    const findManyCalls = prisma.modelCatalogEntry.findMany.mock.calls.length

    // TTL 内调用不触发刷新
    resolveModelKey('image', 'image2')
    expect(prisma.modelCatalogEntry.findMany.mock.calls.length).toBe(findManyCalls)
    expect(MODEL_CATALOG_CACHE_TTL_MS).toBe(5_000)

    // DB 新增条目（模拟后台写入）→ TTL 过期后下一次 resolve 触发刷新并可见
    state.rows.push(
      makeRow({
        id: 'row-admin',
        modelKey: 'agnes-2.5-flash',
        displayName: 'Agnes 2.5 Flash',
        gatewayModelId: 'agnes-2.5-flash',
        modality: 'text',
        params: JSON.stringify({ model: 'native' }),
      }),
    )
    __expireModelCatalogCacheForTests()
    const pending = __modelCatalogRefreshInFlightForTests()
    expect(pending).toBeNull()
    resolveModelKey('text', 'agnes-2.5-flash') // 同步返回旧值，异步触发刷新
    await __modelCatalogRefreshInFlightForTests()
    const r = resolveModelKey('text', 'agnes-2.5-flash')
    expect(r.fallback).toBe(false)
    expect(r.modelKey).toBe('agnes-2.5-flash')
  })

  it('刷新失败吞掉保旧值（不阻塞、不抛出，与 upstream-probe 非阻塞惯例一致）', async () => {
    const broken = {
      modelCatalogEntry: {
        findMany: vi.fn(async () => {
          throw new Error('db down')
        }),
        create: vi.fn(async () => ({})),
      },
    }
    __registerModelCatalogPrismaForTests(broken as never)
    await refreshModelCatalogCache(broken as never).catch(() => {})
    __expireModelCatalogCacheForTests()
    expect(() => resolveModelKey('image', 'image2')).not.toThrow()
    await __modelCatalogRefreshInFlightForTests()
    // 旧缓存仍可用（常量层条目照常命中）
    expect(resolveModelKey('image', 'image2').fallback).toBe(false)
  })
})
