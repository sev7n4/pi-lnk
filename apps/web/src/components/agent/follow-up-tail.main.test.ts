/**
 * 多端一致性 P1（计划 2026-11-04 Task 5/6）：ack 化主流的**通道消费面**。
 *
 * 三块契约：
 *  ① onEvent 排他分派——提供 onEvent 后全量 payload 走它，具名三回调不再触发
 *     （本端回合需要 proposal/ask_user/task_* 全量语义，双发 = 文本双倍）；
 *  ② setLastSeq 绝对游标——覆盖内部残值（seedLastSeq 是「仅空播种」，发起新 run
 *     时内部冻结残值 < 锚点会把上一轮尾包重放进取）；
 *  ③ on 路径终止 = 事件终态（isTurnTerminal），与 [DONE] 无关（本路径没有 POST 流）。
 *
 * harness 与 follow-up-tail.test.ts 同构（streamOf / makeDeps / flush 语义一致）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFollowUpTailListener,
  isTurnTerminal,
  type FollowUpTailDeps,
  type TailResponseLike,
} from './follow-up-tail'

const enc = new TextEncoder()

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

function frame(seq: number, type: string, data: unknown = {}): string {
  return `id: ${seq}\ndata: ${JSON.stringify({ type, data })}\n\n`
}

function makeDeps(overrides: Partial<FollowUpTailDeps> = {}) {
  const urls: string[] = []
  const base: FollowUpTailDeps = {
    fetchImpl: (url, init) => {
      urls.push(url)
      const user = overrides.fetchImpl
      return user
        ? user(url, init)
        : Promise.resolve({ status: 200, ok: true, body: streamOf([], init.signal) } as TailResponseLike)
    },
    headers: () => ({ Authorization: 'Bearer t' }),
    baseUrl: () => '/api/agent/runs/events?sessionId=s1&threadId=t1',
  }
  const { fetchImpl: _drop, ...rest } = overrides
  return { ...base, ...rest, urls }
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('onEvent 排他分派（Task 5：本端回合的全量事件通道）', () => {
  it('提供 onEvent ⇒ 全量 payload 交给它（含具名回调不覆盖的类型），具名回调不触发', async () => {
    const seen: Array<{ type: string; data: unknown }> = []
    const onTextDelta = vi.fn()
    const onCanvasAction = vi.fn()
    const onTurnEnd = vi.fn()
    const deps = makeDeps({
      onEvent: (p) => seen.push(p),
      onTextDelta,
      onCanvasAction,
      onTurnEnd,
      fetchImpl: (_url, init) =>
        Promise.resolve({
          status: 200,
          ok: true,
          body: streamOf(
            [
              frame(1, 'text_delta', { text: 'a' }),
              frame(2, 'canvas_action', { type: 'add_node' }),
              frame(3, 'task_list', { items: [] }),
              frame(4, 'done', {}),
            ],
            init.signal,
          ),
        } as TailResponseLike),
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    await flush()

    expect(seen.map((p) => p.type)).toEqual(['text_delta', 'canvas_action', 'task_list', 'done'])
    expect(seen[0].data).toEqual({ text: 'a' })
    // 排他：双发 = 文本双倍（气泡污染），具名回调必须沉默
    expect(onTextDelta).not.toHaveBeenCalled()
    expect(onCanvasAction).not.toHaveBeenCalled()
    expect(onTurnEnd).not.toHaveBeenCalled()
  })

  it('未提供 onEvent ⇒ 既有具名回调分派不变（旁观最小面回归）', async () => {
    const onTextDelta = vi.fn()
    const onCanvasAction = vi.fn()
    const onTurnEnd = vi.fn()
    const deps = makeDeps({
      onTextDelta,
      onCanvasAction,
      onTurnEnd,
      fetchImpl: (_url, init) =>
        Promise.resolve({
          status: 200,
          ok: true,
          body: streamOf(
            [frame(1, 'text_delta', { text: 'x' }), frame(2, 'canvas_action', { k: 1 }), frame(3, 'done', {})],
            init.signal,
          ),
        } as TailResponseLike),
    })
    const listener = createFollowUpTailListener(deps)
    await listener.start()
    await flush()

    expect(onTextDelta).toHaveBeenCalledWith('x')
    expect(onCanvasAction).toHaveBeenCalledWith({ k: 1 })
    expect(onTurnEnd).toHaveBeenCalledTimes(1)
  })
})

describe('setLastSeq 绝对游标（Task 5：ack 锚点覆盖内部残值）', () => {
  it('setLastSeq(42) 覆盖已有内部游标 ⇒ 首连带 lastEventId=42', async () => {
    const deps = makeDeps({
      fetchImpl: (_url, init) =>
        Promise.resolve({
          status: 200,
          ok: true,
          body: streamOf([frame(7, 'text_delta', { text: 'x' })], init.signal),
        } as TailResponseLike),
    })
    const listener = createFollowUpTailListener(deps)
    // 先跑一程让内部游标推进到 7
    await listener.start()
    await flush()
    // seedLastSeq（仅空播种）不回退 —— 内部已是 7
    listener.seedLastSeq(3)
    await listener.abort()
    await listener.start()
    await flush()
    expect(deps.urls.at(-1)).toContain('lastEventId=7')
    // setLastSeq（绝对覆盖）：ack 锚点 42 必须生效
    listener.setLastSeq(42)
    await listener.abort()
    await listener.start()
    await flush()
    expect(deps.urls.at(-1)).toContain('lastEventId=42')
  })

  it('setLastSeq(null) ⇒ from=now 语义（URL 不带 lastEventId）', async () => {
    const deps = makeDeps()
    const listener = createFollowUpTailListener(deps)
    listener.setLastSeq(42)
    listener.setLastSeq(null)
    await listener.start()
    await flush()
    expect(deps.urls[0]).not.toContain('lastEventId')
  })

  it('非法值（负数/小数）按 null 处理（不拼出损坏 URL）', async () => {
    const deps = makeDeps()
    const listener = createFollowUpTailListener(deps)
    listener.setLastSeq(-1)
    await listener.start()
    await flush()
    expect(deps.urls[0]).not.toContain('lastEventId')
    await listener.abort()
    listener.setLastSeq(3.5)
    await listener.start()
    await flush()
    expect(deps.urls.at(-1)).not.toContain('lastEventId')
  })
})

describe('isTurnTerminal 终止语义（Task 6：on 路径以事件终态收口）', () => {
  it('done / turn_ack / error / turn_not_submitted 是终态；heartbeat / text_delta 不是', () => {
    expect(isTurnTerminal('done')).toBe(true)
    expect(isTurnTerminal('turn_ack')).toBe(true)
    expect(isTurnTerminal('error')).toBe(true)
    expect(isTurnTerminal('turn_not_submitted')).toBe(true)
    expect(isTurnTerminal('heartbeat')).toBe(false)
    expect(isTurnTerminal('text_delta')).toBe(false)
    expect(isTurnTerminal('turn_suspended')).toBe(false) // 挂起 ≠ 终态（run 仍在跑）
  })
})
