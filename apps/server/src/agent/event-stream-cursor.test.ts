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

/**
 * 收集 res.write 的原始帧（可观测出口：浏览器实际收到什么就断言什么）。
 *
 * ⭐ 2026-10-24：补齐 `on` / `off` / `writableFinished`——
 *   controller 现在用 `res.on('close')` + `!res.writableFinished` 判「客户端断连」
 *   （不用 `req.on('close')`：请求体被读完时它会提前触发，见 controller 注释里的实测）。
 */
function makeFakeRes() {
  const chunks: string[] = []
  const listeners = new Map<string, Array<() => void>>()
  // 用闭包变量承载「已正常收尾」标记（不能用 this：vi.fn 的实现是箭头函数，
  // this 会被捕获到模块作用域 ⇒ 赋值落空）。
  const state = { writableFinished: false }
  return {
    chunks,
    /** 服务端是否已正常收尾（对应 Node 的 res.writableFinished）。 */
    get writableFinished() {
      return state.writableFinished
    },
    setHeader: vi.fn(),
    write: vi.fn((s: string) => {
      chunks.push(s)
    }),
    end: vi.fn(() => {
      state.writableFinished = true
    }),
    on: vi.fn((event: string, fn: () => void) => {
      const arr = listeners.get(event) ?? []
      arr.push(fn)
      listeners.set(event, arr)
      return this
    }),
    off: vi.fn((event: string, fn: () => void) => {
      const arr = listeners.get(event) ?? []
      listeners.set(
        event,
        arr.filter((f) => f !== fn),
      )
      return this
    }),
    /** 模拟「客户端掐断」：触发 close 监听器，且 `writableFinished` 仍为 false。 */
    emitClose(): void {
      for (const fn of listeners.get('close') ?? []) fn()
    },
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

    // ⭐ 2026-10-24：opts 现在还带 `signal`（客户端断开 ⇒ 退订）。
    // 用 toMatchObject 而不是 toHaveBeenCalledWith 全等——signal 是 AbortSignal 实例，
    // 全等比对既啰嗦又脆；这里只断言**契约里真正要保证的字段**。
    expect(runEventStream).toHaveBeenCalledWith('s1:t1', expect.objectContaining({ lastEventId: '7' }))
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
        expect.objectContaining({ lastEventId: undefined }),
      )
    }
  })

  it('无 lastEventId 时也不得传错位参数（保持既有单参调用形态兼容）', async () => {
    const runEventStream = vi.fn(async function* () {})
    const ctrl = makeController(runEventStream)
    const res = makeFakeRes()

    await ctrl.runEvents('s1', 's1:t1', undefined, req, res as never)

    expect(runEventStream).toHaveBeenCalledWith('s1:t1', expect.objectContaining({ lastEventId: undefined }))
  })

  it('订阅建立必须**立刻**写一帧（首个业务事件可能几十秒后才到）——变异点：删掉就绪帧', async () => {
    const runEventStream = vi.fn(async function* () {})
    const ctrl = makeController(runEventStream)
    const res = makeFakeRes()

    await ctrl.runEvents('s1', 's1:t1', undefined, req, res as never)

    expect(
      res.chunks[0],
      '订阅建立即写就绪帧：浏览器拿到响应头才算「连上了」，否则整段静默期都处于未连接状态',
    ).toBe(': observer-ready\n\n')
  })

  it('必须发 X-Accel-Buffering: no（nginx 默认缓冲会把 34 字节心跳憋死）——变异点：删掉该头', async () => {
    const runEventStream = vi.fn(async function* () {})
    const ctrl = makeController(runEventStream)
    const res = makeFakeRes()

    await ctrl.runEvents('s1', 's1:t1', undefined, req, res as never)

    expect(
      res.setHeader,
      '逐响应声明「本响应不缓冲」：生产 /api/ 目前已 proxy_buffering off，但反代配置会变，' +
        '而 SSE 一旦被缓冲就是「连接建立、零字节、静默失效」这种极难排查的故障',
    ).toHaveBeenCalledWith('X-Accel-Buffering', 'no')
  })

  it('心跳到达即解除首帧闸门（常驻连接不得被 30s 误杀）——变异点：心跳不 clearTimeout', async () => {
    vi.useFakeTimers()
    try {
      // 永不结束的流：仿真实订阅（pi-runtime 靠 idle 判定存活，不 EOF）
      const runEventStream = vi.fn(async function* () {
        await new Promise<void>(() => {})
        yield { type: 'never' }
      })
      const ctrl = makeController(runEventStream)
      const res = makeFakeRes()

      void ctrl.runEvents('s1', 's1:t1', undefined, req, res as never)

      await vi.advanceTimersByTimeAsync(16_000) // 首个心跳
      expect(res.end, '心跳已到 ⇒ 闸门解除').not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(
        res.end,
        '常驻连接不得在 30s 被闸门 end（否则前端每 30s 全量重连）',
      ).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * ⭐⭐ 2026-10-24：客户端断开 ⇒ 必须 abort 传给 service 的 signal。
   *
   * 背景：`retryOnMissing` 让 404 走「无限期等 lane 出现」⇒ pi-runtime 客户端
   * 永不回调 onError ⇒ Nest 生成器永不结束 ⇒ 浏览器一断开，Nest 侧就永久留下
   * 一条每 ≤5s 轮询 pi-runtime 的订阅（**每个 observer 一条**）⇒ 资源泄漏。
   *
   * 判据落在**可观测出口**：service 收到的 `opts.signal.aborted` 必须变 true，
   * 且生成器必须因此结束（for-await 能正常收敛）。
   */
  it('客户端断开必须 abort 传给 service 的 signal（否则每 observer 留下一条永久轮询）', async () => {
    let capturedSignal: AbortSignal | undefined
    let generatorDone = false
    const runEventStream = vi.fn(async function* (_key: string, opts?: { signal?: AbortSignal }) {
      capturedSignal = opts?.signal
      // 永不结束（仿「retryOnMissing 下无限等 lane」）：只有 signal 能终止它。
      await new Promise<void>((resolve) => {
        opts?.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      generatorDone = true
    })
    const ctrl = makeController(runEventStream)
    const res = makeFakeRes()

    const p = ctrl.runEvents('s1', 's1:t1', undefined, req, res as never)
    await vi.waitFor(() => expect(capturedSignal).toBeDefined())

    expect(capturedSignal?.aborted, '连接正常时不得 abort').toBe(false)

    // 模拟客户端掐断：res 发 close，且 writableFinished 仍为 false（提前结束）
    res.emitClose()

    await expect(p, '客户端断开后生成器必须收敛（不能永久挂着）').resolves.toBeUndefined()
    expect(capturedSignal?.aborted, '客户端断开必须 abort service 侧的 signal').toBe(true)
    expect(generatorDone, '生成器必须因 abort 而结束').toBe(true)
  })

  it('服务端正常收尾（res 已 end）不得误 abort（幂等且无副作用）', async () => {
    let capturedSignal: AbortSignal | undefined
    const runEventStream = vi.fn(async function* (_key: string, opts?: { signal?: AbortSignal }) {
      capturedSignal = opts?.signal
      yield { type: 'ping', data: {} }
    })
    const ctrl = makeController(runEventStream)
    const res = makeFakeRes()

    await ctrl.runEvents('s1', 's1:t1', undefined, req, res as never)

    // 正常收尾路径：controller 自己 end 了响应 ⇒ writableFinished=true ⇒ 不该 abort
    expect(res.writableFinished, 'controller 正常收尾时应已 end 响应').toBe(true)
    // 触发 close（writableFinished=true）⇒ 不得 abort
    res.emitClose()
    expect(capturedSignal?.aborted, '正常收尾不得 abort（否则退订被提前触发）').toBe(false)
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

/**
 * ⭐⭐ 2026-10-24：旁听流的「404 不终止」+「客户端断开必须退订」两条服务端契约。
 *
 * 根因（生产取证）：`GET /api/agent/runs/events` 实测 **47ms 断流**、15s 心跳从未发出。
 *   pi-runtime 的 lane 是**内存态、per-thread、带 TTL**（`session-manager.sessions`
 *   + `sessionTtlMs` 默认 30 分钟）⇒ 「另一端还没在这个 thread 上发过消息」或
 *   「跑完超过 TTL」都会让 `GET /sessions/:key/events` 返回 **404**。
 *   旧语义把 404 当「会话已删除」⇒ 立即 end ⇒ 常驻订阅名存实亡。
 *
 * ⇒ ① `retryOnMissing`：404 归入退避重试（等 lane 真的出现），而不是终止；
 *   ② 客户端断开必须能退订（否则「无限等 lane」= 每 observer 一条永久轮询 ⇒ 泄漏）。
 */
describe('AgentService.runEventStream：404 不终止 + 断开退订（2026-10-24）', () => {
  function createService() {
    return new AgentService(
      {} as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
  }

  it('必须给 pi-runtime client 传 retryOnMissing（404 = lane 未驻留，不是「会话已删除」）', async () => {
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
          onEvent({ type: 'agent_end', ts: Date.now(), data: { status: 'completed' }, seq: 1 })
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
      // 消费一个事件即结束
    }

    expect(
      captured.opts?.retryOnMissing,
      '旁听流必须开 retryOnMissing：否则 lane 未驻留时 404 直接终止订阅 ⇒ 47ms 断流',
    ).toBe(true)
  })

  it('signal abort 后必须退订（unsubscribe 必须被调用）——否则每 observer 留一条永久轮询', async () => {
    const svc = createService()
    let unsubscribed = 0
    const stubClient = {
      streamEvents: () => {
        // 永不回调 onEnd（仿 retryOnMissing 下无限等 lane）⇒ 只有 signal 能终止。
        return () => {
          unsubscribed += 1
        }
      },
    }
    ;(svc as unknown as {
      getPiRuntimeUrl: () => string | null
      createPiRuntimeClient: () => unknown
    }).getPiRuntimeUrl = () => 'http://pi-runtime'
    ;(svc as unknown as { createPiRuntimeClient: () => unknown }).createPiRuntimeClient = () => stubClient

    const abort = new AbortController()
    const drain = (async () => {
      for await (const _ of svc.runEventStream('k1', { signal: abort.signal })) {
        // 不产出事件
      }
    })()

    // 让订阅先建立
    await new Promise((r) => setTimeout(r, 0))
    expect(unsubscribed, '尚未断开时不得退订').toBe(0)

    abort.abort()
    await drain

    expect(
      unsubscribed,
      '客户端断开必须退订 pi-runtime 订阅（否则每个 observer 留一条 ≤5s 轮询的永久泄漏）',
    ).toBe(1)
  })

  it('signal 在订阅建立前就已 abort 时也必须立即收敛（不得挂起）', async () => {
    const svc = createService()
    let unsubscribed = 0
    const stubClient = {
      streamEvents: () => () => {
        unsubscribed += 1
      },
    }
    ;(svc as unknown as {
      getPiRuntimeUrl: () => string | null
      createPiRuntimeClient: () => unknown
    }).getPiRuntimeUrl = () => 'http://pi-runtime'
    ;(svc as unknown as { createPiRuntimeClient: () => unknown }).createPiRuntimeClient = () => stubClient

    const abort = new AbortController()
    abort.abort()

    const events: unknown[] = []
    for await (const e of svc.runEventStream('k1', { signal: abort.signal })) {
      events.push(e)
    }

    expect(events.length, '已 abort 的订阅不得产出事件').toBe(0)
    expect(unsubscribed, '已 abort 的订阅也必须退订').toBe(1)
  })
})
