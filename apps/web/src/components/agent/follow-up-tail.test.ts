/**
 * 旁听流的重连行为（multi-device Task 5 · Review Focus #1）。
 *
 * 核心契约：**用户 A 断网重连后，B 的对话流不应从头重放**——从游标续传。
 * 断言全部落在可观测出口：fetch 收到的 URL（带不带 lastEventId）与
 * onTextDelta 的回放内容。
 *
 * 与纯函数测试（observer-stream.test.ts）的分工：那边锁「URL 怎么拼」，
 * 这边锁「循环真的把 lastSeq 传给 URL、并在断线后重连」。
 *
 * ⭐⭐ 2026-10-24 契约修订（三处，源自生产取证「47ms 断流」）：
 *  ① `start()` 的 promise = **订阅已发起并拿到首个响应**，**不是**「流已结束」。
 *     常驻订阅下流在服务端保持打开、clean-end 也只重连 ⇒ 「等流结束」= 永久挂起。
 *  ② clean end（服务端正常收尾）⇒ **重连**，不是终止。
 *  ③ idle 闸门触发 ⇒ **重连**，不是终止；重连预算耗尽 ⇒ **冷却后重开**，不是终止。
 *     ⇒ 「没有任何一条路径会让订阅静默终止」——这是「常驻订阅」承诺的全部意义，
 *        否则又回到用户主诉的「刷新后才同步」。
 *
 * ⚠️ 流终止约定：`streamOf(chunks)` 发完即 clean end（**会触发重连**）；
 *   需要「挂住不 end」的用例必须传 signal（read 会挂起到 abort）。
 *   默认 makeDeps 的流**挂住不 end**（仿生产：Nest 的 runs/events 靠心跳保活，不 EOF）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFollowUpTailListener, type FollowUpTailDeps, type TailResponseLike } from './follow-up-tail'

const enc = new TextEncoder()

/** 可控 SSE 流：chunks 发完后 clean end；传了 signal 则挂起等 abort（仿真常驻连接）。 */
function streamOf(chunks: string[], signal?: AbortSignal) {
  let i = 0
  return {
    getReader: () => ({
      read: (): Promise<{ done: boolean; value?: Uint8Array }> => {
        if (i < chunks.length) return Promise.resolve({ done: false, value: enc.encode(chunks[i++]) })
        if (signal) {
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
          })
        }
        return Promise.resolve({ done: true })
      },
    }),
  }
}

/**
 * 按时序发帧的流：第 2 帧起每帧间隔 `gapMs`（受 fake timers 控制），
 * 发完后挂起等 abort —— 仿真「服务端周期性心跳的常驻连接」。
 */
function timedStream(signal: AbortSignal, chunks: string[], gapMs: number) {
  let i = 0
  return {
    getReader: () => ({
      read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
        if (i < chunks.length) {
          if (i > 0) await new Promise((r) => setTimeout(r, gapMs))
          return { done: false, value: enc.encode(chunks[i++]) }
        }
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        })
      },
    }),
  }
}

/** 发完 chunks 后连接被掐断（read 抛错）——仿真「断网」。 */
function streamResetAfter(chunks: string[]) {
  let i = 0
  return {
    getReader: () => ({
      read: (): Promise<{ done: boolean; value?: Uint8Array }> => {
        if (i < chunks.length) return Promise.resolve({ done: false, value: enc.encode(chunks[i++]) })
        return Promise.reject(new Error('connection reset by peer'))
      },
    }),
  }
}

function frame(seq: number, type: string, data: unknown = {}): string {
  return `id: ${seq}\ndata: ${JSON.stringify({ type, data })}\n\n`
}

interface TestDeps extends FollowUpTailDeps {
  urls: string[]
  texts: string[]
}

function makeDeps(overrides: Partial<FollowUpTailDeps> = {}): TestDeps {
  const urls: string[] = []
  const texts: string[] = []
  const userFetch = overrides.fetchImpl
  const base: FollowUpTailDeps = {
    // 统一记录 URL：override 的 fetchImpl 不需要自己 push（可观测出口集中一处）
    fetchImpl: (url, init) => {
      urls.push(url)
      // 默认：**常驻不结束**（仿生产：Nest 的 runs/events SSE 靠 15s 心跳保活，不 EOF）。
      // ⭐ 不能默认 clean end：clean end 在新契约下会**触发重连** ⇒ 用例的 URL 计数不再确定。
      return userFetch
        ? userFetch(url, init)
        : Promise.resolve({ status: 200, ok: true, body: streamOf([], init.signal) } as TailResponseLike)
    },
    headers: () => ({ Authorization: 'Bearer t' }),
    baseUrl: () => '/api/agent/runs/events?sessionId=s1&threadId=t1',
    onTextDelta: (text) => texts.push(text),
    onCanvasAction: () => {},
  }
  const { fetchImpl: _drop, ...rest } = overrides
  return { ...base, ...rest, urls, texts } as TestDeps
}

/**
 * 冲掉 microtask 队列（让 fetch/read 的 promise 链推进到下一个 await 点）。
 *
 * ⚠️ 必须单独存在：假时钟只推进**定时器**，不会推进 promise 链。
 * 「fetch 已 resolve 但帧还没被处理」这种中间态，靠 `await` 一个宏任务边界即可排空。
 */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('follow-up-tail 重连行为（multi-device Task 5）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // 退避确定性化：random=0.5 ⇒ 延迟恰为 exp
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('Review Focus #1：断线重连必须带游标，只补增量不重放（变异点：重连时不带 lastEventId）', async () => {
    let call = 0
    const deps = makeDeps({
      backoffBaseMs: 100,
      backoffCapMs: 1000,
      fetchImpl: (_url, init) => {
        call += 1
        if (call === 1) {
          // 第一程：收到 seq 100..110 后连接被掐断
          const chunks = Array.from({ length: 11 }, (_, i) => frame(100 + i, 'text_delta', { text: `t${100 + i}` }))
          return Promise.resolve({ status: 200, ok: true, body: streamResetAfter(chunks) } as TailResponseLike)
        }
        // 第二程（重连）：从 111 继续，发完**挂住不 end**（常驻语义）
        const chunks = [frame(111, 'text_delta', { text: 't111' }), frame(112, 'text_delta', { text: 't112' })]
        return Promise.resolve({ status: 200, ok: true, body: streamOf(chunks, init.signal) } as TailResponseLike)
      },
    })
    const listener = createFollowUpTailListener(deps)

    await listener.start()
    await flush() // 第一程读完 → 抛错 → 进退避
    await vi.advanceTimersByTimeAsync(200) // 退避（attempt=1 ⇒ 100×2×1.0）

    expect(deps.urls.length, '断线后必须重连').toBe(2)
    expect(deps.urls[1], '重连 URL 必须带 lastEventId=110（断点续传）').toContain('lastEventId=110')
    // 增量语义：两程文本都到达，且第二程从 111 开始而不是从 100 重放
    expect(deps.texts).toEqual([...Array.from({ length: 11 }, (_, i) => `t${100 + i}`), 't111', 't112'])
    listener.abort()
  })

  it('首连无游标时 URL 不拼 lastEventId（null 不拼空值）', async () => {
    const deps = makeDeps()
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    expect(deps.urls).toHaveLength(1)
    expect(deps.urls[0]).not.toContain('lastEventId')
    listener.abort()
  })

  it('404（会话已删除）不重连——重连只会再拿一次同样的状态码', async () => {
    const deps = makeDeps({
      fetchImpl: () => {
        return Promise.resolve({ status: 404, ok: false, body: null } as TailResponseLike)
      },
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(deps.urls).toHaveLength(1)
    expect(listener.getState()).toBe('idle')
  })

  it('401/403（鉴权失效）不重连——重连只会再拿一次同样的状态码', async () => {
    for (const code of [401, 403]) {
      const deps = makeDeps({
        fetchImpl: () => Promise.resolve({ status: code, ok: false, body: null } as TailResponseLike),
      })
      const listener = createFollowUpTailListener(deps)
      await listener.start()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(deps.urls, `${code} 不得触发重连`).toHaveLength(1)
      expect(listener.getState()).toBe('idle')
    }
  })

  it('resume()：backoff 等待中掐断重来（跳过排队，冻结期间计时器已停摆）', async () => {
    let call = 0
    const deps = makeDeps({
      backoffBaseMs: 100,
      backoffCapMs: 1000,
      fetchImpl: (_url, init) => {
        call += 1
        if (call === 1) {
          return Promise.resolve({
            status: 200,
            ok: true,
            body: streamResetAfter([frame(9, 'text_delta', { text: 'a' })]),
          } as TailResponseLike)
        }
        // 第二程：常驻不 end（signal 挂起）
        return Promise.resolve({ status: 200, ok: true, body: streamOf([], init.signal) } as TailResponseLike)
      },
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    await flush()
    await vi.advanceTimersByTimeAsync(50)
    expect(listener.getState()).toBe('backoff')

    await listener.resume()
    await flush()
    expect(deps.urls.length, 'resume 必须立即起重连（不等剩余退避）').toBe(2)
    expect(deps.urls[1]).toContain('lastEventId=9')
    expect(listener.getState()).toBe('streaming')
    listener.abort()
  })

  it('resume()：streaming 健康流不做任何事（不额外起连接）', async () => {
    const deps = makeDeps({
      fetchImpl: (_url, init) =>
        Promise.resolve({
          status: 200,
          ok: true,
          body: streamOf([frame(3, 'text_delta', { text: 'hi' })], init.signal),
        } as TailResponseLike),
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    await flush()
    expect(listener.getState()).toBe('streaming')
    await listener.resume()
    expect(deps.urls).toHaveLength(1)
    listener.abort()
  })

  it('畸形 JSON 帧不炸循环，正常帧仍处理', async () => {
    const deps = makeDeps({
      fetchImpl: (_url, init) =>
        Promise.resolve({
          status: 200,
          ok: true,
          body: streamOf(
            [frame(42, 'text_delta', { text: 'ok' }), 'data: {broken\n\n', frame(43, 'text_delta', { text: 'ok2' })],
            init.signal,
          ),
        } as TailResponseLike),
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    await flush()
    expect(deps.texts).toEqual(['ok', 'ok2'])
    listener.abort()
  })

  // 2026-10-24 契约变更：常驻订阅**没有**轮次上限。旧契约「挂 3 轮就不听了」是 tail
  // 语义（只补本轮收尾后的那一小段）；多端一致性要求「只要会话开着就一直在听」，
  // 有上限就等于「第 4 次之后本端又聋了」。显式传 maxRounds 仍按调用方意图生效。
  it('常驻订阅：默认无轮次上限（第 5 次 start 仍真的发起请求）——变异点：maxRounds 改回 3', async () => {
    const deps = makeDeps()
    const listener = createFollowUpTailListener(deps)
    for (let i = 0; i < 5; i++) await listener.start()
    expect(deps.urls, '常驻订阅不得有「几轮之后就不听了」的上限').toHaveLength(5)
    listener.abort()
  })

  it('显式传 maxRounds 时上限仍然生效（不破坏调用方意图）', async () => {
    const deps = makeDeps({ maxRounds: 2 })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    await listener.start()
    await listener.start()
    expect(deps.urls).toHaveLength(2)
    listener.abort()
  })

  it('idle 由任何帧刷新：连续心跳把闸门一路往后推（常驻连接不被前端掐断）——变异点：只认业务事件', async () => {
    const deps = makeDeps({
      idleMs: 10_000,
      fetchImpl: (_url, init) =>
        Promise.resolve({
          status: 200,
          ok: true,
          // 服务端 15s 一帧的心跳形态（无 id 行、无业务语义），两帧间隔 6s
          body: timedStream(init.signal, ['data: {"type":"heartbeat"}\n\n', 'data: {"type":"heartbeat"}\n\n'], 6_000),
        } as TailResponseLike),
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    await vi.advanceTimersByTimeAsync(1) // 建连 + 第 1 个心跳（idle ⇒ 10s）
    await vi.advanceTimersByTimeAsync(6_000) // 第 2 个心跳（idle ⇒ 16s）
    // 累计 12s > idleMs(10s)：只有心跳刷新了 idle 才可能还活着
    await vi.advanceTimersByTimeAsync(6_000)
    expect(listener.getState(), '心跳必须刷新 idle，否则常驻订阅名存实亡').toBe('streaming')
    listener.abort()
  })

  it('回合收束帧回调 onTurnEnd：text_delta 不算收束，done 与 turn_ack 各一次', async () => {
    let ends = 0
    const deps = makeDeps({
      onTurnEnd: () => {
        ends += 1
      },
      fetchImpl: (_url, init) =>
        Promise.resolve({
          status: 200,
          ok: true,
          body: streamOf(
            [frame(1, 'text_delta', { text: 'a' }), frame(2, 'done', {}), frame(3, 'turn_ack', {})],
            init.signal,
          ),
        } as TailResponseLike),
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    await flush()
    expect(deps.texts).toEqual(['a'])
    expect(ends, 'done 与 turn_ack 都是收束（onTurnEnd 需幂等，故允许来两次）').toBe(2)
    listener.abort()
  })

  it('失败帧（error / turn_not_submitted）同样是收束——变异点：去掉收束判定', async () => {
    let ends = 0
    const deps = makeDeps({
      onTurnEnd: () => {
        ends += 1
      },
      fetchImpl: (_url, init) =>
        Promise.resolve({
          status: 200,
          ok: true,
          body: streamOf([frame(1, 'error', {}), frame(2, 'turn_not_submitted', {})], init.signal),
        } as TailResponseLike),
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    await flush()
    expect(ends, '轮失败也必须有收束信号，否则旁观气泡永远转圈').toBe(2)
    listener.abort()
  })
})

/**
 * ⭐⭐ 2026-10-24：服务端 clean-end 后**必须重连**。
 *
 * 生产取证（`/api/agent/runs/events` 实测 47ms 断流）：
 *   旧语义「clean end = 正常收尾 ⇒ return 不重连」让旁听端在服务端收流后
 *   **永久退出**，直到用户切走再切回或刷新页面。
 *   ⇒ 这正是用户主诉「刷新后才同步」的直接成因：
 *   旁听端早就聋了，刷新才重新挂上并拉到权威历史。
 *
 * 断言全部落在**可观测出口**（fetch 收到的 URL 次数）。
 */
describe('follow-up-tail：服务端 clean-end 后仍重连（2026-10-24 语义修正）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('clean-end 后必须发起第二次连接——变异点：clean-end 直接 return', async () => {
    const deps = makeDeps({
      backoffBaseMs: 100,
      backoffCapMs: 1000,
      maxReconnects: 10,
      fetchImpl: () =>
        Promise.resolve({
          status: 200,
          ok: true,
          // 每程都 clean end（仿真「服务端周期性正常收尾」）
          body: streamOf([]),
        } as TailResponseLike),
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    await flush() // 第 1 程：建连 + clean end
    await vi.advanceTimersByTimeAsync(200) // 退避 100ms（random=0.5 ⇒ exp=1）
    expect(deps.urls.length, 'clean-end 后必须重连，否则旁听端永久失联').toBeGreaterThanOrEqual(2)
    listener.abort()
  })

  it('健康连接（产出过 data 帧）豁免重连预算：连续 8 次 clean-end 仍持续重连——变异点：不给豁免', async () => {
    const deps = makeDeps({
      backoffBaseMs: 10,
      backoffCapMs: 20,
      maxReconnects: 2, // 预算故意很小：不给健康豁免的话第 3 次就会被掐断
      fetchImpl: () =>
        Promise.resolve({
          status: 200,
          ok: true,
          body: streamOf([frame(1, 'heartbeat', {})]), // 每程都产出 1 帧 ⇒ 健康连接
        } as TailResponseLike),
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    for (let i = 0; i < 8; i++) {
      await flush()
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(
      deps.urls.length,
      '周期性 clean-end 的常驻订阅不得因预算耗尽而永久失联',
    ).toBeGreaterThanOrEqual(8)
    listener.abort()
  })

  it('零帧的「连上即断」不豁免预算：预算耗尽后冷却重开（而非终止）——变异点：给零帧也豁免', async () => {
    const deps = makeDeps({
      backoffBaseMs: 10,
      backoffCapMs: 20,
      maxReconnects: 3,
      reconnectCooldownMs: 60_000,
      fetchImpl: () =>
        Promise.resolve({
          status: 200,
          ok: true,
          body: streamOf([]), // 零帧 ⇒ 连上即断
        } as TailResponseLike),
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    for (let i = 0; i < 20; i++) {
      await flush()
      await vi.advanceTimersByTimeAsync(50)
    }
    // maxReconnects=3 ⇒ 首连 + 3 次重连 = 4 次 URL，之后进入冷却
    expect(deps.urls.length, '连上即断必须被重连预算掐断').toBe(4)
    expect(listener.getState(), '预算耗尽后进入冷却，而不是终止订阅').toBe('backoff')
    // ⭐ 冷却结束后重开一轮新预算 ⇒ 订阅**没有终止**（旧语义在这里就永久失联了）
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(deps.urls.length, '冷却后必须重开一轮新预算（常驻订阅不许永久失联）').toBeGreaterThanOrEqual(5)
    listener.abort()
  })
})

/**
 * ⭐⭐ 2026-10-24：idle 闸门触发 ⇒ **重连**，不是终止。
 *
 * 旧语义：idle 闸门 abort 掉这一程 ⇒ 循环退出 ⇒ 订阅永久结束。
 * ⇒ 与 clean-end 同一个病根：旁听端在服务端静默 45s 后就聋了。
 * 新语义：idle 只掐**当前这一程**，随后换一程继续听（计入重连预算）。
 */
describe('follow-up-tail：idle 闸门触发后仍重连（2026-10-24 语义修正）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('服务端彻底静默超过 idleMs 后必须换一程继续听——变异点：idle 后直接 return', async () => {
    const deps = makeDeps({
      idleMs: 20_000,
      backoffBaseMs: 100,
      backoffCapMs: 1000,
      maxReconnects: 10,
      fetchImpl: (_url, init) =>
        Promise.resolve({ status: 200, ok: true, body: streamOf([], init.signal) } as TailResponseLike),
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    await flush()
    expect(deps.urls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(21_000) // idle 闸门 fire
    await flush()
    await vi.advanceTimersByTimeAsync(200) // 退避后换一程
    expect(deps.urls.length, 'idle 后必须重连，否则静默会话下本端会聋').toBeGreaterThanOrEqual(2)
    expect(listener.getState(), 'idle 不得终止订阅').not.toBe('idle')
    listener.abort()
  })
})

/**
 * ⭐⭐ 2026-10-24：`abort()` 必须**立刻**掐断一切，不得留下幽灵订阅。
 *
 * 旧实现的两个漏洞：
 *  ① 退避等待用裸 `setTimeout` ⇒ abort 后旧循环仍要等满退避时长（最长 5s）才醒；
 *  ② `abort()` 只掐「当前」controller ⇒ 被 `start()` 取代的旧循环**永不停歇**
 *     （叠加「clean-end 也重连」后 ⇒ 幽灵订阅持续重连）。
 */
describe('follow-up-tail：abort 立刻掐断（无幽灵订阅）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('abort 后不得再发起任何连接——变异点：abort 不掐旧循环', async () => {
    const deps = makeDeps({
      backoffBaseMs: 100,
      backoffCapMs: 5000,
      fetchImpl: () => Promise.reject(new Error('connection reset by peer')),
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    await flush() // 进退避等待
    listener.abort()
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deps.urls.length, 'abort 后不得再发起连接（幽灵订阅）').toBe(1)
    expect(listener.getState()).toBe('idle')
  })

  it('abort 必须立刻清掉退避定时器（不等满退避时长）——变异点：裸 setTimeout 不可中断', async () => {
    const deps = makeDeps({
      backoffBaseMs: 100,
      backoffCapMs: 5000,
      fetchImpl: () => Promise.reject(new Error('connection reset by peer')),
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    await flush()
    expect(vi.getTimerCount(), '退避期间应有一个待触发的定时器').toBeGreaterThan(0)
    listener.abort()
    await flush()
    expect(vi.getTimerCount(), 'abort 后不得残留任何定时器（切会话/关页后旧订阅还挂着）').toBe(0)
  })

  it('start() 取代上一轮时，旧轮必须彻底停掉（不得两条订阅并存）——变异点：旧循环不被掐', async () => {
    // ⭐⭐ 不变量不是「总连接数」：新契约下 clean-end / idle 都会让**当前**轮重连
    //   （idle 闸门默认 45s ⇒ 60s 窗口内当前轮会合法重连一次），
    //   所以「urls.length === 2」根本不是确定值（那是本用例最初失败的原因）。
    //
    // 真正的不变量 = **同时存活的订阅数恒为 1**。
    // 旧轮若没被掐 ⇒ 它那一程的 attempt 不会被 abort ⇒ 并发数变成 2 ⇒ 用例红。
    //   （这正是「幽灵订阅」在生产上的形态：两条 SSE 同时挂着，事件被双份消费。）
    let active = 0
    let peak = 0
    const deps = makeDeps({
      backoffBaseMs: 100,
      backoffCapMs: 1000,
      fetchImpl: (_url, init) => {
        active += 1
        peak = Math.max(peak, active)
        // attempt 被 abort ⇔ 这一程订阅真正结束（唯一出口）。
        init.signal.addEventListener('abort', () => { active -= 1 }, { once: true })
        return Promise.resolve({ status: 200, ok: true, body: streamOf([], init.signal) } as TailResponseLike)
      },
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    await listener.start() // 取代上一轮
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(peak, '旧轮必须被掐断，任何时刻都不得有两条订阅并存').toBe(1)
    listener.abort()
    await flush()
    expect(active, 'abort 后不得残留任何订阅（切会话/关页后旧订阅还挂着）').toBe(0)
  })

  // ── 2026-10-26 生产事故：同一 thread 被同时开了 6 条 SSE ────────────────────
  // 事故：画布页把同源 HTTP/1.1 的 6 个连接槽位占满 ⇒ 画布数据请求排队不 settle
  //      ⇒ 「画布是空的」；且后续自动保存会把这份空画布整份 PUT 回服务端。
  // 修复：不变量从「调用点自觉」改成**模块内部的结构性保证**——
  //      ① abort() 一次掐掉**全部**在途轮次（旧实现只掐 current）；
  //      ② 最新轮次胜出：旧轮在循环顶部自杀。
  // ⇒ 判据落在**可观测出口**（同时在飞的 fetch 峰值 / 在途轮次数）。

  it('⭐ 2026-10-26：任何时刻最多一条连接在飞（并发 start/resume 也不许并发出两条）', async () => {
    let active = 0
    let peak = 0
    const deps = makeDeps({
      fetchImpl: (_url, init) => {
        active += 1
        peak = Math.max(peak, active)
        // attempt 被 abort ⇔ 这一程订阅真正结束（唯一出口）。
        init.signal.addEventListener('abort', () => { active -= 1 }, { once: true })
        return Promise.resolve({ status: 200, ok: true, body: streamOf([], init.signal) } as TailResponseLike)
      },
    })
    const listener = createFollowUpTailListener(deps)

    // 敌意序列：并发 start × 3 → 并发 resume × 2 → 长时间运行
    await Promise.all([listener.start(), listener.start(), listener.start()])
    await flush()
    await Promise.all([listener.resume(), listener.resume()])
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(peak, '任何时刻都不得有两条订阅并存（6 条 ⇒ 吃满浏览器连接槽位）').toBe(1)
    expect(listener.getLiveCount(), '在途轮次必须 ≤1（>1 ⇒ 有旧轮没被掐干净）').toBeLessThanOrEqual(1)

    listener.abort()
    await flush()
    expect(active, 'abort 后不得残留任何订阅').toBe(0)
    expect(listener.getLiveCount(), 'abort 后在途轮次必须归零').toBe(0)
  })

  it('⭐ 2026-10-26：abort 必须掐掉**全部**在途轮次（旧实现只掐 current ⇒ 旧轮变僵尸）', async () => {
    const deps = makeDeps({
      fetchImpl: (_url, init) =>
        Promise.resolve({ status: 200, ok: true, body: streamOf([], init.signal) } as TailResponseLike),
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    await flush()
    expect(listener.getLiveCount(), '正常运行时在途轮次应为 1').toBe(1)
    listener.abort()
    await flush()
    expect(listener.getLiveCount(), 'abort 后在途轮次必须归零（不能只掐 current 一个）').toBe(0)
  })
})
