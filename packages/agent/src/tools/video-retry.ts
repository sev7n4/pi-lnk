/**
 * 视频创建阶段的退避重试。
 *
 * ⚠️ 2026-10-04 新增。生产 video `failed` + `fallback_pending` 共 374 条样本里，
 * **171 条（46%）是明确可重试的**：
 *   - 99  `429 rate limit for free users`（跑在免费额度通道）
 *   - 72  `503 video_queue_full`（上游队列满，错误文案本身就写着「可重试」）
 *   - 11  `fetch failed` 等网络抖动
 * 而改前**零重试** —— 这些全部直接判失败。见
 * `docs/superpowers/specs/2026-10-04-media-generation-audit.md` §2.4
 *
 *⚠️ **只包「创建」阶段，不包轮询阶段**：轮询的 `continue` 已是「等下一轮」语义，
 * 重复它没有意义（且会叠加耗时）。
 */

/**
 * 不可重试的错误特征优先于可重试的 —— 因为错误文案里常混杂数字，
 * 例如 `402 payment_required` 含「402」但重试只会继续扣钱。
 */
const NON_RETRYABLE = [
  /content[_ ]policy/i,
  /payment_required/i,
  /\b402\b/,
  // ⚠️ 不能用 `\b4\d\d\b` 一刀切：**429 就是 4xx 且明确可重试**
  // （生产 99 条）。只拦「除 429 外的 4xx」：
  /\b4(?:0[0-9]|1[0-9]|2[0-9]|3[0-9]|[45]\d)\d\b/,
  /invalid_request/i,
  /could not be downloaded/i, // 上游拉不到我方图片 URL，重试无意义
  /unsupported video gateway/i,
  /model_not_found/i,
  /keyframes mode requires/i,
  /num_frames exceeds/i,
  /已取消/,
]

const RETRYABLE = [
  /\b429\b/,
  /rate[_ ]limit/i,
  /video_queue_full/i,
  /\b50[0234]\b/,        // 500/502/503/504
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /EPIPE/i,
  /socket hang up/i,
  /fetch failed/i,
  /network/i,
  /timed? ?out/i,
  /temporarily unavailable/i,
]

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return ''
}

export function isRetryableVideoError(err: unknown): boolean {
  const msg = messageOf(err)
  if (!msg) return false
  // 先判「明确不可重试」：4xx / 审核 / 余额 / 配置错误
  if (NON_RETRYABLE.some((re) => re.test(msg))) return false
  return RETRYABLE.some((re) => re.test(msg))
}

export interface VideoRetryOptions {
  /** 总尝试次数（含首次），默认 3 */
  attempts?: number
  /** 首次退避基数，默认 1500；实际等待 base * 2^(n-1) */
  baseDelayMs?: number
  /** 可选：每次重试前的钩子（用于日志/指标） */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withVideoRetry<T>(
  fn: () => Promise<T>,
  opts: VideoRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3)
  const base = Math.max(0, opts.baseDelayMs ?? 1500)
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn()
    } catch (err) {
      const isLast = i === attempts - 1
      if (isLast || !isRetryableVideoError(err)) throw err
      const delayMs = base * 2 ** i
      opts.onRetry?.({ attempt: i + 1, delayMs, error: err })
      if (delayMs > 0) await sleep(delayMs)
    }
  }
  // 理论上不可达（循环内必定 return 或 throw），保留以满足类型收敛。
  throw new Error('withVideoRetry: unreachable')
}
