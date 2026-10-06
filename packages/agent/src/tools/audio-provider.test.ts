import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAudioProvider, OpenAITTSProvider, splitTextForTts } from './audio-provider'

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

describe('splitTextForTts', () => {
  // 上游硬约束：StepFun input ≤ 1000 字符，超限返 400。切分必须保证每片 ≤ limit。
  it('keeps short text as a single chunk', () => {
    expect(splitTextForTts('短句。', 1000)).toEqual(['短句。'])
  })

  it('splits at sentence punctuation and never exceeds the limit', () => {
    const sentence = '这是一句用于测试分片逻辑的中文台词。'
    const text = sentence.repeat(120) // 1080+ 字符
    const chunks = splitTextForTts(text, 1000)

    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000)
    // 无字符丢失：拼回去等于原文（去空白后）
    expect(chunks.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''))
  })

  it('hard-splits when a single sentence exceeds the limit', () => {
    const noPunct = '啊'.repeat(2500)
    const chunks = splitTextForTts(noPunct, 1000)
    expect(chunks).toHaveLength(3)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000)
    expect(chunks.join('')).toBe(noPunct)
  })

  it('returns empty array for blank input', () => {
    expect(splitTextForTts('   ', 1000)).toEqual([])
  })
})

describe('OpenAITTSProvider StepFun 适配', () => {
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

  it('passes instruction through and does not truncate at 4096 for step models', async () => {
    const provider = new OpenAITTSProvider('k', 'https://api.stepfun.com/v1', 'stepaudio-3-tts')
    const text = '这是一句台词。'.repeat(400) // 2800 字符 > 1000
    await provider.generate(text, { voice: 'cixingnansheng', instruction: '语气严肃郑重' })

    // 1000 字上限 ⇒ 至少 3 次调用（不是 1 次超长请求）
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3)
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      const body = JSON.parse(String(init.body))
      expect(body.model).toBe('stepaudio-3-tts')
      expect(body.voice).toBe('cixingnansheng')
      expect(body.instruction).toBe('语气严肃郑重')
      expect(body.input.length).toBeLessThanOrEqual(1000)
      // StepFun 无 pitch 语义：未显式传入时不得出现该字段
      expect('pitch' in body).toBe(false)
    }
  })

  it('keeps 4096 single-request behaviour for non-step models', async () => {
    const provider = new OpenAITTSProvider('k', 'https://api.example.com/v1', 'tts-1')
    const text = 'a'.repeat(2000)
    await provider.generate(text)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body)).input).toHaveLength(2000)
  })

  it('concatenates chunk audio into one data url', async () => {
    const provider = new OpenAITTSProvider('k', 'https://api.stepfun.com/v1', 'step-tts-mini')
    fetchMock
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new Uint8Array([4, 5]).buffer })

    const { url } = await provider.generate('一。'.repeat(600))
    const b64 = url.replace('data:audio/mpeg;base64,', '')
    expect(Buffer.from(b64, 'base64')).toEqual(Buffer.from([1, 2, 3, 4, 5]))
  })

  it('rejects on empty input instead of calling upstream with blank text', async () => {
    const provider = new OpenAITTSProvider('k', 'https://api.stepfun.com/v1', 'step-tts-mini')
    await expect(provider.generate('   ')).rejects.toThrow(/输入为空/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('propagates upstream failure from any chunk (no partial audio)', async () => {
    const provider = new OpenAITTSProvider('k', 'https://api.stepfun.com/v1', 'step-tts-mini')
    fetchMock
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer })
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'input too long' })

    await expect(provider.generate('一。'.repeat(600))).rejects.toThrow(/TTS API 400/)
  })

  // 回归锁：模型前缀识别曾写成 /^step(tts|audio)-/，只匹配 stepaudio-*，
  // **漏掉全部 step-tts-*** ⇒ 1000 字上限静默失效，最便宜那档被上游 400 拒掉。
  it.each([
    ['step-tts-mini'],
    ['step-tts-2'],
    ['step-tts-vivid'],
    ['stepaudio-3-tts'],
    ['stepaudio-2.5-tts'],
  ])('applies the 1000-char limit to %s', async (model) => {
    const provider = new OpenAITTSProvider('k', 'https://api.stepfun.com/v1', model)
    await provider.generate('一。'.repeat(600))
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(JSON.parse(String(init.body)).input.length, model).toBeLessThanOrEqual(1000)
    }
    expect(fetchMock.mock.calls.length, model).toBe(2)
  })

  it.each([['tts-1'], ['gpt-4o-mini-tts'], ['speech-2.8-hd'], ['seed-audio-1.0']])(
    'keeps the 4096 limit for non-StepFun model %s',
    async (model) => {
      const provider = new OpenAITTSProvider('k', 'https://api.example.com/v1', model)
      await provider.generate('一。'.repeat(600)) // 1200 chars
      expect(fetchMock).toHaveBeenCalledOnce()
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(JSON.parse(String(init.body)).input).toHaveLength(1200)
    },
  )
})
