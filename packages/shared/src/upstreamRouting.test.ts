import { describe, expect, it } from 'vitest'
import { STUDIO_MODEL_CATALOG } from './studioModelCatalog'
import {
  readPlatformCredentialEnv,
  type PlatformCredentialEnv,
} from './platformCredentials'
import type { ModelCapability } from './providerChannels'
import {
  assertRoutePatternSafe,
  legacyResolveUpstream,
  matchUpstreamRoute,
  MAX_ROUTE_PATTERN_LENGTH,
  resolveUpstreamRoute,
  UPSTREAM_REGISTRY,
  UPSTREAM_ROUTE_SEEDS,
  UpstreamRoutePatternError,
  UpstreamRouteResolutionError,
  type RouteResult,
  type UpstreamRouteRow,
} from './upstreamRouting'

/**
 * S2-2a 验收测试（spec: docs/superpowers/specs/2026-10-09-mph-s22-routing-table-design.md §4）：
 * - A1 双实现对拍（硬门禁）：legacyResolveUpstream（现 resolver 链原样副本）×
 *   resolveUpstreamRoute（新表），fixture = 现目录 25 条 + 2026-10-09 探活下架的
 *   3 条幽灵模型（spec 写于下架前，28 条计数含它们）+ 5 条别名补充键，
 *   每条 × 4 个 capability 全量对比，逐条一致；
 * - A2 优先级与匹配类型；A3 无 default 抛错不回落；A4 RouteResult 无密钥值；
 * - regex ReDoS 防线；种子静态断言；env 名跨模块对齐（防注册表字节漂移）。
 */

const CAPABILITIES: readonly ModelCapability[] = ['text', 'image', 'video', 'audio']

/** 现目录 25 条的 modelKey。 */
const CATALOG_KEYS = STUDIO_MODEL_CATALOG.map((e) => e.modelKey)

/** 2026-10-09 探活下架的 3 条文本模型（studioModelCatalog.ts §3.1 注释锚点）。 */
const GHOST_KEYS = ['deepseek-v4', 'gemini-3.1-flash', 'gpt-5.5']

/** 目录 = 25 条，spec 的「28 条」= 25 + 3 幽灵（下架前计数）。 */
const FIXTURE_KEYS = [...CATALOG_KEYS, ...GHOST_KEYS]

/** 别名补充键：锚定正则/前缀/gateway id 形态的翻译完整性证明。 */
const ALIAS_KEYS = [
  'MiniMax-H3', // /^minimax-h3$/i 的大小写别名形态
  'H3-MAX-TURBO', // /h3-max/i 的大小写形态
  'doubao-seedream-5-0-pro', // seedream 的 gateway id 直连形态
  'gpt-image-2-official', // image2 的 gateway id 直连形态
  'gemini-3.2-flash', // APIMart 的 gpt-image-2 别名形态
]

describe('A1 对拍有效性断言（先证明 fixture 非空集、覆盖 5 上游）', () => {
  it('fixture 规模：目录 26 条 + 幽灵 3 条 = 29；别名补充 5 条', () => {
    expect(CATALOG_KEYS).toHaveLength(26)
    expect(GHOST_KEYS).toHaveLength(3)
    expect(FIXTURE_KEYS).toHaveLength(29)
    expect(ALIAS_KEYS).toHaveLength(5)
  })

  it('fixture 含 backed 名单模型（imageModelProfiles.isApimartBackedImageModel 目录耦合键）', () => {
    for (const key of ['image2', 'seedream-5.0-pro']) {
      expect(CATALOG_KEYS, `backed 名单目录模型 ${key}`).toContain(key)
    }
    for (const key of ['doubao-seedream-5-0-pro', 'gpt-image-2-official']) {
      expect(ALIAS_KEYS, `backed 名单 gateway id ${key}`).toContain(key)
    }
  })

  it('对拍前先证明 legacy 副本在 fixture 上命中全部 5 个上游（非空集/非全默认假绿）', () => {
    const legacyHits = new Set<string>()
    for (const key of [...FIXTURE_KEYS, ...ALIAS_KEYS]) {
      for (const cap of CAPABILITIES) {
        legacyHits.add(legacyResolveUpstream(key, cap))
      }
    }
    expect([...legacyHits].sort()).toEqual(['agnes_hub', 'apimart', 'fal', 'minimax', 'stepfun'])
  })
})

describe('A1 硬门禁：28 条 × 4 capability × legacy/新表逐条一致', () => {
  it('全量对比无分歧（136 组对比，逐条真实值比对）', () => {
    const keys = [...FIXTURE_KEYS, ...ALIAS_KEYS]
    const mismatches: string[] = []
    let comparisons = 0
    for (const key of keys) {
      for (const cap of CAPABILITIES) {
        const legacy = legacyResolveUpstream(key, cap)
        const routed = resolveUpstreamRoute(UPSTREAM_ROUTE_SEEDS, key, cap).upstream
        comparisons++
        if (legacy !== routed) {
          mismatches.push(`modelKey="${key}" capability="${cap}": legacy=${legacy} != routed=${routed}`)
        }
      }
    }
    // 有效性：136 = (29 + 5) × 4，逐条真实值比对非抽样
    expect(comparisons).toBe(136)
    expect(mismatches, mismatches.join('\n')).toEqual([])
  })

  it('命中抽样：fal / minimax / stepfun / apimart / agnes_hub 各自代表键逐个核对', () => {
    const expectUpstream = (key: string, cap: ModelCapability, upstream: string) => {
      expect(legacyResolveUpstream(key, cap), `legacy ${key}@${cap}`).toBe(upstream)
      expect(resolveUpstreamRoute(UPSTREAM_ROUTE_SEEDS, key, cap).upstream, `routed ${key}@${cap}`).toBe(upstream)
    }
    expectUpstream('h3-max', 'video', 'fal')
    expectUpstream('h3-max-turbo', 'video', 'fal')
    expectUpstream('minimax-h3', 'video', 'minimax')
    expectUpstream('MiniMax-H3', 'video', 'minimax')
    expectUpstream('step-tts-mini', 'audio', 'stepfun')
    expectUpstream('stepaudio-3-music-preview', 'audio', 'stepfun')
    expectUpstream('image2', 'image', 'apimart')
    expectUpstream('seedream-5.0-pro', 'image', 'apimart')
    expectUpstream('doubao-seedream-5-0-pro', 'image', 'apimart')
    expectUpstream('gpt-image-2-official', 'image', 'apimart')
    expectUpstream('gemini-3.2-flash', 'image', 'apimart')
    expectUpstream('gemini-3.1-flash', 'image', 'apimart')
    expectUpstream('agnes-image-2.1-flash', 'image', 'agnes_hub')
    expectUpstream('agnes-2.0-flash', 'text', 'agnes_hub')
    expectUpstream('deepseek-v4', 'text', 'agnes_hub')
    // apimart 行是 image 专属：legacy 仅在 modality==='image' 分支检查
    expectUpstream('image2', 'text', 'agnes_hub')
    expectUpstream('seedream-5.0-pro', 'video', 'agnes_hub')
  })
})

describe('A2 优先级与匹配类型', () => {
  const row = (overrides: Partial<UpstreamRouteRow> & Pick<UpstreamRouteRow, 'matchType' | 'pattern' | 'upstream'>): UpstreamRouteRow => ({
    capability: '*',
    priority: 10,
    enabled: true,
    ...overrides,
  })
  const DEFAULT_ROW = row({ matchType: 'default', pattern: null, upstream: 'agnes_hub', priority: 0 })

  it('同优先级 exact 胜 prefix 胜 regex', () => {
    const rows = [
      row({ matchType: 'regex', pattern: 'zz$', upstream: 'fal' }),
      row({ matchType: 'prefix', pattern: 'agnes-', upstream: 'minimax' }),
      row({ matchType: 'exact', pattern: 'agnes-x', upstream: 'apimart' }),
      DEFAULT_ROW,
    ]
    // 三类都命中 → exact 胜
    expect(resolveUpstreamRoute(rows, 'agnes-x', 'text').upstream).toBe('apimart')
    // prefix + regex 都命中（agnes-zz 也匹配 zz$）→ prefix 胜
    expect(resolveUpstreamRoute(rows, 'agnes-y', 'text').upstream).toBe('minimax')
    expect(resolveUpstreamRoute(rows, 'agnes-zz', 'text').upstream).toBe('minimax')
    // 仅 regex 命中 → fal
    expect(resolveUpstreamRoute(rows, 'foo-zz', 'text').upstream).toBe('fal')
  })

  it('priority 降序优先于匹配类型：高优先级 prefix 胜过低优先级 exact', () => {
    const rows = [
      row({ matchType: 'exact', pattern: 'agnes-x', upstream: 'apimart', priority: 1 }),
      row({ matchType: 'prefix', pattern: 'agnes-', upstream: 'minimax', priority: 10 }),
      DEFAULT_ROW,
    ]
    expect(resolveUpstreamRoute(rows, 'agnes-x', 'text').upstream).toBe('minimax')
  })

  it('enabled=false 的行不参与命中（落到 default）', () => {
    const rows = [
      row({ matchType: 'exact', pattern: 'agnes-x', upstream: 'apimart', enabled: false }),
      DEFAULT_ROW,
    ]
    expect(resolveUpstreamRoute(rows, 'agnes-x', 'text').upstream).toBe('agnes_hub')
  })

  it('capability 维度过滤：image 行对 text 不命中（legacy apimart 仅 image 分支的等价语义）', () => {
    const rows = [
      row({ matchType: 'exact', pattern: 'agnes-x', upstream: 'apimart', capability: 'image' }),
      DEFAULT_ROW,
    ]
    expect(resolveUpstreamRoute(rows, 'agnes-x', 'image').upstream).toBe('apimart')
    expect(resolveUpstreamRoute(rows, 'agnes-x', 'text').upstream).toBe('agnes_hub')
  })

  it('default 行不作为普通命中参与匹配（matchType 排除）', () => {
    const rows = [row({ matchType: 'default', pattern: 'agnes-x', upstream: 'apimart', priority: 100 })]
    // default 行不算普通命中，但会兜底 → 仍返回 apimart（兜底走它）
    expect(matchUpstreamRoute(rows, 'agnes-x', 'text')).toBeNull()
    expect(resolveUpstreamRoute(rows, 'agnes-x', 'text').upstream).toBe('apimart')
  })

  it('多个 default 行取装载序第一行（确定性：priority 降序 → id 升序装载）', () => {
    const rows = [
      row({ matchType: 'default', pattern: null, upstream: 'agnes_hub', priority: 0 }),
      row({ matchType: 'default', pattern: null, upstream: 'apimart', priority: -1 }),
    ]
    expect(resolveUpstreamRoute(rows, 'no-such-model', 'text').upstream).toBe('agnes_hub')
  })
})

describe('A3 未命中且无 default → 确定性抛错，禁止回落 OpenAI 链', () => {
  it('无 default 行 + 未命中 → UpstreamRouteResolutionError，文案含 modelKey/capability', () => {
    const rows = UPSTREAM_ROUTE_SEEDS.filter((r) => r.matchType !== 'default')
    const resolve = () => resolveUpstreamRoute(rows as UpstreamRouteRow[], 'totally-unknown-model', 'text')
    expect(resolve).toThrow(UpstreamRouteResolutionError)
    try {
      resolve()
    } catch (err) {
      expect((err as Error).message).toContain('totally-unknown-model')
      expect((err as Error).message).toContain('text')
    }
  })

  it('确定性：同输入两次抛错的 message 逐字节一致', () => {
    const rows = UPSTREAM_ROUTE_SEEDS.filter((r) => r.matchType !== 'default')
    let first: string | null = null
    let second: string | null = null
    try {
      resolveUpstreamRoute(rows as UpstreamRouteRow[], 'unknown-x', 'video')
    } catch (err) {
      first = (err as Error).message
    }
    try {
      resolveUpstreamRoute(rows as UpstreamRouteRow[], 'unknown-x', 'video')
    } catch (err) {
      second = (err as Error).message
    }
    expect(first).not.toBeNull()
    expect(second).toBe(first)
  })

  it('default 行存在但 enabled=false → 同样抛错（不静默回落）', () => {
    const rows: UpstreamRouteRow[] = [
      ...UPSTREAM_ROUTE_SEEDS.filter((r) => r.matchType !== 'default'),
      { matchType: 'default', pattern: null, capability: '*', upstream: 'agnes_hub', priority: 0, enabled: false },
    ]
    expect(() => resolveUpstreamRoute(rows, 'unknown-x', 'text')).toThrow(UpstreamRouteResolutionError)
  })

  it('default 行存在 → 未命中兜底返回 default 上游，不抛错', () => {
    expect(resolveUpstreamRoute(UPSTREAM_ROUTE_SEEDS, 'totally-unknown-model', 'text')).toMatchObject({
      upstream: 'agnes_hub',
    })
  })
})

describe('A4 RouteResult 只回 env 名，绝不回密钥值', () => {
  it('全部种子可解析的结果序列化后无 sk- 前缀值', () => {
    for (const key of ['image2', 'seedream-5.0-pro', 'step-tts-mini', 'minimax-h3', 'h3-max', 'unknown-x']) {
      for (const cap of CAPABILITIES) {
        const result = resolveUpstreamRoute(UPSTREAM_ROUTE_SEEDS, key, cap)
        const serialized = JSON.stringify(result)
        expect(serialized, `${key}@${cap}`).not.toContain('sk-')
        expect(result.apiKeyEnvName).toMatch(/^[A-Z][A-Z0-9_]*$/)
        expect(result.fallbackApiKeyEnvName ?? 'OPENAI_API_KEY').toMatch(/^[A-Z][A-Z0-9_]*$/)
      }
    }
  })

  it('逐上游构造结果：apiKeyEnvName 是 env 名形态，无任何密钥值字段', () => {
    const rows: UpstreamRouteRow[] = [
      { matchType: 'exact', pattern: 'm-fal', capability: '*', upstream: 'fal', priority: 50, enabled: true },
      { matchType: 'exact', pattern: 'm-step', capability: '*', upstream: 'stepfun', priority: 40, enabled: true },
      { matchType: 'exact', pattern: 'm-mini', capability: '*', upstream: 'minimax', priority: 30, enabled: true },
      { matchType: 'exact', pattern: 'm-api', capability: 'image', upstream: 'apimart', priority: 20, enabled: true },
      { matchType: 'default', pattern: null, capability: '*', upstream: 'agnes_hub', priority: 0, enabled: true },
    ]
    for (const key of ['m-fal', 'm-step', 'm-mini', 'm-api', 'm-none']) {
      const result = resolveUpstreamRoute(rows, key, 'image')
      const values = Object.values(result)
      for (const v of values) {
        expect(typeof v === 'string' ? v : JSON.stringify(v)).not.toContain('sk-')
      }
      expect(result.apiKeyEnvName).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
  })
})

describe('regex 行 ReDoS 防线', () => {
  it('pattern 超长（> MAX_ROUTE_PATTERN_LENGTH）→ 抛错；边界内放行', () => {
    expect(() => assertRoutePatternSafe('a'.repeat(MAX_ROUTE_PATTERN_LENGTH + 1))).toThrow(UpstreamRoutePatternError)
    expect(() => assertRoutePatternSafe('a'.repeat(MAX_ROUTE_PATTERN_LENGTH))).not.toThrow()
    expect(MAX_ROUTE_PATTERN_LENGTH).toBe(128)
  })

  it('嵌套量词（(a+)+ 形态）→ 抛错；普通分组量词 (abc)* 放行', () => {
    expect(() => assertRoutePatternSafe('(a+)+')).toThrow(UpstreamRoutePatternError)
    expect(() => assertRoutePatternSafe('(?:a{2,3})*b')).toThrow(UpstreamRoutePatternError)
    expect(() => assertRoutePatternSafe('(abc)*')).not.toThrow()
  })

  it('相邻双量词（a** 形态）→ 抛错', () => {
    expect(() => assertRoutePatternSafe('a**')).toThrow(UpstreamRoutePatternError)
  })

  it('无法编译的 pattern → 确定性抛错（不静默跳过该行）', () => {
    expect(() => assertRoutePatternSafe('(unclosed')).toThrow(UpstreamRoutePatternError)
  })

  it('regex 行在解析期同样受防线约束（命中前先断言）', () => {
    const rows: UpstreamRouteRow[] = [
      { matchType: 'regex', pattern: '(a+)+', capability: '*', upstream: 'fal', priority: 10, enabled: true },
      { matchType: 'default', pattern: null, capability: '*', upstream: 'agnes_hub', priority: 0, enabled: true },
    ]
    expect(() => resolveUpstreamRoute(rows, 'aaa', 'text')).toThrow(UpstreamRoutePatternError)
  })

  it('种子中所有 regex 行均过安全断言', () => {
    for (const seed of UPSTREAM_ROUTE_SEEDS) {
      if (seed.matchType === 'regex' && seed.pattern) {
        expect(() => assertRoutePatternSafe(seed.pattern!), seed.pattern).not.toThrow()
      }
    }
  })
})

describe('种子静态断言（翻译表完整性）', () => {
  it('恰好 1 条 default 行，指向 agnes_hub、通配 capability', () => {
    const defaults = UPSTREAM_ROUTE_SEEDS.filter((r) => r.matchType === 'default')
    expect(defaults).toHaveLength(1)
    expect(defaults[0]).toMatchObject({ upstream: 'agnes_hub', capability: '*' })
  })

  it('legacy 判定链顺序经优先级翻译：fal > minimax > stepfun > apimart > default', () => {
    const priorityOf = (upstream: string) =>
      UPSTREAM_ROUTE_SEEDS.filter((r) => r.upstream === upstream).map((r) => r.priority)
    const [falP] = priorityOf('fal')
    const [miniP] = priorityOf('minimax')
    const [stepP] = priorityOf('stepfun')
    const [apiP] = priorityOf('apimart')
    expect(falP!).toBeGreaterThan(miniP!)
    expect(miniP!).toBeGreaterThan(stepP!)
    expect(stepP!).toBeGreaterThan(apiP!)
    expect(apiP!).toBeGreaterThan(0)
  })

  it('apimart 行 capability=image；fal/minimax/stepfun 行通配（legacy 判定器不分模态）', () => {
    for (const seed of UPSTREAM_ROUTE_SEEDS) {
      if (seed.upstream === 'apimart') expect(seed.capability, seed.pattern ?? seed.matchType).toBe('image')
      if (seed.upstream === 'fal' || seed.upstream === 'minimax' || seed.upstream === 'stepfun') {
        expect(seed.capability, seed.pattern ?? seed.matchType).toBe('*')
      }
    }
  })

  it('apimart 行全部记录 openai key 回落 env 名（legacy apimartApiKey || openaiApiKey）', () => {
    const openaiEnv = UPSTREAM_REGISTRY.agnes_hub.apiKeyEnvName
    for (const seed of UPSTREAM_ROUTE_SEEDS) {
      if (seed.upstream === 'apimart') {
        expect(seed.fallbackApiKeyEnvName, seed.pattern ?? seed.matchType).toBe(openaiEnv)
      }
    }
    expect(UPSTREAM_REGISTRY.apimart.fallbackApiKeyEnvName).toBe(openaiEnv)
  })
})

describe('注册表 env 名与 readPlatformCredentialEnv 跨模块对齐（防字节漂移）', () => {
  it('注册表 env 名写进 process.env 后，readPlatformCredentialEnv 读到对应凭据字段', () => {
    const cases: Array<{ envName: string; field: keyof PlatformCredentialEnv }> = [
      { envName: UPSTREAM_REGISTRY.agnes_hub.apiKeyEnvName, field: 'openaiApiKey' },
      { envName: UPSTREAM_REGISTRY.apimart.apiKeyEnvName, field: 'apimartApiKey' },
      { envName: UPSTREAM_REGISTRY.stepfun.apiKeyEnvName, field: 'stepfunApiKey' },
      { envName: UPSTREAM_REGISTRY.minimax.apiKeyEnvName, field: 'minimaxApiKey' },
      { envName: UPSTREAM_REGISTRY.fal.apiKeyEnvName, field: 'falApiKey' },
    ]
    for (const { envName, field } of cases) {
      const saved = process.env[envName]
      process.env[envName] = `sentinel-${field}`
      try {
        const vars = readPlatformCredentialEnv()
        expect(vars[field], `${envName} → ${field}`).toBe(`sentinel-${field}`)
      } finally {
        if (saved === undefined) delete process.env[envName]
        else process.env[envName] = saved
      }
    }
  })

  it('每上游 RouteResult 的 apiKeyEnvName / baseUrl 来自注册表；agnes_hub 无静态 baseUrl', () => {
    for (const key of ['image2', 'step-tts-mini', 'minimax-h3', 'h3-max', 'unknown-x']) {
      const result: RouteResult = resolveUpstreamRoute(UPSTREAM_ROUTE_SEEDS, key, 'image')
      const registry = UPSTREAM_REGISTRY[result.upstream]
      expect(result.apiKeyEnvName).toBe(registry.apiKeyEnvName)
      if (registry.baseUrl === undefined) expect(result.baseUrl).toBeUndefined()
      else expect(result.baseUrl).toBe(registry.baseUrl)
    }
  })
})
