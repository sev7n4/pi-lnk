import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FalH3MaxVideoProvider } from './fal-h3-max-video-provider'
import { MiniMaxH3VideoProvider } from './minimax-h3-video-provider'
import {
  AgnesVideoProvider,
  ApimartVideoProvider,
  createVideoProvider,
  isFalBaseUrl,
  isFalVideoModel,
  resolveVideoParams,
} from './video-provider'

describe('createVideoProvider', () => {
  const env = { ...process.env }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env = { ...env }
    process.env.OPENAI_API_KEY = 'env-key'
    process.env.OPENAI_BASE_URL = 'https://env.example.com/v1'
    process.env.OPENAI_VIDEO_MODEL = 'env-video'
    fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ video_id: 'vid-1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'completed', url: 'https://example.com/video.mp4' }),
      })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    process.env = env
    vi.unstubAllGlobals()
  })

  it('uses explicit opts over env credentials for Agnes', async () => {
    const provider = createVideoProvider({
      apiKey: 'opts-key',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      model: 'opts-video',
    })
    expect(provider).toBeInstanceOf(AgnesVideoProvider)
    await provider.generate('animate')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://apihub.agnes-ai.com/v1/videos')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer opts-key' })
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'opts-video' })
  })

  // 回归锁：生产有 1 条 video 记录的 url 是 unsplash 静态图（JPEG）冒充视频，
  // 即 PlaceholderVideoProvider 线上确已触发。2026-08-08 的设计文档
  // （docs/superpowers/specs/2026-08-08-seedance-agnes-video-adapter-design.md:549）
  // 已写明「不得 PlaceholderVideoProvider；返回明确错误」，但无凭据分支一直没落实。
  it('throws instead of returning an Unsplash still image when unconfigured', () => {
    delete process.env.OPENAI_API_KEY
    delete process.env.VIDEO_API_KEY
    expect(() => createVideoProvider(undefined)).toThrow(/视频通道未配置/)
  })

  it('never returns a non-video URL for a failed upstream create', async () => {
    const p = createVideoProvider({
      apiKey: 'k',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      model: 'agnes-video-v2.0',
    })
    // 清掉 beforeEach 预置的「创建成功 + 轮询完成」两次响应，改为只让创建失败
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'bad' })
    const outcome = await p.generate('x').then(
      (r) => ({ resolved: r }),
      (e) => ({ rejected: e }),
    )
    expect('rejected' in outcome).toBe(true)
    expect(JSON.stringify(outcome)).not.toContain('unsplash')
  })
})


describe('createVideoProvider apimart', () => {
  const env = { ...process.env }

  beforeEach(() => {
    process.env = { ...env }
  })

  afterEach(() => {
    process.env = env
  })

  it('returns ApimartVideoProvider for apimart baseUrl', () => {
    const p = createVideoProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.apimart.ai/v1',
      model: 'doubao-seedance-2.0-mini',
    })
    expect(p).toBeInstanceOf(ApimartVideoProvider)
  })

  it('rejects apimart.ai suffix attacker domains', async () => {
    const p = createVideoProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://apimart.ai.attacker.example/v1',
    })
    expect(p).not.toBeInstanceOf(ApimartVideoProvider)
    await expect(p.generate('test')).rejects.toThrow(/unsupported video gateway/i)
  })

  it('throws readable error for unknown BYOK instead of placeholder', async () => {
    const p = createVideoProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://unknown.example.com/v1',
    })
    await expect(p.generate('test')).rejects.toThrow(/unsupported video gateway/i)
  })
})

describe('isFalVideoModel / isFalBaseUrl', () => {
  it('detects h3-max model keys and gateways case-insensitively', () => {
    expect(isFalVideoModel('h3-max-turbo')).toBe(true)
    expect(isFalVideoModel('h3-max')).toBe(true)
    expect(isFalVideoModel('minimax/h3-max-turbo')).toBe(true)
    expect(isFalVideoModel('MINIMAX/H3-MAX')).toBe(true)
    expect(isFalVideoModel('agnes-video-v2.0')).toBe(false)
    expect(isFalVideoModel(undefined)).toBe(false)
  })

  it('detects fal.ai and fal.run hosts including queue.fal.run', () => {
    expect(isFalBaseUrl('https://fal.run')).toBe(true)
    expect(isFalBaseUrl('https://queue.fal.run')).toBe(true)
    expect(isFalBaseUrl('https://fal.ai')).toBe(true)
    expect(isFalBaseUrl('https://www.fal.ai/models')).toBe(true)
    expect(isFalBaseUrl('https://apihub.agnes-ai.com/v1')).toBe(false)
    expect(isFalBaseUrl('https://fal.run.attacker.example/v1')).toBe(false)
    expect(isFalBaseUrl(undefined)).toBe(false)
  })
})

describe('createVideoProvider fal routing', () => {
  const env = { ...process.env }

  beforeEach(() => {
    process.env = { ...env }
    process.env.FAL_KEY = 'env-fal-key-must-not-be-read'
  })

  afterEach(() => {
    process.env = env
  })

  it('returns FalH3MaxVideoProvider for fal model even when baseUrl looks like Agnes', () => {
    const p = createVideoProvider({
      apiKey: 'opts-fal-key',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      model: 'h3-max-turbo',
    })
    expect(p).toBeInstanceOf(FalH3MaxVideoProvider)
  })

  it('returns FalH3MaxVideoProvider for fal baseUrl', () => {
    const p = createVideoProvider({
      apiKey: 'opts-fal-key',
      baseUrl: 'https://fal.run',
      model: 'agnes-video-v2.0',
    })
    expect(p).toBeInstanceOf(FalH3MaxVideoProvider)
  })

  it('still routes Agnes when apiKey + agnes host + non-fal model', () => {
    const p = createVideoProvider({
      apiKey: 'opts-key',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      model: 'agnes-video-v2.0',
    })
    expect(p).toBeInstanceOf(AgnesVideoProvider)
  })

  it('does not read process.env.FAL_KEY for routing', () => {
    const p = createVideoProvider({
      apiKey: 'opts-fal-key',
      baseUrl: 'https://queue.fal.run',
      model: 'minimax/h3-max',
    })
    expect(p).toBeInstanceOf(FalH3MaxVideoProvider)
    expect(p).not.toBeInstanceOf(AgnesVideoProvider)
  })

  it('throws 视频加速通道未配置 for fal baseUrl without apiKey even when OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'env-openai-must-not-be-used'
    process.env.OPENAI_BASE_URL = 'https://apihub.agnes-ai.com/v1'
    expect(() =>
      createVideoProvider({ model: 'h3-max-turbo', baseUrl: 'https://fal.run' }),
    ).toThrow('视频加速通道未配置')
  })

  it('throws 视频加速通道未配置 for h3-max model without apiKey or baseUrl', () => {
    process.env.OPENAI_API_KEY = 'env-openai-must-not-be-used'
    process.env.OPENAI_BASE_URL = 'https://apihub.agnes-ai.com/v1'
    expect(() => createVideoProvider({ model: 'h3-max' })).toThrow('视频加速通道未配置')
  })
})

describe('createVideoProvider MiniMax routing', () => {
  const env = { ...process.env }

  beforeEach(() => {
    process.env = { ...env }
  })

  afterEach(() => {
    process.env = env
  })

  it('createVideoProvider routes MiniMax-H3 with Bearer provider before Agnes', () => {
    const p = createVideoProvider({
      apiKey: 'mm-key',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      model: 'minimax-h3',
    })
    expect(p).toBeInstanceOf(MiniMaxH3VideoProvider)
    expect(p).not.toBeInstanceOf(AgnesVideoProvider)
    expect(p).not.toBeInstanceOf(FalH3MaxVideoProvider)
  })

  it('routes MiniMax-H3 gateway id and official baseUrl to MiniMax provider', () => {
    expect(
      createVideoProvider({
        apiKey: 'mm-key',
        baseUrl: 'https://api.minimax.io',
        model: 'MiniMax-H3',
      }),
    ).toBeInstanceOf(MiniMaxH3VideoProvider)
    expect(
      createVideoProvider({
        apiKey: 'mm-key',
        baseUrl: 'https://api.minimax.io',
        model: 'agnes-video-v2.0',
      }),
    ).toBeInstanceOf(MiniMaxH3VideoProvider)
  })

  it('keeps fal first for h3-max-turbo even with MiniMax baseUrl', () => {
    const p = createVideoProvider({
      apiKey: 'fal-key',
      baseUrl: 'https://api.minimax.io',
      model: 'h3-max-turbo',
    })
    expect(p).toBeInstanceOf(FalH3MaxVideoProvider)
  })

  it('refuses MiniMax model without apiKey even if OPENAI_API_KEY set', () => {
    process.env.OPENAI_API_KEY = 'sk-openai'
    process.env.OPENAI_BASE_URL = 'https://apihub.agnes-ai.com/v1'
    expect(() =>
      createVideoProvider({ model: 'minimax-h3', baseUrl: 'https://api.minimax.io' }),
    ).toThrow('未配置 MiniMax API Key')
  })
})

describe('ApimartVideoProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('polls apimart task and returns video url', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ task_id: 'task_1' }] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { status: 'completed', result: { video_url: 'https://cdn/v.mp4' } } }),
      })
    const provider = new ApimartVideoProvider('key', 'https://api.apimart.ai/v1', 0, 30_000)
    const { url } = await provider.generate('hello', { model: 'doubao-seedance-2.0-mini', duration: 5 })
    expect(url).toBe('https://cdn/v.mp4')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).image_urls).toBeUndefined()
  })

  it('normalizes apimart result.url when returned as string array', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ task_id: 'task_arr' }] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            status: 'completed',
            result: {
              url: [
                'https://getapib.org/video/9998213808887624-db838584-132d-48ee-a487-440a1a26f801-video_task_01KZGMCY3V95MGPWVY46C3NWF3.mp4',
              ],
            },
          },
        }),
      })
    const provider = new ApimartVideoProvider('key', 'https://api.apimart.ai/v1', 0, 30_000)
    const { url } = await provider.generate('hello', { model: 'doubao-seedance-2.0-mini', duration: 5 })
    expect(url).toBe(
      'https://getapib.org/video/9998213808887624-db838584-132d-48ee-a487-440a1a26f801-video_task_01KZGMCY3V95MGPWVY46C3NWF3.mp4',
    )
  })

  it('RED→GREEN: 连续 5xx 后抛错（P0-D tracker 接入验证）', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ task_id: 'task_5xx' }] }) })
      .mockResolvedValue({ ok: false, status: 503, text: async () => 'Service Unavailable' })
    // maxPollMs=500 避免 RED 时 loop 到 30s 超时；GREEN 后 tracker 第 5 次抛错（<500ms）
    const provider = new ApimartVideoProvider('key', 'https://api.apimart.ai/v1', 0, 500)
    await expect(provider.generate('hello', { model: 'm', duration: 5 })).rejects.toThrow(/consecutive/i)
  })
})

describe('resolveVideoParams', () => {
  it('maps duration to 8n+1 frames at 24fps', () => {
    const five = resolveVideoParams(5, '16:9')
    expect(five.num_frames).toBe(121)
    expect(five.frame_rate).toBe(24)
  })

  it('caps frames at 441', () => {
    const long = resolveVideoParams(60, '16:9')
    expect(long.num_frames).toBe(441)
  })

  it('maps aspect ratios at 720p', () => {
    expect(resolveVideoParams(5, '9:16', '720p')).toEqual(
      expect.objectContaining({ width: 720, height: 1280 }),
    )
    expect(resolveVideoParams(5, '1:1', '720p')).toEqual(
      expect.objectContaining({ width: 720, height: 720 }),
    )
    expect(resolveVideoParams(5, '16:9', '720p')).toEqual(
      expect.objectContaining({ width: 1280, height: 720 }),
    )
  })

  it('maps 1080p long edge', () => {
    expect(resolveVideoParams(5, '16:9', '1080p')).toEqual(
      expect.objectContaining({ width: 1920, height: 1080 }),
    )
  })
})

describe('AgnesVideoProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('includes image in create body but not crop', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ video_id: 'vid-1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'completed', url: 'https://example.com/video.mp4' }),
      })

    const provider = new AgnesVideoProvider('test-key')
    await provider.generate('animate this', {
      model: 'agnes-video-v2.0',
      image: 'https://example.com/ref.png',
      crop: 'center',
    })

    const createCall = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(createCall[1].body)) as Record<string, unknown>
    expect(body.image).toBe('https://example.com/ref.png')
    expect(body).not.toHaveProperty('crop')
    expect(body.model).toBe('agnes-video-v2.0')
  })

  it('sends extra_body keyframes when referenceImages length >= 2', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ video_id: 'vid-kf' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'completed', url: 'https://example.com/kf.mp4' }),
      })

    const provider = new AgnesVideoProvider('test-key', 'https://apihub.agnes-ai.com/v1', 'https://apihub.agnes-ai.com', 'agnes-video-v2.0', 0)
    await provider.generate('transition', {
      referenceImages: ['https://cdn/a.png', 'https://cdn/b.png'],
      refWire: 'agnes_keyframes',
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.extra_body).toEqual({
      image: ['https://cdn/a.png', 'https://cdn/b.png'],
      mode: 'keyframes',
    })
    expect(body).not.toHaveProperty('image')
  })

  it('returns url from metadata when top-level url is absent', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ video_id: 'vid-meta' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'completed',
          metadata: { url: 'https://example.com/meta-video.mp4' },
        }),
      })

    const provider = new AgnesVideoProvider('test-key', 'https://apihub.agnes-ai.com/v1', 'https://apihub.agnes-ai.com', 'agnes-video-v2.0', 0)
    const { url } = await provider.generate('animate')
    expect(url).toBe('https://example.com/meta-video.mp4')
  })

  it('passes seed and negative_prompt in create body', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ video_id: 'vid-seed' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'completed', url: 'https://example.com/seed.mp4' }),
      })

    const provider = new AgnesVideoProvider('test-key', 'https://apihub.agnes-ai.com/v1', 'https://apihub.agnes-ai.com', 'agnes-video-v2.0', 0)
    await provider.generate('animate', {
      seed: 42,
      negativePrompt: 'watermark, blur',
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.seed).toBe(42)
    expect(body.negative_prompt).toBe('watermark, blur')
  })

  it('sends OpenAI Videos 2.5 flash seconds/size/mode instead of pixel frames', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ video_id: 'vid-25' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'completed', url: 'https://example.com/v25.mp4' }),
      })

    const provider = new AgnesVideoProvider(
      'test-key',
      'https://apihub.agnes-ai.com/v1',
      'https://apihub.agnes-ai.com',
      'agnes-video-2.5-flash',
      0,
    )
    await provider.generate('rainy city', {
      model: 'agnes-video-2.5-flash',
      duration: 8,
      aspectRatio: '9:16',
      resolution: '1080p',
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'agnes-video-2.5-flash',
      prompt: 'rainy city',
      seconds: '8',
      mode: 'text',
      size: '720P',
      aspect_ratio: '9:16',
    })
    expect(body).not.toHaveProperty('width')
    expect(body).not.toHaveProperty('num_frames')
    expect(body).not.toHaveProperty('negative_prompt')
  })

  it('maps two reference images to 2.5 flash keyframe first/last frames', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ video_id: 'vid-25kf' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'completed', url: 'https://example.com/kf25.mp4' }),
      })

    const provider = new AgnesVideoProvider(
      'test-key',
      'https://apihub.agnes-ai.com/v1',
      'https://apihub.agnes-ai.com',
      'agnes-video-2.5-flash',
      0,
    )
    await provider.generate('turn', {
      model: 'agnes-video-2.5-flash',
      referenceImages: ['https://cdn/a.png', 'https://cdn/b.png'],
      refWire: 'agnes_keyframes',
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>
    expect(body.mode).toBe('keyframe')
    expect(body.first_frame).toBe('https://cdn/a.png')
    expect(body.last_frame).toBe('https://cdn/b.png')
    expect(body).not.toHaveProperty('extra_body')
    expect(body).not.toHaveProperty('image')
  })

  it('maps a single reference image to 2.5 flash reference mode', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ video_id: 'vid-25ref' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'completed', url: 'https://example.com/ref25.mp4' }),
      })

    const provider = new AgnesVideoProvider(
      'test-key',
      'https://apihub.agnes-ai.com/v1',
      'https://apihub.agnes-ai.com',
      'agnes-video-2.5-flash',
      0,
    )
    await provider.generate('run', {
      model: 'agnes-video-2.5-flash',
      image: 'https://cdn/char.png',
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>
    expect(body.mode).toBe('reference')
    expect(body.images).toEqual(['https://cdn/char.png'])
    expect(body).not.toHaveProperty('image')
  })
})

// 回归锁：生产 374 条 video 失败样本里 171 条（46%）是可重试的
//（99 条 `429 rate limit` + 72 条 `503 video_queue_full` + 11 条 `fetch failed`），
// 而改前**零重试**。见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.4
// ⚠️ 只包「创建」阶段，轮询阶段的 `continue` 已是「等下一轮」语义，不重复包。
describe('AgnesVideoProvider 创建阶段退避重试', () => {
  const env = { ...process.env }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env = { ...env }
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    process.env = env
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('retries the create call on 429 and eventually succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limit for free users' })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'video_queue_full' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ video_id: 'vid-9' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'completed', url: 'https://e/v.mp4' }) })

    const p = new AgnesVideoProvider('k', 'https://apihub.agnes-ai.com/v1', 'https://apihub.agnes-ai.com', 'agnes-video-v2.0', 1, 2, 1)
    const out = await p.generate('animate')

    expect(out.url).toBe('https://e/v.mp4')
    // 3 次 create + 1 次 poll
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('does NOT retry a 400 invalid_request (params are wrong, retry is futile)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid_request: num_frames exceeds max' })

    const p = new AgnesVideoProvider('k', 'https://apihub.agnes-ai.com/v1', 'https://apihub.agnes-ai.com', 'agnes-video-v2.0', 1, 2, 1)
    await expect(p.generate('animate')).rejects.toThrow(/400/)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after 3 attempts and surfaces the last error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'video_queue_full' })

    const p = new AgnesVideoProvider('k', 'https://apihub.agnes-ai.com/v1', 'https://apihub.agnes-ai.com', 'agnes-video-v2.0', 1, 2, 1)
    await expect(p.generate('animate')).rejects.toThrow(/video_queue_full/)

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

// P0-D（诊断报告 V4）：四处视频轮询 `if(!pollRes.ok) continue` 无限吞 HTTP 错误。
// 改为「4xx 非 429 立即抛 + 5xx/429 累计 N 次抛 + log」。
describe('AgnesVideoProvider 轮询错误处理', () => {
  const env = { ...process.env }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env = { ...env }
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    process.env = env
    vi.unstubAllGlobals()
  })

  // maxPollAttempts=10 让 RED 时不会跑 120 次；GREEN 后 tracker 在第 5 次抛错（< 10）
  const p = new AgnesVideoProvider('k', 'https://apihub.agnes-ai.com/v1', 'https://apihub.agnes-ai.com', 'agnes-video-v2.0', 1, 10, 1)

  it('RED→GREEN: 连续 5 次 5xx 后抛错（不再 loop 到 timeout）', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ video_id: 'vid-1' }) })
      .mockResolvedValue({ ok: false, status: 503, text: async () => 'Service Unavailable' })

    await expect(p.generate('animate')).rejects.toThrow(/consecutive/i)
    // 1 创建 + 5 轮询 503
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('RED→GREEN: 4xx 非 429 立即抛错（不浪费轮询周期）', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ video_id: 'vid-1' }) })
      .mockResolvedValue({ ok: false, status: 404, text: async () => 'not found' })

    await expect(p.generate('animate')).rejects.toThrow(/404|non-retryable/i)
    // 1 创建 + 1 轮询 404（立即抛）
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('回归: 5xx 未到阈值后恢复成功（reset 机制）', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ video_id: 'vid-1' }) })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'x' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'completed', url: 'https://e/v.mp4' }) })

    const out = await p.generate('animate')
    expect(out.url).toBe('https://e/v.mp4')
  })
})

// P1-A（诊断报告 V6 / 附录 V6）：3 个 provider 创建阶段无重试——仅 Agnes 有 #178。
// 生产 374 条 video 失败样本里 171 条可重试（429/503/fetch failed），切到非 Agnes
// 通道时仍零重试。对齐 Agnes #178：创建阶段包 withUpstreamRetry。
// ⚠️ fetch 对 4xx/5xx 正常返回 ok:false 不抛异常，必须显式 throw 才能触发重试。
describe('ApimartVideoProvider 创建阶段退避重试', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries the create call on 429/503 and eventually succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limit' })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'video_queue_full' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ task_id: 'task_r' }] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { status: 'completed', result: { video_url: 'https://cdn/r.mp4' } } }),
      })

    const p = new ApimartVideoProvider('key', 'https://api.apimart.ai/v1', 0, 30_000, 1)
    const { url } = await p.generate('hello', { model: 'doubao-seedance-2.0-mini', duration: 5 })

    expect(url).toBe('https://cdn/r.mp4')
    // 3 次 create + 1 次 poll
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('does NOT retry a 402 insufficient balance (account error, retry is futile)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 402, text: async () => 'insufficient balance' })

    const p = new ApimartVideoProvider('key', 'https://api.apimart.ai/v1', 0, 30_000, 1)
    await expect(p.generate('hello')).rejects.toThrow(/402/)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after 3 attempts and surfaces the last error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'video_queue_full' })

    const p = new ApimartVideoProvider('key', 'https://api.apimart.ai/v1', 0, 30_000, 1)
    await expect(p.generate('hello')).rejects.toThrow(/video_queue_full/)

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('MiniMaxH3VideoProvider 创建阶段退避重试', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries the create call on 429 and eventually succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limit' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ task_id: 'mm-task-r' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ task: { status: 'succeeded', content: { url: 'https://cdn/mmr.mp4' } } }),
      })

    const p = new MiniMaxH3VideoProvider('key', 'https://api.minimax.io', 'minimax-h3', 1)
    const { url } = await p.generate('hello')

    expect(url).toBe('https://cdn/mmr.mp4')
    // 2 次 create + 1 次 poll
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry a 402 account error (throwMiniMaxHttpError → 账户异常文案)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 402, text: async () => 'insufficient balance' })

    const p = new MiniMaxH3VideoProvider('key', 'https://api.minimax.io', 'minimax-h3', 1)
    await expect(p.generate('hello')).rejects.toThrow(/账户异常/)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after 3 attempts on persistent 503', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'Service Unavailable' })

    const p = new MiniMaxH3VideoProvider('key', 'https://api.minimax.io', 'minimax-h3', 1)
    await expect(p.generate('hello')).rejects.toThrow(/503/)

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('FalH3MaxVideoProvider 创建阶段退避重试', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries the submit call on 429/503 and eventually succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limit' })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'video_queue_full' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status_url: 'https://queue.fal.run/status/r' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'COMPLETED', response: { video: { url: 'https://cdn/falr.mp4' } } }),
      })

    const p = new FalH3MaxVideoProvider('fal-key', 'https://fal.run', 'h3-max-turbo', 1)
    const { url } = await p.generate('hello')

    expect(url).toBe('https://cdn/falr.mp4')
    // 3 次 submit + 1 次 poll
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('does NOT retry a 403 account-locked error (throwFalVideoHttpError → 账户异常文案)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'User is locked. Reason: TOP_UP',
    })

    const p = new FalH3MaxVideoProvider('fal-key', 'https://fal.run', 'h3-max-turbo', 1)
    await expect(p.generate('hello')).rejects.toThrow(/账户异常/)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after 3 attempts on persistent 503', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'Service Unavailable' })

    const p = new FalH3MaxVideoProvider('fal-key', 'https://fal.run', 'h3-max-turbo', 1)
    await expect(p.generate('hello')).rejects.toThrow(/503/)

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
