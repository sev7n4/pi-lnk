import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAudioProvider, OpenAITTSProvider } from './audio-provider'

describe('createAudioProvider', () => {
  const env = { ...process.env }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env = { ...env }
    process.env.OPENAI_API_KEY = 'env-key'
    process.env.OPENAI_BASE_URL = 'https://env.example.com/v1'
    process.env.OPENAI_TTS_MODEL = 'env-tts'
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    process.env = env
    vi.unstubAllGlobals()
  })

  it('uses explicit opts over env credentials', async () => {
    const provider = createAudioProvider({
      apiKey: 'opts-key',
      baseUrl: 'https://opts.example.com/v1',
      model: 'opts-tts',
    })
    expect(provider).toBeInstanceOf(OpenAITTSProvider)
    await provider.generate('hello')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://opts.example.com/v1/audio/speech')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer opts-key' })
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'opts-tts' })
  })

  // 回归锁：生产 18/18 条 audio 记录落库的是 soundhelix 示例曲、hasTtsData 全 false、
  // 扣费 18 笔退款 0 笔。根因是 FallbackAudioProvider catch 后返回占位 MP3 且不抛错，
  // 于是不进 service 的 catch、不退款、status 写 completed。见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.2
  it('does NOT fall back to a placeholder when the primary TTS fails', async () => {
    const provider = createAudioProvider({
      apiKey: 'k',
      baseUrl: 'https://apihub.agnes-ai.cn/v1',
      model: 'speech-2.8-hd',
    })
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'model_not_found: No available channel',
    })

    await expect(provider.generate('hello')).rejects.toThrow(/TTS API 503/)
    // 关键：不得有第二次调用去取占位音频
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws when no API key is configured instead of returning a placeholder', () => {
    delete process.env.OPENAI_API_KEY
    expect(() => createAudioProvider(undefined)).toThrow(/音频通道未配置/)
  })

  it('does not return the soundhelix placeholder for an Agnes base url', async () => {
    process.env.OPENAI_BASE_URL = 'https://apihub.agnes-ai.cn/v1'
    const provider = createAudioProvider(undefined)
    expect(provider).toBeInstanceOf(OpenAITTSProvider)

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'model_not_found',
    })
    const outcome = provider.generate('hello').then(
      (r) => ({ resolved: r }),
      (e) => ({ rejected: e }),
    )
    const settled = await outcome
    expect('rejected' in settled).toBe(true)
    expect(JSON.stringify(settled)).not.toContain('soundhelix')
  })
})

describe('OpenAITTSProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('passes model, voice, speed, volume, pitch, emotion in request body', async () => {
    const provider = new OpenAITTSProvider('test-key', 'https://api.example.com/v1', 'tts-1')
    await provider.generate('hello', {
      model: 'tts-1-hd',
      voice: 'nova',
      speed: 1.2,
      volume: 0.8,
      pitch: 1.1,
      emotion: 'happy',
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'tts-1-hd',
      input: 'hello',
      voice: 'nova',
      speed: 1.2,
      volume: 0.8,
      pitch: 1.1,
      emotion: 'happy',
    })
  })

  it('accepts legacy voice string overload', async () => {
    const provider = new OpenAITTSProvider('test-key', 'https://api.example.com/v1', 'tts-1')
    await provider.generate('hello', 'shimmer')

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'tts-1',
      voice: 'shimmer',
    })
  })

  it('defaults voice to alloy when options omitted', async () => {
    const provider = new OpenAITTSProvider('test-key', 'https://api.example.com/v1', 'tts-1')
    await provider.generate('hello')

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ voice: 'alloy' })
  })
})
