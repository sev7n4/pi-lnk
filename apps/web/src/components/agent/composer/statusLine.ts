/**
 * P1-3.1：composer 生成中状态行纯模块。
 * 输入已知什么就渲染什么；成本未知（null/undefined）→ 对应段为 null，UI **隐藏**而非置零。
 * eta = `约 ${Math.ceil(s)}s`（向上取整，39.6s → 约 40s）；points = `${Math.ceil(n)} 积分`
 *（#415 口径：积分一律向上取整，7.3 → 8）。
 */
export interface StatusLineModel {
  phase: string
  progress: number | null
  eta: string | null
  points: string | null
}
export function buildStatusLine(input: {
  phase?: string | null
  progressRatio?: number | null
  etaSeconds?: number | null
  points?: number | null
}): StatusLineModel {
  return {
    phase: input.phase ?? '生成中',
    progress: input.progressRatio ?? null,
    eta: input.etaSeconds == null ? null : `约 ${Math.ceil(input.etaSeconds)}s`,
    points: input.points == null ? null : `${Math.ceil(input.points)} 积分`,
  }
}
