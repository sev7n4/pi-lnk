import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  appendImageRefsForTextOnlyPrompt,
  generateTextForRefs,
  supportsVisionTextModel,
} from './text-generation'

describe('supportsVisionTextModel', () => {
  it('allows gemini and gpt-4o family', () => {
    expect(supportsVisionTextModel('gemini-3.5-flash-lite')).toBe(true)
    expect(supportsVisionTextModel('ch_x::gemini-3.1-flash')).toBe(true)
    expect(supportsVisionTextModel('gpt-4o')).toBe(true)
    expect(supportsVisionTextModel('agnes-2.0-flash')).toBe(true)
  })

  it('rejects non-flash deepseek and reasoning-only models', () => {
    expect(supportsVisionTextModel('deepseek-v4-pro')).toBe(false)
    expect(supportsVisionTextModel('ch_x::deepseek-v3.2')).toBe(false)
    expect(supportsVisionTextModel('o3-mini')).toBe(false)
  })

  it('allows DeepSeek V4.1 Flash multimodal ids', () => {
    expect(supportsVisionTextModel('deepseek-flash')).toBe(true)
    expect(supportsVisionTextModel('ch_x::deepseek-flash')).toBe(true)
    expect(supportsVisionTextModel('deepseek-v4-flash')).toBe(true)
    expect(supportsVisionTextModel('deepseek-v4.1-flash')).toBe(true)
    expect(supportsVisionTextModel('deepseek-v4-flash-vision-exp')).toBe(true)
  })
})

describe('appendImageRefsForTextOnlyPrompt', () => {
  it('appends ref-image tags for text-only fallback', () => {
    const out = appendImageRefsForTextOnlyPrompt('写方案', ['https://cdn.example/a.png'])
    expect(out).toContain('写方案')
    expect(out).toContain('[ref-image:https://cdn.example/a.png]')
    expect(out).toContain('不支持直接识图')
  })
})

describe('generateTextForRefs', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.OPENAI_API_KEY
  })

  it('uses vision chat for gemini when refs present', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'vision ok' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateTextForRefs('describe', ['https://cdn.example/a.png'], {
      apiKey: 'k',
      model: 'gemini-3.5-flash-lite',
    })

    expect(result).toEqual({ text: 'vision ok', visionUsed: true, retryCount: 0 })
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.stream).toBe(false)
    expect(body.messages[1].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://cdn.example/a.png' },
    })
  })

  it('uses vision chat for deepseek-flash when refs present', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'flash vision' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateTextForRefs('describe', ['https://cdn.example/a.png'], {
      apiKey: 'k',
      model: 'ch_x::deepseek-flash',
    })

    expect(result).toEqual({ text: 'flash vision', visionUsed: true, retryCount: 0 })
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.model).toBe('deepseek-flash')
    expect(body.messages[1].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://cdn.example/a.png' },
    })
  })

  it('falls back to text-only provider for deepseek when refs present', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'text ok' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateTextForRefs('describe', ['https://cdn.example/a.png'], {
      apiKey: 'k',
      model: 'deepseek-v4-pro',
    })

    expect(result).toEqual({ text: 'text ok', visionUsed: false, retryCount: 0 })
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.stream).toBe(false)
    expect(typeof body.messages[1].content).toBe('string')
    expect(body.messages[1].content).toContain('[ref-image:https://cdn.example/a.png]')
    expect(body.messages[1].content).not.toContain('image_url')
  })

  it('uses text provider without refs', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'plain' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateTextForRefs('hello', [], {
      apiKey: 'k',
      model: 'deepseek-v4-pro',
    })

    expect(result).toEqual({ text: 'plain', visionUsed: false, retryCount: 0 })
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.messages[1].content).toBe('hello')
  })

  // ── retryCount 透传：vision 分支传真值，两条非 vision 分支也传真值 ──────
  it('passes the real retryCount through from the vision branch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'recovered' } }] }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateTextForRefs('describe', ['https://cdn.example/a.png'], {
      apiKey: 'k',
      model: 'gemini-3.5-flash-lite',
    })

    expect(result).toEqual({ text: 'recovered', visionUsed: true, retryCount: 1 })
    expect(fetchMock.mock.calls.length).toBe(2)
  }, 30_000)

  it('reports retryCount 0 for the text-only fallback branch on first-attempt success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'text ok' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateTextForRefs('describe', ['https://cdn.example/a.png'], {
      apiKey: 'k',
      model: 'deepseek-v4-pro',
    })

    expect(result.retryCount).toBe(0)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('reports retryCount 0 for the no-refs branch on first-attempt success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'plain' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateTextForRefs('hello', [], { apiKey: 'k', model: 'gpt-4o' })

    expect(result.retryCount).toBe(0)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  // ── 下面两条是 Task 4 的核心：非 vision 两条分支必须透传 provider 的真实
  // 重试计数（此前恒为 0）。若retryCount 写死 0，这两条必红。
  it('passes the real retryCount through from the text-only fallback branch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'text recovered' } }] }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateTextForRefs('describe', ['https://cdn.example/a.png'], {
      apiKey: 'k',
      model: 'deepseek-v4-pro',
    })

    expect(result).toEqual({ text: 'text recovered', visionUsed: false, retryCount: 1 })
    expect(fetchMock.mock.calls.length).toBe(2)
  }, 30_000)

  it('passes the real retryCount through from the no-refs branch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'plain recovered' } }] }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateTextForRefs('hello', [], { apiKey: 'k', model: 'gpt-4o' })

    // 总尝试 3 次 ⇒ 实际重试 2 次（口径不是总尝试数）
    expect(result).toEqual({ text: 'plain recovered', visionUsed: false, retryCount: 2 })
    expect(fetchMock.mock.calls.length).toBe(3)
  }, 30_000)
})
