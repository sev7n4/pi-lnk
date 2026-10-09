/**
 * 上游（模型/图像/视频 API）调用的通用退避重试。
 *
 * ⚠️ 2026-10-05（U9）从 `video-retry.ts` 泛化而来。原先只有 video 侧有重试，
 * 但生产数据说明这是**分类错误** —— 重试是通用的上游韧性手段：
 *   audio          18成功率 100.0%
 *   image_edit     77   成功率  11.7%   ← 66 条失败里 31 条是 `fetch failed`
 *   image       3373   成功率  83.0%   ← 无任何重试
 *   video796   成功率  52.4%   ← U5 加了重试后才改善
 * 见 `docs/superpowers/specs/2026-10-04-media-generation-audit.md` §2.4
 *
 * ⚠️ **`fetch` 对 4xx/5xx 是正常返回（`ok: false`）而不抛异常** ⇒ 只把 `fetch`
 * 包进 `withUpstreamRetry` 的话重试**永远不会触发**，必须在 `!res.ok` 分支显式
 * `throw`。这是本模块最容易做错的一处，`image-provider` / `image-edit-provider`
 * 的接入点都遵守它。
 */

import { VIDEO_CREATE_RETRY_ATTEMPTS, VIDEO_CREATE_RETRY_BASE_DELAY_MS } from '@lnkpi/shared'

/**
 * 不可重试的规则**优先于**可重试的 —— 错误文案里常混数字：
 * `402 insufficient balance` / `403 User is locked` 含数字但重试只会继续扣钱
 * 或重复失败；而 `429` 本身明确可重试。
 */
const NON_RETRYABLE = [
  /content[_ ]policy/i,
  /payment_required/i,
  /\b402\b/,
  /\b403\b/,                // 含「User is locked. Reason: TOP_UP.」（账户欠费被锁）
  // ⚠️ 不能用 `\b4\d\d\b` 一刀切：**429 就是 4xx 且明确可重试**（video 侧 99 条）。
  // 只拦「除 429/403 外的 4xx」：
  /\b4(?:0[0-9]|1[0-9]|2[0-9]|3[0-9]|[45]\d)\d\b/,
  /insufficient balance/i,
  /user is locked/i,
  /invalid_request/i,
  /could not be downloaded/i, // 上游拉不到我方图片 URL，重试无意义
  /dimensions do not match/i, // mask 尺寸不匹配，参数错
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
  /fetch failed/i,        // image_edit 生产 31 条，最该重试
  /network/i,
  /timed? ?out/i,
  /temporarily unavailable/i,
]

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return ''
}

export function isRetryableUpstreamError(err: unknown): boolean {
  const msg = messageOf(err)
  if (!msg) return false
  if (NON_RETRYABLE.some((re) => re.test(msg))) return false
  return RETRYABLE.some((re) => re.test(msg))
}

export interface UpstreamRetryOptions {
  /** 总尝试次数（含首次），默认 3 */
  attempts?: number
  /** 首次退避基数，默认 1500；实际等待 base * 2^(n-1) */
  baseDelayMs?: number
  /** 每次重试前的钩子（用于日志/指标） */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withUpstreamRetry<T>(
  fn: () => Promise<T>,
  opts: UpstreamRetryOptions = {},
): Promise<T> {
  // 默认值来自 @lnkpi/shared/generationTimeoutBudget（跨层预算单一来源）：
  // web 墙钟与 reaper 阈值都由 attempts/timeout 派生，改默认值 = 改三层。
  const attempts = Math.max(1, opts.attempts ?? VIDEO_CREATE_RETRY_ATTEMPTS)
  const base = Math.max(0, opts.baseDelayMs ?? VIDEO_CREATE_RETRY_BASE_DELAY_MS)
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn()
    } catch (err) {
      const isLast = i === attempts - 1
      if (isLast || !isRetryableUpstreamError(err)) throw err
      const delayMs = base * 2 ** i
      opts.onRetry?.({ attempt: i + 1, delayMs, error: err })
      if (delayMs > 0) await sleep(delayMs)
    }
  }
  // 理论上不可达（循环内必定 return 或 throw），保留以满足类型收敛。
  throw new Error('withUpstreamRetry: unreachable')
}

/* ── 向后兼容：U5 的 video 侧调用点 ──────────────────────────────────────
 * `withVideoRetry` / `isRetryableVideoError` 保留为别名，避免改动
 * `video-provider.ts` 的既有 import（那是已上线并验证过的代码）。
 * 若将来 video 与 image 的重试策略需要分叉（例如 image 不重试 429），
 * 应从这两个名字分出独立实现，而不是在调用点加 if。
 */
export const withVideoRetry = withUpstreamRetry
export const isRetryableVideoError = isRetryableUpstreamError
export type VideoRetryOptions = UpstreamRetryOptions

/* ── 轮询阶段 HTTP 错误预算（P0-D / 诊断报告 V4）───────────────────────
 *
 * 背景：4 个 video provider 轮询一律 `if(!pollRes.ok) continue`，把 5xx/429
 * 当「等下一轮」无限吞掉，直到 `maxPollAttempts`/`deadline` 超时才抛
 * `timed out` —— 故障表现为「任务不返回」而非「任务失败」，监控看不到。
 * 见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.4 第 8 点。
 *
 * 改为：
 *  ① 4xx 非 429（401/403/404/422…）：非可重试，立即抛 —— 参数错或权限错，
 *     重试只会重复失败；带 body 便于定位。
 *  ② 5xx / 429：累计 consecutive 计数，超 `maxConsecutive` 抛错退出；
 *     未到阈值时打 warn（可观测），由调用方 `continue` 等下一轮。
 *  ③ 成功响应（调用方在 `pollRes.ok` 后）调 `reset()` 重置计数 —— 避免一次
 *     5xx 后的恢复被历史计数拖到阈值。
 *
 * ⚠️ 401/402/403 在 MiniMax/Fal 已有特定文案（ACCOUNT_ERROR_MESSAGE）的
 * 内联抛错，应在调 `recordHttpError` **之前**过滤掉，否则会被本函数覆盖成
 * 通用文案。Fal 的 `isAccountLockedError` 会消费 body，之后本函数 `res.text()`
 * 返回空串，不影响抛错（4xx 非 429 仍按 status 抛）。
 */
export interface PollErrorTracker {
  recordHttpError: (res: Response) => Promise<void>
  reset: () => void
}

export function createPollErrorTracker(providerName: string, maxConsecutive = 5): PollErrorTracker {
  let consecutive = 0
  return {
    async recordHttpError(res: Response) {
      consecutive += 1
      const status = res.status
      // 4xx 非 429：非可重试，立即抛（401/403/404/422…）
      if (status >= 400 && status < 500 && status !== 429) {
        const body = await res.text().catch(() => '')
        throw new Error(
          `${providerName} poll ${status} non-retryable${body ? ` — ${body.slice(0, 200)}` : ''}`,
        )
      }
      // 5xx / 429：超阈值抛
      if (consecutive >= maxConsecutive) {
        throw new Error(
          `${providerName} poll: ${consecutive} consecutive HTTP errors (last ${status})`,
        )
      }
      console.warn(`[${providerName}] poll ${status} (${consecutive}/${maxConsecutive} consecutive)`)
    },
    reset() {
      consecutive = 0
    },
  }
}
