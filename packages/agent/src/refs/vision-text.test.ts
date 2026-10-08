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

    expect(result).toEqual({ text: 'vision result' })
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
  })

  it('throws when no image urls', async () => {
    await expect(generateTextWithImages('x', [], { apiKey: 'test-key' })).rejects.toThrow(/至少提供一张参考图/)
  })
})
