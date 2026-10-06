import { describe, expect, it, vi } from 'vitest'
import { StepFunDesignProvider } from './stepfun-audio'

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  return vi.fn(async (url: string | URL, init?: RequestInit) =>
    handler(String(url), init ?? {}),
  ) as unknown as typeof fetch
}

describe('StepFunDesignProvider', () => {
  it('POST /audio/generate 并原样返回音频字节', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe('https://api.stepfun.com/v1/audio/generate')
      const body = JSON.parse(String(init.body))
      expect(body.model).toBe('stepaudio-3-gen-preview')
      expect(body.roles).toEqual([{ role: '旁白', voice: 'cixingnansheng' }])
      expect(body.scripts).toEqual([{ role: '旁白', text: '（轻声）今晚的风很温柔。' }])
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      })
    })
    const p = new StepFunDesignProvider('k', 'https://api.stepfun.com/v1', fetchImpl)
    const out = await p.generate({
      roles: [{ role: '旁白', voice: 'cixingnansheng' }],
      scripts: [{ role: '旁白', text: '（轻声）今晚的风很温柔。' }],
    })
    expect(out.contentType).toBe('audio/mpeg')
    expect(out.buffer.byteLength).toBe(4)
  })

  it('非 2xx 一律抛出（不吞、不返回占位音频）', async () => {
    const fetchImpl = fakeFetch(() => new Response('bad request', { status: 400 }))
    const p = new StepFunDesignProvider('k', 'https://api.stepfun.com/v1', fetchImpl)
    await expect(
      p.generate({ roles: [], scripts: [{ text: 'x' }] }),
    ).rejects.toThrow(/StepFun audio\/generate 400/)
  })

  it('返回 JSON 而非音频时显式报错（避免把错误体当 mp3 存下来）', async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'model not found' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const p = new StepFunDesignProvider('k', 'https://api.stepfun.com/v1', fetchImpl)
    await expect(p.generate({ roles: [], scripts: [{ text: 'x' }] })).rejects.toThrow(
      /model not found/,
    )
  })
})
