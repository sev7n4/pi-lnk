import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { stubPiClient } from './agent.test-utils'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

function seqEvent(type: string, data: unknown, seq: number): PiRuntimeEvent {
  return { type, ts: 1_700_000_000_000, seq, data } as PiRuntimeEvent
}

/** D1 既有测试同款 3 参桩（DI 参数 as never 是本仓惯例）。 */
function makePrismaStub() {
  return {
    agentMessage: {
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'm1', ...data })),
      findMany: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _max: { seq: null } }),
    },
    agentThread: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    session: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue({}) },
    userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
    agentEvent: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
  }
}

/**
 * 构造 AgentService：真实构造参表共 15 个（subagentTasks 为末位 @Optional）。
 * 位置必须对齐真 master agent.service.ts:360-422；之前 14 个参数里仅前 3 个为必填，
 * 其余 @Optional，故以 undefined 占位补齐到末位。tasks 落第 15 位。
 */
function makeService(
  prisma: ReturnType<typeof makePrismaStub>,
  tasks: { onTraceEvent: ReturnType<typeof vi.fn> } | undefined,
): AgentService {
  return new AgentService(
    prisma as never,
    { createFromAgent: vi.fn() } as never,
    { resolveForGeneration: vi.fn().mockResolvedValue(null) } as never,
    undefined, undefined, undefined, undefined, undefined, // 4-8
    undefined, undefined, undefined, undefined, undefined, // 9-13
    undefined, // 14 pendingInterruptions
    tasks as never, // 15 subagentTasks
  )
}

describe('D2 漏斗接线：单据由 SSE 事件驱动', () => {
  let service: AgentService
  let tasks: { onTraceEvent: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    // 避免计费冻结/释放需要真实 PointsService（本测试未装配）；沿用 D1 既有测试做法。
    delete process.env.TEXT_TOKEN_BILLING
    tasks = { onTraceEvent: vi.fn() }
    service = makeService(makePrismaStub(), tasks)
  })

  async function runNaturallyExhausted(events: PiRuntimeEvent[]) {
    const pi = stubPiClient([])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    pi.streamEvents.mockImplementation(
      (_sid: string, onEvent: (e: PiRuntimeEvent) => void, onClosed: () => void) => {
        for (const e of events) onEvent(e)
        onClosed()
        return () => {}
      },
    )
    const out: Array<{ type: string; data?: unknown }> = []
    for await (const e of service.streamConversation('s1', '帮我调研', 'u1', 't1')) out.push(e)
    return out
  }

  it('★ 阳性：tool_call{spawn} 到达漏斗 ⇒ onTraceEvent 收到 tool_call 帧', async () => {
    await runNaturallyExhausted([
      seqEvent('agent_start', { runId: 'run-A' }, 140),
      seqEvent('tool_execution_start', {
        toolCallId: 'call_A', toolName: 'spawn_subagent', args: { task: '调研X' },
      }, 152),
    ])
    expect(tasks.onTraceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_call' }),
      expect.objectContaining({ threadId: expect.any(String) }),
    )
  })

  it('★ 阴性 B：有配对 tool_result 的正常回合，漏斗收到 tool_result 帧', async () => {
    await runNaturallyExhausted([
      seqEvent('agent_start', { runId: 'run-B' }, 1),
      seqEvent('tool_execution_start', {
        toolCallId: 'call_B', toolName: 'spawn_subagent', args: { task: 'Y' },
      }, 2),
      seqEvent('tool_execution_end', {
        toolCallId: 'call_B', toolName: 'spawn_subagent',
        result: { details: { ok: true, report: 'R',
          usage: { turns: 1, durationMs: 10, status: 'completed' } } },
      }, 3),
      seqEvent('agent_end', { status: 'completed' }, 4),
    ])
    expect(tasks.onTraceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_result' }),
      expect.anything(),
    )
  })

  it('★ D1 关联：turn_interrupted 帧到达漏斗（Review Focus 4）', async () => {
    await runNaturallyExhausted([
      seqEvent('agent_start', { runId: 'run-A' }, 140),
      seqEvent('tool_execution_start', {
        toolCallId: 'call_A', toolName: 'spawn_subagent', args: { task: 'X' },
      }, 152),
    ])
    expect(tasks.onTraceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'turn_interrupted',
        data: expect.objectContaining({ reason: 'no_terminal_event' }),
      }),
      expect.anything(),
    )
  })

  it('★ 未装配 SubagentTaskService（既有单测）⇒ 整段短路、零回归', async () => {
    const bare = makeService(makePrismaStub(), undefined)
    const pi = stubPiClient([])
    vi.spyOn(bare, 'createPiRuntimeClient').mockReturnValue(pi)
    pi.streamEvents.mockImplementation(
      (_s: string, onEvent: (e: PiRuntimeEvent) => void, onClosed: () => void) => {
        onEvent(seqEvent('tool_execution_start', {
          toolCallId: 'call_X', toolName: 'spawn_subagent', args: { task: 'X' },
        }, 1))
        onClosed()
        return () => {}
      },
    )
    await expect(async () => {
      for await (const _e of bare.streamConversation('s1', 'x', 'u1', 't1')) { /* drain */ }
    }).not.toThrow()
  })
})
