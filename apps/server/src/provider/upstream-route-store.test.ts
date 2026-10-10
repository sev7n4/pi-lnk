import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UPSTREAM_ROUTE_SEEDS, type UpstreamRouteRow } from '@lnkpi/shared'
import {
  loadUpstreamRouteRows,
  markUpstreamRoutesBootstrapped,
  refreshUpstreamRouteCache,
  seedUpstreamRoutes,
  UpstreamRouteSeedService,
  UPSTREAM_ROUTE_CACHE_TTL_MS,
  upstreamRouteRowFromDb,
  currentUpstreamRoutes,
  whenUpstreamRoutesBootstrapped,
  __expireUpstreamRouteCacheForTests,
  __registerUpstreamRoutePrismaForTests,
  __resetUpstreamRouteStoreForTests,
  __upstreamRouteRefreshInFlightForTests,
  type UpstreamRouteDbRow,
} from './upstream-route-store'

/**
 * S2-2a server 端播种/读取包装器单测（纯 mock prisma，无 DB）：
 * 行→路由行白名单校验（脏行跳过）、种子 insert-if-absent（只插不改）、
 * 5s TTL 惰性刷新。真 DB 验证见 upstream-route.sqlite.integration.test.ts。
 */

function makeSeedRow(overrides: Partial<UpstreamRouteDbRow> = {}): UpstreamRouteDbRow {
  const seed = UPSTREAM_ROUTE_SEEDS[0]!
  return {
    id: 'row-1',
    matchType: seed.matchType,
    pattern: seed.pattern,
    capability: seed.capability,
    upstream: seed.upstream,
    priority: seed.priority,
    enabled: seed.enabled,
    fallbackApiKeyEnvName: seed.fallbackApiKeyEnvName ?? null,
    ...overrides,
  }
}

/** 最小 prisma 桩：只实现 store 用到的 upstreamRoute.findMany/create。 */
function makeFakePrisma(initialRows: UpstreamRouteDbRow[] = []) {
  const state = { rows: [...initialRows], created: [] as Record<string, unknown>[] }
  const prisma = {
    upstreamRoute: {
      findMany: vi.fn(async () => state.rows.map((r) => ({ ...r }))),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `cuid-${state.created.length + 1}`, ...data }
        state.rows.push(row as UpstreamRouteDbRow)
        state.created.push(data)
        return row
      }),
    },
  }
  return { prisma, state }
}

describe('upstreamRouteRowFromDb（行 → 路由行白名单校验）', () => {
  it('合法行完整还原（default 行 pattern=null 放行）', () => {
    const seed = UPSTREAM_ROUTE_SEEDS.find((s) => s.matchType === 'default')!
    const row = makeSeedRow({
      matchType: seed.matchType,
      pattern: null,
      capability: seed.capability,
      upstream: seed.upstream,
      priority: seed.priority,
      fallbackApiKeyEnvName: null,
    })
    expect(upstreamRouteRowFromDb(row)).toMatchObject({ matchType: 'default', upstream: 'agnes_hub' })
  })

  it('脏行跳过：非法 matchType/upstream/capability、普通行空 pattern、超长/嵌套量词 regex、NaN priority → null', () => {
    expect(upstreamRouteRowFromDb(makeSeedRow({ matchType: 'glob' }))).toBeNull()
    expect(upstreamRouteRowFromDb(makeSeedRow({ upstream: 'openrouter' }))).toBeNull()
    expect(upstreamRouteRowFromDb(makeSeedRow({ capability: 'text3d' }))).toBeNull()
    expect(upstreamRouteRowFromDb(makeSeedRow({ pattern: '   ' }))).toBeNull()
    expect(
      upstreamRouteRowFromDb(makeSeedRow({ matchType: 'regex', pattern: 'a'.repeat(999) })),
    ).toBeNull()
    expect(upstreamRouteRowFromDb(makeSeedRow({ matchType: 'regex', pattern: '(a+)+' }))).toBeNull()
    expect(upstreamRouteRowFromDb(makeSeedRow({ priority: Number.NaN }))).toBeNull()
  })
})

describe('seedUpstreamRoutes（insert-if-absent，只插不改）', () => {
  beforeEach(() => __resetUpstreamRouteStoreForTests())

  it('空库首播全部种子行；二次播种 0 条（幂等，create 不再被调用）', async () => {
    const { prisma, state } = makeFakePrisma()
    expect(await seedUpstreamRoutes(prisma as never)).toBe(UPSTREAM_ROUTE_SEEDS.length)
    expect(state.created).toHaveLength(UPSTREAM_ROUTE_SEEDS.length)
    expect(await seedUpstreamRoutes(prisma as never)).toBe(0)
    expect(state.created).toHaveLength(UPSTREAM_ROUTE_SEEDS.length)
  })

  it('存在即跳过：幂等键 (matchType,pattern,capability,upstream) 命中即跳——人工改 priority 不被覆盖', async () => {
    // 人工把 fal 行 priority 改成 999（priority 不参与幂等键，行为同「存在」）
    const { prisma, state } = makeFakePrisma([
      makeSeedRow({ id: 'row-manual', priority: 999 }),
    ])
    const inserted = await seedUpstreamRoutes(prisma as never)
    expect(inserted).toBe(UPSTREAM_ROUTE_SEEDS.length - 1)
    const manual = state.rows.find((r) => r.id === 'row-manual')
    expect(manual!.priority).toBe(999) // 人工改动存活（绝不 UPDATE）
  })
})

describe('loadUpstreamRouteRows（白名单映射 + 脏行跳过）', () => {
  beforeEach(() => __resetUpstreamRouteStoreForTests())

  it('合法行全量还原；脏行被跳过', async () => {
    const { prisma } = makeFakePrisma([
      makeSeedRow({ id: 'row-ok' }),
      makeSeedRow({ id: 'row-bad', upstream: 'openrouter' }),
    ])
    const rows = await loadUpstreamRouteRows(prisma as never)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.upstream).toBe('fal')
  })
})

describe('缓存（TTL 惰性刷新，同 T1 形态；T3b 接 routesVersion 失效）', () => {
  beforeEach(() => __resetUpstreamRouteStoreForTests())

  it('bootstrap（refreshUpstreamRouteCache）后 currentUpstreamRoutes 返回装载行', async () => {
    const { prisma } = makeFakePrisma()
    __registerUpstreamRoutePrismaForTests(prisma as never)
    await refreshUpstreamRouteCache(prisma as never)
    const rows = currentUpstreamRoutes()
    expect(rows).toHaveLength(UPSTREAM_ROUTE_SEEDS.length)
    expect(UPSTREAM_ROUTE_CACHE_TTL_MS).toBe(5_000)

    // TTL 内调用不触发刷新
    const findManyCalls = prisma.upstreamRoute.findMany.mock.calls.length
    currentUpstreamRoutes()
    expect(prisma.upstreamRoute.findMany.mock.calls.length).toBe(findManyCalls)
  })

  it('DB 新增行 → 缓存过期后下一次读取异步刷新可见（fire-and-forget）', async () => {
    const { prisma, state } = makeFakePrisma()
    __registerUpstreamRoutePrismaForTests(prisma as never)
    await refreshUpstreamRouteCache(prisma as never)
    const findManyCalls = prisma.upstreamRoute.findMany.mock.calls.length

    state.rows.push(makeSeedRow({ id: 'row-admin', matchType: 'exact', pattern: 'admin-model-x', capability: 'image', upstream: 'apimart', priority: 50 }))
    __expireUpstreamRouteCacheForTests()
    expect(__upstreamRouteRefreshInFlightForTests()).toBeNull()
    currentUpstreamRoutes() // 同步返回旧值，异步触发刷新
    await __upstreamRouteRefreshInFlightForTests()
    expect(prisma.upstreamRoute.findMany.mock.calls.length).toBeGreaterThan(findManyCalls)
    expect(currentUpstreamRoutes().find((r) => r.pattern === 'admin-model-x')).toBeDefined()
  })

  it('刷新失败吞掉保旧值（不阻塞、不抛出，与 model-catalog-store 同惯例）', async () => {
    const { prisma } = makeFakePrisma()
    __registerUpstreamRoutePrismaForTests(prisma as never)
    await refreshUpstreamRouteCache(prisma as never)
    const goodRows = currentUpstreamRoutes()
    expect(goodRows.length).toBeGreaterThan(0)

    const broken = {
      upstreamRoute: {
        findMany: vi.fn(async () => {
          throw new Error('db down')
        }),
        create: vi.fn(async () => ({})),
      },
    }
    __registerUpstreamRoutePrismaForTests(broken as never)
    __expireUpstreamRouteCacheForTests()
    expect(() => currentUpstreamRoutes()).not.toThrow()
    await __upstreamRouteRefreshInFlightForTests()
    // 刷新失败 → 旧缓存仍在（行数不变）
    expect(currentUpstreamRoutes().length).toBe(goodRows.length)
  })

  it('B3 空表保护：load 返回空数组时旧缓存保留（对称 model-catalog-store）；后续正常装载仍生效', async () => {
    // 空表保护下 cachedAt 不更新 ⇒ 每次读取都可能再链式触发一次刷新；
    // 断言前必须把在途刷新（含链式）全部等完，否则会误等到旧刷新。
    async function settleRefresh(): Promise<void> {
      for (;;) {
        const p = __upstreamRouteRefreshInFlightForTests()
        if (!p) return
        await p
      }
    }

    const { prisma, state } = makeFakePrisma()
    __registerUpstreamRoutePrismaForTests(prisma as never)
    await refreshUpstreamRouteCache(prisma as never)
    const goodRows = currentUpstreamRoutes()
    expect(goodRows).toHaveLength(UPSTREAM_ROUTE_SEEDS.length)

    // DB 瞬时读空（findMany 返回 []）：刷新后旧缓存逐条保留，绝不被空表冲掉
    const emptyPrisma = {
      upstreamRoute: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async () => ({})),
      },
    }
    __registerUpstreamRoutePrismaForTests(emptyPrisma as never)
    __expireUpstreamRouteCacheForTests()
    currentUpstreamRoutes() // 同步返回旧值，异步触发刷新
    await settleRefresh()
    expect(currentUpstreamRoutes()).toEqual(goodRows)

    // 正常装载不受保护影响：DB 重新有行 → 装载即生效（新行可见）。
    // 直调 refresh（确定性）：异步 TTL 路径已有上方用例与「DB 新增行」用例覆盖。
    __registerUpstreamRoutePrismaForTests(prisma as never)
    state.rows.push(makeSeedRow({ id: 'row-after-empty', matchType: 'exact', pattern: 'recovered-model', capability: 'text', upstream: 'stepfun', priority: 50 }))
    await refreshUpstreamRouteCache(prisma as never)
    expect(currentUpstreamRoutes().find((r) => r.pattern === 'recovered-model')).toBeDefined()
  })
})

describe('bootstrap 落定信号（B3 热修：startup 探活等待路由就绪）', () => {
  beforeEach(() => __resetUpstreamRouteStoreForTests())

  it('mark 前 pending，mark 后 resolve（成功落定）', async () => {
    let settled = false
    void whenUpstreamRoutesBootstrapped().then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(settled).toBe(false)
    markUpstreamRoutesBootstrapped()
    await whenUpstreamRoutesBootstrapped()
    expect(settled).toBe(true)
    // 重复 mark 幂等；已落定后 when 直接 resolve
    markUpstreamRoutesBootstrapped()
    await expect(whenUpstreamRoutesBootstrapped()).resolves.toBeUndefined()
  })

  it('SeedService.onModuleInit：refresh 成功 → mark 且缓存可读', async () => {
    const { prisma } = makeFakePrisma()
    new UpstreamRouteSeedService(prisma as never).onModuleInit()
    await whenUpstreamRoutesBootstrapped()
    expect(currentUpstreamRoutes()).toHaveLength(UPSTREAM_ROUTE_SEEDS.length)
  })

  it('SeedService.onModuleInit：refresh 失败也 mark（失败=落定，消费方按当前缓存自处理）', async () => {
    const broken = {
      upstreamRoute: {
        findMany: vi.fn(async () => {
          throw new Error('db down')
        }),
        create: vi.fn(async () => ({})),
      },
    }
    new UpstreamRouteSeedService(broken as never).onModuleInit()
    // 失败不悬挂：when 仍落定（失败也算落定），缓存保持空数组由消费方告警
    await expect(whenUpstreamRoutesBootstrapped()).resolves.toBeUndefined()
    expect(currentUpstreamRoutes()).toEqual([])
  })
})
