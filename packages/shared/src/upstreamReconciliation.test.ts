import { describe, expect, it } from 'vitest'
import { STUDIO_MODEL_CATALOG } from './studioModelCatalog'
import {
  DEFAULT_UPSTREAM,
  diffCatalogAgainstUpstream,
  routeCatalogEntry,
  type UpstreamRoutingMap,
} from './upstreamReconciliation'

/**
 * S0-3 上游对账纯函数单测（A1/A2/A3，docs/superpowers/specs/2026-10-09-mph-s03-smoke-probe-design.md §4）。
 *
 * fixture 数据源：
 * - agnes hub 真实 12 个 = 总体规格 2026-10-09-model-platform-hardening-design.md §2.4 逐字清单；
 * - 两态目录：S0-1 前（含 3 幽灵）/ S0-1 后（当前目录，幽灵已删）—— A1 对两态都断言，
 *   不硬编码任何一种目录状态。
 */

/** agnes hub /v1/models 真实 12 个（总体规格 §2.4 逐字，勿改动顺序/拼写） */
const AGNES_HUB_REAL_12 = [
  'agnes-2.0-flash',
  'agnes-2.5-flash',
  'agnes-2.5-pro',
  'agnes-2.5-pro-alpha',
  'agnes-2.5-pro-beta',
  'agnes-3.0-flash',
  'agnes-image-2.0-flash',
  'agnes-image-2.1-flash',
  'agnes-image-2.5-flash',
  'agnes-video-2.5',
  'agnes-video-2.5-flash',
  'agnes-video-v2.0',
]

const GHOST_IDS = ['gemini-3.1-flash', 'deepseek-v4', 'gpt-5.5']

/** S0-1 前的目录形态：当前目录 + 3 个幽灵条目按原条目结构原样重加 */
const CATALOG_WITH_GHOSTS = [
  ...STUDIO_MODEL_CATALOG,
  ...GHOST_IDS.map(
    (id): (typeof STUDIO_MODEL_CATALOG)[number] => ({
      modelKey: id,
      displayName: id,
      gatewayModelId: id,
      modality: 'text',
      providerBinding: 'gateway-openai-compat',
      params: { model: 'native' },
    }),
  ),
]

/**
 * family→upstream 路由表 fixture：与 ops/probe-upstream-models.mjs 内硬编码的
 * ROUTING_MAP 同表。来源两层：
 * - platformCredentials.ts 的 resolver 族（step / minimax-h3 / h3-max / apimart-backed-image）；
 * - 总体规格 §2.2 运行时路由表的其余家族（agnes 系 → agnes hub；非 agnes 系图片/视频
 *   → apimart；MiniMax 语音家族 → minimax；音频层 → stepfun）。
 * 兜底 = agnes hub 文本通道（gemini-/deepseek-/gpt- 等 LLM 家族）。S2-2 落地后两处都改为 import。
 */
const ROUTING_MAP: UpstreamRoutingMap = [
  { upstream: 'stepfun', pattern: /^step|^seed-audio/i },
  { upstream: 'minimax', pattern: /^minimax-h3$|^minimax-speech/i },
  { upstream: 'fal', pattern: /h3-max/i },
  {
    upstream: 'apimart',
    pattern:
      /^seedance-|^doubao-seedance-|^wan-|^seedream-|^doubao-seedream-|^gpt-image-2|^image2$|^midjourney-|^navo-|^happyhose-/i,
  },
  { upstream: 'agnes', pattern: /^agnes-/i },
]

/** 当前目录按路由表归到 agnes 的条目（其余 19 个归 stepfun/minimax/fal/apimart） */
const CURRENT_CATALOG_AGNES_MATCHED = [
  'agnes-2.0-flash',
  'agnes-image-2.0-flash',
  'agnes-image-2.1-flash',
  'agnes-image-2.5-flash',
  'agnes-video-2.5-flash',
  'agnes-video-v2.0',
].sort()

/** agnes hub 有而目录无（总体规格 §2.4：5 个文本上架机会 + 1 个视频） */
const EXPECTED_MISSING_CURRENT = [
  'agnes-2.5-flash',
  'agnes-2.5-pro',
  'agnes-2.5-pro-alpha',
  'agnes-2.5-pro-beta',
  'agnes-3.0-flash',
  'agnes-video-2.5',
].sort()

describe('S0-3 diffCatalogAgainstUpstream', () => {
  it('A1 两态参数化：含幽灵目录 → ghosts 恰为 3 幽灵；当前目录（S0-1 已下架）→ ghosts=[]', () => {
    const cases = [
      { name: 'S0-1 前目录（含 3 幽灵）', catalog: CATALOG_WITH_GHOSTS, expected: [...GHOST_IDS].sort() },
      { name: '当前目录（S0-1 已下架）', catalog: STUDIO_MODEL_CATALOG, expected: [] },
    ]
    for (const c of cases) {
      const diff = diffCatalogAgainstUpstream(c.catalog, AGNES_HUB_REAL_12, ROUTING_MAP)
      expect(diff.ghosts, c.name).toEqual(c.expected)
    }
  })

  it('A1 当前目录：matched 恰为 6 个 agnes 条目、missing 恰为网关多出的 6 个可用模型', () => {
    const diff = diffCatalogAgainstUpstream(STUDIO_MODEL_CATALOG, AGNES_HUB_REAL_12, ROUTING_MAP)
    expect(diff.matched).toEqual(CURRENT_CATALOG_AGNES_MATCHED)
    expect(diff.missing).toEqual(EXPECTED_MISSING_CURRENT)
  })

  it('A2：打乱 upstream 顺序 + 目录条目增删无关字段 + 打乱目录顺序 → 结果不变', () => {
    const baseline = diffCatalogAgainstUpstream(CATALOG_WITH_GHOSTS, AGNES_HUB_REAL_12, ROUTING_MAP)

    const shuffledUpstream = [...AGNES_HUB_REAL_12].reverse()
    // 增无关字段
    const decorated = CATALOG_WITH_GHOSTS.map((entry, i) => ({ ...entry, irrelevant: i, extra: { x: 1 } }))
    // 删无关字段（只留路由与 id 所需）
    const stripped = CATALOG_WITH_GHOSTS.map(({ displayName: _d, params: _p, ...rest }) => rest)
    // 打乱目录顺序
    const reordered = [...CATALOG_WITH_GHOSTS].reverse()

    expect(diffCatalogAgainstUpstream(decorated, shuffledUpstream, ROUTING_MAP)).toEqual(baseline)
    expect(diffCatalogAgainstUpstream(stripped, shuffledUpstream, ROUTING_MAP)).toEqual(baseline)
    expect(diffCatalogAgainstUpstream(reordered, shuffledUpstream, ROUTING_MAP)).toEqual(baseline)
  })

  it('A3：upstreamModelIds=null（上游不可达）→ ghosts=[]，两态目录都不误报', () => {
    for (const catalog of [CATALOG_WITH_GHOSTS, STUDIO_MODEL_CATALOG]) {
      expect(diffCatalogAgainstUpstream(catalog, null, ROUTING_MAP)).toEqual({
        ghosts: [],
        missing: [],
        matched: [],
      })
    }
  })

  it('ghost/matched 报 modelKey，比较按 gatewayModelId 大小写不敏感', () => {
    // minimax-h3 条目：gatewayModelId 是 MiniMax-H3，上游按该 id（任意大小写）列出即 matched
    const diff = diffCatalogAgainstUpstream(
      [{ modelKey: 'minimax-h3', gatewayModelId: 'MiniMax-H3' }],
      ['MINIMAX-H3'],
      ROUTING_MAP,
      { targetUpstream: 'minimax' },
    )
    expect(diff).toEqual({ ghosts: [], missing: [], matched: ['minimax-h3'] })
  })
})

describe('S0-3 路由表与 platformCredentials resolver 族一致', () => {
  it('family→upstream 判定样例（镜像各 resolver 的判别正则）', () => {
    // isStepFunPlatformModel: /^step/i
    expect(routeCatalogEntry({ modelKey: 'step-tts-mini', gatewayModelId: 'step-tts-mini' }, ROUTING_MAP)).toBe('stepfun')
    expect(routeCatalogEntry({ modelKey: 'stepaudio-3-gen-preview', gatewayModelId: 'stepaudio-3-gen-preview' }, ROUTING_MAP)).toBe('stepfun')
    // isMiniMaxH3PlatformModel: /^minimax-h3$/i
    expect(routeCatalogEntry({ modelKey: 'minimax-h3', gatewayModelId: 'MiniMax-H3' }, ROUTING_MAP)).toBe('minimax')
    // isFalH3MaxPlatformModel: /h3-max/i（注意 gatewayModelId 是 minimax/h3-max-*，仍归 fal）
    expect(routeCatalogEntry({ modelKey: 'h3-max-turbo', gatewayModelId: 'minimax/h3-max-turbo' }, ROUTING_MAP)).toBe('fal')
    // isApimartBackedImageModel：seedream / gpt-image-2（image2 的别名入口）
    expect(routeCatalogEntry({ modelKey: 'seedream-5.0-pro', gatewayModelId: 'doubao-seedream-5-0-pro' }, ROUTING_MAP)).toBe('apimart')
    expect(routeCatalogEntry({ modelKey: 'image2', gatewayModelId: 'gpt-image-2-official' }, ROUTING_MAP)).toBe('apimart')
    // 总体规格 §2.2：非 agnes 系图片/视频 → apimart
    expect(routeCatalogEntry({ modelKey: 'seedance-2.0-min', gatewayModelId: 'doubao-seedance-2.0-mini' }, ROUTING_MAP)).toBe('apimart')
    expect(routeCatalogEntry({ modelKey: 'wan-2.7', gatewayModelId: 'wan-2.7' }, ROUTING_MAP)).toBe('apimart')
    // 总体规格 §2.2：音频 6 个 → StepFun / MiniMax 域；agnes 系 → agnes hub
    expect(routeCatalogEntry({ modelKey: 'seed-audio-1.0', gatewayModelId: 'seed-audio-1.0' }, ROUTING_MAP)).toBe('stepfun')
    expect(routeCatalogEntry({ modelKey: 'minimax-speech-2.8-hd', gatewayModelId: 'speech-2.8-hd' }, ROUTING_MAP)).toBe('minimax')
    expect(routeCatalogEntry({ modelKey: 'agnes-image-2.0-flash', gatewayModelId: 'agnes-image-2.0-flash' }, ROUTING_MAP)).toBe('agnes')
    // 兜底 = agnes hub 文本通道（LLM 家族）
    expect(routeCatalogEntry({ modelKey: 'agnes-2.0-flash', gatewayModelId: 'agnes-2.0-flash' }, ROUTING_MAP)).toBe(DEFAULT_UPSTREAM)
    expect(routeCatalogEntry({ modelKey: 'some-future-llm', gatewayModelId: 'some-future-llm' }, ROUTING_MAP)).toBe(DEFAULT_UPSTREAM)
  })

  it('幽灵 id 不命中任何特化 family → 归 agnes → 才能被 agnes hub 对账发现', () => {
    for (const id of GHOST_IDS) {
      expect(routeCatalogEntry({ modelKey: id, gatewayModelId: id }, ROUTING_MAP)).toBe(DEFAULT_UPSTREAM)
    }
  })
})
