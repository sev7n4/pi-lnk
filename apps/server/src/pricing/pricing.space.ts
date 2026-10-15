/**
 * 离散档位空间枚举（P0 · spec §6）。
 *
 * 唯一消费者：seed-pricing（写行）、金标准等价测试（逐档比对）。
 * 边界口径：
 * - 视频时长取前端 VIDEO_DURATION_OPTIONS（4/5/10/15）；表外时长（7/20…）
 *   归 enumerateOutOfSpaceCases，由 PricingService fallback 承接；
 * - 视频分辨率只枚举 canonical 三档（480p/768p/2k，720p·1080p 与 768p 同价），
 *   别名拼写归 enumerateAliasCases；
 * - 参考图加价仅官方 H3 + reference_to_video 生效（legacy 分支），
 *   ri 枚举 0..6（前 5 张免费）、rv 枚举 0..2。
 */
import type { PricingQuery } from './pricing.core'
import { TEXT_TOKEN_MODELS, type TextTokenSpec } from './pricing.core'

export const ENUMERATED_IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const
export const ENUMERATED_IMAGE_COUNTS = [1, 2, 3, 4] as const
export const ENUMERATED_VIDEO_MODEL_KEYS = ['seedance-2.0', 'h3-max', 'h3-max-turbo', 'minimax-h3'] as const
export const ENUMERATED_VIDEO_DURATIONS = [4, 5, 10, 15] as const
export const ENUMERATED_VIDEO_RESOLUTIONS_CANONICAL = ['480p', '768p', '2k'] as const
export const ENUMERATED_REF_IMAGE_COUNTS = [0, 1, 2, 3, 4, 5, 6] as const
export const ENUMERATED_REF_VIDEO_COUNTS = [0, 1, 2] as const

export function enumeratePricingSpace(): PricingQuery[] {
  const out: PricingQuery[] = []
  out.push({ capability: 'text' })
  for (const resolution of ENUMERATED_IMAGE_RESOLUTIONS) {
    for (const count of ENUMERATED_IMAGE_COUNTS) {
      out.push({ capability: 'image', resolution, count })
    }
  }
  out.push({ capability: 'image_variant' })
  // image_edit 的 '*' 默认行 = legacy 的 `?? 10`（BYOK 渠道编辑键走它）
  out.push({ capability: 'image_edit', modelKey: 'image2' })
  out.push({ capability: 'image_edit', modelKey: '*' })
  out.push({ capability: 'audio', audioKind: 'voice' })
  out.push({ capability: 'audio', audioKind: 'music' })
  for (const modelKey of ENUMERATED_VIDEO_MODEL_KEYS) {
    for (const resolution of ENUMERATED_VIDEO_RESOLUTIONS_CANONICAL) {
      for (const duration of ENUMERATED_VIDEO_DURATIONS) {
        out.push({ capability: 'video', modelKey, resolution, duration })
        if (modelKey === 'minimax-h3') {
          for (const ri of ENUMERATED_REF_IMAGE_COUNTS) {
            for (const rv of ENUMERATED_REF_VIDEO_COUNTS) {
              out.push({
                capability: 'video',
                modelKey,
                resolution,
                duration,
                videoMode: 'reference_to_video',
                referenceImageCount: ri,
                referenceVideoCount: rv,
              })
            }
          }
        }
      }
    }
  }
  return out
}

// —— P2 T4：文本 token 反比率行枚举 ——

export interface TextTokenRowSpec {
  modelKey: string
  spec: TextTokenSpec
}

/** step-2-16k 上游未公布 cache 价（CostRate 无 per_1m_tokens_cache 行）→ 不枚举 cache 行。 */
const TEXT_TOKEN_MODELS_WITH_CACHE: readonly string[] = [
  'step-3.5-flash',
  'step-3.7-flash',
  'step-5-preview',
  'minimax-m2.7',
]

/**
 * 文本 token 反比率行枚举（P2 · spec §6.5）：5 模型 × in/out 全量 + cache 4 行 = 14 行。
 *
 * 刻意**不并入** enumeratePricingSpace()：那里的每个 case 都必须能过 legacyPriceOf
 * （v1 seed 逐行落 legacy 值、启动自检、金标准 tripwire 三处共同前提），而 token
 * 反比率行没有 legacy 常量、只进新版本（v1 不重播——Global Constraints 生命线）。
 * 消费者（v2 草案种子/发布流）参照既有 image/video 行的挂法：按 (modelKey, spec)
 * 查 CostRate `per_1m_tokens_*` 行，用
 * `r = floor(1e6 / (costYuan × marginBp / 100))（等价于 floor(1e6 × 100 / (costYuan × marginBp))；勿写成 costYuan × 100 × marginBp——会差 100×）` 现算反比率并挂 costRateId
 * （basis='launch-reprice'，marginBp 取当前生效阶段，缺省 11000bp）。
 */
export function enumerateTextTokenRows(): TextTokenRowSpec[] {
  const out: TextTokenRowSpec[] = []
  for (const modelKey of TEXT_TOKEN_MODELS) {
    out.push({ modelKey, spec: 'in' })
    out.push({ modelKey, spec: 'out' })
    if (TEXT_TOKEN_MODELS_WITH_CACHE.includes(modelKey)) {
      out.push({ modelKey, spec: 'cache' })
    }
  }
  return out
}

/** 别名拼写：规范化后必须命中同一条种子行且价格不变。 */
export function enumerateAliasCases(): PricingQuery[] {
  return [
    { capability: 'image', resolution: '720p', count: 1 },
    { capability: 'image', resolution: '2k', count: 1 },
    { capability: 'image', count: 2 },
    { capability: 'image', count: 9 },
    { capability: 'image_edit', modelKey: 'ch9::gpt-image-2' },
    { capability: 'audio' },
    { capability: 'video', modelKey: 'ch1::sora', duration: 5 },
    { capability: 'video', modelKey: 'MiniMax-H3', duration: 5 },
    { capability: 'video', modelKey: 'h3-max', resolution: '1080p', duration: 5 },
    { capability: 'video', modelKey: 'minimax-h3', duration: 5, videoMode: 'image_to_video', referenceImageCount: 3 },
    { capability: 'video', modelKey: 'h3-max', resolution: '480P', duration: 10 },
    // '8K' 静默归一化为 1K（legacy FACTORS 查找同样回落 factor 1，价格等价），
    // 键 image:1K:1 在种子空间内——是别名而非表外组合。
    { capability: 'image', count: 1, resolution: '8K' },
  ]
}

/** 表外组合：键不在种子行 ⇒ 必须走 fallback 且价格等于 legacy。 */
export function enumerateOutOfSpaceCases(): PricingQuery[] {
  return [
    { capability: 'video', modelKey: 'seedance-2.0', duration: 7 },
    { capability: 'video', modelKey: 'seedance-2.0', duration: 20 },
    { capability: 'video', modelKey: 'minimax-h3', duration: 6, resolution: '768p' },
  ]
}
