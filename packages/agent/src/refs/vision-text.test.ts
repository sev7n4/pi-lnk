import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  DEFAULT_VISION_USER_PROMPT,
  ECOMMERCE_VISION_SYSTEM,
  generateTextWithImages,
} from './vision-text'

describe('generateTextWithImages without key', () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY
  })

  it('throws instead of returning a placeholder', async () => {
    await expect(
      generateTextWithImages('春季连衣裙', ['https://example.com/dress.jpg']),
    ).rejects.toThrow(/credentials missing/)
  })

  it('never returns placeholder draft content', async () => {
    await expect(
      generateTextWithImages('', ['https://example.com/a.jpg']),
    ).rejects.toThrow()
    // 断言：不可能出现占位文案
    await expect(
      generateTextWithImages('x', ['https://example.com/a.jpg']).catch((e: Error) => e.message),
    ).resolves.not.toContain('草案')
  })
})

describe('generateTextWithImages with key', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.OPENAI_API_KEY
  })

  it('calls vision chat with image_url parts and ecommerce system', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'vision result' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const urls = ['https://example.com/i1.jpg', 'https://example.com/i2.jpg']
    const result = await generateTextWithImages('衣服图', urls, { apiKey: 'test-key' })

    expect(result).toEqual({ text: 'vision result', retryCount: 0 })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as {
      stream?: boolean
      messages: Array<{ role: string; content: unknown }>
    }
    expect(body.stream).toBe(false)
    expect(body.messages[0]).toEqual({ role: 'system', content: ECOMMERCE_VISION_SYSTEM })
    const userContent = body.messages[1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>
    expect(userContent[0]).toEqual({ type: 'text', text: '衣服图' })
    expect(userContent[1]).toEqual({ type: 'image_url', image_url: { url: urls[0] } })
    expect(userContent[2]).toEqual({ type: 'image_url', image_url: { url: urls[1] } })
  })

  it('falls back to DEFAULT_VISION_USER_PROMPT when user prompt is blank', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'vision result' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await generateTextWithImages('   ', ['https://example.com/a.jpg'], { apiKey: 'test-key' })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: unknown }>
    }
    const userContent = body.messages[1].content as Array<{ type: string; text?: string }>
    expect(userContent[0]).toEqual({ type: 'text', text: DEFAULT_VISION_USER_PROMPT })
  })

  it('throws when API returns !ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'err' }))
    await expect(
      generateTextWithImages('x', ['https://example.com/a.jpg'], { apiKey: 'test-key' }),
    ).rejects.toThrow(/Vision API/)
    // 500 属可重试（`upstream-retry.ts` 的 `/50[0234]/`），故本用例现在会走满
    // 3 次尝试 + 1.5s/3s 退避 ≈ 4.5s，墙钟远超默认 5s ⇒ 必须显式放宽。
  }, 30_000)

  it('throws when no image urls', async () => {
    await expect(generateTextWithImages('x', [], { apiKey: 'test-key' })).rejects.toThrow(/至少提供一张参考图/)
  })
})

/**
 * 上游韧性：超时必须有界 + 可重试错误必须真的重试。
 *
 * ⚠️ 这里的用例是2026-10-08 事故的回归锁。`vision-text.ts` 曾是文本侧
 * 唯一无超时保护的上游请求（`fetch` 无 `AbortSignal` ⇒ await 永不 settle）。
 */
describe('generateTextWithImages upstream resilience', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    delete process.env.OPENAI_API_KEY
  })

  it('aborts a hanging upstream instead of pending forever', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const pending = generateTextWithImages('x', ['https://example.com/a.jpg'], { apiKey: 'k' })
    const assertion = expect(pending).rejects.toThrow(/timeout/i)
    // 每次尝试 45s 超时，重试退避 1.5s + 3s ⇒ 最坏 3*45s + 4.5s = 139.5s。
    // 推进超过这个预算仍未settle ⇒ 说明超时/abort 没生效（await 永久挂起）。
    await vi.advanceTimersByTimeAsync(200_000)
    await assertion
    // 超时错误可重试 ⇒ 必须真的重试到 3 次尝试，而不是首次超时就放弃。
    expect(fetchMock.mock.calls.length).toBe(3)
  })

  it('retries on 503 and succeeds on second attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok result' } }] }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateTextWithImages('x', ['https://example.com/a.jpg'], {
      apiKey: 'k',
      baseUrl: 'https://example.invalid/v1',
    })
    expect(result.text).toBe('ok result')
    expect(fetchMock.mock.calls.length).toBe(2)
  }, 30_000)

  it('does not retry on non-retryable error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 400, text: async () => 'model_not_found' })
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      generateTextWithImages('x', ['https://example.com/a.jpg'], {
        apiKey: 'k',
        baseUrl: 'https://example.invalid/v1',
      }),
    ).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledOnce()
  }, 30_000)

  // ── retryCount 透传：语义是「实际重试次数」，不是总尝试数 ──────────────
  it('reports retryCount 0 when the first attempt succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'first try' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateTextWithImages('x', ['https://example.com/a.jpg'], { apiKey: 'k' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(result.retryCount).toBe(0)
  })

  it('reports retryCount 1 after one retried attempt (not 2 attempts)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'recovered' } }] }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateTextWithImages('x', ['https://example.com/a.jpg'], { apiKey: 'k' })
    expect(fetchMock.mock.calls.length).toBe(2)
    expect(result.retryCount).toBe(1)
  }, 30_000)

  it('reports retryCount 2 when both retries are consumed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'recovered late' } }] }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateTextWithImages('x', ['https://example.com/a.jpg'], { apiKey: 'k' })
    expect(fetchMock.mock.calls.length).toBe(3)
    expect(result.retryCount).toBe(2)
  }, 30_000)
})
