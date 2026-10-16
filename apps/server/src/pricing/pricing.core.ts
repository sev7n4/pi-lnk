/**
 * 定价纯函数核心（P0 等价迁移 · spec 2026-10-13-pricing-baseline-config-design.md §5）。
 *
 * 三条纪律：
 * 1. `legacyPriceOf` 是现行常量（shared/imageCredits、points/video-credits、
 *    shared/imageEditProfiles、text 5 / audio 5·15）的唯一委托出口——等价迁移的
 *    「旧行为」以它为准，金标准测试全网比对；
 * 2. 规范化函数（family/resolution/count）必须与 legacy 公式的**实际分支结果**
 *    逐档同果（大小写、未知值回落都算），否则表命中会静默改价；
 * 3. 本文件不碰 DB、不碰 Nest——种子、服务、测试三个消费方共用。
 */
import {
  IMAGE_EDIT_MODEL_PRICING,
  P1_IMAGE_EDIT_MODEL_KEY,
  imageGenerationCredits,
} from '@lnkpi/shared'
import { videoCreditsForModel } from '../points/video-credits'

export type PricingCapability = 'text' | 'image' | 'image_variant' | 'image_edit' | 'video' | 'audio'
export type AudioPriceKind = 'voice' | 'music'
export type VideoPriceFamily = 'default' | 'minimax-h3' | 'h3-max' | 'h3-max-turbo'

export interface PricingQuery {
  capability: PricingCapability
  modelKey?: string
  count?: number
  resolution?: string
  audioKind?: AudioPriceKind
  duration?: number
  videoMode?: string
  referenceImageCount?: number
  referenceVideoCount?: number
}

export interface PricingQuote {
  credits: number
  ruleVersion: string
  /** 灰度命中时的 release id；global/兜底路径为 undefined（条件写入账本，避免破坏既有断言） */
  grayReleaseId?: string
}

/** 走常量兜底时落账的 ruleVersion 字面量（与表版本区分，便于审计「这笔钱哪来的」）。 */
export const RULE_VERSION_CONSTANTS_FALLBACK = 'constants-fallback'

/** 镜像 videoCreditsForModel 的家族分支（h3-max 家族 / 官方 H3 / 其余）。 */
export function videoPriceFamily(modelKey?: string): VideoPriceFamily {
  const key = (modelKey || '').toLowerCase()
  if (key.includes('h3-max')) return key.includes('turbo') ? 'h3-max-turbo' : 'h3-max'
  if (key === 'minimax-h3' || (key.includes('minimax-h3') && !key.includes('h3-max'))) return 'minimax-h3'
  return 'default'
}

/**
 * 视频分辨率规范化：legacy 只区分 480（h3-max 家族系数）与 2k（官方 H3 系数），
 * 其余（720p/1080p/缺省/未知）全部等价 768p 档。
 */
export function canonicalVideoResolution(resolution?: string): '480p' | '768p' | '2k' {
  const res = (resolution || '768p').toLowerCase()
  if (res.includes('480')) return '480p'
  if (res.includes('2k')) return '2k'
  return '768p'
}

/** 镜像 FACTORS 查找：键大小写敏感，未命中回落 1K。 */
export function canonicalImageResolution(resolution?: string): '1K' | '2K' | '4K' {
  if (resolution === '2K') return '2K'
  if (resolution === '4K') return '4K'
  return '1K'
}

/** 镜像 imageGenerationCredits 的 count 钳制（1..4，非有限数回落 1）。 */
export function canonicalImageCount(count?: number): 1 | 2 | 3 | 4 {
  const raw = Number(count)
  if (!Number.isFinite(raw)) return 1
  return Math.max(1, Math.min(4, Math.floor(raw))) as 1 | 2 | 3 | 4
}

function canonicalVideoDuration(duration?: number): number {
  return Number.isFinite(duration) ? Number(duration) : 5
}

/**
 * 匹配键：种子枚举、价目查询、金标准测试三处同源。
 * video 段 = family:resolution:duration:mode:ri:rv；非 reference_to_video 的
 * ri/rv 恒规范为 0（legacy 在该模式不看参考数）。
 */
export function buildMatchKey(q: PricingQuery): string {
  switch (q.capability) {
    case 'text':
      return 'text'
    case 'image':
      return `image:${canonicalImageResolution(q.resolution)}:${canonicalImageCount(q.count)}`
    case 'image_variant':
      return 'image_variant'
    case 'image_edit':
      return `image_edit:${q.modelKey ?? P1_IMAGE_EDIT_MODEL_KEY}`
    case 'audio':
      return `audio:${q.audioKind ?? 'voice'}`
    case 'video': {
      const family = videoPriceFamily(q.modelKey)
      const isRef = family === 'minimax-h3' && q.videoMode === 'reference_to_video'
      const ri = isRef ? Math.max(0, Math.floor(q.referenceImageCount ?? 0)) : 0
      const rv = isRef ? Math.max(0, Math.floor(q.referenceVideoCount ?? 0)) : 0
      return `video:${family}:${canonicalVideoResolution(q.resolution)}:${canonicalVideoDuration(q.duration)}:${isRef ? 'ref' : '-'}:ri${ri}:rv${rv}`
    }
  }
}

/**
 * 文本 token 反比率行（P2 · spec §6.5）：`text:<modelKey>:in|cache|out` 三行一组，
 * credits 存反比率整数 `r = floor(1e6 / (costYuan × marginBp / 100))（等价于 floor(1e6 × 100 / (costYuan × marginBp))；勿写成 costYuan × 100 × marginBp——会差 100×）`。
 */
const TEXT_TOKEN_SPECS = ['in', 'cache', 'out'] as const

/**
 * 反比率行的 spec 全集。类型（本别名）与判据正则（TEXT_TOKEN_KEY_PATTERN）同源于
 * 上面的 TEXT_TOKEN_SPECS——新增 spec 只改一处。
 */
export type TextTokenSpec = (typeof TEXT_TOKEN_SPECS)[number]

/**
 * 文本 token 计费的 5 个模型键（P2，与 CostRate `per_1m_tokens_*` 行同键：
 * 小写连字符）。结算按此判定已知模型；未知模型 → USD 成本兜底。
 */
export const TEXT_TOKEN_MODELS: readonly string[] = [
  'step-3.5-flash',
  'step-3.7-flash',
  'step-2-16k',
  'step-5-preview',
  'minimax-m2.7',
  // agnes 文本渠道（PROVISIONAL 暂定）：平台在用的 agnes-2.0/2.5/3.0-flash 此前未进 RMB
  // 台账，quoteTextTokens 对它们会走 USD 兜底；补入后走精确 token 反比率。成本数值待
  // 「上游渠道定价全链路」立项打通后以真实 RMB/1M 覆盖（仅改 seed 成本行即可）。
  'agnes-2.0-flash',
  'agnes-2.5-flash',
  'agnes-3.0-flash',
]

/**
 * 反比率行匹配键。⚠️ `buildMatchKey` 的 `text` 单行分支不动——studio 文本直生
 * 仍走 `text` 单行 5 分（Out of Scope），两套键空间以 `text:` 前缀天然隔离。
 */
export function buildTextTokenMatchKey(modelKey: string, spec: TextTokenSpec): string {
  return `text:${modelKey}:${spec}`
}

/**
 * 反比率行匹配键正则（与 TEXT_TOKEN_SPECS 同源：新增 spec 只改 TEXT_TOKEN_SPECS 一处，
 * 正则会自动覆盖）。判别「价格行」（`text` 单价行 / `image:*` / `video:*` …）与「token 反比率行」
 * （`text:<model>:<spec>`）的唯一可靠键形判据——两者 capability 都可能是 'text'，不能靠它分。
 */
export const TEXT_TOKEN_KEY_PATTERN = /^text:[^:]+:(in|cache|out)$/

/** 是否文本 token 反比率行（键形 `text:<model>:<spec>`）。 */
export function isTextTokenMatchKey(matchKey: string): boolean {
  return TEXT_TOKEN_KEY_PATTERN.test(matchKey)
}

/** 地板违规项（价格行跌破下限 / 反比率行超过上限）。kind 供前端区分 floor/ceiling 渲染。 */
export interface FloorViolation {
  matchKey: string
  credits: number
  /** 临界值：kind='min' 为下限（floor）；kind='max' 为上限（ceiling）。 */
  limit: number
  kind: 'min' | 'max'
}

/** 地板毛利系数（×1.05，spec §10）。价格行下限与反比率行上限同源同一因子。 */
const FLOOR_MULTIPLIER = 105

/**
 * 统一地板校验（价格行 + 反比率行同源），发布流与种子两处共用。
 *
 * 价格行（非 `text:<model>:<spec>`）：售价 credits ≥ ceil(costYuan × 1.05) ⇒ kind='min'。
 *
 * 反比率行（`text:<model>:<spec>`）：credits=r（每 credit=r tokens）。计费 charge=ceil(tokens/r)
 * credit，每 credit 成本 = r × costYuan / 1e6 元；收入=0.01 元/credit。「收入 ≥ 成本×1.05」
 * 在 T=r 取等 ⇒ r × costYuan × 1.05 ≤ 1e4 ⇔ r ≤ floor(1e6/(costYuan×105)) ⇒ kind='max'。
 * 种子按 marginBp=11000（×1.10）现算 r ⇒ 110>105 ⇒ 任何种子行必过；本函数防的是未来映射
 * 改动（折扣/封顶/换锚）把带病条目混进草案/发布。
 *
 * costRateId 缺失或 costYuan 未知 ⇒ 返回 null（缺失成本不在地板判定内，由 missingCost 另行报告）。
 */
export function checkCostFloor(
  e: { matchKey: string; credits: number; costRateId: string | null },
  costYuan: number | undefined,
): FloorViolation | null {
  if (!e.costRateId) return null
  if (costYuan === undefined) return null
  if (isTextTokenMatchKey(e.matchKey)) {
    const limit = Math.floor(1_000_000 / (costYuan * FLOOR_MULTIPLIER))
    return e.credits > limit ? { matchKey: e.matchKey, credits: e.credits, limit, kind: 'max' } : null
  }
  const limit = Math.ceil(costYuan * FLOOR_MULTIPLIER)
  return e.credits < limit ? { matchKey: e.matchKey, credits: e.credits, limit, kind: 'min' } : null
}

/** 现行常量行为（= 迁移前的代码路径）。任何查询都可求值，用于兜底与金标准比对。 */
export function legacyPriceOf(q: PricingQuery): number {
  switch (q.capability) {
    case 'text':
      return 5
    case 'image':
      return imageGenerationCredits({ count: q.count, resolution: q.resolution })
    case 'image_variant':
      return 10
    case 'image_edit':
      return IMAGE_EDIT_MODEL_PRICING[q.modelKey ?? P1_IMAGE_EDIT_MODEL_KEY] ?? 10
    case 'audio':
      return q.audioKind === 'music' ? 15 : 5
    case 'video':
      return videoCreditsForModel({
        duration: canonicalVideoDuration(q.duration),
        modelKey: q.modelKey,
        resolution: q.resolution,
        videoMode: q.videoMode,
        referenceImageCount: q.referenceImageCount,
        referenceVideoCount: q.referenceVideoCount,
      })
  }
}

/**
 * 成本 → 积分（spec §5.1）：credits = ceil(成本(元) × 毛利系数 ÷ 积分锚(0.01元))。
 * P1 重定价消费；P0 种子不用它（条目显式值 = legacyPriceOf）。
 */
export function computeCreditsFromCost(costYuan: number, marginBp: number): number {
  return Math.ceil((costYuan * marginBp) / 100)
}

/**
 * 展示层预估（Q2 2026-10-14，spec §6.5/§6.7 呈现口径的先行实现）：
 * vendor usage.cost（USD，渠道 models[].pricing 四元组经 vendor calculateCost 算出）
 * → 元（× FX）→ 积分（复用 §5.1 公式 + MarginPolicy.marginBp）。
 *
 * ⚠️ 定位：**纯展示预估**，不落账、不扣分、不是 P2 §3.4 的权威 token 结算——
 * P2 价目表（每模型反比率行）落地后由 turn_settled 权威值覆盖。FX 只是 USD 计价
 * 渠道成本折元的近似，配置化（PRICING_FX_USD_CNY，默认 7.2）；CostRate 有该模型
 * token 行时应走元口径（那是官方实证成本），USD 路径是渠道 pricing 存在时的兜底。
 */
export const DEFAULT_FX_USD_CNY = 7.2

export function resolveFxUsdCny(env: { PRICING_FX_USD_CNY?: string } | undefined): number {
  const raw = env?.PRICING_FX_USD_CNY
  const v = raw ? Number(raw) : NaN
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_FX_USD_CNY
}

export function estimateCreditsFromUsdCost(
  costUsd: number,
  marginBp: number,
  fxUsdCny = DEFAULT_FX_USD_CNY,
): number {
  return computeCreditsFromCost(costUsd * fxUsdCny, marginBp)
}
