/**
 * 回合外投影记账者测试（P0-A，2026-11-02 天鹅事故）。
 *
 * 三层覆盖：
 * 1. `createOutOfTurnRunAcceptor` 纯逻辑：分桶 / 因果围栏（只记账见到 agent_start 的
 *    run）/ 画布动作同源提取 / error 也是收束；
 * 2. `projectOutOfTurnRuns` 集成：notify 送达后的订阅 → 落库（runId 进唯一键、
 *    metadata.outOfTurn 标记）+ 在飞守卫（同 thread 不开第二条订阅）；
 * 3. `onModuleInit` 钩子接线：AgentService 把投影回调注册到 reaper。
 *
 * 背景：生成 job 终态的回合外简报轮不属于任何用户 turn ⇒ Nest 主流不存在 ⇒
 * 此前零落库（AgentMessage 是展示层 SSOT）⇒ 刷新即失（生产实证：白天鹅简报
 * runtime transcript 里有、AgentMessage 0 行）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  AgentService,
  createOutOfTurnRunAcceptor,
} from './agent.service'
import { piEvent, type PiClientStub } from './agent.test-utils'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

/** 带回合身份的事件（runtime 给所有 run 内事件兜底打 runId 戳）。 */
function runEvent(type: PiRuntimeEvent['type'], data: unknown, runId: string): PiRuntimeEvent {
  return { ...piEvent(type, data), runId } as PiRuntimeEvent
}

describe('createOutOfTurnRunAcceptor', () => {
  it('完整简报轮：agent_start → text_delta → done 产出快照（文本按序拼接）', () => {
    const acceptor = createOutOfTurnRunAcceptor()
    expect(acceptor.feed(runEvent('agent_start', {}, 'run-brief-1'))).toBeNull()
    expect(
      acceptor.feed(runEvent('message_update', { event: { type: 'text_delta', delta: '白色天鹅' } }, 'run-brief-1')),
    ).toBeNull()
    expect(
      acceptor.feed(runEvent('message_update', { event: { type: 'text_delta', delta: '图片已生成完成' } }, 'run-brief-1')),
    ).toBeNull()
    const snapshot = acceptor.feed(runEvent('agent_end', { status: 'completed' }, 'run-brief-1'))
    expect(snapshot).toEqual({
      runId: 'run-brief-1',
      assistantText: '白色天鹅图片已生成完成',
      canvasActions: [],
    })
  })

  it('因果围栏：半路接入的 run（没见到 agent_start）不产出快照——不冒充全量', () => {
    const acceptor = createOutOfTurnRunAcceptor()
    expect(
      acceptor.feed(runEvent('message_update', { event: { type: 'text_delta', delta: '前缀' } }, 'run-mid')),
    ).toBeNull()
    expect(acceptor.feed(runEvent('agent_end', { status: 'completed' }, 'run-mid'))).toBeNull()
  })

  it('画布动作与主流同源提取（tool_execution_end details.actions）', () => {
    const acceptor = createOutOfTurnRunAcceptor()
    acceptor.feed(runEvent('agent_start', {}, 'run-canvas'))
    acceptor.feed(
      runEvent(
        'tool_execution_end',
        {
          isError: false,
          result: {
            details: {
              actions: [
                {
                  type: 'add_node',
                  payload: { id: 'text-1', nodeType: 'text', data: { prompt: '方案' }, position: { x: 0, y: 0 } },
                },
              ],
            },
          },
        },
        'run-canvas',
      ),
    )
    const snapshot = acceptor.feed(runEvent('agent_end', { status: 'completed' }, 'run-canvas'))
    expect(snapshot?.canvasActions).toHaveLength(1)
    expect(snapshot?.canvasActions[0]?.type).toBe('add_node')
  })

  it('error 也是收束（失败轮落什么算什么）', () => {
    const acceptor = createOutOfTurnRunAcceptor()
    acceptor.feed(runEvent('agent_start', {}, 'run-fail'))
    acceptor.feed(runEvent('message_update', { event: { type: 'text_delta', delta: '生成失败：' } }, 'run-fail'))
    const snapshot = acceptor.feed(runEvent('error', { message: 'upstream timeout' }, 'run-fail'))
    expect(snapshot?.assistantText).toBe('生成失败：')
  })

  it('无 runId 的事件一律忽略（旧 runtime 兼容面不进回合外账本）', () => {
    const acceptor = createOutOfTurnRunAcceptor()
    expect(acceptor.feed(piEvent('agent_start', {}))).toBeNull()
    expect(acceptor.feed(piEvent('agent_end', { status: 'completed' }))).toBeNull()
  })

  it('多 run 交错互不串账（回合外 drain 可能有多个生成终态接连通报）', () => {
    const acceptor = createOutOfTurnRunAcceptor()
    acceptor.feed(runEvent('agent_start', {}, 'run-a'))
    acceptor.feed(runEvent('agent_start', {}, 'run-b'))
    acceptor.feed(runEvent('message_update', { event: { type: 'text_delta', delta: 'A' } }, 'run-a'))
    acceptor.feed(runEvent('message_update', { event: { type: 'text_delta', delta: 'B' } }, 'run-b'))
    expect(acceptor.feed(runEvent('agent_end', {}, 'run-a'))?.assistantText).toBe('A')
    expect(acceptor.feed(runEvent('agent_end', {}, 'run-b'))?.assistantText).toBe('B')
  })
})

describe('AgentService projectOutOfTurnRuns', () => {
  const agentMessageCreate = vi.fn()
  const agentMessageFindFirst = vi.fn()
  const agentThreadFindFirst = vi.fn()
  const sessionFindUnique = vi.fn()
  let service: AgentService
  let pi: PiClientStub
  /** 每个 stub 的流式回调集合（onEvent / onOpen），测试按序回放事件。 */
  let streamCalls: Array<{ onEvent: (e: PiRuntimeEvent) => void; onOpen?: () => void }>

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'

    agentMessageCreate.mockReset().mockResolvedValue({})
    agentMessageFindFirst.mockReset().mockResolvedValue(null)
    agentThreadFindFirst.mockReset().mockResolvedValue({ id: 's1:t1', sessionId: 's1' })
    sessionFindUnique.mockReset().mockResolvedValue({ userId: 'u1' })

    service = new AgentService(
      {
        agentMessage: {
          create: agentMessageCreate,
          findFirst: agentMessageFindFirst,
          findMany: vi.fn(),
          // P4-T1：seq 取号桩
          aggregate: vi.fn().mockResolvedValue({ _max: { seq: null } }),
        },
        agentThread: { findFirst: agentThreadFindFirst, findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
        session: { findUnique: sessionFindUnique, update: vi.fn() },
        idempotencyRecord: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
        marginPolicy: { findFirst: vi.fn().mockResolvedValue(null) },
      } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
    streamCalls = []
    pi = {
      ...({} as object),
      streamEvents: vi.fn(
        (
          _key: string,
          onEvent: (e: PiRuntimeEvent) => void,
          _onError?: unknown,
          opts?: { onOpen?: () => void },
        ) => {
          streamCalls.push({ onEvent, onOpen: opts?.onOpen })
          return () => {}
        },
      ),
    } as unknown as PiClientStub
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
  })

  /** 模拟简报轮完整事件序列（notify 触发 drain 后 runtime 侧的产出）。 */
  function replayBriefRun(runId = 'run-brief-1', text = '白色天鹅图片已生成完成，可在画布节点中查看。') {
    const call = streamCalls.at(-1)
    call?.onEvent(runEvent('agent_start', {}, runId))
    call?.onEvent(runEvent('message_update', { event: { type: 'text_delta', delta: text } }, runId))
    call?.onEvent(runEvent('agent_end', { status: 'completed' }, runId))
  }

  /** 等 project 现场挂上订阅（arm 是 async：prisma 查询后才调 streamEvents）。 */
  async function waitSubscribed(min = 1) {
    await vi.waitFor(() => expect(streamCalls.length).toBeGreaterThanOrEqual(min))
  }

  it('简报轮落库：runId 进唯一键 + metadata.outOfTurn 标记', async () => {
    const p = service.projectOutOfTurnRuns('s1:t1', { tickMs: 5, quietMs: 20, capMs: 300 })
    await waitSubscribed()
    replayBriefRun()
    await p

    // persist 是 fire-and-forget（finalizeTurn 异步链），quiet 退订后仍可能未落完 ⇒ 轮询断言
    await vi.waitFor(() => {
      const persistCall = agentMessageCreate.mock.calls
        .map((call) => call[0] as { data: { runId?: string; metadata?: string } })
        .find((arg) => arg?.data?.runId === 'run-brief-1')
      expect(persistCall).toBeDefined()
    })
    const persistCall = agentMessageCreate.mock.calls
      .map((call) => call[0] as { data: { runId?: string; metadata?: string } })
      .find((arg) => arg?.data?.runId === 'run-brief-1')!
    const metadata = JSON.parse(persistCall.data.metadata ?? '{}')
    expect(metadata.outOfTurn).toBe(true)
  })

  it('在飞守卫：同 thread 并发第二次调用不再开订阅', async () => {
    const first = service.projectOutOfTurnRuns('s1:t1', { tickMs: 5, quietMs: 20, capMs: 300 })
    const second = service.projectOutOfTurnRuns('s1:t1', { tickMs: 5, quietMs: 20, capMs: 300 })
    await Promise.all([first, second])
    expect(pi.streamEvents).toHaveBeenCalledTimes(1)
  })

  it('线程不存在（已删/键错）⇒ 零订阅零落库', async () => {
    agentThreadFindFirst.mockResolvedValue(null)
    await service.projectOutOfTurnRuns('gone:t9', { tickMs: 5, quietMs: 20, capMs: 300 })
    expect(pi.streamEvents).not.toHaveBeenCalled()
    expect(agentMessageCreate).not.toHaveBeenCalled()
  })

  it('onModuleInit 把投影回调注册到 reaper（fail-soft：无 reaper 不炸）', () => {
    const reaper = { outOfTurnProjectionHook: undefined as unknown }
    const svc = new AgentService(
      { agentMessage: {}, agentThread: {}, session: {} } as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reaper as never,
    )
    expect(() => svc.onModuleInit()).not.toThrow()
    expect(typeof reaper.outOfTurnProjectionHook).toBe('function')

    // 无 reaper（单测默认构造）也不炸
    expect(() => service.onModuleInit()).not.toThrow()
  })
})

// ── 2026-11-03 Layer 3（蓝老虎复测）：订阅先于触发（arm/project 两段式）──────
//
// 生产实证（thread cmvzixb8k0018pc01ktoxthpy）：runtime 在 notify handler 内同步
// drain 开简报轮，agent_start 在响应返回前发出 ⇒ 后置订阅（旧单段式）经 prisma
// 归属查询再挂 SSE 晚 ~500ms+ ⇒ from=now 错过 agent_start ⇒ 因果围栏静默丢整轮
// （pi transcript seq 435→653 简报完整存在、Nest 零落库、out_of_turn_turn_persisted
// 零命中）。修复：arm 在 notify 之前挂订阅并等 SSE open，project 消费 armed 上下文。

describe('AgentService armOutOfTurnProjection（订阅先于 notify）', () => {
  const agentMessageCreate = vi.fn()
  const agentThreadFindFirst = vi.fn()
  const sessionFindUnique = vi.fn()
  let service: AgentService
  let pi: PiClientStub
  let streamCalls: Array<{ onEvent: (e: PiRuntimeEvent) => void; onOpen?: () => void; unsubscribe: () => void }>
  let unsubscribed: string[]

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'

    agentMessageCreate.mockReset().mockResolvedValue({})
    agentThreadFindFirst.mockReset().mockResolvedValue({ id: 's1:t1', sessionId: 's1' })
    sessionFindUnique.mockReset().mockResolvedValue({ userId: 'u1' })

    service = new AgentService(
      {
        agentMessage: {
          create: agentMessageCreate,
          findFirst: vi.fn(),
          findMany: vi.fn(),
          // P4-T1：seq 取号桩
          aggregate: vi.fn().mockResolvedValue({ _max: { seq: null } }),
        },
        agentThread: { findFirst: agentThreadFindFirst, findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
        session: { findUnique: sessionFindUnique, update: vi.fn() },
        idempotencyRecord: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
        marginPolicy: { findFirst: vi.fn().mockResolvedValue(null) },
      } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
    streamCalls = []
    unsubscribed = []
    pi = {
      ...({} as object),
      streamEvents: vi.fn(
        (
          _key: string,
          onEvent: (e: PiRuntimeEvent) => void,
          _onError?: unknown,
          opts?: { onOpen?: () => void },
        ) => {
          const entry = { onEvent, onOpen: opts?.onOpen, unsubscribe: () => unsubscribed.push(_key) }
          streamCalls.push(entry)
          return () => entry.unsubscribe()
        },
      ),
    } as unknown as PiClientStub
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
  })

  /** 等 arm 挂上订阅（async：prisma 查询后才调 streamEvents）。 */
  async function waitSubscribed(min = 1) {
    await vi.waitFor(() => expect(streamCalls.length).toBeGreaterThanOrEqual(min))
  }

  it('⚠️ arm 等 SSE open 后才返回；project 消费 armed 订阅不再新开', async () => {
    // open 由 stub 在 arm 挂上订阅后触发（模拟 fetch resolve → onOpen）
    const armed = service.armOutOfTurnProjection('s1:t1', { openTimeoutMs: 2_000, armTtlMs: 60_000 })
    await waitSubscribed()
    streamCalls.at(-1)?.onOpen?.()
    await armed
    expect(pi.streamEvents).toHaveBeenCalledTimes(1) // arm 挂了订阅

    // notify 之后 project 激活：复用 armed 订阅（不新开第二条）→ 简报轮事件全部记账
    const projecting = service.projectOutOfTurnRuns('s1:t1', { tickMs: 5, quietMs: 20, capMs: 300 })
    // 简报轮事件在 activate 后到达（正常时序：notify → runtime drain → agent_start…）
    streamCalls.at(-1)?.onEvent(runEvent('agent_start', {}, 'run-l3'))
    streamCalls.at(-1)?.onEvent(
      runEvent('message_update', { event: { type: 'text_delta', delta: '蓝色老虎已出图' } }, 'run-l3'),
    )
    streamCalls.at(-1)?.onEvent(runEvent('agent_end', { status: 'completed' }, 'run-l3'))
    await projecting

    expect(pi.streamEvents).toHaveBeenCalledTimes(1) // ⭐ 旧代码（无 arm）此断言红：project 现场再开一条
    const persistCall = agentMessageCreate.mock.calls
      .map((c) => c[0] as { data: { runId?: string } })
      .find((arg) => arg?.data?.runId === 'run-l3')
    expect(persistCall).toBeDefined()
  })

  it('armed 期间简报轮抢先收束也照常落库（唯一索引防重，不丢）', async () => {
    const armed = service.armOutOfTurnProjection('s1:t1', { openTimeoutMs: 2_000, armTtlMs: 60_000 })
    await waitSubscribed()
    const entry = streamCalls.at(-1)
    entry?.onOpen?.()
    // 竞态极小但理论存在：notify 尚未发出，简报轮事件已在 armed 窗口内收束
    entry?.onEvent(runEvent('agent_start', {}, 'run-early'))
    entry?.onEvent(runEvent('message_update', { event: { type: 'text_delta', delta: '抢先完成' } }, 'run-early'))
    entry?.onEvent(runEvent('agent_end', {}, 'run-early'))
    await armed

    const projecting = service.projectOutOfTurnRuns('s1:t1', { tickMs: 5, quietMs: 20, capMs: 300 })
    await projecting
    expect(
      agentMessageCreate.mock.calls.some(
        (c) => (c[0] as { data: { runId?: string } })?.data?.runId === 'run-early',
      ),
    ).toBe(true)
  })

  it('arm 等 open 超时 ⇒ 退订放弃预挂（notify 照发的退化路径不悬挂）', async () => {
    const armed = service.armOutOfTurnProjection('s1:t1', { openTimeoutMs: 60, armTtlMs: 60_000 })
    await waitSubscribed()
    await armed // stub 不触发 onOpen ⇒ 60ms 超时
    expect(unsubscribed).toEqual(['s1:t1'])

    // project 未武装 ⇒ 现场挂订阅兜底（旧行为）
    const projecting = service.projectOutOfTurnRuns('s1:t1', { tickMs: 5, quietMs: 20, capMs: 300 })
    await waitSubscribed(2)
    replayBrief(streamCalls)
    await projecting
    expect(pi.streamEvents).toHaveBeenCalledTimes(2)
  })

  it('armed TTL 自愈：notify 一直不来（tool-wait 抑制）⇒ 到点退订防悬挂', async () => {
    vi.useFakeTimers()
    try {
      const armed = service.armOutOfTurnProjection('s1:t1', { openTimeoutMs: 60_000, armTtlMs: 100 })
      // fake 时钟下用 advance(0/1) 推微任务直到 arm 挂上订阅（不可用真实 waitFor）
      for (let i = 0; i < 50 && streamCalls.length === 0; i++) await vi.advanceTimersByTimeAsync(1)
      expect(streamCalls.length).toBe(1)
      streamCalls.at(-1)?.onOpen?.()
      await vi.advanceTimersByTimeAsync(50) // arm 轮询循环检测到 opened 退出
      await armed
      expect(pi.streamEvents).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(150) // TTL 100ms 到点，notify 从未到达
      expect(unsubscribed).toEqual(['s1:t1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('arm 双守卫：同 thread 已武装 ⇒ 不重复开订阅', async () => {
    const armed = service.armOutOfTurnProjection('s1:t1', { openTimeoutMs: 2_000, armTtlMs: 60_000 })
    await waitSubscribed()
    streamCalls.at(-1)?.onOpen?.()
    await armed
    await service.armOutOfTurnProjection('s1:t1', { openTimeoutMs: 2_000, armTtlMs: 60_000 })
    expect(pi.streamEvents).toHaveBeenCalledTimes(1)
  })
})

/** 未武装兜底路径用：在最新订阅上回放一轮完整简报。 */
function replayBrief(
  streamCalls: Array<{ onEvent: (e: PiRuntimeEvent) => void }>,
  runId = 'run-brief-1',
) {
  const call = streamCalls.at(-1)
  call?.onEvent(runEvent('agent_start', {}, runId))
  call?.onEvent(runEvent('message_update', { event: { type: 'text_delta', delta: '简报正文' } }, runId))
  call?.onEvent(runEvent('agent_end', { status: 'completed' }, runId))
}
