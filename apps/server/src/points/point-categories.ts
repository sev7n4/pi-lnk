import type { PointCategory } from './point-tx.types'

/**
 * 生成记录类型 → 积分分类。
 *
 * 原先私有在 `studio.service.ts`，2026-10-08 抽到 points 域：
 * `GenerationReaperService` 需要按**同一条规则**决定退款交易的 category，
 * 否则同一笔钱扣在 `other`、退在 `image`，`points-usage` 的分类汇总会出现
 * 「image 退款 > image 消费」的错账（image_upscale 即属此类）。
 *
 * ⚠️ 改这里等于同时改扣费与退款两侧，务必同步核对 `completeImage` /
 * `image_edit` / 取消退款三条路径。
 */
export function studioPointCategory(type: string): PointCategory {
  if (type === 'text' || type === 'prompt') return 'text'
  if (type === 'image' || type === 'image_edit') return 'image'
  if (type === 'audio' || type === 'video') return type
  return 'other'
}
