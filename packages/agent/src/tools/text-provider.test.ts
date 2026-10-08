import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildDeepSeekThinkingFields,
  createTextProvider,
  isDeepSeekV4Model,
  OpenAITextProvider,
} from './text-provider'

describe('isDeepSeekV4Model', () => {
  it('matches common deepseek-v4 id shapes', () => {
    expect(isDeepSeekV4Model('deepseek-v4')).toBe(true)
    expect(isDeepSeekV4Model('deepseek-v4-pro')).toBe(true)
    expect(isDeepSeekV4Model('ch_x::deepseek-v4-flash')).toBe(true)
    expect(isDeepSeekV4Model('deepseek/deepseek-v4-pro')).toBe(true)
    expect(isDeepSeekV4Model('deepseek-flash')).toBe(true)
    expect(isDeepSeekV4Model('ch_x::deepseek-flash')).toBe(true)
    expect(isDeepSeekV4Model('gpt-4o')).toBe(false)
  })
})

describe('buildDeepSeekThinkingFields', () => {
  it('disables thinking by default', () => {
    expect(buildDeepSeekThinkingFields()).toEqual({ thinking: { type: 'disabled' } })
    expect(buildDeepSeekThinkingFields({ thinking: false })).toEqual({
      thinking: { type: 'disabled' },
    })
  })

  it('enables thinking with effort', () => {
    expect(buildDeepSeekThinkingFields({ thinking: true, thinkingEffort: 'high' })).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
    expect(buildDeepSeekThinkingFields({ thinking: true, thinkingEffort: 'max' })).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    })
  })
})

describe('createTextProvider', () => {
  const env = { ...process.env }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env = { ...env }
    process.env.OPENAI_API_KEY = 'env-key'
    process.env.OPENAI_BASE_URL = 'https://env.example.com/v1'
    process.env.OPENAI_CHAT_MODEL = 'env-model'
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    process.env = env
    vi.unstubAllGlobals()
  })

  it('uses explicit opts over env credentials', async () => {
    const provider = createTextProvider({
      apiKey: 'opts-key',
      baseUrl: 'https://opts.example.com/v1',
      model: 'opts-model',
    })
    expect(provider).toBeInstanceOf(OpenAITextProvider)
    await provider.generate('hello')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://opts.example.com/v1/chat/completions')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer opts-key' })
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'opts-model' })
  })

  it('falls back to env when apiKey is omitted', async () => {
    const provider = createTextProvider()
    await provider.generate('hello')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://env.example.com/v1/chat/completions')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer env-key' })
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'env-model' })
  })

  it('adds disabled thinking for deepseek-v4 by default', async () => {
    const provider = createTextProvider({
      apiKey: 'k',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
    })
    await provider.generate('hello', 'deepseek-v4-pro')
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body.stream).toBe(false)
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('adds enabled thinking + effort when requested', async () => {
    const provider = createTextProvider({
      apiKey: 'k',
      baseUrl: 'https://api.deepseek.com',
    })
    await provider.generate('hello', 'deepseek-v4-flash', {
      thinking: true,
      thinkingEffort: 'max',
    })
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('max')
  })

  it('does not add thinking fields for non-deepseek models', async () => {
    const provider = createTextProvider({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1' })
    await provider.generate('hello', 'gpt-4o', { thinking: true, thinkingEffort: 'max' })
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })
})

describe('OpenAITextProvider retry', () => {
  const env = { ...process.env }
  afterEach(() => {
    process.env = env
    vi.unstubAllGlobals()
  })

  it('retries on 429 then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'done' } }] }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const provider = createTextProvider({ apiKey: 'k', baseUrl: 'https://x.invalid/v1' })
    const { text } = await provider.generate('hello')
    expect(text).toBe('done')
    expect(fetchMock.mock.calls.length).toBe(2)
  }, 30_000)

  it('does not retry model_not_found', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 404, text: async () => 'model_not_found' })
    vi.stubGlobal('fetch', fetchMock)
    const provider = createTextProvider({ apiKey: 'k', baseUrl: 'https://x.invalid/v1' })
    await expect(provider.generate('hello')).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledOnce()
  }, 30_000)

  // ── 阈值锁死：attempts=3（与图片侧、vision 路径一致）────────────────────
  it('gives up after exactly 3 attempts on persistent 503', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, text: async () => 'unavailable' })
    vi.stubGlobal('fetch', fetchMock)
    const provider = createTextProvider({ apiKey: 'k', baseUrl: 'https://x.invalid/v1' })
    await expect(provider.generate('hello')).rejects.toThrow(/Text API 503/)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  }, 30_000)

  // ── retryCount 口径：实际重试次数（非总尝试数），与 vision 路径一致 ──────
  it('reports retryCount 0 when the first attempt succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'done' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const provider = createTextProvider({ apiKey: 'k', baseUrl: 'https://x.invalid/v1' })

    const result = await provider.generate('hello')

    expect(result.retryCount).toBe(0)
    expect(fetchMock).toHaveBeenCalledOnce()
  }, 30_000)

  it('reports retryCount 2 after two retried attempts (not 3 attempts)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'recovered' } }] }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const provider = createTextProvider({ apiKey: 'k', baseUrl: 'https://x.invalid/v1' })

    const result = await provider.generate('hello')

    expect(result.text).toBe('recovered')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // 总尝试 3 次 ⇒ 实际重试 2 次。口径若错成「总尝试数」这里会是 3。
    expect(result.retryCount).toBe(2)
  }, 30_000)
})
