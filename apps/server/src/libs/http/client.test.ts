import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { httpGet, DEFAULT_HTTP_TIMEOUT_MS } from './client'

vi.mock('@lnkpi/agent', () => ({
  upstreamFetch: vi.fn(),
}))

import { upstreamFetch } from '@lnkpi/agent'

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === '.git') continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) acc.push(p)
  }
  return acc
}

describe('httpGet（统一出网端口）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('成功：透传 upstreamFetch 的 Response', async () => {
    const fakeRes = {
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => null },
    } as unknown as Response
    ;(upstreamFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(fakeRes)
    const res = await httpGet('http://x/y.png')
    expect(upstreamFetch).toHaveBeenCalledWith('http://x/y.png')
    expect(res).toBe(fakeRes)
  })

  it('黑洞连接：在 timeoutMs 内 reject，不永久挂死', async () => {
    ;(upstreamFetch as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<Response>(() => {}),
    )
    const p = httpGet('http://blackhole/z.png', { timeoutMs: 100 })
    const assertion = expect(p).rejects.toThrow(/超时/)
    await vi.advanceTimersByTimeAsync(100)
    await assertion
  })

  it('默认超时 = DEFAULT_HTTP_TIMEOUT_MS', async () => {
    ;(upstreamFetch as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<Response>(() => {}),
    )
    const p = httpGet('http://blackhole/a.png')
    const assertion = expect(p).rejects.toThrow(/超时/)
    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS)
    await assertion
  })

  it('R-IO-1 静态判据：upstreamFetch( 仅可出现在统一端口（client.ts）', () => {
    const srcRoot = join(__dirname, '..', '..')
    const files = walk(srcRoot)
    const violators = files.filter((f) => {
      if (!readFileSync(f, 'utf8').includes('upstreamFetch(')) return false
      return !f.endsWith('libs/http/client.ts') && !f.endsWith('http-timeout.util.ts')
    })
    expect(violators).toEqual([])
  })
})
