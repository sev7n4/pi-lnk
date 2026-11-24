import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioGenerateOptions, OpenAITTSProvider } from './audio-provider'
import {
  createVoiceStudioAudioProvider,
  fetchVoiceStudioVoices,
  parseVoiceStudioVoicesResponse,
  probeVoiceStudioHealth,
  VOICESTUDIO_UNAVAILABLE_MESSAGE,
  VoiceStudioTTSProvider,
  __resetVoiceStudioHealthCacheForTests,
} from './voice-studio-tts'

/** 构造响应 helper：speech 用 mp3 字节；health 用 JSON。 */
function okRes(body: ArrayBuffer | Record<string, unknown>) {
  const buf = body instanceof ArrayBuffer ? body : new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer
  return { ok: true, status: 200, arrayBuffer: async () => buf, text: async () => JSON.stringify(body) }
}

function failRes(status: number, text: string) {
  return { ok: false, status, arrayBuffer: async () => new ArrayBuffer(0), text: async () => text }
}

const MP3_BYTES = new Uint8Array([1, 2, 3]).buffer

/** 造一段 n 字符、按句号收尾的文本（切分测试用，保证切点落在句末标点）。 */
function sentenceText(n: number): string {
  const unit = '这一句有九字。'
  let out = ''
  while (out.length < n) out += unit
  return out.slice(0, n)
}

describe('VoiceStudioTTSProvider 字段映射', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    __resetVoiceStudioHealthCacheForTests()
    fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return okRes({ status: 'ok' })
      return okRes(MP3_BYTES)
    })
  })

  it('instruction 单数映射为 VS 的 instructions 复数；volume/pitch/emotion 不发送；speed 直通', async () => {
    const provider = new VoiceStudioTTSProvider('k', 'http://vs.example.com:3900', 'omnivoice', fetchMock as unknown as typeof fetch)
    const opts: AudioGenerateOptions = {
      voice: 'default',
      speed: 1.2,
      instruction: '语气明快欢快，节奏轻快，带一点笑意',
      emotion: 'happy',
      volume: 1.0,
      pitch: 1,
    }
    await provider.generate('你好世界', opts)

    const speechCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/audio/speech'))
    expect(speechCalls).toHaveLength(1)
    const [, init] = speechCalls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      model: 'omnivoice',
      input: '你好世界',
      voice: 'default',
      speed: 1.2,
      instructions: '语气明快欢快，节奏轻快，带一点笑意',
      response_format: 'mp3',
    })
    // VS 静默忽略的三字段：一律不发送（发送 = 伪装成已生效，比报错更具误导性）
    expect(body).not.toHaveProperty('emotion')
    expect(body).not.toHaveProperty('volume')
    expect(body).not.toHaveProperty('pitch')
    expect(body).not.toHaveProperty('instruction')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer k' })
  })

  it('voice 缺省为 default（VS 实测直用），而非基类的 alloy', async () => {
    const provider = new VoiceStudioTTSProvider('k', 'http://vs.example.com:3900', 'omnivoice', fetchMock as unknown as typeof fetch)
    await provider.generate('你好')
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/audio/speech')) as [string, RequestInit]
    expect(JSON.parse(String(init.body)).voice).toBe('default')
  })
})

describe('VoiceStudio 探活门（生成前置，显式报错禁静默）', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    __resetVoiceStudioHealthCacheForTests()
    fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return okRes({ status: 'ok' })
      return okRes(MP3_BYTES)
    })
  })

  it('generate 前先打 /health，探活通过才打 /audio/speech（顺序断言）', async () => {
    const provider = new VoiceStudioTTSProvider('k', 'http://vs.example.com:3900/', 'omnivoice', fetchMock as unknown as typeof fetch)
    await provider.generate('你好')
    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls[0]).toBe('http://vs.example.com:3900/health')
    expect(urls).toContain('http://vs.example.com:3900/audio/speech')
    expect(urls.indexOf('http://vs.example.com:3900/health')).toBeLessThan(urls.indexOf('http://vs.example.com:3900/audio/speech'))
  })

  it('探活 500 ⇒ generate 显式报错（文案指路云端模型），绝不打 speech、绝不静默换道', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return failRes(500, 'boom')
      return okRes(MP3_BYTES)
    })
    const provider = new VoiceStudioTTSProvider('k', 'http://vs.example.com:3900', 'omnivoice', fetchMock as unknown as typeof fetch)
    await expect(provider.generate('你好')).rejects.toThrow(VOICESTUDIO_UNAVAILABLE_MESSAGE)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/audio/speech'))).toBe(false)
  })

  it('探活网络异常/超时 ⇒ 同样显式报错（不可用必须可判读）', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) throw new Error('upstream timeout after 5000ms: http://vs.example.com:3900/health')
      return okRes(MP3_BYTES)
    })
    const provider = new VoiceStudioTTSProvider('k', 'http://vs.example.com:3900', 'omnivoice', fetchMock as unknown as typeof fetch)
    await expect(provider.generate('你好')).rejects.toThrow(/upstream timeout after 5000ms/)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/audio/speech'))).toBe(false)
  })

  it('探活成功 60s 内缓存命中：第二次 generate 不再打 /health', async () => {
    const provider = new VoiceStudioTTSProvider('k', 'http://vs.example.com:3900', 'omnivoice', fetchMock as unknown as typeof fetch)
    await provider.generate('第一次')
    await provider.generate('第二次')
    const healthCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/health'))
    expect(healthCalls).toHaveLength(1)
  })

  it('baseUrl 含 /v1（OMNIVOICE_BASE_URL 契约）：speech 走 {base}/audio/speech，health 剥 /v1 走根路径', async () => {
    const provider = new VoiceStudioTTSProvider('k', 'http://vs.example.com:3900/v1', 'omnivoice', fetchMock as unknown as typeof fetch)
    await provider.generate('你好')
    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    // VS 固定拓扑：/health 挂根（spike 实测），/v1/* 才是 OpenAI 兼容面
    expect(urls[0]).toBe('http://vs.example.com:3900/health')
    expect(urls).toContain('http://vs.example.com:3900/v1/audio/speech')
  })

  it('探活失败同样缓存（60s 快速失败）：第二次 generate 不重打 /health、文案一致', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return failRes(502, 'down')
      return okRes(MP3_BYTES)
    })
    const provider = new VoiceStudioTTSProvider('k', 'http://vs.example.com:3900', 'omnivoice', fetchMock as unknown as typeof fetch)
    await expect(provider.generate('第一次')).rejects.toThrow(VOICESTUDIO_UNAVAILABLE_MESSAGE)
    const healthCallsAfterFirst = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/health')).length
    await expect(provider.generate('第二次')).rejects.toThrow(VOICESTUDIO_UNAVAILABLE_MESSAGE)
    const healthCallsAfterSecond = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/health')).length
    expect(healthCallsAfterSecond).toBe(healthCallsAfterFirst)
  })
})

describe('VoiceStudio 失败契约与切分', () => {
  beforeEach(() => {
    __resetVoiceStudioHealthCacheForTests()
  })

  it('speech 503 ⇒ generate reject（2026-10-04 家族契约：不兜底占位音频、不重试换道）', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return okRes({ status: 'ok' })
      return failRes(503, 'engine not ready')
    })
    const provider = new VoiceStudioTTSProvider('k', 'http://vs.example.com:3900', 'omnivoice', fetchMock as unknown as typeof fetch)
    await expect(provider.generate('你好')).rejects.toThrow(/TTS API 503/)
    const speechCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/audio/speech'))
    expect(speechCalls).toHaveLength(1)
  })

  it('超 4096 字符按句切分逐片请求（inputLimit 4096 语义与基类同源），拼接不丢字', async () => {
    const inputs: string[] = []
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return okRes({ status: 'ok' })
      return okRes(MP3_BYTES)
    })
    const provider = new VoiceStudioTTSProvider('k', 'http://vs.example.com:3900', 'omnivoice', fetchMock as unknown as typeof fetch)
    const text = sentenceText(5000)
    await provider.generate(text)
    for (const call of fetchMock.mock.calls) {
      const [url, init] = call as [string, RequestInit]
      if (String(url).endsWith('/audio/speech')) {
        const body = JSON.parse(String(init.body))
        expect(body.input.length).toBeLessThanOrEqual(4096)
        inputs.push(body.input as string)
      }
    }
    expect(inputs.length).toBe(2)
    expect(inputs.join('')).toBe(text)
  })

  it('工厂：缺 key / 缺地址显式报错（2026-10-04 契约：不静默回落 OPENAI_* env）', () => {
    expect(() => createVoiceStudioAudioProvider({ baseUrl: 'http://vs:3900' })).toThrow(/OMNIVOICE_API_KEY/)
    expect(() => createVoiceStudioAudioProvider({ apiKey: 'k' })).toThrow(/OMNIVOICE_BASE_URL/)
    const provider = createVoiceStudioAudioProvider({ apiKey: 'k', baseUrl: 'http://vs:3900', fetchImpl: (async () => okRes(MP3_BYTES)) as unknown as typeof fetch })
    expect(provider).toBeInstanceOf(VoiceStudioTTSProvider)
  })
})

describe('probeVoiceStudioHealth 独立判定', () => {
  beforeEach(() => {
    __resetVoiceStudioHealthCacheForTests()
  })

  it('与 OpenAITTSProvider 无关的独立探活：ok 直通；非 ok 抛显式文案并带状态码', async () => {
    await probeVoiceStudioHealth('http://vs:3900', 'k', (async () => okRes({ status: 'ok' })) as unknown as typeof fetch)
    __resetVoiceStudioHealthCacheForTests()
    await expect(
      probeVoiceStudioHealth('http://vs:3900', 'k', (async () => failRes(401, 'unauthorized')) as unknown as typeof fetch),
    ).rejects.toThrow(new RegExp(`${VOICESTUDIO_UNAVAILABLE_MESSAGE}（HTTP 401）`))
  })

  it('缓存按实例键控：A 实例（健康）不掩盖 B 实例（死）——BYOK 多实例并存判据独立', async () => {
    // A 实例健康（写缓存）
    await probeVoiceStudioHealth('http://a.vs:3900/v1', 'k', (async () => okRes({ status: 'ok' })) as unknown as typeof fetch)
    // B 实例死端口：必须真实探活并显式报错，绝不能因 A 的缓存跳过
    await expect(
      probeVoiceStudioHealth('http://b.vs:3900/v1', 'k', (async () => { throw new Error('fetch failed') }) as unknown as typeof fetch),
    ).rejects.toThrow(new RegExp(`${VOICESTUDIO_UNAVAILABLE_MESSAGE}（fetch failed）`))
  })
})

describe('fetchVoiceStudioVoices + parseVoiceStudioVoicesResponse（音色数据面）', () => {
  it('解析：id/voice_id 双字段、name 缺省回落 id、缺 id 跳过、空清单/畸形 = null', () => {
    expect(parseVoiceStudioVoicesResponse({
      voices: [
        { voice_id: 'default', name: 'Default', id: 'default' },
        { voice_id: 'lnk-abc', name: '主角' },
        { id: 'noname' },
        { name: 'noid' },
        'junk',
      ],
    })).toEqual([
      { id: 'default', label: 'Default' },
      { id: 'lnk-abc', label: '主角' },
      { id: 'noname', label: 'noname' },
    ])
    expect(parseVoiceStudioVoicesResponse(null)).toBeNull()
    expect(parseVoiceStudioVoicesResponse({})).toBeNull()
    expect(parseVoiceStudioVoicesResponse({ voices: [] })).toBeNull()
  })

  it('拉取：base 含 /v1 走 {base}/audio/voices + Bearer；非 2xx / 网络异常 / 畸形 = null（调用方保旧值）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ voices: [{ voice_id: 'default', name: 'Default', id: 'default' }] }),
    })
    const out = await fetchVoiceStudioVoices('http://vs:3900/v1/', 'k', fetchMock as unknown as typeof fetch)
    expect(out).toEqual([{ id: 'default', label: 'Default' }])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://vs:3900/v1/audio/voices')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer k' })

    expect(await fetchVoiceStudioVoices('http://vs:3900/v1', 'k', (async () => failRes(502, 'down')) as unknown as typeof fetch)).toBeNull()
    expect(await fetchVoiceStudioVoices('http://vs:3900/v1', 'k', (async () => { throw new Error('timeout') }) as unknown as typeof fetch)).toBeNull()
    expect(await fetchVoiceStudioVoices('http://vs:3900/v1', 'k', (async () => ({ ok: true, json: async () => ({ voices: [] }) })) as unknown as typeof fetch)).toBeNull()
  })
})

// 基类守卫：protected 化后对外行为不变（实例成员仍不可从外部枚举到私有字段语义）
describe('OpenAITTSProvider 兼容回归', () => {
  it('protected 化不影响既有构造与调用面', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okRes(MP3_BYTES))
    // 基类走 upstreamFetch（全局 fetch），必须 stub
    vi.stubGlobal('fetch', fetchMock)
    try {
      const provider = new OpenAITTSProvider('k', 'https://api.example.com/v1', 'tts-1')
      const url = await provider.generate('hello')
      expect(url.url).toMatch(/^data:audio\/mpeg;base64,/)
      const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe('https://api.example.com/v1/audio/speech')
      expect(JSON.parse(String(init.body)).voice).toBe('alloy')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
