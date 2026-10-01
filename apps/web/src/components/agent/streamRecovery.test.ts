/** @vitest-environment node */
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  buildIdempotencyKey,
  createAgentThreadId,
  randomThreadSuffix,
  resolveBootstrapThreadId,
  persistActiveThreadId,
  shouldPollRuntimeHealth,
  checkRuntimeHealthViaNest,
  isStreamStale,
  shouldKeepReconciling,
  shouldInjectUnreachableSnippet,
  fetchThreadStateSafe,
  RECONCILE_NULL_THRESHOLD,
  STREAM_STALE_MS,
} from './streamRecovery'
import { lastThreadStorageKey } from '@/utils/formatSessionTime'

vi.mock('@/services/api-base', () => ({
  apiUrl: (path: string) => `http://localhost:5100${path.startsWith('/') ? path : `/${path}`}`,
}))

describe('resolveBootstrapThreadId', () => {
  it('prefers cached thread when it has messages', async () => {
    const id = await resolveBootstrapThreadId('sess1', {
      cachedThreadId: 'sess1:cached',
      threads: [{ id: 'sess1:other' }],
      messageCountFor: async (tid) => (tid === 'sess1:cached' ? 3 : 0),
    })
    expect(id).toBe('sess1:cached')
  })

  it('falls back to first non-empty thread when cached is empty', async () => {
    const id = await resolveBootstrapThreadId('sess1', {
      cachedThreadId: 'sess1:empty',
      threads: [{ id: 'sess1:empty' }, { id: 'sess1:busy' }],
      messageCountFor: async (tid) => (tid === 'sess1:busy' ? 5 : 0),
    })
    expect(id).toBe('sess1:busy')
  })

  it('creates new thread when nothing has messages', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'new-thread' })
    const id = await resolveBootstrapThreadId('sess1', {
      cachedThreadId: null,
      threads: [],
      messageCountFor: async () => 0,
    })
    expect(id).toBe('sess1:new-thread')
  })
})

describe('persistActiveThreadId', () => {
  it('writes localStorage key', () => {
    const store: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      setItem: (k: string, v: string) => {
        store[k] = v
      },
      getItem: (k: string) => store[k] ?? null,
    })
    persistActiveThreadId('sess-abc', 'sess-abc:tid1')
    expect(store[lastThreadStorageKey('sess-abc')]).toBe('sess-abc:tid1')
  })
})

describe('randomThreadSuffix', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses crypto.randomUUID when available', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid-1234' })
    expect(randomThreadSuffix()).toBe('test-uuid-1234')
  })

  it('falls back when crypto.randomUUID is unavailable (HTTP)', () => {
    vi.stubGlobal('crypto', {})
    const suffix = randomThreadSuffix()
    expect(suffix).toMatch(/^[a-z0-9]+-[a-z0-9]+$/)
  })
})

describe('createAgentThreadId', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never uses :main suffix', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'abc-def' })
    expect(createAgentThreadId('sess1')).toBe('sess1:abc-def')
    expect(createAgentThreadId('sess1')).not.toContain(':main')
  })
})

describe('buildIdempotencyKey', () => {
  it('generates key with thread ID, timestamp, and random suffix', () => {
    const key = buildIdempotencyKey('thread-123')
    expect(key).toMatch(/^ik_thread-123_\d+_[a-z0-9]{4}$/)
  })

  it('generates unique keys on successive calls', () => {
    const keys = new Set(Array.from({ length: 10 }, () => buildIdempotencyKey('t1')))
    expect(keys.size).toBe(10)
  })
})

describe('shouldPollRuntimeHealth', () => {
  it('returns true when content has busy indicators without completion', () => {
    expect(shouldPollRuntimeHealth('上一轮仍在处理中，请稍候')).toBe(true)
    expect(shouldPollRuntimeHealth('出图仍在进行中')).toBe(true)
    expect(shouldPollRuntimeHealth('正在生成图片')).toBe(true)
  })

  it('returns false when content has completion indicators', () => {
    expect(shouldPollRuntimeHealth('出图成功')).toBe(false)
    expect(shouldPollRuntimeHealth('已将确认的主文案写入')).toBe(false)
    expect(shouldPollRuntimeHealth('自动出图完成')).toBe(false)
  })

  it('returns false when content has no relevant indicators', () => {
    expect(shouldPollRuntimeHealth('方案确认成功')).toBe(false)
    expect(shouldPollRuntimeHealth('')).toBe(false)
  })

  it('returns false when both busy and done indicators present', () => {
    expect(shouldPollRuntimeHealth('上一轮仍在处理中，但出图成功')).toBe(false)
  })
})

describe('shouldInjectUnreachableSnippet', () => {
  // I-2 修复：reconcile 循环 thread-state 连续 null 达阈值 → 注入 RUNTIME_UNREACHABLE_SNIPPET 并 break
  it('阈值之下不注入（仍可恢复）', () => {
    expect(shouldInjectUnreachableSnippet(0)).toBe(false)
    expect(shouldInjectUnreachableSnippet(RECONCILE_NULL_THRESHOLD - 1)).toBe(false)
  })

  it('达阈值或超过注入（未做健康探测 / 探测本身失败 → 无法确认健康）', () => {
    expect(shouldInjectUnreachableSnippet(RECONCILE_NULL_THRESHOLD)).toBe(true)
    expect(shouldInjectUnreachableSnippet(RECONCILE_NULL_THRESHOLD + 2)).toBe(true)
    expect(shouldInjectUnreachableSnippet(RECONCILE_NULL_THRESHOLD, null)).toBe(true)
  })

  // 2026-10-01 生产误报：thread-state 连续 3 次 304 空体 → 读取失败，但 runtime 其实健康、出图也成功了。
  it('健康探测 ok → 即使连续读取失败也不注入（状态读取失败 ≠ 服务不可达）', () => {
    expect(shouldInjectUnreachableSnippet(RECONCILE_NULL_THRESHOLD, { ok: true })).toBe(false)
    expect(shouldInjectUnreachableSnippet(RECONCILE_NULL_THRESHOLD + 5, { ok: true })).toBe(false)
  })

  it('健康探测明确 not ok → 注入（pi-runtime 真宕机）', () => {
    expect(shouldInjectUnreachableSnippet(RECONCILE_NULL_THRESHOLD, { ok: false })).toBe(true)
  })

  it('阈值之下即便探测失败也不注入', () => {
    expect(shouldInjectUnreachableSnippet(RECONCILE_NULL_THRESHOLD - 1, { ok: false })).toBe(false)
  })
})

describe('fetchThreadStateSafe', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const stubToken = () => vi.stubGlobal('localStorage', { getItem: () => 'tok' })

  it('200 → ok:true 并回传终态', async () => {
    stubToken()
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ code: 0, data: { finished: true } }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const res = await fetchThreadStateSafe('sess:t1')
    expect(res).toEqual({ ok: true, state: { finished: true } })
  })

  it('304 空体 → ok:false（不算成功，也不冒充宕机）', async () => {
    stubToken()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 304,
        json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
      }),
    )

    expect(await fetchThreadStateSafe('sess:t1')).toEqual({ ok: false })
  })

  it('网络异常 → ok:false', async () => {
    stubToken()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    expect(await fetchThreadStateSafe('sess:t1')).toEqual({ ok: false })
  })

  it('请求带 cache:no-store（否则浏览器发 If-None-Match → 304 空体）', async () => {
    stubToken()
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ code: 0, data: null }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await fetchThreadStateSafe('sess:t1')
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/agent/thread-state?threadId=sess%3At1'),
      expect.objectContaining({ cache: 'no-store' }),
    )
  })
})

describe('isStreamStale', () => {
  it('returns true after STREAM_STALE_MS without activity', () => {
    const now = 1_000_000
    expect(isStreamStale(now - STREAM_STALE_MS - 1, now)).toBe(true)
  })

  it('returns false when activity is recent', () => {
    const now = 1_000_000
    expect(isStreamStale(now - 5_000, now)).toBe(false)
  })
})

describe('checkRuntimeHealthViaNest', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns health data when API responds ok', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ code: 0, data: { ok: true, latencyMs: 42 } }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await checkRuntimeHealthViaNest()
    expect(result).toEqual({ ok: true, latencyMs: 42 })
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:5100/agent/runtime-health',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('returns null when API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))

    const result = await checkRuntimeHealthViaNest()
    expect(result).toBeNull()
  })

  it('returns null when API returns non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))

    const result = await checkRuntimeHealthViaNest()
    expect(result).toBeNull()
  })
})

describe("shouldKeepReconciling（P1#11 重连判定）", () => {
  it("thread-state 终态立即停止", () => {
    expect(shouldKeepReconciling({ finished: true }, 0)).toBe(false);
  });

  it("未完成且未达上限时继续轮询", () => {
    expect(shouldKeepReconciling({ finished: false }, 3)).toBe(true);
    expect(shouldKeepReconciling({ finished: false }, 36)).toBe(false);
  });

  it("thread-state 缺失按上限兜底", () => {
    expect(shouldKeepReconciling(null, 10)).toBe(true);
  });
});
