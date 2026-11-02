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
        agentMessage: { create: agentMessageCreate, findFirst: agentMessageFindFirst, findMany: vi.fn() },
        agentThread: { findFirst: agentThreadFindFirst, findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
        session: { findUnique: sessionFindUnique, update: vi.fn() },
        idempotencyRecord: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
        marginPolicy: { findFirst: vi.fn().mockResolvedValue(null) },
      } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
    pi = {
      ...({} as object),
      streamEvents: vi.fn((_key: string, onEvent: (e: PiRuntimeEvent) => void) => {
        // 模拟简报轮：notify 先于 drain，订阅挂上后 run 才开始。
        onEvent(runEvent('agent_start', {}, 'run-brief-1'))
        onEvent(
          runEvent('message_update', { event: { type: 'text_delta', delta: '白色天鹅图片已生成完成，可在画布节点中查看。' } }, 'run-brief-1'),
        )
        onEvent(runEvent('agent_end', { status: 'completed' }, 'run-brief-1'))
        return () => {}
      }),
    } as unknown as PiClientStub
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
  })

  it('简报轮落库：runId 进唯一键 + metadata.outOfTurn 标记', async () => {
    await service.projectOutOfTurnRuns('s1:t1', { tickMs: 5, quietMs: 20, capMs: 300 })

    const persistCall = agentMessageCreate.mock.calls
      .map((call) => call[0] as { data: { runId?: string; metadata?: string } })
      .find((arg) => arg?.data?.runId === 'run-brief-1')
    expect(persistCall).toBeDefined()
    const metadata = JSON.parse(persistCall!.data.metadata ?? '{}')
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
