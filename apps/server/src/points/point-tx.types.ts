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
  /**
   * Epic 1（spec 2026-11-03-credit-consumption-display-design）：关联会话 id。
   * 经 consumeMeta/refundMeta 的 `extra` 透传，由 PointsService 写入
   * `pointTransaction.sessionId`（键不出现纪律：缺省不落地）。
   */
  sessionId?: string | null
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
