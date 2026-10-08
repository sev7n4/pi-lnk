import { describe, expect, it, vi } from 'vitest'
import { StepFunDesignProvider, StepFunMusicProvider } from './stepfun-audio'

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

describe('StepFunMusicProvider', () => {
  it('submit 用 model_id（不是 model）并拿 task_id', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe('https://api.stepfun.com/v1/audio/music/submit')
      const body = JSON.parse(String(init.body))
      expect(body.model_id).toBe('stepaudio-3-music-preview')
      expect(body.model).toBeUndefined()
      expect(body.caption).toBe('轻柔的钢琴独奏')
      expect(body.instrumental).toBe(true)
      return new Response(JSON.stringify({ task_id: 't1' }), { status: 200 })
    })
    const p = new StepFunMusicProvider('k', 'https://api.stepfun.com/v1', fetchImpl)
    expect(await p.submit({ caption: '轻柔的钢琴独奏', instrumental: true })).toEqual({
      taskId: 't1',
    })
  })

  it('🔴 终态 FAILED 时 HTTP 仍 200，必须按状态字段判失败', async () => {
    let call = 0
    const fetchImpl = fakeFetch((url) => {
      if (url.endsWith('/submit')) {
        return new Response(JSON.stringify({ task_id: 't1' }), { status: 200 })
      }
      call += 1
      return new Response(
        JSON.stringify(
          call === 1
            ? { status: 'RUNNING' }
            : { status: 'FAILED', error: { message: 'content policy' } },
        ),
        { status: 200 },
      )
    })
    const p = new StepFunMusicProvider('k', 'https://api.stepfun.com/v1', fetchImpl)
    await expect(
      p.generate({ caption: 'x' }, { intervalMs: 1, timeoutMs: 5_000 }),
    ).rejects.toThrow(/content policy/)
  })

  it('SUCCESS 时返回音频字节', async () => {
    const fetchImpl = fakeFetch((url) =>
      url.endsWith('/submit')
        ? new Response(JSON.stringify({ task_id: 't1' }), { status: 200 })
        : new Response(
            JSON.stringify({ status: 'SUCCESS', audio: Buffer.from([9, 9]).toString('base64') }),
            { status: 200 },
          ),
    )
    const p = new StepFunMusicProvider('k', 'https://api.stepfun.com/v1', fetchImpl)
    const out = await p.generate({ caption: 'x' }, { intervalMs: 1, timeoutMs: 5_000 })
    expect(out.buffer.byteLength).toBe(2)
  })

  it('轮询超时抛「仍在生成」而不是静默成功', async () => {
    const fetchImpl = fakeFetch((url) =>
      url.endsWith('/submit')
        ? new Response(JSON.stringify({ task_id: 't1' }), { status: 200 })
        : new Response(JSON.stringify({ status: 'RUNNING' }), { status: 200 }),
    )
    const p = new StepFunMusicProvider('k', 'https://api.stepfun.com/v1', fetchImpl)
    await expect(
      p.generate({ caption: 'x' }, { intervalMs: 1, timeoutMs: 5 }),
    ).rejects.toThrow(/仍在生成/)
  })

  it('submit 200 但无 task_id → 显式报错（不拿 undefined 去轮询）', async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ id: 't1' }), { status: 200 }))
    const p = new StepFunMusicProvider('k', 'https://api.stepfun.com/v1', fetchImpl)
    await expect(p.submit({ caption: 'x' })).rejects.toThrow(/未返回 task_id/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('submit/query 非 2xx 一律抛出（不吞、不当成功）', async () => {
    const p = new StepFunMusicProvider(
      'k',
      'https://api.stepfun.com/v1',
      fakeFetch(() => new Response('bad request', { status: 400 })),
    )
    await expect(p.submit({ caption: 'x' })).rejects.toThrow(/StepFun music\/submit 400/)
    await expect(p.query('t1')).rejects.toThrow(/StepFun music\/query 400/)
  })
})
