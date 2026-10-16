/**
 * TURN-IDENTITY：回合身份与单一写者（P0-1 / P0-2）回归锁。
 *
 * 生产事故（画布 cmv9hmpph001qoa017y9rv312）：一次 run 被 4 条流各记一本账。
 * 根因形态是 `void client.prompt(...).catch(...)` —— **发射后不管**：409（上游
 * `LaneBusy` = 现成的 NotIdle）被 catch 吞掉后，那条流**并不终止**，继续旁听在跑的
 * run，跑到 `agent_end` 时自己也 `finalizeTurn` 落库。同秒落下 4 条正文完全相同的
 * 助手消息；后 3 条的事件集是完整回合的**子序列**（起点滞后、终点同刻 ⇒ 订阅切片），
 * 切片首事件是孤儿 `tool_result` ⇒ 前端 `parts.push` 把它变成 `parts[0]`
 * ⇒「提议生成」卡片顶到思考和工具消息之前。
 *
 * 本文件钉住四件事（任一被改回即红灯）：
 *   A. 409 ⇒ 本流降级为 **shadow**：**不落库**、不结算，但事件照常转发（进度可见）；
 *   B. 结构化拒绝 `turn_not_submitted{reason}` 必须下发 —— 409 是传输层信号，
 *      UI 拿不到 reason 就分不出「已并入 / 当前不可插话」两种文案；
 *   C. 用户发言不得蒸发：409 后必须走 steer 队列；steer 也失败 ⇒ reason=not_steerable；
 *   D. 落库事件带 pi-runtime **会话级全局 seq**（`gSeq`），与 `afterSeq` 同编号空间
 *      —— 局部 `seq` 是每条流各自从 1 起，跨流不可比。
 */
import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { piEvent, stubPiClient } from './agent.test-utils'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

/** 带全局 seq 的事件（pi-runtime 的 `entry.nextSeq++`，与 afterSeq 同编号空间）。 */
function seqEvent(type: string, data: unknown, seq: number): PiRuntimeEvent {
  return { type, ts: 1_700_000_000_000, seq, data } as PiRuntimeEvent
}

describe('AgentService 回合身份与单一写者（TURN-IDENTITY P0-1/P0-2）', () => {
  const agentMessageCreate = vi.fn()
  const agentMessageFindMany = vi.fn()
  const agentThreadFindUnique = vi.fn()
  const agentThreadUpsert = vi.fn()
  const agentThreadUpdate = vi.fn()
  const sessionFindUnique = vi.fn()
  const sessionUpdate = vi.fn()

  let service: AgentService

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'

    // ⚠️ 这些 spy 定义在 describe 外层（跨用例共享），`vi.restoreAllMocks()` **不会**
    // 清空调用记录 ⇒ 不 mockClear 的话用例之间会互相污染（实测第 2 个用例就变成 2 次调用）。
    for (const spy of [
      agentMessageCreate,
      agentMessageFindMany,
      agentThreadFindUnique,
      agentThreadUpsert,
      agentThreadUpdate,
      sessionFindUnique,
      sessionUpdate,
    ]) {
      spy.mockClear()
    }
    agentMessageCreate.mockResolvedValue({})
    agentMessageFindMany.mockResolvedValue([])
    agentThreadFindUnique.mockResolvedValue(null)
    agentThreadUpsert.mockResolvedValue({})
    agentThreadUpdate.mockResolvedValue({})
    sessionFindUnique.mockResolvedValue({ id: 's1', canvasData: null })
    sessionUpdate.mockResolvedValue({})

    service = new AgentService(
      {
        agentMessage: { create: agentMessageCreate, findMany: agentMessageFindMany },
        agentThread: {
          findUnique: agentThreadFindUnique,
          upsert: agentThreadUpsert,
          update: agentThreadUpdate,
        },
        session: { findUnique: sessionFindUnique, update: sessionUpdate },
        userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
      { create: vi.fn() } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
  })

  afterEach(() => {
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL
  })

  /**
   * ⚠️ 同一个 `agentMessage.create` 通道也落**用户**消息（实测首参 role='user'），
   * 所以断言「有没有落助手消息」必须按 role 过滤，不能只数调用次数。
   */
  function assistantCreates() {
    return agentMessageCreate.mock.calls.filter((c) => {
      const arg = c[0] as { data?: { role?: string } }
      return arg?.data?.role === 'assistant'
    })
  }

  /** 跑一轮，返回 (客户端桩, 收到的 SSE 事件)。 */
  async function runTurn(events: PiRuntimeEvent[]) {
    const pi = stubPiClient(events)
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    const out: Array<{ type: string; data?: unknown }> = []
    for await (const e of service.streamConversation('s1', '生成一只小乌龟', 'u1', 't1')) {
      out.push(e)
    }
    return { pi, out }
  }

  const TYPICAL_TURN = [
    piEvent('agent_start', {}),
    piEvent('message_update', { event: { type: 'text_delta', delta: '好' } }),
    piEvent('agent_end', { status: 'completed' }),
  ]

  it('A/C（对照）：owner 流正常落库，且不发 turn_not_submitted', async () => {
    const { pi, out } = await runTurn([...TYPICAL_TURN])

    expect(pi.prompt).toHaveBeenCalledTimes(1)
    expect(pi.steer).not.toHaveBeenCalled()
    expect(out.map((e) => e.type)).not.toContain('turn_not_submitted')
    expect(assistantCreates()).toHaveLength(1)
  }, 120_000)

  it('A/B/C：prompt 撞 409（LaneBusy）⇒ 本流转 shadow：不落库 + 下发结构化拒绝 + 发言走 steer', async () => {
    const busy = Object.assign(new Error('lane busy'), { status: 409 })
    const pi = stubPiClient([...TYPICAL_TURN])
    pi.prompt.mockRejectedValue(busy)
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const out: Array<{ type: string; data?: unknown }> = []
    for await (const e of service.streamConversation('s1', '生成一只小乌龟', 'u1', 't1')) {
      out.push(e)
    }

    // A：shadow 不落库 —— 这是「同一 run 被记 N 本账」的直接止血点。
    expect(assistantCreates()).toHaveLength(0)
    // C：发言不得蒸发 —— 并入在跑的 run 的 steer 队列。
    expect(pi.steer).toHaveBeenCalledWith('t1', '生成一只小乌龟', 'main', expect.anything())
    // B：结构化拒绝（reason=not_idle），UI 才能显示「已并入进行中的任务」。
    const refusal = out.find((e) => e.type === 'turn_not_submitted')
    expect(refusal).toBeDefined()
    expect(refusal?.data).toEqual({ reason: 'not_idle' })
    // 事件仍然转发 —— 用户在旁听流里照样看得到在跑的进度。
    expect(out.map((e) => e.type)).toContain('text_delta')
  }, 120_000)

  it('C：409 后再 steer 也失败 ⇒ reason=not_steerable（不许假装已受理）', async () => {
    const busy = Object.assign(new Error('lane busy'), { status: 409 })
    const pi = stubPiClient([...TYPICAL_TURN])
    pi.prompt.mockRejectedValue(busy)
    pi.steer.mockRejectedValue(new Error('session gone'))
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const out: Array<{ type: string; data?: unknown }> = []
    for await (const e of service.streamConversation('s1', '生成一只小乌龟', 'u1', 't1')) {
      out.push(e)
    }

    const refusal = out.find((e) => e.type === 'turn_not_submitted')
    expect(refusal?.data).toEqual({ reason: 'not_steerable' })
    expect(assistantCreates()).toHaveLength(0)
  }, 120_000)

  it('C（边界）：非 409 的 prompt 失败**不**置 shadow —— 避免把唯一写者误判成旁听', async () => {
    // 网络超时等场景下 run 可能其实已被接受；此时若判 shadow ⇒ 整轮消息彻底不落库（比重复更糟）。
    const pi = stubPiClient([...TYPICAL_TURN])
    pi.prompt.mockRejectedValue(Object.assign(new Error('upstream 503'), { status: 503 }))
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const out: Array<{ type: string; data?: unknown }> = []
    for await (const e of service.streamConversation('s1', '生成一只小乌龟', 'u1', 't1')) {
      out.push(e)
    }

    expect(out.map((e) => e.type)).not.toContain('turn_not_submitted')
    // 非 409 不置 shadow ⇒ 助手消息仍必须落库（否则真超时时整轮消息会丢）
    expect(assistantCreates()).toHaveLength(1)
  }, 120_000)

  it('D：落库事件带会话级全局 seq（gSeq），与 pi-runtime afterSeq 同编号空间', async () => {
    const { } = await runTurn([
      seqEvent('tool_execution_start', { toolCallId: 'c1', toolName: 'propose_generation', args: {} }, 4242),
      piEvent('agent_end', { status: 'completed' }),
    ])

    const call = agentMessageCreate.mock.calls.at(-1)?.[0] as {
      data: { metadata?: string }
    }
    const meta = JSON.parse(call.data.metadata ?? '{}') as {
      executionEvents?: Array<{ type: string; seq?: number; gSeq?: number }>
    }
    const toolCall = meta.executionEvents?.find((e) => e.type === 'tool_call')
    expect(toolCall).toBeDefined()
    // gSeq 来自 pi-runtime 的全局序号（本例 4242），不是 Nest 每条流从 1 起的局部 seq。
    expect(toolCall?.gSeq).toBe(4242)
    expect(toolCall?.seq).toBe(1)
  }, 120_000)
})
