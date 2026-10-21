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
 * ⚠️ 流终止约定：`streamOf(chunks)` 发完即 clean end（start() 可 await）；
 * 只有需要「挂住不 end」的用例才传 signal（read 会挂起到 abort）。
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
      return userFetch ? userFetch(url, init) : Promise.resolve({ status: 200, ok: true, body: streamOf([]) } as TailResponseLike)
    },
    headers: () => ({ Authorization: 'Bearer t' }),
    baseUrl: () => '/api/agent/runs/events?sessionId=s1&threadId=t1',
    onTextDelta: (text) => texts.push(text),
    onCanvasAction: () => {},
  }
  const { fetchImpl: _drop, ...rest } = overrides
  return { ...base, ...rest, urls, texts } as TestDeps
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
      fetchImpl: (_url) => {
        call += 1
        if (call === 1) {
          // 第一程：收到 seq 100..110 后连接被掐断
          const chunks = Array.from({ length: 11 }, (_, i) => frame(100 + i, 'text_delta', { text: `t${100 + i}` }))
          return Promise.resolve({ status: 200, ok: true, body: streamResetAfter(chunks) } as TailResponseLike)
        }
        // 第二程（重连）：从 111 继续，发完 clean end
        const chunks = [frame(111, 'text_delta', { text: 't111' }), frame(112, 'text_delta', { text: 't112' })]
        return Promise.resolve({ status: 200, ok: true, body: streamOf(chunks) } as TailResponseLike)
      },
    })
    const listener = createFollowUpTailListener(deps)

    const p = listener.start()
    await vi.advanceTimersByTimeAsync(200) // 退避（attempt=1 ⇒ 100×2×1.0）
    await p

    expect(deps.urls.length, '断线后必须重连').toBe(2)
    expect(deps.urls[1], '重连 URL 必须带 lastEventId=110（断点续传）').toContain('lastEventId=110')
    // 增量语义：两程文本都到达，且第二程从 111 开始而不是从 100 重放
    expect(deps.texts).toEqual([...Array.from({ length: 11 }, (_, i) => `t${100 + i}`), 't111', 't112'])
  })

  it('首连无游标时 URL 不拼 lastEventId（null 不拼空值）', async () => {
    const deps = makeDeps()
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    expect(deps.urls).toHaveLength(1)
    expect(deps.urls[0]).not.toContain('lastEventId')
  })

  it('404（会话已删除）不重连', async () => {
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

  it('重连预算耗尽后停止（maxReconnects=3 ⇒ 共 4 次），不无限重挂', async () => {
    const deps = makeDeps({
      backoffBaseMs: 100,
      backoffCapMs: 1000,
      maxReconnects: 3,
      fetchImpl: () => {
        return Promise.resolve({
          status: 200,
          ok: true,
          body: streamResetAfter([frame(1, 'text_delta', { text: 'a' })]),
        } as TailResponseLike)
      },
    })
    const listener = createFollowUpTailListener(deps)
    const p = listener.start()
    // 增量推进覆盖 200+400+800 三段退避；不要一把推进 100s——默认 idle 20s
    // 会在中途 fire abort，把「预算耗尽」与「idle 断开」两条路径混在一起。
    await vi.advanceTimersByTimeAsync(200)
    await vi.advanceTimersByTimeAsync(400)
    await vi.advanceTimersByTimeAsync(800)
    await p
    expect(deps.urls).toHaveLength(4)
    expect(listener.getState()).toBe('idle')
  })

  it('第二程健康流直达 clean end，不再触发额外重连', async () => {
    let call = 0
    const deps = makeDeps({
      backoffBaseMs: 100,
      backoffCapMs: 1000,
      fetchImpl: (_url) => {
        call += 1
        if (call === 1) {
          return Promise.resolve({
            status: 200,
            ok: true,
            body: streamResetAfter([frame(5, 'text_delta', { text: 'x' })]),
          } as TailResponseLike)
        }
        return Promise.resolve({
          status: 200,
          ok: true,
          body: streamOf([frame(6, 'text_delta', { text: 'y' }), frame(7, 'text_delta', { text: 'z' })]),
        } as TailResponseLike)
      },
    })
    const listener = createFollowUpTailListener(deps)
    const p = listener.start()
    await vi.advanceTimersByTimeAsync(200)
    await p
    expect(deps.urls).toHaveLength(2)
    expect(deps.texts).toEqual(['x', 'y', 'z'])
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
    const p1 = listener.start()
    await vi.advanceTimersByTimeAsync(50)
    expect(listener.getState()).toBe('backoff')

    const p2 = listener.resume()
    await vi.advanceTimersByTimeAsync(250) // 旧循环退避计时器到点自行退出
    await p1
    expect(deps.urls.length, 'resume 必须立即起重连（不等剩余退避）').toBe(2)
    expect(deps.urls[1]).toContain('lastEventId=9')
    expect(listener.getState()).toBe('streaming')
    listener.abort()
    await p2
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
    const p = listener.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(listener.getState()).toBe('streaming')
    await listener.resume()
    expect(deps.urls).toHaveLength(1)
    listener.abort()
    await p
  })

  it('idle 闸门：无业务事件 20s 即断（不得用心跳保活）', async () => {
    const deps = makeDeps({
      idleMs: 20_000,
      fetchImpl: (_url, init) =>
        Promise.resolve({ status: 200, ok: true, body: streamOf([], init.signal) } as TailResponseLike),
    })
    const listener = createFollowUpTailListener(deps)
    const p = listener.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(listener.getState()).toBe('streaming')
    await vi.advanceTimersByTimeAsync(21_000)
    await p
    expect(listener.getState()).toBe('idle')
    expect(deps.urls, 'idle 断开不重连').toHaveLength(1)
  })

  it('畸形 JSON 帧不炸循环，正常帧仍处理', async () => {
    const deps = makeDeps({
      fetchImpl: () =>
        Promise.resolve({
          status: 200,
          ok: true,
          body: streamOf([frame(42, 'text_delta', { text: 'ok' }), 'data: {broken\n\n', frame(43, 'text_delta', { text: 'ok2' })]),
        } as TailResponseLike),
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    expect(deps.texts).toEqual(['ok', 'ok2'])
  })

  it('轮次上限：超过 maxRounds 次 start 后不再挂（默认 3）', async () => {
    const deps = makeDeps()
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    await listener.start()
    await listener.start()
    await listener.start()
    expect(deps.urls).toHaveLength(3)
  })
})
