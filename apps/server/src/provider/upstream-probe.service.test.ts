import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import {
  resolveUpstreamRoute,
  STUDIO_MODEL_CATALOG,
  UPSTREAM_ROUTE_SEEDS,
} from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'
import {
  __resetUpstreamRouteStoreForTests,
  __setCachedUpstreamRoutesForTests,
  markUpstreamRoutesBootstrapped,
} from './upstream-route-store'
import {
  DEFAULT_PROBE_INTERVAL_MINUTES,
  groupCatalogEntriesByUpstream,
  resolveProbeIntervalMinutes,
  toReconciliationUpstreamId,
  UPSTREAM_PROBE_FETCH,
  UpstreamProbeService,
  type ProbeCatalogEntry,
  type ProbeFetchResponse,
} from './upstream-probe.service'

/**
 * agnes 帧对账清单（S2-2b 起与探活分组**同源**）：按路由种子表判定归属 agnes_hub 的
 * 目录条目（包含 step/minimax-h3/h3-max/apimart-image 名单之外的一切 —— 注意这比旧
 * 硬编码探活映射宽：seedance/wan/minimax-speech 等在 resolver 链里本就落 agnes hub，
 * 旧映射把它们错探到 apimart/minimax，S2-2b 消除第二套映射后归位）。
 * 假上游返回「全量 agnes 清单 − 指定模型」⇒ ghost 集恰好 = 被摘掉的那个模型。
 */
const AGNES_IDS = STUDIO_MODEL_CATALOG.filter(
  (entry) =>
    resolveUpstreamRoute([...UPSTREAM_ROUTE_SEEDS], entry.modelKey, entry.modality).upstream ===
    'agnes_hub',
).map((entry) => entry.gatewayModelId)

const GHOST_MODEL = 'agnes-image-2.0-flash'
const MATCHED_MODEL = 'agnes-2.0-flash'

/** 平台渠道镜像 fixture（新格式：显式 availability）。 */
const FIXTURE_MODELS = [
  { name: MATCHED_MODEL, capability: 'text', availability: 'unknown' },
  { name: GHOST_MODEL, capability: 'image', availability: 'unknown' },
]

/** 旧格式 fixture（A5：无 availability 字段）。 */
const LEGACY_MODELS = [
  { name: MATCHED_MODEL, capability: 'text' },
  { name: GHOST_MODEL, capability: 'image' },
]

interface StoredRun {
  id: string
  ranAt: Date
  upstream: string
  httpStatus: number | null
  modelCount: number | null
  ghosts: string | null
  missing: string | null
  error: string | null
}

type ModelFixture = { name: string; capability: string; availability?: string }

/**
 * 内存 prisma 桩（对账纪律：count 必须忠实执行 where 的 model / status.in / createdAt.gte，
 * update 必须真改 modelsJson，否则「漏掉成功背书查询」「灰显未写库」这类变异杀不掉）。
 */
function createMemoryPrisma(initialModels: readonly ModelFixture[]) {
  let modelsJson = JSON.stringify(initialModels)
  const genRecords: Array<{ model: string; status: string; createdAt: Date }> = []
  const runs: StoredRun[] = []

  const findUnique = vi.fn(async () => ({ id: 'platform', models: modelsJson }))
  const update = vi.fn(async ({ data }: { data: { models: string } }) => {
    modelsJson = data.models
    return { id: 'platform', models: modelsJson }
  })
  const count = vi.fn(
    async ({
      where,
    }: {
      where: { model: string; status: { in: string[] }; createdAt: { gte: Date } }
    }) =>
      genRecords.filter(
        (r) =>
          r.model === where.model &&
          where.status.in.includes(r.status) &&
          r.createdAt.getTime() >= where.createdAt.gte.getTime(),
      ).length,
  )
  const createRun = vi.fn(async ({ data }: { data: Omit<StoredRun, 'id' | 'ranAt'> }) => {
    const row: StoredRun = { id: `run-${runs.length + 1}`, ranAt: new Date(), ...data }
    runs.push(row)
    return row
  })

  return {
    prisma: {
      providerChannel: { findUnique, update },
      generationRecord: { count },
      upstreamProbeRun: { create: createRun },
    },
    findUnique,
    update,
    count,
    runs,
    genRecords,
    getModels: (): ModelFixture[] => JSON.parse(modelsJson),
    setModels: (models: readonly ModelFixture[]) => {
      modelsJson = JSON.stringify(models)
    },
  }
}

function okResponse(ids: readonly string[]): ProbeFetchResponse {
  return { ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ id, owned_by: 'org' })) }) }
}

function statusResponse(status: number): ProbeFetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => ({}) }
}

describe('UpstreamProbeService（S1-1 定时探活对账）', () => {
  const savedEnv = { ...process.env }
  let store: ReturnType<typeof createMemoryPrisma>
  let svc: UpstreamProbeService
  let fetchImpl: ReturnType<typeof vi.fn>
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  function agnesResolves(ids: readonly string[]) {
    fetchImpl.mockImplementation(async (url: string) => {
      if (url.includes('agnes.example')) return okResponse(ids)
      throw new Error(`unexpected fetch: ${url}`)
    })
  }

  function agnesFailsWith(status: number) {
    fetchImpl.mockImplementation(async (url: string) => {
      if (url.includes('agnes.example')) return statusResponse(status)
      throw new Error(`unexpected fetch: ${url}`)
    })
  }

  function agnesUnreachable() {
    fetchImpl.mockImplementation(async (url: string) => {
      if (url.includes('agnes.example')) throw new Error('fetch failed')
      throw new Error(`unexpected fetch: ${url}`)
    })
  }

  function agnesRun(round: number): StoredRun {
    const found = store.runs.filter((r) => r.upstream === 'agnes')
    expect(found.length).toBeGreaterThanOrEqual(round)
    return found[found.length - 1]!
  }

  async function compile() {
    const moduleRef = await Test.createTestingModule({
      providers: [
        UpstreamProbeService,
        { provide: PrismaService, useValue: store.prisma },
        { provide: UPSTREAM_PROBE_FETCH, useValue: fetchImpl },
      ],
    }).compile()
    svc = moduleRef.get(UpstreamProbeService)
  }

  beforeEach(() => {
    process.env = { ...savedEnv }
    // 与探活相关的 env 一律清零再按需设置（含开发者机器可能残留的 OPENAI_* / 代理）
    for (const key of [
      'OPENAI_BASE_URL',
      'OPENAI_API_KEY',
      'APIMART_BASE_URL',
      'APIMART_API_KEY',
      'FAL_BASE_URL',
      'FAL_KEY',
      'MINIMAX_BASE_URL',
      'MINIMAX_API_KEY',
      'STEPFUN_BASE_URL',
      'STEPFUN_API_KEY',
      'HTTPS_PROXY',
      'https_proxy',
      'LNKPI_UPSTREAM_PROBE_INTERVAL_MINUTES',
    ]) {
      delete process.env[key]
    }
    process.env.OPENAI_BASE_URL = 'https://agnes.example/v1'
    process.env.OPENAI_API_KEY = 'k-agnes-secret'

    // S2-2b 探活接线：路由行来自 upstream-route-store 缓存 —— 注入种子行
    // （不注册 store 的 prisma ⇒ TTL 刷新不触发，缓存即测试注入值）。
    __resetUpstreamRouteStoreForTests()
    __setCachedUpstreamRoutesForTests([...UPSTREAM_ROUTE_SEEDS])

    store = createMemoryPrisma(FIXTURE_MODELS)
    fetchImpl = vi.fn()
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(async () => {
    svc?.onModuleDestroy()
    consoleLogSpy.mockRestore()
    process.env = savedEnv
    vi.restoreAllMocks()
  })

  it('A3/Ruling A：连败 2 次只记日志不改库；第 3 次且零成功 → 灰显 + run 落库', async () => {
    agnesResolves(AGNES_IDS.filter((id) => id !== GHOST_MODEL))
    await compile()

    await svc.probeOnce('manual')
    await svc.probeOnce('manual')

    // 抖动防护：连败 2 次，镜像绝不变
    expect(store.update).not.toHaveBeenCalled()
    expect(store.getModels()).toEqual(FIXTURE_MODELS)

    await svc.probeOnce('manual')

    // 第 3 次连败 + 近 24h 零成功 ⇒ 灰显
    expect(store.update).toHaveBeenCalledTimes(1)
    const grayed = store.getModels().find((m) => m.name === GHOST_MODEL)
    expect(grayed?.availability).toBe('unavailable')
    // matched 条目不动（unknown 保持 unknown）
    expect(store.getModels().find((m) => m.name === MATCHED_MODEL)?.availability).toBe('unknown')

    // run 落库：每轮 6 上游各一帧（2026-10-10 加 zhipu）；agnes 帧带 ghosts/modelCount
    expect(store.runs).toHaveLength(18)
    const run = agnesRun(3)
    expect(run).toMatchObject({
      upstream: 'agnes',
      httpStatus: 200,
      modelCount: AGNES_IDS.length - 1,
      ghosts: JSON.stringify([GHOST_MODEL]),
      error: null,
    })

    // 结构化日志：灰显变化时打 [MPH][probe]
    const mphLines = consoleLogSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[MPH][probe]'))
    expect(mphLines.some((l) => l.includes('"grayed"') && l.includes(GHOST_MODEL))).toBe(true)

    // 成功背书查询只对 ghost 模型发生
    expect(store.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ model: GHOST_MODEL }) }),
    )
  })

  it('Ruling A：连败 3 次但近 24h 有成功 ⇒ 只记日志，DB 永不变（/models 缺失 ≠ 不可用）', async () => {
    agnesResolves(AGNES_IDS.filter((id) => id !== GHOST_MODEL))
    const now = Date.now()
    store.genRecords.push(
      { model: GHOST_MODEL, status: 'completed', createdAt: new Date(now - 1 * 60 * 60_000) },
      // 反向样本：failed 状态不算成功
      { model: GHOST_MODEL, status: 'failed', createdAt: new Date(now - 30 * 60_000) },
      // 反向样本：25h 前的成功超出 24h 窗口
      { model: GHOST_MODEL, status: 'completed', createdAt: new Date(now - 25 * 60 * 60_000) },
      // 别的模型的成功不得背书本模型
      { model: MATCHED_MODEL, status: 'completed', createdAt: new Date(now - 60 * 60_000) },
    )
    await compile()

    await svc.probeOnce('manual')
    await svc.probeOnce('manual')
    await svc.probeOnce('manual')

    expect(store.update).not.toHaveBeenCalled()
    expect(store.getModels()).toEqual(FIXTURE_MODELS)
    const mphLines = consoleLogSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[MPH][probe]'))
    expect(mphLines.some((l) => l.includes('"suppressed"'))).toBe(true)

    // 结构断言：成功计数 where 确实限定 status ∈ success 集 + 24h 窗口
    const where = store.count.mock.calls[0]![0].where
    expect(where.status.in).toEqual(['completed'])
    expect(now - where.createdAt.gte.getTime()).toBeGreaterThan(23.9 * 60 * 60_000)
    expect(now - where.createdAt.gte.getTime()).toBeLessThan(24.1 * 60 * 60_000)
  })

  it('A4 恢复：灰显条目探活通过 → available，且连败计数归零（再抖 2 次不灰显）', async () => {
    agnesResolves(AGNES_IDS)
    store.setModels([
      { name: MATCHED_MODEL, capability: 'text', availability: 'unknown' },
      { name: GHOST_MODEL, capability: 'image', availability: 'unavailable' },
    ])
    await compile()

    await svc.probeOnce('manual')

    expect(store.update).toHaveBeenCalledTimes(1)
    expect(store.getModels().find((m) => m.name === GHOST_MODEL)?.availability).toBe('available')
    const mphLines = consoleLogSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[MPH][probe]'))
    expect(mphLines.some((l) => l.includes('"recovered"'))).toBe(true)

    // 计数已随 matched 归零：随后连续 2 轮 ghost 也只是抖动（3 次才会灰显）
    agnesResolves(AGNES_IDS.filter((id) => id !== GHOST_MODEL))
    await svc.probeOnce('manual')
    await svc.probeOnce('manual')
    expect(store.update).toHaveBeenCalledTimes(1)
    expect(store.getModels().find((m) => m.name === GHOST_MODEL)?.availability).toBe('available')
  })

  it('上游不可达（fetch 抛错）→ 不判 ghost、不 bump 计数，落 unavailable(reason) run 记录', async () => {
    agnesUnreachable()
    await compile()

    for (let i = 0; i < 3; i++) await svc.probeOnce('manual')

    // 镜像绝不变（上游不可达 ≠ 模型幽灵）
    expect(store.update).not.toHaveBeenCalled()
    expect(store.getModels()).toEqual(FIXTURE_MODELS)

    const run = agnesRun(3)
    expect(run.httpStatus).toBeNull()
    expect(run.ghosts).toBeNull()
    expect(run.error).toMatch(/网络错误/)
    expect(run.modelCount).toBeNull()

    // 计数未被 bump：随后 1 轮真实 ghost（连败从 0 起算）绝不灰显
    agnesResolves(AGNES_IDS.filter((id) => id !== GHOST_MODEL))
    await svc.probeOnce('manual')
    expect(store.update).not.toHaveBeenCalled()
  })

  it('上游 402（欠费）→ unavailable(reason) run 记录，不产生 ghost、不灰显', async () => {
    agnesFailsWith(402)
    await compile()

    await svc.probeOnce('manual')

    const run = agnesRun(1)
    expect(run).toMatchObject({ httpStatus: 402, ghosts: null, error: 'HTTP 402（余额不足）' })
    expect(store.update).not.toHaveBeenCalled()
    expect(store.getModels()).toEqual(FIXTURE_MODELS)

    // 计数未被 bump：随后 1 轮真实 ghost 不灰显（连败从 0 起算）
    agnesResolves(AGNES_IDS.filter((id) => id !== GHOST_MODEL))
    await svc.probeOnce('manual')
    expect(store.update).not.toHaveBeenCalled()
  })

  it('上游 404（无 /models 端点）→ NO_MODELS_ENDPOINT run 记录，正常跳过', async () => {
    agnesFailsWith(404)
    await compile()

    await svc.probeOnce('manual')

    const run = agnesRun(1)
    expect(run.httpStatus).toBe(404)
    expect(run.error).toContain('NO_MODELS_ENDPOINT')
    expect(run.ghosts).toBeNull()
    expect(store.update).not.toHaveBeenCalled()
  })

  it('A5 旧格式兼容：无 availability 字段的存量条目可被正常灰显（升级为显式写入）', async () => {
    agnesResolves(AGNES_IDS.filter((id) => id !== GHOST_MODEL))
    store.setModels(LEGACY_MODELS)
    await compile()

    await svc.probeOnce('manual')
    await svc.probeOnce('manual')
    expect(store.update).not.toHaveBeenCalled()

    await svc.probeOnce('manual')

    expect(store.update).toHaveBeenCalledTimes(1)
    const models = store.getModels()
    expect(models.find((m) => m.name === GHOST_MODEL)).toEqual({
      name: GHOST_MODEL,
      capability: 'image',
      availability: 'unavailable',
    })
    // matched 旧条目升级为显式 unknown
    expect(models.find((m) => m.name === MATCHED_MODEL)).toEqual({
      name: MATCHED_MODEL,
      capability: 'text',
      availability: 'unknown',
    })
  })

  it('读-改-写防竞态：写入前重读最新镜像，plan 按名套用，重建期间新增的条目不受影响', async () => {
    agnesResolves(AGNES_IDS.filter((id) => id !== GHOST_MODEL))
    await compile()

    // findUnique 第 2 次调用（writeMirror 的 fresh read）时，镜像被 bootstrap 对齐重建：
    // 多了一个新条目、灰显计数被重置——写入必须以 fresh 为基，而不是陈旧的 prev 快照
    let call = 0
    store.findUnique.mockImplementation(async () => {
      call++
      if (call === 2) {
        store.setModels([
          ...FIXTURE_MODELS,
          { name: 'agnes-image-2.5-flash', capability: 'image', availability: 'unknown' },
        ])
      }
      return { id: 'platform', models: JSON.stringify(store.getModels()) }
    })

    await svc.probeOnce('manual')
    await svc.probeOnce('manual')
    await svc.probeOnce('manual')

    const models = store.getModels()
    expect(models.find((m) => m.name === GHOST_MODEL)?.availability).toBe('unavailable')
    // 重建期间新增的条目原样保留（plan 不触碰 plan 外的名字）
    expect(models.find((m) => m.name === 'agnes-image-2.5-flash')).toEqual({
      name: 'agnes-image-2.5-flash',
      capability: 'image',
      availability: 'unknown',
    })
  })

  it('每轮对 6 个上游各落一帧 run；未配置 env 的上游记 unavailable(未配置) 不判 ghost', async () => {
    agnesResolves(AGNES_IDS)
    await compile()

    await svc.probeOnce('manual')

    expect(store.runs).toHaveLength(6)
    const upstreams = new Set(store.runs.map((r) => r.upstream))
    expect(upstreams).toEqual(new Set(['agnes', 'apimart', 'fal', 'minimax', 'stepfun', 'zhipu']))
    const apimart = store.runs.find((r) => r.upstream === 'apimart')!
    expect(apimart.error).toContain('未配置 APIMART_API_KEY')
    expect(apimart.ghosts).toBeNull()
  })

  it('⛔ 探活只读 GET /v1/models，绝不发送生成请求，日志绝不打印密钥', async () => {
    agnesResolves(AGNES_IDS)
    await compile()

    await svc.probeOnce('manual')
    await svc.probeOnce('manual')

    expect(fetchImpl).toHaveBeenCalled()
    for (const call of fetchImpl.mock.calls) {
      const [url, init] = call as [string, { method?: string; headers?: Record<string, string> }]
      expect(url.endsWith('/models')).toBe(true)
      expect(init.method).toBe('GET')
    }
    const allLogs = consoleLogSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(allLogs).not.toContain('k-agnes-secret')
  })

  it('probeOnce 自身异常被吞掉（探活器故障不拖垮调用方）', async () => {
    await compile()
    // 静音 logger（该用例会走 error 分支，避免污染测试输出）
    const inner = svc as unknown as { logger: { error: (...args: unknown[]) => void } }
    vi.spyOn(inner.logger, 'error').mockImplementation(() => {})
    // prisma 挂掉：probeOnce 不抛
    store.findUnique.mockRejectedValue(new Error('db down'))
    await expect(svc.probeOnce('manual')).resolves.toBeUndefined()
  })

  it('A5 双行 fixture：同名模型双上游都配 → 只探路由行指向的那一家（exact 高优胜出）', async () => {
    // 完整种子表 + 叠加同名双行：exact → apimart（priority 100）vs regex → agnes_hub
    // （priority 5）。路由胜者 = apimart 行 ⇒ agnes 帧的 expected 不含它。
    __setCachedUpstreamRoutesForTests([
      { matchType: 'exact', pattern: 'agnes-image-2.0-flash', capability: 'image', upstream: 'apimart', priority: 100, enabled: true },
      { matchType: 'regex', pattern: 'agnes-image-.*', capability: 'image', upstream: 'agnes_hub', priority: 5, enabled: true },
      ...UPSTREAM_ROUTE_SEEDS.map((row) => ({ ...row })),
    ])
    // agnes 返回「全量 agnes 清单 − GHOST_MODEL」：若误归 agnes，GHOST_MODEL 会被判 ghost；
    // 正确行为（只探 apimart）⇒ agnes 帧 ghosts 恒空、apimart 缺 key 探测失败只落 run 记录。
    agnesResolves(AGNES_IDS.filter((id) => id !== GHOST_MODEL))
    await compile()

    await svc.probeOnce('manual')
    await svc.probeOnce('manual')
    await svc.probeOnce('manual')

    const run = agnesRun(3)
    expect(run.ghosts).toBe('[]')
    const apimartRun = store.runs.find((r) => r.upstream === 'apimart')!
    expect(apimartRun.error).toContain('未配置 APIMART_API_KEY')
    expect(apimartRun.ghosts).toBeNull()
    // 没有任何上游能判它 ghost ⇒ 三轮后镜像不变
    expect(store.update).not.toHaveBeenCalled()
    expect(store.getModels()).toEqual(FIXTURE_MODELS)
  })

  it('A5 反向 fixture：禁用高优 exact 行后同名模型归低优 regex 行（enabled 过滤生效）', async () => {
    // 同款叠加，但 exact 行 enabled=false ⇒ 低优 regex 行接棒（agnes_hub）⇒ 归 agnes。
    __setCachedUpstreamRoutesForTests([
      { matchType: 'exact', pattern: 'agnes-image-2.0-flash', capability: 'image', upstream: 'apimart', priority: 100, enabled: false },
      { matchType: 'regex', pattern: 'agnes-image-.*', capability: 'image', upstream: 'agnes_hub', priority: 5, enabled: true },
      ...UPSTREAM_ROUTE_SEEDS.map((row) => ({ ...row })),
    ])
    // agnes 清单摘掉 GHOST_MODEL ⇒ 此时它归 agnes（低优 regex 行接棒）⇒ 被判 ghost
    agnesResolves(AGNES_IDS.filter((id) => id !== GHOST_MODEL))
    await compile()

    await svc.probeOnce('manual')
    const run = agnesRun(1)
    expect(run.ghosts).toBe(JSON.stringify([GHOST_MODEL]))
  })
})

describe('S2-2b 路由分组与双 id 映射（A5 单胜者 / B1 裁定：穷举 switch、无字符串绕过）', () => {
  const ENTRIES: ProbeCatalogEntry[] = [
    { modelKey: 'agnes-image-2.0-flash', gatewayModelId: 'agnes-image-2.0-flash', modality: 'image' },
    { modelKey: 'agnes-2.0-flash', gatewayModelId: 'agnes-2.0-flash', modality: 'text' },
  ]

  it('同名模型双上游都配 → 只归胜者（priority 降序 + exact > regex）指向那一家', () => {
    const { byUpstream, unroutable } = groupCatalogEntriesByUpstream(
      [
        { matchType: 'exact', pattern: 'agnes-image-2.0-flash', capability: 'image', upstream: 'apimart', priority: 100, enabled: true },
        { matchType: 'regex', pattern: 'agnes-image-.*', capability: 'image', upstream: 'agnes_hub', priority: 5, enabled: true },
        { matchType: 'default', pattern: null, capability: '*', upstream: 'agnes_hub', priority: 0, enabled: true },
      ],
      ENTRIES,
    )
    expect(byUpstream.get('apimart')?.map((e) => e.modelKey)).toEqual(['agnes-image-2.0-flash'])
    expect(byUpstream.get('agnes')?.map((e) => e.modelKey)).toEqual(['agnes-2.0-flash'])
    expect(unroutable).toEqual([])
  })

  it('未命中且无可用 default 行 → 不归任何上游（unroutable 上报，绝不算 ghost）', () => {
    const { byUpstream, unroutable } = groupCatalogEntriesByUpstream(
      [
        { matchType: 'exact', pattern: 'other-model', capability: '*', upstream: 'fal', priority: 10, enabled: true },
      ],
      ENTRIES,
    )
    expect(byUpstream.size).toBe(0)
    expect(unroutable).toEqual(['agnes-image-2.0-flash', 'agnes-2.0-flash'])
  })

  it('穷举 switch 映射：routing agnes_hub → 对账 agnes，其余四家同名直映', () => {
    expect(toReconciliationUpstreamId('agnes_hub')).toBe('agnes')
    expect(toReconciliationUpstreamId('apimart')).toBe('apimart')
    expect(toReconciliationUpstreamId('fal')).toBe('fal')
    expect(toReconciliationUpstreamId('minimax')).toBe('minimax')
    expect(toReconciliationUpstreamId('stepfun')).toBe('stepfun')
  })
})

describe('探活调度（A2：手动 setInterval + LNKPI_UPSTREAM_PROBE_INTERVAL_MINUTES）', () => {
  const savedEnv = { ...process.env }
  let svc: UpstreamProbeService

  async function compile() {
    const moduleRef = await Test.createTestingModule({
      providers: [
        UpstreamProbeService,
        { provide: PrismaService, useValue: {} },
        { provide: UPSTREAM_PROBE_FETCH, useValue: vi.fn() },
      ],
    }).compile()
    svc = moduleRef.get(UpstreamProbeService)
    // 默认静音启动首轮（本 describe 只断言调度；个别用例再自建 spy 断言 startup 触发）。
    vi.spyOn(svc, 'probeOnce').mockResolvedValue(undefined)
  }

  afterEach(() => {
    svc?.onModuleDestroy()
    process.env = savedEnv
    // B3 热修：startup 探活现在依赖路由表 bootstrap 落定信号（store 模块级状态），逐用例重置防污染。
    __resetUpstreamRouteStoreForTests()
  })

  it('env 缺省按 360 分钟注册 timer', async () => {
    delete process.env.NODE_ENV
    delete process.env.LNKPI_UPSTREAM_PROBE_INTERVAL_MINUTES
    await compile()
    const spy = vi.spyOn(global, 'setInterval')
    svc.onModuleInit()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![1]).toBe(DEFAULT_PROBE_INTERVAL_MINUTES * 60_000)
  })

  it('env=1 分钟（低于默认值，防假绿）生效：60_000ms 注册且 unref', async () => {
    delete process.env.NODE_ENV
    process.env.LNKPI_UPSTREAM_PROBE_INTERVAL_MINUTES = '1'
    await compile()
    const spy = vi.spyOn(global, 'setInterval')
    svc.onModuleInit()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![1]).toBe(60_000)
    const handle = spy.mock.results[0]!.value as unknown as { hasRef?: () => boolean }
    expect(handle.hasRef?.()).toBe(false)
  })

  it('env=0 显式禁用：不注册任何 timer', async () => {
    delete process.env.NODE_ENV
    process.env.LNKPI_UPSTREAM_PROBE_INTERVAL_MINUTES = '0'
    await compile()
    const spy = vi.spyOn(global, 'setInterval')
    svc.onModuleInit()
    expect(spy).not.toHaveBeenCalled()
  })

  it('NODE_ENV=test 不注册 timer（与 generation-reaper 同款纪律）', async () => {
    process.env.NODE_ENV = 'test'
    process.env.LNKPI_UPSTREAM_PROBE_INTERVAL_MINUTES = '1'
    await compile()
    const spy = vi.spyOn(global, 'setInterval')
    svc.onModuleInit()
    expect(spy).not.toHaveBeenCalled()
  })

  it('onModuleDestroy 清掉 timer', async () => {
    delete process.env.NODE_ENV
    process.env.LNKPI_UPSTREAM_PROBE_INTERVAL_MINUTES = '1'
    await compile()
    const spy = vi.spyOn(global, 'clearInterval')
    svc.onModuleInit()
    svc.onModuleDestroy()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('启动首轮（B3 热修）：等路由表就绪后触发一次 probeOnce("startup")', async () => {
    delete process.env.NODE_ENV
    process.env.LNKPI_UPSTREAM_PROBE_INTERVAL_MINUTES = '1'
    __resetUpstreamRouteStoreForTests()
    await compile()
    const spy = vi.spyOn(svc, 'probeOnce')
    svc.onModuleInit()
    // 路由表未落定 → 不立即触发（消除「空表 → 全量 unroutable」启动竞态）
    expect(spy).not.toHaveBeenCalled()
    markUpstreamRoutesBootstrapped()
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith('startup')
    })
  })

  it('启动首轮等待超时兜底：路由表一直未就绪也照常执行（绝不静默丢失首轮）', async () => {
    delete process.env.NODE_ENV
    __resetUpstreamRouteStoreForTests()
    await compile()
    const spy = vi.spyOn(svc, 'probeOnce')
    await (
      svc as unknown as { startupProbeWhenRoutesReady(t?: number): Promise<void> }
    ).startupProbeWhenRoutesReady(30)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('startup')
  })

  it('启动首轮等待不阻塞 bootstrap：路由早已落定时 onModuleInit 同步返回、探测异步补跑', async () => {
    delete process.env.NODE_ENV
    process.env.LNKPI_UPSTREAM_PROBE_INTERVAL_MINUTES = '1'
    __resetUpstreamRouteStoreForTests()
    markUpstreamRoutesBootstrapped()
    await compile()
    const spy = vi.spyOn(svc, 'probeOnce')
    const t0 = Date.now()
    svc.onModuleInit()
    expect(Date.now() - t0).toBeLessThan(1_000)
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith('startup')
    })
  })

  it('启动首轮不触发：env=0 显式禁用 / NODE_ENV=test（与定时器同款纪律）', async () => {
    delete process.env.NODE_ENV
    process.env.LNKPI_UPSTREAM_PROBE_INTERVAL_MINUTES = '0'
    await compile()
    const spy0 = vi.spyOn(svc, 'probeOnce')
    svc.onModuleInit()
    expect(spy0).not.toHaveBeenCalled()

    process.env.NODE_ENV = 'test'
    process.env.LNKPI_UPSTREAM_PROBE_INTERVAL_MINUTES = '1'
    await compile()
    const spy1 = vi.spyOn(svc, 'probeOnce')
    svc.onModuleInit()
    expect(spy1).not.toHaveBeenCalled()
  })

  it('resolveProbeIntervalMinutes：缺失/非法回落默认；0 保留为禁用', () => {
    expect(resolveProbeIntervalMinutes(undefined)).toBe(360)
    expect(resolveProbeIntervalMinutes('')).toBe(360)
    expect(resolveProbeIntervalMinutes('abc')).toBe(360)
    expect(resolveProbeIntervalMinutes('-5')).toBe(360)
    expect(resolveProbeIntervalMinutes('0')).toBe(0)
    expect(resolveProbeIntervalMinutes('17')).toBe(17)
  })
})
