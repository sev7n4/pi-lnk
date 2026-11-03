import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectPointEvents } from './points-events'

/**
 * Epic 2 Task 9：user 级 credit_tx SSE 客户端——帧解析/心跳忽略/畸形帧不炸。
 * fetch mock 返回 ReadableStream，认证头来自 localStorage.token。
 */

function sseResponse(chunks: string[]) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

describe('connectPointEvents（Epic 2 Task 9 前端）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('解析 data 帧 → onEvent；heartbeat/注释帧忽略；认证头携带 token', async () => {
    localStorage.setItem('token', 'tok-1')
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        ': point-events-ready\n\n',
        'data: {"type":"heartbeat"}\n\n',
        'data: {"type":"credit_tx","data":{"txId":"a","balanceAfter":88}}\n\n',
        'data: not-json\n\n',
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)
    const events: Array<{ type: string; data?: unknown }> = []
    const conn = connectPointEvents((ev) => events.push(ev))
    await vi.waitFor(() => {
      expect(events).toEqual([{ type: 'credit_tx', data: { txId: 'a', balanceAfter: 88 } }])
    })
    conn.stop()
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-1')
  })

  it('stop() 中止连接（abort 信号触发）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([': ready\n\n']))
    vi.stubGlobal('fetch', fetchMock)
    const conn = connectPointEvents(() => {})
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    conn.stop()
    // fetch mock 不看 signal，但 stop 后不应再次发起重连
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
