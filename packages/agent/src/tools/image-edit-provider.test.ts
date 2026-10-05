import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApimartImageEditProvider,
  createImageEditProvider,
  SyncImageEditProvider,
} from './image-edit-provider'

describe('createImageEditProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts mask_url to /images/generations and returns completed url', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/images/generations') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        expect(body.mask_url).toBe('https://cdn/mask.png')
        expect(body.image_urls).toEqual(['https://cdn/base.png'])
        expect(body.size).toBe('auto')
        return new Response(JSON.stringify({ data: { task_id: 't1' } }), { status: 200 })
      }
      if (url.endsWith('/tasks/t1')) {
        return new Response(
          JSON.stringify({
            data: {
              status: 'completed',
              result: { images: [{ url: 'https://cdn/out.png' }] },
            },
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = createImageEditProvider({
      apiKey: 'k',
      baseUrl: 'https://api.apimart.ai/v1',
      model: 'gpt-image-2-official',
    })
    const out = await provider.edit({
      userPrompt: '去污渍',
      imageUrl: 'https://cdn/base.png',
      maskUrl: 'https://cdn/mask.png',
      pollIntervalMs: 1,
      maxPollMs: 1000,
    })
    expect(out.url).toBe('https://cdn/out.png')
  })

  it('throws missing api key when credentials are absent', () => {
    expect(() => createImageEditProvider()).toThrow('missing api key')
  })

  it('overrides body.model with input.modelId', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/images/generations') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        expect(body.model).toBe('gpt-image-2-override')
        return new Response(JSON.stringify({ data: { task_id: 't2' } }), { status: 200 })
      }
      if (url.endsWith('/tasks/t2')) {
        return new Response(
          JSON.stringify({
            data: {
              status: 'completed',
              result: { images: [{ url: 'https://cdn/out2.png' }] },
            },
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = createImageEditProvider({
      apiKey: 'k',
      baseUrl: 'https://api.apimart.ai/v1',
    })
    const out = await provider.edit({
      userPrompt: '去污渍',
      imageUrl: 'https://cdn/base.png',
      maskUrl: 'https://cdn/mask.png',
      modelId: 'gpt-image-2-override',
      pollIntervalMs: 1,
      maxPollMs: 1000,
    })
    expect(out.url).toBe('https://cdn/out2.png')
  })
})

describe('SyncImageEditProvider (openai_sync wire)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('routes wire=openai_sync to SyncImageEditProvider', () => {
    const sync = createImageEditProvider({ apiKey: 'k', wire: 'openai_sync' })
    expect(sync).toBeInstanceOf(SyncImageEditProvider)
    const apimart = createImageEditProvider({ apiKey: 'k' })
    expect(apimart).toBeInstanceOf(ApimartImageEditProvider)
  })

  it('posts image+mask sync body and returns data[0].url directly', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/images/generations') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        expect(body.model).toBe('agnes-image-2.0-flash')
        expect(body.image).toBe('data:image/png;base64,AAA')
        expect(body.mask).toBe('data:image/png;base64,BBB')
        expect(body.size).toBe('1024x1024')
        expect(body.n).toBe(1)
        expect(body.extra_body).toEqual({ image: ['https://cdn/ref.png'], response_format: 'url' })
        expect(body.prompt).toContain('仅修改蒙版区域')
        return new Response(
          JSON.stringify({ data: [{ url: 'https://cdn/sync-out.png' }], task_id: 'task_x' }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = createImageEditProvider({
      apiKey: 'user-key',
      baseUrl: 'https://apihub.example.com/v1',
      wire: 'openai_sync',
      model: 'agnes-image-2.0-flash',
    })
    const out = await provider.edit({
      userPrompt: '把头盔换成皇冠',
      imageUrl: 'data:image/png;base64,AAA',
      maskUrl: 'data:image/png;base64,BBB',
      referenceImageUrls: ['https://cdn/ref.png'],
      size: '1024x1024',
    })
    expect(out.url).toBe('https://cdn/sync-out.png')
  })

  it('falls back to apimart task polling when response has task_id but no url', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/images/generations') && init?.method === 'POST') {
        return new Response(JSON.stringify({ task_id: 't9' }), { status: 200 })
      }
      if (url.endsWith('/tasks/t9')) {
        return new Response(
          JSON.stringify({
            data: { status: 'completed', result: { images: [{ url: 'https://cdn/polled.png' }] } },
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = createImageEditProvider({
      apiKey: 'user-key',
      baseUrl: 'https://gw.example.com/v1',
      wire: 'openai_sync',
      model: 'm1',
    })
    const out = await provider.edit({
      userPrompt: 'p',
      imageUrl: 'https://cdn/a.png',
      maskUrl: 'https://cdn/b.png',
      pollIntervalMs: 1,
      maxPollMs: 1000,
    })
    expect(out.url).toBe('https://cdn/polled.png')
  })

  it('throws with upstream text on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    )
    const provider = createImageEditProvider({
      apiKey: 'user-key',
      wire: 'openai_sync',
      model: 'm1',
    })
    await expect(
      provider.edit({ userPrompt: 'p', imageUrl: 'https://a.png', maskUrl: 'https://b.png' }),
    ).rejects.toThrow('Image edit API 500')
  })
})

// U9 回归锁：image_edit 接入退避重试。
// 生产实测（2026-10-05）：image_edit 77 条成功率仅 11.7%，66 条失败里
//   - 31 条 `fetch failed`            ← 纯网络抖动，**最该重试**
//   - 11 条 `402 insufficient balance`← 重试只会继续扣钱
//   -  2 条 `Mask dimensions do not match` ← 参数错
// ⇒ 接入重试前，这 31 条全部直接判失败。见 upstream-retry.ts。
describe('ImageEditProvider 创建阶段退避重试（U9）', () => {
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
    vi.restoreAllMocks()
  })

  // ⚠️ pollIntervalMs 必须给 1：否则轮询走真实间隔（数秒）导致测试超时
  const input = {
    userPrompt: '把裙子改长',
    imageUrl: 'https://cdn/base.png',
    maskUrl: 'https://cdn/mask.png',
    pollIntervalMs: 1,
  }

  it('retries on `fetch failed` (the 31-case) then succeeds', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('fetch failed'))
      // task_id 必须包在 data 里（extractApimartTaskId 的约定）
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { task_id: 't1' } }),
      })
      // 轮询响应形状（pollApimartImageTask）：data.status + data.result.images
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { status: 'completed', result: { images: [{ url: 'https://cdn/out.png' }] } },
        }),
      })

    const p = new ApimartImageEditProvider('k', 'https://api.apimart.ai/v1', 'm', 1)
    const out = await p.edit(input)

    expect(out.url).toBe('https://cdn/out.png')
    expect(fetchMock).toHaveBeenCalledTimes(3) // 1 失败 + 1 重试成功 + 1 次轮询
  })

  it('does NOT retry 402 insufficient balance', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => '[token_id=90701] insufficient balance',
    })

    const p = new ApimartImageEditProvider('k', 'https://api.apimart.ai/v1', 'm', 1)
    await expect(p.edit(input)).rejects.toThrow(/402/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry mask dimension mismatch (params are wrong)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Mask dimensions do not match base image',
    })

    const p = new ApimartImageEditProvider('k', 'https://api.apimart.ai/v1', 'm', 1)
    await expect(p.edit(input)).rejects.toThrow(/Mask dimensions/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after 3 attempts and surfaces the last error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'overloaded' })

    const p = new ApimartImageEditProvider('k', 'https://api.apimart.ai/v1', 'm', 1)
    await expect(p.edit(input)).rejects.toThrow(/503/)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
