/**
 * D4（multi-device Task 6）：执行面 ACK 语义 + mode 三态。
 *
 * 权威定义见 spec §5.2：
 *   ConversationAck = { runId, mode: 'run'|'steer'|'followup', reason?, messageId? }
 * 本期形态（plan Task 6 Step 3）：不改「流随请求」，只在 SSE 流**末尾**追加一个
 * `turn_ack` 事件，与既有 `turn_not_submitted` 并存。
 *
 * 本文件钉住四件事（任一被改回即红灯）：
 *   A. 三态映射：空闲⇒'run'；409+steer 成功⇒'steer'；409+steer 失败+followUp 成功⇒'followup'；
 *   B. 发言不蒸发：steer 塞不进去时必须兜底 followUp（plan 模式表「忙碌+队列满⇒followup」）——
 *      没有这条兜底，「队列满」时用户消息既不入队也不报错，是查不掉的黑洞；
 *   C. 双失败（steer+followUp 都失败）⇒ **不发** turn_ack：没有可裁定的归属，
 *      `turn_not_submitted{not_steerable}` 已经把话说清，ack 再发就是二次编造；
 *   D. 键纪律：runId 仅在观测到（runtime 透传）时出现；reason 仅 mode!=='run' 时出现；
 *      messageId 本期不出现（插话落库是 Task 8，提前发就是假装已落库）。
 */
import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { piEvent, stubPiClient } from './agent.test-utils'
import type { PiClientStub } from './agent.test-utils'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

/** 带回合身份的事件（PR2：runtime 透传 operationId 后的形态）。 */
function ridEvent(type: string, data: unknown, runId: string, seq = 1): PiRuntimeEvent {
  return { type, ts: 1_700_000_000_000, seq, runId, data } as PiRuntimeEvent
}

describe('ConversationAck：流末尾 turn_ack 三态（D4 / multi-device Task 6）', () => {
  const agentMessageCreate = vi.fn()
  const agentMessageFindMany = vi.fn()
  const agentMessageFindFirst = vi.fn()
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

    for (const spy of [
      agentMessageCreate,
      agentMessageFindMany,
      agentMessageFindFirst,
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
    agentMessageFindFirst.mockResolvedValue(null)
    agentThreadFindUnique.mockResolvedValue(null)
    agentThreadUpsert.mockResolvedValue({})
    agentThreadUpdate.mockResolvedValue({})
    sessionFindUnique.mockResolvedValue({ id: 's1', canvasData: null })
    sessionUpdate.mockResolvedValue({})

    service = new AgentService(
      {
        agentMessage: {
          create: agentMessageCreate,
          findMany: agentMessageFindMany,
          findFirst: agentMessageFindFirst,
        },
        agentThread: {
          findUnique: agentThreadFindUnique,
          upsert: agentThreadUpsert,
          update: agentThreadUpdate,
        },
        session: { findUnique: sessionFindUnique, update: sessionUpdate },
        userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
  })

  afterEach(() => {
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL
  })

  /** 跑一轮，返回 (客户端桩, 收到的 SSE 事件)。 */
  async function runTurn(pi: PiClientStub) {
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    const out: Array<{ type: string; data?: unknown }> = []
    for await (const e of service.streamConversation('s1', '把小乌龟变大', 'u1', 't1')) {
      out.push(e)
    }
    return out
  }

  /** 忙碌错误（上游 LaneBusy = 现成的 NotIdle）。 */
  const busy409 = () => Object.assign(new Error('lane busy'), { status: 409 })

  const TYPICAL_TURN = [
    piEvent('agent_start', {}),
    piEvent('message_update', { event: { type: 'text_delta', delta: '好' } }),
    piEvent('agent_end', { status: 'completed' }),
  ]

  function ackOf(out: Array<{ type: string; data?: unknown }>) {
    return out.find((e) => e.type === 'turn_ack')
  }

  it('A-1 空闲 ⇒ turn_ack{mode:run}，且是流末尾最后一个事件', async () => {
    const pi = stubPiClient([...TYPICAL_TURN])
    const out = await runTurn(pi)

    const ack = ackOf(out)
    expect(ack).toBeDefined()
    expect(ack?.data).toEqual({ mode: 'run' })
    // plan Task 6 Step 3：「放在 SSE 流末尾的一个 turn_ack 事件」——
    // 断言落在可观测出口：它是自然完成路径 yield 的最后一个事件。
    expect(out.at(-1)?.type).toBe('turn_ack')
    // 空闲轮不碰队列。
    expect(pi.steer).not.toHaveBeenCalled()
    expect(pi.followUp).not.toHaveBeenCalled()
  }, 120_000)

  it('A-2 空闲 + runtime 透传 runId ⇒ turn_ack 带上观测到的 runId', async () => {
    const out = await runTurn(
      stubPiClient([
        ridEvent('agent_start', {}, 'run-77', 4200),
        piEvent('message_update', { event: { type: 'text_delta', delta: '好' } }),
        ridEvent('agent_end', { status: 'completed' }, 'run-77', 4300),
      ]),
    )

    expect(ackOf(out)?.data).toEqual({ runId: 'run-77', mode: 'run' })
  }, 120_000)

  it('A-3 键纪律：runtime 未透传 runId ⇒ ack 不出现 runId 键（不造假值）', async () => {
    const out = await runTurn(stubPiClient([...TYPICAL_TURN]))

    const data = ackOf(out)?.data as Record<string, unknown>
    expect('runId' in data).toBe(false)
    expect('reason' in data).toBe(false)
  }, 120_000)

  it('B-1 409 + steer 成功 ⇒ turn_ack{mode:steer, reason:not_idle}，不碰 followUp', async () => {
    const pi = stubPiClient([...TYPICAL_TURN])
    pi.prompt.mockRejectedValue(busy409())
    const out = await runTurn(pi)

    const ack = ackOf(out)
    expect(ack?.data).toEqual({ mode: 'steer', reason: 'not_idle' })
    expect(pi.steer).toHaveBeenCalledWith('t1', '把小乌龟变大', 'main', expect.anything())
    expect(pi.followUp).not.toHaveBeenCalled()
    // 与 turn_not_submitted 并存（plan Step 3），且 ack 在流末尾。
    expect(out.find((e) => e.type === 'turn_not_submitted')?.data).toEqual({ reason: 'not_idle' })
    expect(out.at(-1)?.type).toBe('turn_ack')
  }, 120_000)

  it('B-2 409 + steer 失败 + followUp 成功 ⇒ turn_ack{mode:followup}（发言不蒸发）', async () => {
    const pi = stubPiClient([...TYPICAL_TURN])
    pi.prompt.mockRejectedValue(busy409())
    pi.steer.mockRejectedValue(new Error('steer queue full'))
    const out = await runTurn(pi)

    const ack = ackOf(out)
    expect(ack?.data).toEqual({ mode: 'followup', reason: 'not_idle' })
    // 兜底必须真的把用户原话送进 followUp 队列（收尾边界接住）。
    expect(pi.followUp).toHaveBeenCalledWith('t1', '把小乌龟变大', 'main', expect.anything())
    // followup 受理成功 ⇒ 不得谎称 not_steerable。
    expect(out.find((e) => e.type === 'turn_not_submitted')?.data).toEqual({ reason: 'not_idle' })
    // messageId 是 Task 8（插话落库）的产物——本期发了就是假装已落库。
    const data = ack?.data as Record<string, unknown>
    expect('messageId' in data).toBe(false)
  }, 120_000)

  it('C 409 + steer/followUp 双失败 ⇒ 无 turn_ack（turn_not_submitted{not_steerable} 已告知）', async () => {
    const pi = stubPiClient([...TYPICAL_TURN])
    pi.prompt.mockRejectedValue(busy409())
    pi.steer.mockRejectedValue(new Error('steer queue full'))
    pi.followUp.mockRejectedValue(new Error('session gone'))
    const out = await runTurn(pi)

    expect(ackOf(out)).toBeUndefined()
    expect(out.find((e) => e.type === 'turn_not_submitted')?.data).toEqual({
      reason: 'not_steerable',
    })
  }, 120_000)

  it('C（边界）非 409 的 prompt 失败 ⇒ 无 turn_ack（error 事件已告知，不二次编造归属）', async () => {
    const pi = stubPiClient([...TYPICAL_TURN])
    pi.prompt.mockRejectedValue(Object.assign(new Error('upstream 503'), { status: 503 }))
    const out = await runTurn(pi)

    expect(ackOf(out)).toBeUndefined()
    expect(out.map((e) => e.type)).not.toContain('turn_not_submitted')
  }, 120_000)
})
