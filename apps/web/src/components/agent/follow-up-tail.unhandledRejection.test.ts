/**
 * F1 行为级契约：被丢弃的 Promise 不得产生未处理 rejection。
 *
 * 现象（生产 CDP 取证，见 docs/ops/2026-11-08-phase3-prod-smoke.md §3）：
 *   Uncaught (in promise) AbortError: signal is aborted without reason
 * 复刻链路：建连 → 显式 abort → pending read() 以 AbortError reject
 *         → finally 里 cancel() 对已 errored 的流返回被拒 Promise
 *         → 该 Promise 被 `void` 丢弃 ⇒ 浏览器 Runtime.exceptionThrown。
 *
 * 判据出口是**运行时事件**，不是源码文本；源码文本判据另设 S4 作第二道门禁。
 * 探针临时独占 process 的 unhandledRejection 监听，结束后完整恢复，
 * 避免 vitest 自身的处理器把本用例的预期 rejection 计成 unhandled error。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createFollowUpTailListener,
  type FollowUpTailDeps,
  type TailResponseLike,
} from './follow-up-tail'

type UnhandledHandler = (reason: unknown, promise: Promise<unknown>) => void

function installProbe() {
  const seen: unknown[] = []
  const prior = process.listeners('unhandledRejection') as unknown as UnhandledHandler[]
  process.removeAllListeners('unhandledRejection')
  const handler: UnhandledHandler = (reason) => {
    seen.push(reason)
  }
  process.on('unhandledRejection', handler)
  return {
    seen,
    restore: () => {
      process.off('unhandledRejection', handler)
      for (const l of prior) process.on('unhandledRejection', l)
    },
  }
}

/** 真实时钟等一拍：unhandledRejection 在微任务队列排空后由 Node 触发。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const abortError = () => new DOMException('signal is aborted without reason', 'AbortError')

/** 像真实浏览器一样：abort ⇒ pending read() reject；cancel 返回被拒 Promise。 */
function hangingReader(signal: AbortSignal, cancel: () => unknown) {
  return {
    read: () =>
      new Promise<{ done: boolean; value?: Uint8Array }>((_resolve, reject) => {
        const onAbort = () => reject(abortError())
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }),
    cancel,
  }
}

function makeDeps(overrides: Partial<FollowUpTailDeps> = {}) {
  const state = { fetchCalls: 0, cancelCalls: 0 }
  const base: FollowUpTailDeps = {
    idleMs: 60_000,
    baseUrl: () => '/api/agent/runs/events?sessionId=s1&threadId=t1',
    headers: () => ({}),
    fetchImpl: (_url, init) => {
      state.fetchCalls += 1
      return Promise.resolve({
        status: 200,
        ok: true,
        body: {
          getReader: () =>
            hangingReader(init.signal, () => {
              state.cancelCalls += 1
              // Streams 规范：流已 errored 时 cancel 返回被拒 Promise
              return Promise.reject(abortError())
            }),
        },
      } as TailResponseLike)
    },
  }
  return { deps: { ...base, ...overrides }, state }
}

describe('F1 · 被丢弃的 Promise 不得产生未处理 rejection', () => {
  it('S1 abort 后 cancel 异步 reject：零 unhandledRejection', async () => {
    const probe = installProbe()
    try {
      const { deps, state } = makeDeps()
      const listener = createFollowUpTailListener(deps)
      await listener.start()
      listener.abort()
      await tick()
      // 肯定配对：链路确实走到了 abort → finally → cancel，不能靠「什么都没发生」变绿
      expect(state.fetchCalls, '前置：确实建连').toBe(1)
      expect(state.cancelCalls, '前置：abort 后 reader.cancel 确实被调用').toBeGreaterThanOrEqual(1)
      expect(probe.seen, 'cancel 的异步 reject 必须被吞掉，否则浏览器抛 AbortError').toEqual([])
    } finally {
      probe.restore()
    }
  })

  it('S2 run 在首个响应前 reject：零 unhandledRejection', async () => {
    const probe = installProbe()
    try {
      const { deps, state } = makeDeps({
        baseUrl: () => {
          throw new Error('baseUrl failed before first response')
        },
      })
      const listener = createFollowUpTailListener(deps)
      // 故意不 await：launch 等不到 ready 是既有语义，本刀不改变它
      void listener.start()
      await tick()
      expect(state.fetchCalls, '前置：首个响应未到达').toBe(0)
      expect(probe.seen, 'run 的 Promise 必须挂 catch，否则产生未处理 rejection').toEqual([])
    } finally {
      probe.restore()
    }
  })

  it('S3 探针自检：人为制造的未处理 rejection 必被捕获', async () => {
    const probe = installProbe()
    try {
      void Promise.reject(new Error('probe'))
      await tick()
      expect(probe.seen, '探针必须能捕获事件；否则 S1/S2 的零事件是假绿').toHaveLength(1)
    } finally {
      probe.restore()
    }
  })

  it('S5 cancel 同步抛错仍被既有 try/catch 吞掉', async () => {
    const probe = installProbe()
    try {
      const { deps, state } = makeDeps({
        fetchImpl: (_url, init) => {
          state.fetchCalls += 1
          return Promise.resolve({
            status: 200,
            ok: true,
            body: {
              getReader: () =>
                hangingReader(init.signal, () => {
                  state.cancelCalls += 1
                  throw new Error('sync cancel failure')
                }),
            },
          } as TailResponseLike)
        },
      })
      const listener = createFollowUpTailListener(deps)
      await listener.start()
      listener.abort()
      await tick()
      expect(state.cancelCalls, '肯定配对：cancel 确实被调用').toBeGreaterThanOrEqual(1)
      expect(probe.seen, '同步抛错由外层 try/catch 吞掉，修复不得破坏这条路径').toEqual([])
    } finally {
      probe.restore()
    }
  })
})

describe('F1 · 类别化源级门禁', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, 'follow-up-tail.ts'), 'utf8')
  const voidLines = src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^void\s/.test(l))

  it('S4 所有以 void 丢弃的 Promise 调用都必须显式接 catch', () => {
    // 存在性配对：防止「把两条语句删空」也能绿
    expect(src).toContain('async function launch()')
    expect(src).toContain('r.cancel?.()')
    expect(voidLines.length, '该文件确实存在被丢弃的 Promise 调用').toBeGreaterThanOrEqual(2)
    for (const line of voidLines) {
      expect(line, '被 void 丢弃的异步调用必须挂 catch，否则迟早复现 F1').toContain('.catch(')
    }
  })
})
