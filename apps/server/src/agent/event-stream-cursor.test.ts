/**
 * SSE 游标端到端贯通（multi-device Task 4 · D1 传输基础）。
 *
 * 背景（evidence.md R1 / plan Task 4）：pi-runtime 早在每帧写 `id: ${seq}`
 * （pi-runtime app.ts:547）且支持 `?lastEventId=` 增量续传（app.ts:41-43），
 * 但 Nest `GET runs/events` 只写 `data:` 行把 id 丢了 ⇒ 浏览器的
 * Last-Event-ID 自动续传永远空转，旁听端断线只能重放或丢增量。
 *
 * 本文件钉住三件事（断言全落**可观测出口**——res.write 的原始帧 / client 收到的 opts）：
 *   ① controller 给带 seq 的帧写 `id:` 行；无 seq 的合成帧不写（写了会让
 *      Last-Event-ID 指到不存在的 seq ⇒ 续传错位）；
 *   ② controller 接受 `?lastEventId=` 并透传给 service；
 *   ③ service 把 lastEventId 透传给 pi-runtime client 的订阅 opts。
 *
 * ⚠️ 参数位置纪律：runEventStream 的新参数**追加在末尾**（中段插参会移位同型参数）。
 */
import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { AgentController } from './agent.controller'
import { AgentService } from './agent.service'
import type { SessionsService } from '../sessions/sessions.service'
import type { AgentCanvasToolsService } from './agent-canvas-tools.service'
import type { AgentMemoryService } from './agent-memory.service'

/** 收集 res.write 的原始帧（可观测出口：浏览器实际收到什么就断言什么）。 */
function makeFakeRes() {
  const chunks: string[] = []
  return {
    chunks,
    setHeader: vi.fn(),
    write: vi.fn((s: string) => {
      chunks.push(s)
    }),
    end: vi.fn(),
  }
}

const req = { user: { sub: 'u1' } } as never

function makeController(runEventStream: ReturnType<typeof vi.fn>) {
  return new AgentController(
    { runEventStream } as unknown as AgentService,
    { findOne: vi.fn().mockResolvedValue({ id: 's1' }) } as unknown as SessionsService,
    {} as never as AgentCanvasToolsService,
    {} as never as AgentMemoryService,
  )
}

describe('GET runs/events 的 SSE 游标（multi-device Task 4）', () => {
  it('带 seq 的事件必须写 id: 行（浏览器 Last-Event-ID 续传的前提）——预期红：现在只写 data 行', async () => {
    const runEventStream = vi.fn(async function* () {
      yield { type: 'text_delta', data: { text: '你好' }, seq: 42 }
    })
    const res = makeFakeRes()
    const ctrl = makeController(runEventStream)

    await ctrl.runEvents('s1', 's1:t1', undefined, req, res as never)

    const dataFrames = res.chunks.filter((c) => c.includes('"text_delta"'))
    expect(dataFrames.length).toBe(1)
    expect(
      dataFrames[0]!.startsWith('id: 42\n'),
      `带 seq 的帧必须以 id: 行开头，实际：${JSON.stringify(dataFrames[0])}`,
    ).toBe(true)
  })

  it('无 seq 的合成帧不写 id: 行（避免 Last-Event-ID 指向不存在的 seq）', async () => {
    const runEventStream = vi.fn(async function* () {
      yield { type: 'ping', data: {} }
    })
    const res = makeFakeRes()
    const ctrl = makeController(runEventStream)

    await ctrl.runEvents('s1', 's1:t1', undefined, req, res as never)

    const dataFrames = res.chunks.filter((c) => c.includes('"ping"'))
    expect(dataFrames.length).toBe(1)
    expect(dataFrames[0]!.startsWith('id:'), '无 seq 帧不得写 id: 行').toBe(false)
  })

  it('?lastEventId= 必须透传给 service.runEventStream（断线重连带游标）——预期红', async () => {
    const runEventStream = vi.fn(async function* () {})
    const ctrl = makeController(runEventStream)
    const reqWithCursor = { user: { sub: 'u1' } } as never
    const res = makeFakeRes()

    await ctrl.runEvents('s1', 's1:t1', '7', reqWithCursor, res as never)

    expect(runEventStream).toHaveBeenCalledWith('s1:t1', { lastEventId: '7' })
  })

  it('畸形 lastEventId（空串/非数字）不得透传（pi-runtime 会落进全量重放分支）', async () => {
    const runEventStream = vi.fn(async function* () {})
    const ctrl = makeController(runEventStream)
    const res = makeFakeRes()

    for (const bad of ['', '   ', 'abc', '-1', '7x']) {
      ;(runEventStream as ReturnType<typeof vi.fn>).mockClear()
      await ctrl.runEvents('s1', 's1:t1', bad, req, res as never)
      expect(runEventStream, `畸形值 ${JSON.stringify(bad)} 必须被闸门拦下`).toHaveBeenCalledWith(
        's1:t1',
        { lastEventId: undefined },
      )
    }
  })

  it('无 lastEventId 时也不得传错位参数（保持既有单参调用形态兼容）', async () => {
    const runEventStream = vi.fn(async function* () {})
    const ctrl = makeController(runEventStream)
    const res = makeFakeRes()

    await ctrl.runEvents('s1', 's1:t1', undefined, req, res as never)

    expect(runEventStream).toHaveBeenCalledWith('s1:t1', { lastEventId: undefined })
  })
})

describe('AgentService.runEventStream 游标透传（multi-device Task 4）', () => {
  /** 最小构造 + 桩掉 pi-runtime 取址与 client 工厂（沿用 cancel-run.test.ts 惯例）。 */
  function createService() {
    return new AgentService(
      {} as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
  }

  it('opts.lastEventId 必须透传给 client.streamEvents（pi-runtime 据此增量续传）——预期红', async () => {
    const svc = createService()
    const captured: { sessionId?: string; opts?: Record<string, unknown> } = {}
    const stubClient = {
      streamEvents: (
        sessionId: string,
        onEvent: (e: unknown) => void,
        onEnd: () => void,
        opts?: Record<string, unknown>,
      ) => {
        captured.sessionId = sessionId
        captured.opts = opts
        void Promise.resolve().then(() => {
          onEvent({ type: 'agent_end', ts: Date.now(), data: { status: 'completed' }, seq: 9 })
          onEnd()
        })
        return () => {}
      },
    }
    ;(svc as unknown as {
      getPiRuntimeUrl: () => string | null
      createPiRuntimeClient: () => unknown
    }).getPiRuntimeUrl = () => 'http://pi-runtime'
    ;(svc as unknown as { createPiRuntimeClient: () => unknown }).createPiRuntimeClient = () => stubClient

    const events: Array<Record<string, unknown>> = []
    for await (const e of svc.runEventStream('k1', { lastEventId: '7' })) {
      events.push(e as Record<string, unknown>)
    }

    expect(captured.opts, 'streamEvents 必须收到 lastEventId 选项').toMatchObject({ lastEventId: '7' })
    expect(events.length).toBe(1)
  })

  it('不传 opts 时维持既有 live 订阅形态（零回归）', async () => {
    const svc = createService()
    const captured: { opts?: Record<string, unknown> } = {}
    const stubClient = {
      streamEvents: (
        _sessionId: string,
        onEvent: (e: unknown) => void,
        onEnd: () => void,
        opts?: Record<string, unknown>,
      ) => {
        captured.opts = opts
        void Promise.resolve().then(() => {
          onEvent({ type: 'agent_end', ts: Date.now(), data: { status: 'completed' }, seq: 9 })
          onEnd()
        })
        return () => {}
      },
    }
    ;(svc as unknown as {
      getPiRuntimeUrl: () => string | null
      createPiRuntimeClient: () => unknown
    }).getPiRuntimeUrl = () => 'http://pi-runtime'
    ;(svc as unknown as { createPiRuntimeClient: () => unknown }).createPiRuntimeClient = () => stubClient

    for await (const _ of svc.runEventStream('k1')) {
      // 只消费一个事件即结束
    }

    expect(captured.opts).toMatchObject({ live: true })
  })

  it('yield 出的事件必须带 seq（mapPiEventToUiEvent 透传契约，防未来回归）', async () => {
    const svc = createService()
    const stubClient = {
      streamEvents: (_s: string, onEvent: (e: unknown) => void, onEnd: () => void) => {
        void Promise.resolve().then(() => {
          onEvent({ type: 'agent_end', ts: Date.now(), data: { status: 'completed' }, seq: 9 })
          onEnd()
        })
        return () => {}
      },
    }
    ;(svc as unknown as {
      getPiRuntimeUrl: () => string | null
      createPiRuntimeClient: () => unknown
    }).getPiRuntimeUrl = () => 'http://pi-runtime'
    ;(svc as unknown as { createPiRuntimeClient: () => unknown }).createPiRuntimeClient = () => stubClient

    const events: Array<Record<string, unknown>> = []
    for await (const e of svc.runEventStream('k1')) {
      events.push(e as Record<string, unknown>)
    }

    expect(events[0]!.seq, 'seq 必须一路透传到 yield 出口（controller 写 id 行的数据源）').toBe(9)
  })
})
