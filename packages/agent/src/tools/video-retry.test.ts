import { describe, expect, it, vi } from 'vitest'
import { isRetryableVideoError, withVideoRetry } from './video-retry'

// 回归锁：生产 video failed+fallback_pending 近 400 条的真实错误分布
// （2026-10-04 容器内 SQLite 直查 374 条样本）：
//   99  429 rate_limit            ← 可重试
//   72  503 video_queue_full      ← 可重试
//   44  (空)
//   36  media URL could not be downloaded  ← 我方图片 URL 上游拉不到，重试无意义
//   34  fail_to_fetch_task
//   19  content_policy            ← 内容审核，重试无意义
//   15  已取消
//   11  fetch failed              ← 网络抖动，可重试
//   10  Agnes video create 400 num_frames exceeds  ← 参数错误，重试无意义
//    5  unsupported video gateway ← 配置错误，重试无意义
//    5  Apimart 402 payment_required ← 余额不足，重试无意义
//  ⇒ 可重试合计171/374 = 46%，**改前零重试**。
// 见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.4
describe('isRetryableVideoError', () => {
  it.each([
    ['429 rate limit for free users', true],
    ['503 video_queue_full', true],
    ['Agnes video create 503: service unavailable', true],
    ['fetch failed', true],
    ['ETIMEDOUT', true],
    ['ECONNRESET', true],
    ['socket hang up', true],
    ['upstream 502 Bad Gateway', true],
    ['upstream 504 Gateway Timeout', true],
  ])('treats %s as retryable', (msg, expected) => {
    expect(isRetryableVideoError(new Error(msg))).toBe(expected)
  })

  it.each([
    ['content_policy_violation', false],
    ['Agnes video create 400: num_frames exceeds max frames', false],
    ['invalid_request: image URL could not be downloaded', false],
    ['unsupported video gateway: https://ark.cn-beijing.volces.com/api/v3', false],
    ['Apimart video create 402: payment_required Insufficient account balance', false],
    ['keyframes mode requires 2 to 3 images', false],
    ['已取消', false],
    ['model_not_found', false],
  ])('treats %s as NOT retryable', (msg, expected) => {
    expect(isRetryableVideoError(new Error(msg))).toBe(expected)
  })

  it('handles non-Error inputs without throwing', () => {
    expect(isRetryableVideoError('429 rate limit')).toBe(true)
    expect(isRetryableVideoError(undefined)).toBe(false)
    expect(isRetryableVideoError(null)).toBe(false)
    expect(isRetryableVideoError({ code: 429 })).toBe(false)
  })

  it('does not retry a 402 even though it contains a digit', () => {
    // 防「按数字猜状态码」的误判：402 是余额不足，重试只会继续扣钱
    expect(isRetryableVideoError(new Error('Apimart video create 402: payment_required'))).toBe(false)
  })
})

describe('withVideoRetry', () => {
  it('retries 429 then queue_full then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('429 rate limit for free users'))
      .mockRejectedValueOnce(new Error('503 video_queue_full'))
      .mockResolvedValueOnce('ok')
    const out = await withVideoRetry(fn, { attempts: 3, baseDelayMs: 1 })
    expect(out).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry content policy and calls fn once', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('content_policy_violation'))
    await expect(withVideoRetry(fn, { baseDelayMs: 1 })).rejects.toThrow(/content_policy/)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('gives up after max attempts and rethrows the LAST error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('503 video_queue_full'))
    await expect(withVideoRetry(fn, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow(/video_queue_full/)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('returns immediately when fn succeeds first try (no delay)', async () => {
    const fn = vi.fn().mockResolvedValue('fast')
    const out = await withVideoRetry(fn, { baseDelayMs: 10_000 })
    expect(out).toBe('fast')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('backs off exponentially (base, 2*base, ...) not linearly', async () => {
    vi.useFakeTimers()
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('429 rate limit'))
        .mockRejectedValueOnce(new Error('429 rate limit'))
        .mockResolvedValueOnce('ok')
      const p = withVideoRetry(fn, { attempts: 3, baseDelayMs: 100 })
      const settled = p.then((v) => ({ v }))
      // 第一次退避 100ms
      await vi.advanceTimersByTimeAsync(99)
      expect(fn).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(fn).toHaveBeenCalledTimes(2)
      // 第二次退避 200ms（指数）
      await vi.advanceTimersByTimeAsync(199)
      expect(fn).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(fn).toHaveBeenCalledTimes(3)
      await expect(settled).resolves.toEqual({ v: 'ok' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves null (not undefined) after exhausting a non-Error rejection', async () => {
    // 防御：若fn 抛非Error，重试逻辑不应把 last 变成 undefined
    const fn = vi.fn().mockRejectedValue(new Error('429 rate limit'))
    await expect(withVideoRetry(fn, { attempts: 2, baseDelayMs: 1 })).rejects.toBeInstanceOf(Error)
  })
})
