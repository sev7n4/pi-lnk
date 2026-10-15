export type PointKind = 'consume' | 'refund' | 'grant' | 'freeze' | 'release'

export type PointCategory = 'text' | 'image' | 'audio' | 'video' | 'other'

export type PointTxStatus =
  | 'success'
  | 'failed_refund'
  | 'cancelled_refund'
  | 'byok_refund'
  | 'held'
  | 'released'

export interface PointTxMeta {
  kind: PointKind
  category: PointCategory
  status?: PointTxStatus | null
  model?: string | null
  generationId?: string | null
  /** 扣费时的价目表版本（P0 定价等价迁移；兜底路径为 'constants-fallback'）。 */
  ruleVersion?: string | null
  /** 灰度命中时的 release id（undefined = 走 global，不写库——保持既有断言逐字不变） */
  grayReleaseId?: string | null
  /** 关联冻结单 id（P2 token 计费 freeze/settle 链路透传；PointTransaction 无对应列，不落库） */
  holdId?: string
}

export function consumeMeta(
  category: PointCategory,
  extra: Partial<PointTxMeta> = {},
): PointTxMeta {
  return { kind: 'consume', category, status: 'success', ...extra }
}

export function refundMeta(
  category: PointCategory,
  status: PointTxStatus,
  extra: Partial<PointTxMeta> = {},
): PointTxMeta {
  return { kind: 'refund', category, status, ...extra }
}
