// apps/server/src/pricing/cost-collect.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common'
import { resolveUpstreamRoute, type ModelCapability, type UpstreamId, type UpstreamRouteRow } from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'
import { ENUMERATED_VIDEO_RESOLUTIONS_CANONICAL } from './pricing.space'
import { videoPriceFamily } from './pricing.core'

/**
 * 成本自动采集服务（spec: docs/design/2026-11-15-cost-auto-collect-design.md）：
 *
 * - 按上游注册适配器（不按模型）——现有渠道上架新模型时，查询输入（gatewayModelId）
 *   由目录自动带出，无需新代码（设计 §7/D4）。
 * - 两段式（D4）：`dryRun=true` 只产出「将写入的行 + 来源 + 凭证」预览，人工在卡片确认后
 *   才以 `dryRun=false` 真正落库。落库只写 `official_list`，**遇 manual / channel_actual
 *   生效行一律跳过**（人工优先，R2 不覆盖）。
 * - 不猜数（原则 1）：官方价目与主体档位口径不匹配（如音乐按输出小时 vs 主体按元/首）、
 *   上游不提供的档位（如 MiniMax-H3 无 480P）一律 skip 并给原因，绝不填占位数。
 * - D1 显式 0 价：免费模型（CogVideoX-Flash）写 costYuan=0 的 official_list 行，
 *   引擎视其为合法免费价。
 * - AC10（D9）：上游美元价在**录入侧**折算人民币（fx 取 LNKPI_FX_USD_CNY，缺省 7.15，
 *   与存量种子口径一致），折算参数进 evidence 供复核；CostRate 只存人民币。
 * - fail-soft（探活器纪律）：单适配器失败只记 error 与日志，不阻塞其它上游、不抛出。
 */

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface CollectCandidate {
  modelKey: string
  /** 卡片档位值（如 480p / voice）。 */
  spec: string
  /** 成本行 spec（视频=分辨率；音频=per_100_chars / per_song）。 */
  rowSpec: string
  unit: string
  unitQuantity: number
  costYuan: number
  source: 'official_list'
  evidence: { url: string; note: string }
}

export interface CollectSkip {
  modelKey: string
  spec: string
  reason: string
}

export interface AdapterReport {
  upstream: string
  status: 'ok' | 'error'
  candidates: CollectCandidate[]
  skips: CollectSkip[]
  error?: string
}

export interface CollectRunReport {
  ranAt: string
  dryRun: boolean
  adapters: AdapterReport[]
  /** 有在售模型但无适配器的上游（如 agnes_hub）——人工卡片填数（D3）。 */
  uncovered: { upstream: string; modelKeys: string[] }[]
  written: number
  keptManual: { modelKey: string; rowSpec: string }[]
}

export interface CollectFetchResponse {
  ok: boolean
  status: number
  text: () => Promise<string>
}

export type CollectFetch = (url: string) => Promise<CollectFetchResponse>

export const COST_COLLECT_FETCH = Symbol('COST_COLLECT_FETCH')

// ── 适配器共享工具 ──────────────────────────────────────────────────────────

/** 美元 → 人民币 折算（录入侧 D9）；fx 缺省与存量种子口径一致。 */
export function fxUsdCny(): number {
  const raw = process.env['LNKPI_FX_USD_CNY']
  const v = raw ? Number(raw) : NaN
  return Number.isFinite(v) && v > 0 ? v : 7.15
}

export interface AdapterModel {
  modelKey: string
  gatewayModelId: string
  /** 视频分辨率档位（音频模型为空数组）。 */
  videoRes: string[]
  /** 音频档位（视频模型为空数组）。 */
  audioTiers: { spec: string; rowSpec: string; unit: string; unitQuantity: number }[]
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4
}

// ── zhipu：CogVideoX-Flash 免费（官方价目页明示） ────────────────────────────

const ZHIPU_PRICING_URL = 'https://docs.bigmodel.cn/cn/guide/start/pricing'

export function collectZhipu(models: AdapterModel[]): AdapterReport {
  const candidates: CollectCandidate[] = []
  for (const m of models) {
    for (const res of m.videoRes) {
      candidates.push({
        modelKey: m.modelKey,
        spec: res,
        rowSpec: res,
        unit: 'per_second',
        unitQuantity: 1,
        costYuan: 0,
        source: 'official_list',
        evidence: { url: ZHIPU_PRICING_URL, note: '智谱官方价目：CogVideoX-Flash 视频生成 多分辨率 免费（0 元/次，D1 显式 0 价）' },
      })
    }
  }
  return { upstream: 'zhipu', status: 'ok', candidates, skips: [] }
}

// ── fal：模型页 SSR「Video costs $X per second at RES」句式（每端点每分辨率直价） ──

/** 页面分辨率 token → 主体枚举档位（不在枚举内的分辨率不猜，跳过）。 */
function mapFalResolution(token: string): string | null {
  const t = token.toLowerCase()
  if (t === '480p' || t === '768p' || t === '2k') return t
  return null
}

/** 从 fal 模型页文本解析「Video costs $A per second at RESA, $B per second at RESB …」句式。 */
export function parseFalVideoCosts(html: string): { res: string; usd: number }[] {
  const plain = html.replace(/<[^>]+>/g, ' ').replace(/[*\\]/g, '')
  const marker = plain.toLowerCase().indexOf('video costs')
  if (marker < 0) return []
  const seg = plain.slice(marker, marker + 800)
  const out: { res: string; usd: number }[] = []
  const re = /\$(\d+(?:\.\d+)?)\s*per\s*sec\w*\s*at\s*([0-9]+[pKk])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(seg)) !== null) {
    const usd = Number(m[1])
    const res = mapFalResolution(m[2])
    if (Number.isFinite(usd) && usd > 0 && res) out.push({ res, usd })
  }
  return out
}

function collectFal(models: AdapterModel[], fetchFn: CollectFetch): Promise<AdapterReport> {
  const candidates: CollectCandidate[] = []
  const skips: CollectSkip[] = []
  return (async () => {
    for (const m of models) {
      const pageUrl = `https://fal.ai/models/${m.gatewayModelId}/text-to-video`
      try {
        const resp = await fetchFn(pageUrl)
        if (!resp.ok) {
          for (const t of m.videoRes) skips.push({ modelKey: m.modelKey, spec: t, reason: `fal 页面拉取失败 HTTP ${resp.status}` })
          continue
        }
        const prices = parseFalVideoCosts(await resp.text())
        if (prices.length === 0) {
          for (const t of m.videoRes) skips.push({ modelKey: m.modelKey, spec: t, reason: 'fal 页面无「Video costs $X per second at RES」句式' })
          continue
        }
        const fx = fxUsdCny()
        const byRes = new Map(prices.map((p) => [p.res, p.usd]))
        for (const res of m.videoRes) {
          const usd = byRes.get(res)
          if (usd === undefined) {
            skips.push({ modelKey: m.modelKey, spec: res, reason: 'fal 该端点未提供此分辨率直价' })
            continue
          }
          candidates.push({
            modelKey: m.modelKey,
            spec: res,
            rowSpec: res,
            unit: 'per_second',
            unitQuantity: 1,
            costYuan: round4(usd * fx),
            source: 'official_list',
            evidence: { url: pageUrl, note: `fal 端点直价 $${usd}/秒 × fx ${fx}（LNKPI_FX_USD_CNY，录入侧折算 D9）` },
          })
        }
      } catch (err) {
        for (const t of m.videoRes) skips.push({ modelKey: m.modelKey, spec: t, reason: `fal 页面拉取异常：${err instanceof Error ? err.message : String(err)}` })
      }
    }
    return { upstream: 'fal', status: 'ok', candidates, skips }
  })()
}

// ── minimax：官方按量价目（MiniMax-H3：768P $0.08/s、2K $0.13/s，无 480P） ────

const MINIMAX_PRICING_URL = 'https://platform.minimax.io/docs/guides/pricing-paygo'
/** 官方牌价（USD/输出秒），核对于 2026-11-15；480P 官方不提供。 */
const MINIMAX_H3_USD_PER_SECOND: Partial<Record<string, number>> = { '768p': 0.08, '2k': 0.13 }

export function collectMinimax(models: AdapterModel[]): AdapterReport {
  const candidates: CollectCandidate[] = []
  const skips: CollectSkip[] = []
  const fx = fxUsdCny()
  for (const m of models) {
    for (const res of m.videoRes) {
      const usd = MINIMAX_H3_USD_PER_SECOND[res]
      if (usd === undefined) {
        skips.push({ modelKey: m.modelKey, spec: res, reason: 'MiniMax 官方价目未提供该分辨率（H3 仅 768P/2K），人工核对' })
        continue
      }
      candidates.push({
        modelKey: m.modelKey,
        spec: res,
        rowSpec: res,
        unit: 'per_second',
        unitQuantity: 1,
        costYuan: round4(usd * fx),
        source: 'official_list',
        evidence: { url: MINIMAX_PRICING_URL, note: `MiniMax 官方价目 MiniMax-H3 输出 $${usd}/秒 × fx ${fx}（录入侧折算 D9）` },
      })
    }
  }
  return { upstream: 'minimax', status: 'ok', candidates, skips }
}

// ── stepfun：官方价目（人民币直价；口径不匹配的档位 skip） ────────────────────

const STEPFUN_PRICING_URL = 'https://platform.stepfun.com/docs/zh/guides/pricing/details'
/** 元/百字符；核对于 2026-11-15（stepaudio-3-tts 为 11-09 新价，计费字符口径含汉字=3 折算，人工复核项）。 */
const STEPFUN_PER_100_CHARS: Record<string, number> = {
  'step-tts-mini': 0.009, // 0.9 元/万字符
  'stepaudio-3-tts': 0.0095, // 95 元/百万输入计费字符
}
const STEPFUN_SKIP_NOTE: Record<string, string> = {
  'stepaudio-3-gen-preview': '官方「设计/音色」按个计价，与主体 元/百字符 口径不匹配——人工卡片填数',
  'stepaudio-3-music-preview': '官方音乐按输出音频小时计价，与主体 元/首 口径不匹配——人工卡片填数',
}

export function collectStepfun(models: AdapterModel[]): AdapterReport {
  const candidates: CollectCandidate[] = []
  const skips: CollectSkip[] = []
  for (const m of models) {
    for (const t of m.audioTiers) {
      const skipNote = STEPFUN_SKIP_NOTE[m.modelKey]
      if (skipNote) {
        skips.push({ modelKey: m.modelKey, spec: t.spec, reason: skipNote })
        continue
      }
      const price = STEPFUN_PER_100_CHARS[m.modelKey]
      if (t.rowSpec !== 'per_100_chars' || price === undefined) {
        skips.push({ modelKey: m.modelKey, spec: t.spec, reason: '官方价目无此模型/档位的直价口径' })
        continue
      }
      candidates.push({
        modelKey: m.modelKey,
        spec: t.spec,
        rowSpec: t.rowSpec,
        unit: t.unit,
        unitQuantity: t.unitQuantity,
        costYuan: price,
        source: 'official_list',
        evidence: { url: STEPFUN_PRICING_URL, note: '阶跃官方价目（人民币直价）；stepaudio-3-tts 为 2026-11-09 新价（95 元/百万计费字符），计费字符口径差异待人工复核' },
      })
    }
  }
  return { upstream: 'stepfun', status: 'ok', candidates, skips }
}

// ── 服务 ────────────────────────────────────────────────────────────────────

/** 无适配器上游 → 人工（当前仅 agnes_hub）。 */
const ADAPTER_UPSTREAMS = new Set(['fal', 'zhipu', 'minimax', 'stepfun'])

/** 路由行最小形状（resolveUpstreamRoute 输入；DB 行字符串字段需窄化）。 */
type RouteRowLite = Pick<UpstreamRouteRow, 'matchType' | 'pattern' | 'capability' | 'upstream' | 'priority' | 'enabled' | 'fallbackApiKeyEnvName'>

@Injectable()
export class CostCollectService {
  private readonly logger = new Logger('CostCollect')
  constructor(
    private readonly prisma: PrismaService,
    @Inject(COST_COLLECT_FETCH) private readonly fetchFn: CollectFetch,
  ) {}

  async run(opts: { dryRun: boolean; upstreams?: string[] }): Promise<CollectRunReport> {
    const entries = await this.prisma.modelCatalogEntry.findMany({
      where: { deletedAt: null, modality: { in: ['video', 'audio'] } },
    })
    const routeRows = (await this.prisma.upstreamRoute.findMany()) as unknown as RouteRowLite[]
    const byUpstream = new Map<string, AdapterModel[]>()
    const uncovered = new Map<string, string[]>()
    for (const e of entries) {
      let upstream: UpstreamId | 'unroutable'
      try {
        upstream = resolveUpstreamRoute(routeRows as unknown as UpstreamRouteRow[], e.modelKey, e.modality as ModelCapability).upstream
      } catch {
        upstream = 'unroutable'
      }
      const model: AdapterModel = {
        modelKey: e.modelKey,
        gatewayModelId: e.gatewayModelId,
        videoRes: e.modality === 'video' ? [...ENUMERATED_VIDEO_RESOLUTIONS_CANONICAL] : [],
        audioTiers:
          e.modality === 'audio'
            ? (e.audioKind && ['voice', 'design', 'music'].includes(e.audioKind) ? [e.audioKind] : ['voice', 'design', 'music']).map((k) =>
                k === 'music' ? { spec: k, rowSpec: 'per_song', unit: 'per_call', unitQuantity: 1 } : { spec: k, rowSpec: 'per_100_chars', unit: 'per_call', unitQuantity: 100 },
              )
            : [],
      }
      if (ADAPTER_UPSTREAMS.has(upstream)) {
        const list = byUpstream.get(upstream) ?? []
        list.push(model)
        byUpstream.set(upstream, list)
      } else {
        const list = uncovered.get(upstream) ?? []
        list.push(model.modelKey)
        uncovered.set(upstream, list)
      }
    }

    const adapters: AdapterReport[] = []
    if (this.wants('zhipu', opts.upstreams)) adapters.push(collectZhipu(byUpstream.get('zhipu') ?? []))
    if (this.wants('fal', opts.upstreams) && (byUpstream.get('fal') ?? []).length > 0) adapters.push(await collectFal(byUpstream.get('fal') ?? [], this.fetchFn))
    if (this.wants('minimax', opts.upstreams)) adapters.push(collectMinimax(byUpstream.get('minimax') ?? []))
    if (this.wants('stepfun', opts.upstreams)) adapters.push(collectStepfun(byUpstream.get('stepfun') ?? []))

    let written = 0
    const keptManual: { modelKey: string; rowSpec: string }[] = []
    if (!opts.dryRun) {
      for (const rep of adapters) {
        for (const c of rep.candidates) {
          try {
            const existing = await this.prisma.costRate.findMany({
              where: { channel: 'platform', modelKey: c.modelKey, spec: c.rowSpec, effectiveTo: null },
            })
            // R2：人工（manual）与实测（channel_actual）优先，采集器绝不覆盖。
            const guarded = existing.some((r: { source: string; provisional: boolean }) => !r.provisional && (r.source === 'manual' || r.source === 'channel_actual'))
            if (guarded) {
              keptManual.push({ modelKey: c.modelKey, rowSpec: c.rowSpec })
              continue
            }
            await this.prisma.costRate.upsert({
              where: { channel_modelKey_spec: { channel: 'platform', modelKey: c.modelKey, spec: c.rowSpec } },
              create: { channel: 'platform', modelKey: c.modelKey, spec: c.rowSpec, unit: c.unit, unitQuantity: c.unitQuantity, costYuan: c.costYuan, source: c.source, provisional: false },
              update: { unit: c.unit, unitQuantity: c.unitQuantity, costYuan: c.costYuan, source: c.source, provisional: false, effectiveTo: null },
            })
            written += 1
            await this.retireLegacyPerVideo(c.modelKey, c.rowSpec)
          } catch (err) {
            this.logger.warn(`写入失败 ${c.modelKey}/${c.rowSpec}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
    }

    const report: CollectRunReport = {
      ranAt: new Date().toISOString(),
      dryRun: opts.dryRun,
      adapters,
      uncovered: [...uncovered.entries()].map(([upstream, modelKeys]) => ({ upstream, modelKeys })),
      written,
      keptManual,
    }
    this.logger.log(`cost-collect run dryRun=${opts.dryRun} written=${written} keptManual=${keptManual.length}`)
    return report
  }

  private wants(upstream: string, filter?: string[]): boolean {
    return !filter || filter.length === 0 || filter.includes(upstream)
  }

  /** 与定价中心 PUT 同款自迁移：per_second 落库后退役同族同分辨率 legacy per_video 行。 */
  private async retireLegacyPerVideo(modelKey: string, res: string): Promise<void> {
    const family = videoPriceFamily(modelKey)
    const legacy = await this.prisma.costRate.findMany({ where: { unit: 'per_video', effectiveTo: null } })
    for (const r of legacy) {
      if (videoPriceFamily(r.modelKey) === family && r.spec.startsWith(`${res}:`)) {
        await this.prisma.costRate.update({ where: { id: r.id }, data: { effectiveTo: new Date() } })
      }
    }
  }
}
