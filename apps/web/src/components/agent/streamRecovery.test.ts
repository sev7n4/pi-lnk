/** @vitest-environment node */
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  buildIdempotencyKey,
  deriveObserverFromSeq,
  createAgentThreadId,
  getForkedThreadId,
  randomThreadSuffix,
  resolveBootstrapThreadId,
  persistActiveThreadId,
  persistForkedThreadId,
  shouldPollRuntimeHealth,
  checkRuntimeHealthViaNest,
  isStreamStale,
  shouldKeepReconciling,
  STREAM_STALE_MS,
  fetchRuntimeReconcile,
} from './streamRecovery'
import { lastThreadStorageKey } from '@/utils/formatSessionTime'

vi.mock('@/services/api-base', () => ({
  apiUrl: (path: string) => `http://localhost:5100${path.startsWith('/') ? path : `/${path}`}`,
}))

/**
 * ⭐ 本 describe 的三个用例就是 **INV-3（进入既有项目后恢复既有 thread，不新建 thread）**
 *    与 **INV-1（list 非空时进入创作产生 0 个新 Session 行）** 的守卫。
 *
 * 2026-10-25 PR-1 Task 5 说明：原计划要求在此补一条「已有带消息的 thread 优先复用」
 * 用例 —— 经核对它与下面第 1、2 条**语义重复**（都会立即通过，证明不了任何东西），
 * 按 TDD 纪律不加。改为把这三个用例与不变量的对应关系写明，让"锁定"的目的
 * （后人知道改这里会破坏什么）达成，而不是制造一个永远绿的假测试。
 *
 * 对应关系：
 *   · prefers cached thread when it has messages        ⇒ INV-3 主路径（有缓存且缓存有消息）
 *   · falls back to first non-empty thread when cached…  ⇒ INV-3 兜底（缓存空了就找有消息的）
 *   · creates new thread when nothing has messages       ⇒ 唯一允许新建 thread 的场景（真空项目）
 */
function stubLocalStorage() {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  return store
}

// H1-b / D3：bootstrap 不再全量下载 user/messages 只为数数（S6 契约）
it('messageCountFor 已退役（D3：bootstrap 不再全量下载计数）', async () => {
  expect((await import('./streamRecovery') as Record<string, unknown>).messageCountFor).toBeUndefined()
})

// H1-c（规格 2026-10-28 §5.2）：thread-state 死端点退役，导出面收窄（D20 不许半死）
it('fetchThreadStateSafe 已退役（H1-c：死端点清除，D20 不许半死）', async () => {
  const mod = (await import('./streamRecovery')) as Record<string, unknown>
  expect(mod.fetchThreadStateSafe).toBeUndefined()
})

it('ThreadStateRead 已退役（H1-c：类型随安全拉取一并删除）', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./streamRecovery.ts', import.meta.url), 'utf8'),
  )
  expect(src).not.toContain('ThreadStateRead')
})

it('I-2 thread-state 不可达判定随 H1-c 一并退役（消费分支死代码清除）', async () => {
  const mod = (await import('./streamRecovery')) as Record<string, unknown>
  expect(mod.shouldInjectUnreachableSnippet).toBeUndefined()
  expect(mod.RECONCILE_NULL_THRESHOLD).toBeUndefined()
})

describe('resolveBootstrapThreadId（H1-b：threads 行计数 + fail-open）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fork key 有消息（messageCount>0）⇒ 激活分支线程', async () => {
    stubLocalStorage()
    persistForkedThreadId('s1', 'branch_1')
    const id = await resolveBootstrapThreadId('s1', {
      threads: [{ id: 'branch_1', messageCount: 3 }, { id: 's1', messageCount: 9 }],
    })
    expect(id).toBe('branch_1')
  })

  it('fork key 无消息 ⇒ 清 fork key 回落共享线程（原行为不变）', async () => {
    stubLocalStorage()
    persistForkedThreadId('s1', 'branch_1')
    const id = await resolveBootstrapThreadId('s1', {
      threads: [{ id: 's1', messageCount: 9 }],
    })
    expect(id).toBe('s1')
    expect(getForkedThreadId('s1')).toBeNull()
  })

  it('threads=null（拉取失败）⇒ fail-open：保留 fork key 现场不清（Review Focus #5 / K3）', async () => {
    stubLocalStorage()
    persistForkedThreadId('s1', 'branch_1')
    const id = await resolveBootstrapThreadId('s1', { threads: null })
    expect(id).toBe('branch_1')
    expect(getForkedThreadId('s1')).toBe('branch_1')
  })

  it('threads=null 且无 fork key ⇒ 回落共享线程，同样不清任何 key', async () => {
    stubLocalStorage()
    const id = await resolveBootstrapThreadId('s1', { threads: null })
    expect(id).toBe('s1')
    expect(getForkedThreadId('s1')).toBeNull()
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

describe('createAgentThreadId（多端共享对话）', () => {
  it('等于 sessionId（确定式，跨设备收敛到同一条对话）', () => {
    expect(createAgentThreadId('sess1')).toBe('sess1')
  })

  it('never uses :main suffix', () => {
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

describe("shouldKeepReconciling（P1#11 重连判定；H1-c 后调用方恒传 null ⇒ 按上限兜底）", () => {
  it("终态立即停止（保留语义：H3 重接 turnState 时复用）", () => {
    expect(shouldKeepReconciling({ finished: true }, 0)).toBe(false);
  });

  it("未完成且未达上限时继续轮询", () => {
    expect(shouldKeepReconciling({ finished: false }, 3)).toBe(true);
    expect(shouldKeepReconciling({ finished: false }, 36)).toBe(false);
  });

  it("状态缺失（现生产恒 null）按上限兜底", () => {
    expect(shouldKeepReconciling(null, 10)).toBe(true);
  });
});

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

describe('deriveObserverFromSeq（P0 断流回填尾包参数推导）', () => {
  it('有主流最后 seq 时返回 lastEventId 断点续拉', () => {
    expect(deriveObserverFromSeq(42)).toEqual({ fromNow: false, lastEventId: 42 })
  })

  it('null/undefined 时回退从 now 起', () => {
    expect(deriveObserverFromSeq(null)).toEqual({ fromNow: true })
    expect(deriveObserverFromSeq(undefined as unknown as number | null)).toEqual({ fromNow: true })
  })

  it('负值/小数被当作无效，回退 fromNow（避免拼接空值触发全量重放）', () => {
    expect(deriveObserverFromSeq(-1)).toEqual({ fromNow: true })
    expect(deriveObserverFromSeq(3.5)).toEqual({ fromNow: true })
  })
})


describe('fetchRuntimeReconcile（P0+P1：transcript 层对账）', () => {
  const okFetch = (data: unknown) =>
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0, data }) })

  it('解包 {code,data} 包络并透传 outcome + sinceSeq 参数', async () => {
    const fetchMock = okFetch({ outcome: 'active', lastSeq: 9 })
    const r = await fetchRuntimeReconcile('T1', 5, fetchMock as unknown as typeof fetch)
    expect(r).toEqual({ outcome: 'active', lastSeq: 9 })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('threadId=T1')
    expect(url).toContain('sinceSeq=5')
  })

  it('sinceSeq 为 null 时不带该参数（避免空值触发全量重放）', async () => {
    const fetchMock = okFetch({ outcome: 'missing', lastSeq: 0 })
    await fetchRuntimeReconcile('T1', null, fetchMock as unknown as typeof fetch)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).not.toContain('sinceSeq')
  })

  it('带 cache:no-store（304 空体会让 json() 抛错，静默中断对账）', async () => {
    const fetchMock = okFetch({ outcome: 'settled', lastSeq: 1 })
    await fetchRuntimeReconcile('T1', 1, fetchMock as unknown as typeof fetch)
    const init = fetchMock.mock.calls[0][1] as { cache?: string }
    expect(init.cache).toBe('no-store')
  })

  it('非 200 / 网络异常 / 非法 outcome ⇒ null（调用方回落既有失败路径）', async () => {
    const bad = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    expect(await fetchRuntimeReconcile('T1', 1, bad as unknown as typeof fetch)).toBeNull()
    const thrower = vi.fn().mockRejectedValue(new Error('net'))
    expect(await fetchRuntimeReconcile('T1', 1, thrower as unknown as typeof fetch)).toBeNull()
    const weird = okFetch({ outcome: 'bogus' })
    expect(await fetchRuntimeReconcile('T1', 1, weird as unknown as typeof fetch)).toBeNull()
  })
})
