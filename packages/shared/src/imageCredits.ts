/**
 * 图片生成积分定价（诊断 B4：此前 10×n 与模型/分辨率完全脱钩）。
 *
 * 单一真源：服务端 `studio.service.ts` 与前端 `apps/web/src/constants/credits.ts`
 * 都从这里取值——🔴 两处必须同进退，否则面板显示与实际扣分不符
 * （对齐 audio 的既有纪律，见 credits.ts 内注释）。
 *
 * 档位（按分辨率，base=10 分/张）：
 * - 1K ×1.0 = 10 分（存量默认不变）
 * - 2K ×1.5 = 15 分
 * - 4K ×2.0 = 20 分
 * 数字要调就改 FACTORS，两边自动跟上。
 */
import type { ImageResolutionTier } from './imageParams'

const BASE_IMAGE_CREDITS = 10

export const IMAGE_RESOLUTION_CREDIT_FACTORS: Record<ImageResolutionTier, number> = {
  '1K': 1,
  '2K': 1.5,
  '4K': 2,
}

export function imageGenerationCredits(input: { count?: number; resolution?: string }): number {
  const rawCount = Number(input.count)
  const count = Number.isFinite(rawCount) ? Math.max(1, Math.min(4, Math.floor(rawCount))) : 1
  const factor = IMAGE_RESOLUTION_CREDIT_FACTORS[(input.resolution ?? '1K') as ImageResolutionTier] ?? 1
  return Math.ceil(BASE_IMAGE_CREDITS * factor * count)
}
