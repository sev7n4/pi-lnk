/**
 * 指数退避 + 全抖动（multi-device Task 5）。
 *
 * 区间 [0.5, 1.5)×exp 而非 [0, exp)：后者在高并发重连时把请求打在同一「最早时刻」，
 * 前者既分散又不会把等待拖到用户以为断流（AWS 架构博客「Exponential Backoff and Jitter」）。
 *
 * 产出物：`backoffWithJitter(baseMs, capMs, attempt)`（plan「Interfaces · Produces」）。
 */
export function backoffWithJitter(baseMs: number, capMs: number, attempt: number): number {
  const exp = Math.min(baseMs * 2 ** attempt, capMs)
  return Math.floor(exp * (0.5 + Math.random()))
}
