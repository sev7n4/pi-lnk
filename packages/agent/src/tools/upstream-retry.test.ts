import { describe, expect, it, vi } from 'vitest'
import {
  isRetryableUpstreamError,
  withUpstreamRetry,
  withVideoRetry,
  isRetryableVideoError,
} from './upstream-retry'

// U9：把 U5 的 `withVideoRetry` 泛化为 `withUpstreamRetry`。
//
// 生产全量成功率实测（2026-10-05，容器内 SQLite 直查 4800+ 条）：
//   audio          18   成功率 100.0%
//   image_upscale  16   成功率   0.0%   ← 历史数据，功能已下线（代码零引用）
//   image_edit     77   成功率  11.7%   ← 31/66 失败是 `fetch failed`（可重试）
//   image       3373   成功率  83.0%
//   video        796   成功率  52.4%   ← U5 已改善
//⇒ image_edit 与 image 侧**完全没有重试**（`image-provider.ts` 里 retry 零命中），
//   而 video 侧 U5 已加。**重试是通用上游韧性手段，不该是视频专属。**
// 见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.4
describe('U9 泛化：video-retry → upstream-retry', () => {
  it('withVideoRetry / isRetryableVideoError 保持可用（向后兼容）', () => {
    expect(typeof withVideoRetry).toBe('function')
    expect(typeof isRetryableVideoError).toBe('function')
    // 行为一致
    expect(isRetryableVideoError(new Error('429 rate limit'))).toBe(true)
    expect(isRetryableVideoError(new Error('content_policy'))).toBe(false)
  })

  it('isRetryableVideoError 就是 isRetryableUpstreamError 的别名（同一套分类）', () => {
    const cases = [
      '429 rate limit for free users',
      '503 video_queue_full',
      'fetch failed',
      'content_policy_violation',
      'Apimart video create 402: payment_required',
      'Upscale API 403: {"detail":"User is locked. Reason: TOP_UP."}',
      'Image edit API 402: insufficient balance',
      'invalid_request: Mask dimensions do not match base image',
      'ETIMEDOUT',
    ]
    for (const msg of cases) {
      expect(isRetryableVideoError(new Error(msg))).toBe(isRetryableUpstreamError(new Error(msg)))
    }
  })
})

describe('isRetryableUpstreamError —— image_edit 的真实错误', () => {
  // 生产 image_edit 66 条失败的真实分布（2026-10-05 实测）
  // ⚠️ each 的行数组长度必须与回调形参数量一致，否则 TS2345
  it.each([
    ['fetch failed', true],
    ['Image edit API 500: internal error', true],
    ['Image edit API 502 Bad Gateway', true],
    ['Image edit API 504 Gateway Timeout', true],
    ['ETIMEDOUT', true],
    ['ECONNRESET', true],
  ])('%s -> 可重试', (msg, expected) => {
    expect(isRetryableUpstreamError(new Error(msg))).toBe(expected)
  })

  it.each([
    ['Image edit API 402: {"error":{"code":"","message":"[token_id=90701] insufficient balance"}}'],
    ['Upscale API 403: {"detail":"User is locked. Reason: TOP_UP."}'],
    ['Mask dimensions do not match base image'],
    ['content_policy_violation'],
  ])('%s -> 不可重试', (msg) => {
    expect(isRetryableUpstreamError(new Error(msg))).toBe(false)
  })

  it('402 单独拉黑：重试只会继续扣钱', () => {
    expect(
      isRetryableUpstreamError(new Error('Image edit API 402: insufficient balance')),
    ).toBe(false)
  })

  it('403 User is locked 不可重试（账户状态问题，重试无意义）', () => {
    expect(
      isRetryableUpstreamError(
        new Error('Upscale API 403: {"detail":"User is locked. Reason: TOP_UP."}'),
      ),
    ).toBe(false)
  })
})

describe('withUpstreamRetry', () => {
  it('retries fetch failed then succeeds（image_edit 最重要的场景）', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({ url: 'https://cdn/out.png' })
    await expect(withUpstreamRetry(fn, { baseDelayMs: 1 })).resolves.toEqual({
      url: 'https://cdn/out.png',
    })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry 402 insufficient balance（避免继续扣钱）', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Image edit API 402: insufficient balance'))
    await expect(withUpstreamRetry(fn, { baseDelayMs: 1 })).rejects.toThrow(/402/)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry 403 User is locked', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Upscale API 403: User is locked. Reason: TOP_UP.'))
    await expect(withUpstreamRetry(fn, { baseDelayMs: 1 })).rejects.toThrow(/403/)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('backs off exponentially and calls onRetry per attempt', async () => {
    const onRetry = vi.fn()
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce('ok')
    await expect(
      withUpstreamRetry(fn, { attempts: 3, baseDelayMs: 1, onRetry }),
    ).resolves.toBe('ok')
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry.mock.calls[0][0].delayMs).toBe(1)
    expect(onRetry.mock.calls[1][0].delayMs).toBe(2) // 指数：1*2^1
  })

  it('rethrows the LAST error after exhausting attempts', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed attempt1'))
      .mockRejectedValue(new Error('fetch failed last'))
    await expect(withUpstreamRetry(fn, { attempts: 2, baseDelayMs: 1 })).rejects.toThrow(
      /fetch failed last/,
    )
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
