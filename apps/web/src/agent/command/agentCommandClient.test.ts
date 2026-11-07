import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  postCancelQueued,
  postCancelRun,
  postConversation,
  postPersistEntryId,
  postSteerFollowup,
} from './agentCommandClient'

/**
 * agentCommandClient 单测（SSE 统一规格 §8：指令构造须覆盖 chat/conversation 与 steer/followup/cancel）。
 * 锁的是「5 个 L1 指令端点各路由到正确 URL + 带鉴权头 + 透传 signal / idempotencyKey」。
 */
describe('agentCommandClient（L1 指令客户端 · Phase 2）', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    const store: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v
      },
      removeItem: (k: string) => {
        delete store[k]
      },
    })
    localStorage.setItem('token', 'tok-123')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function okResponse(): Response {
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: {} }),
    } as unknown as Response
  }

  it('postConversation：正确端点 + 鉴权头 + Idempotency-Key + 透传 signal + 体', async () => {
    fetchMock.mockResolvedValue(okResponse())
    const signal = new AbortController().signal
    await postConversation({ sessionId: 's', message: 'hi' }, { signal, idempotencyKey: 'key-1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/agent/chat/conversation')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.headers['Authorization']).toBe('Bearer tok-123')
    expect(init.headers['Idempotency-Key']).toBe('key-1')
    expect(init.signal).toBe(signal)
    expect(JSON.parse(init.body)).toEqual({ sessionId: 's', message: 'hi' })
  })

  it('postSteerFollowup：intent=steer → /runs/steer；followup → /runs/followup', async () => {
    fetchMock.mockResolvedValue(okResponse())
    await postSteerFollowup('steer', { text: 'x' })
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/agent/runs/steer')
    await postSteerFollowup('followup', { text: 'x' })
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/agent/runs/followup')
  })

  it('postCancelRun → /api/agent/runs/cancel', async () => {
    fetchMock.mockResolvedValue(okResponse())
    await postCancelRun({ threadId: 't' })
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/agent/runs/cancel')
  })

  it('postCancelQueued → /api/agent/runs/queue/cancel', async () => {
    fetchMock.mockResolvedValue(okResponse())
    await postCancelQueued({ entryId: 'e' })
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/agent/runs/queue/cancel')
  })

  it('postPersistEntryId → /api/agent/chat/user/entry-id', async () => {
    fetchMock.mockResolvedValue(okResponse())
    await postPersistEntryId({ entryId: 'e' })
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/agent/chat/user/entry-id')
  })

  it('无 token 时不带 Authorization 头（fail-open，与内联 authHeaders 同源口径）', async () => {
    localStorage.removeItem('token')
    fetchMock.mockResolvedValue(okResponse())
    await postConversation({ a: 1 }, { signal: new AbortController().signal, idempotencyKey: 'k' })
    expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBeUndefined()
  })
})
