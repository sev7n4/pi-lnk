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
 *   C. 用户发言不得蒸发：409 后必须走 steer 队列；steer 也失败 ⇒ followUp 兜底
 *      （D4 Task 6）；两者都失败 ⇒ reason=not_steerable；
 *   D. 落库事件带 pi-runtime **会话级全局 seq**（`gSeq`），与 `afterSeq` 同编号空间
 *      —— 局部 `seq` 是每条流各自从 1 起，跨流不可比。
 */
import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { piEvent, stubPiClient } from './agent.test-utils'
import type { PiClientStub } from './agent.test-utils'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

/** 带全局 seq 的事件（pi-runtime 的 `entry.nextSeq++`，与 afterSeq 同编号空间）。 */
function seqEvent(type: string, data: unknown, seq: number): PiRuntimeEvent {
  return { type, ts: 1_700_000_000_000, seq, data } as PiRuntimeEvent
}

/** 带回合身份的事件（PR2：runtime 透传 operationId 后的形态）。 */
function ridEvent(type: string, data: unknown, runId: string, seq = 1): PiRuntimeEvent {
  return { type, ts: 1_700_000_000_000, seq, runId, data } as PiRuntimeEvent
}

/**
 * 复现「订阅晚于 prompt」竞态的桩（生产 partial 账本的根因）。
 *
 * 语义对齐 pi-runtime 的 `streamEvents({ live:true })` = `from=now`：
 * **只有在订阅建立之后到达的事件才会被投递**；订阅建立前发出的事件一律丢弃
 * （from=now 从不重放历史缓冲）。run 的起点事件（agent_start）由 `prompt` 触发发出，
 * 于是「订阅是否早于 prompt」直接决定 agent_start 会不会丢：
 *   - 若 `streamEvents` 在 `prompt` 之后才被调用（= 惰性 async generator 的真 bug）
 *     ⇒ agent_start 在订阅建立前已发出 ⇒ 永久丢失 ⇒ 账本 partial；
 *   - 订阅先于 prompt 建立 ⇒ agent_start 被接住 ⇒ 账本完整。
 *
 * 后续事件（thinking / tool / agent_end）延后到下一 tick 发出，保证两种代码路径下流都能收口。
 */
function stubPiClientRace(): PiClientStub {
  const base = stubPiClient([])
  let onEvent: ((e: PiRuntimeEvent) => void) | null = null
  let active = false
  const deliver = (e: PiRuntimeEvent) => {
    if (active && onEvent) onEvent(e)
  }
  base.prompt = vi.fn(async () => {
    // run 起点在 prompt 这一刻发出：此刻订阅若尚未建立 ⇒ agent_start 丢（from=now 不重放）。
    deliver(ridEvent('agent_start', {}, 'run-77', 4200))
    // 其余事件稍后到达（订阅此时应已建立）⇒ 正常收到，保证消费循环能收到 agent_end 收口。
    setTimeout(() => {
      deliver(ridEvent('tool_execution_start', { toolCallId: 'c1', toolName: 'propose_generation', args: {} }, 'run-77', 4242))
      deliver(ridEvent('agent_end', { status: 'completed' }, 'run-77', 4300))
    }, 5)
    return undefined as never
  }) as never
  base.streamEvents = vi.fn((_sessionId: string, cb: (e: PiRuntimeEvent) => void) => {
    onEvent = cb
    active = true
    return () => {
      active = false
    }
  }) as never
  return base
}

describe('AgentService 回合身份与单一写者（TURN-IDENTITY P0-1/P0-2）', () => {
  const agentMessageCreate = vi.fn()
  const agentMessageFindMany = vi.fn()
  /** PR2：回合唯一性的读侧判据（`(threadId, runId)` 查存在）。 */
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

    // ⚠️ 这些 spy 定义在 describe 外层（跨用例共享），`vi.restoreAllMocks()` **不会**
    // 清空调用记录 ⇒ 不 mockClear 的话用例之间会互相污染（实测第 2 个用例就变成 2 次调用）。
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

  /** 取出最后一次助手落库的 metadata（已 JSON 解析）。 */
  function lastAssistantMetadata(): Record<string, unknown> {
    const call = assistantCreates().at(-1)?.[0] as { data: { metadata?: string } }
    return JSON.parse(call?.data?.metadata ?? '{}') as Record<string, unknown>
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
    // D4（Task 6）：steer 失败后有 followUp 兜底 ⇒ 必须让兜底也失败，
    // 才回到 not_steerable（否则 followup 受理成功，reason 应是 not_idle）。
    pi.followUp.mockRejectedValue(new Error('session gone'))
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const out: Array<{ type: string; data?: unknown }> = []
    for await (const e of service.streamConversation('s1', '生成一只小乌龟', 'u1', 't1')) {
      out.push(e)
    }

    // 兜底确实被尝试过（不是直接放弃）——「队列满时消息蒸发」的止血点。
    expect(pi.followUp).toHaveBeenCalledTimes(1)
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

  it('D2：waiting_user（阻塞确认等待生命周期）必须落库 —— 刷新/历史重放才能重建 proposal part', async () => {
    // 生产实证 cmvvaw8ar000moe01fdolrugb（2026-10-31）：propose_generation 阻塞等待
    // 7.5min 后 timeout 收场，账本里 tool_call/tool_result 齐全却无 waiting_user ⇒
    // 前端 replayTimelineEvents 无法从历史重建 proposal part（含 callId），
    // 确认/取消按钮静默 no-op，节点卡死在 pending_confirm。
    // 修法与 node_status 漏入库同款：把 waiting_user 纳入落库白名单。
    const waitingEv = seqEvent(
      'waiting_user',
      { status: 'waiting', toolName: 'propose_generation', callId: 'call_w1', timeoutMs: 450_000, nodeId: 'node-frog' },
      4243,
    )
    const resolvedEv = seqEvent(
      'waiting_user',
      { status: 'resolved', toolName: 'propose_generation', callId: 'call_w1', reason: 'timeout' },
      4299,
    )
    await runTurn([
      ridEvent('agent_start', {}, 'run-88', 4240),
      seqEvent('tool_execution_start', { toolCallId: 'call_w1', toolName: 'propose_generation', args: {} }, 4242),
      waitingEv,
      resolvedEv,
      piEvent('agent_end', { status: 'completed' }),
    ])

    const meta = lastAssistantMetadata() as {
      executionEvents?: Array<{ type: string; data?: { status?: string; callId?: string } }>
    }
    const waits = (meta.executionEvents ?? []).filter((e) => e.type === 'waiting_user')
    // waiting + resolved 两条都必须在（缺 resolved ⇒ 重放后 proposal part 恒 pending_confirm，
    // 历史里会残留可点但无效的确认卡；缺 waiting ⇒ part 无从建起）。
    expect(waits).toHaveLength(2)
    expect(waits[0]?.data).toMatchObject({ status: 'waiting', callId: 'call_w1', toolName: 'propose_generation' })
    expect(waits[1]?.data).toMatchObject({ status: 'resolved', callId: 'call_w1', reason: 'timeout' })
  }, 120_000)

  // ─────────────── PR2 · 立身份（回合唯一性 + 账本完整性）───────────────

  it('D3（turn_suspended）：流在阻塞等待边界耗尽（无 agent_end）⇒ 末尾必须显式下发 turn_suspended', async () => {
    // 生产实证 cmvvaw8ar000moe01fdolrugb（2026-10-31）：propose_generation 挂起后
    // pi lane 收尾 ⇒ 主流在 waiting_user 后自然耗尽（nginx 实测 201 完成、用时=等待起点）。
    // 此前客户端对「正常挂起」零显式信号：等待条随 isStreaming 熄灭、真断链与挂起
    // 在传输层不可区分（P0-5 安抚文案只能挂在 fetch 异常分支）。修法：流耗尽时
    // 若「见到 waiting{waiting} 且未见权威收束」⇒ 末尾下发 turn_suspended。
    // 桩：回放事件后触发 streamEvents 的 closed 回调（= pi lane 挂起收尾的真实形态，
    // stubPiClient 默认桩只回放不收口，iterator 会永久挂起）。
    const pi = stubPiClient([])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    pi.streamEvents.mockImplementation(
      (_sessionId: string, onEvent: (e: PiRuntimeEvent) => void, onClosed: () => void) => {
        for (const event of [
          ridEvent('agent_start', {}, 'run-91', 4240),
          seqEvent('tool_execution_start', { toolCallId: 'call_s1', toolName: 'propose_generation', args: {} }, 4242),
          seqEvent('waiting_user', { status: 'waiting', toolName: 'propose_generation', callId: 'call_s1', timeoutMs: 300_000, nodeId: 'node-shrimp' }, 4243),
        ]) {
          onEvent(event)
        }
        onClosed()
        return () => {}
      },
    )
    const out: Array<{ type: string; data?: unknown }> = []
    for await (const e of service.streamConversation('s1', '生成一只皮皮虾', 'u1', 't1')) {
      out.push(e)
    }
    // turn_ack（D4）在流末尾收口，晚于挂起事件 ⇒ 断言「恰一个且在 waiting_user 之后」。
    const waitIdx = out.findIndex((e) => e.type === 'waiting_user')
    const suspendedIdx = out.findIndex((e) => e.type === 'turn_suspended')
    expect(suspendedIdx).toBeGreaterThan(waitIdx)
    expect(waitIdx).toBeGreaterThan(-1)
    const suspended = out.filter((e) => e.type === 'turn_suspended')
    expect(suspended).toHaveLength(1)
    expect(suspended[0]).toBeDefined()
  }, 120_000)

  it('D3（对照）：等待在同流内 resolved（answered/超时后 agent_end）⇒ 不发 turn_suspended', async () => {
    // 只有「流耗尽时仍挂着」才算挂起收尾；等待已在流内解除 ⇒ 回合照常收口。
    const { out } = await runTurn([
      ridEvent('agent_start', {}, 'run-92', 4240),
      seqEvent('waiting_user', { status: 'waiting', toolName: 'propose_generation', callId: 'call_s2', timeoutMs: 300_000, nodeId: 'node-x' }, 4241),
      seqEvent('waiting_user', { status: 'resolved', toolName: 'propose_generation', callId: 'call_s2', reason: 'answered' }, 4242),
      piEvent('agent_end', { status: 'completed' }),
    ])
    expect(out.some((e) => e.type === 'turn_suspended')).toBe(false)
  }, 120_000)

  it('E：owner 落库必须写 runId —— 它是「一次 run 一条账」唯一键的一半', async () => {
    await runTurn([
      ridEvent('agent_start', {}, 'run-77'),
      piEvent('message_update', { event: { type: 'text_delta', delta: '好' } }),
      ridEvent('agent_end', { status: 'completed' }, 'run-77'),
    ])

    const call = assistantCreates().at(-1)?.[0] as { data: { runId?: string } }
    expect(call?.data?.runId).toBe('run-77')
  }, 120_000)

  it('F（唯一性）：同 (threadId, runId) 已有记账行 ⇒ 本条 no-op 且不再写画布产出', async () => {
    // 模拟「第二个写者」：上游 409 判定之外仍走到落库的漏网者（断线重连补发 /
    // generation-recovery 的 drain / 任何未来的第三写者）。
    agentMessageFindFirst.mockResolvedValue({ id: 'm-owner-already-there' })

    await runTurn([
      ridEvent('agent_start', {}, 'run-77'),
      piEvent('message_update', { event: { type: 'text_delta', delta: '好' } }),
      ridEvent('agent_end', { status: 'completed' }, 'run-77'),
    ])

    expect(agentMessageFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: 't1', runId: 'run-77' } }),
    )
    expect(assistantCreates()).toHaveLength(0)
  }, 120_000)

  it('G（N4）：没捕获到 run 起点 ⇒ 账本标 partial + gapFrom，不冒充全量', async () => {
    // 切片形态：首事件就是孤儿 tool_result（生产漂移签名），没有 agent_start。
    await runTurn([
      ridEvent(
        'tool_execution_start',
        { toolCallId: 'c1', toolName: 'propose_generation', args: {} },
        'run-77',
        4242,
      ),
      ridEvent('agent_end', { status: 'completed' }, 'run-77', 4300),
    ])

    const meta = lastAssistantMetadata()
    expect(meta.partial).toBe(true)
    expect(meta.gapFrom).toBe(4242)
  }, 120_000)

  it('G（对照）：捕获到 run 起点 ⇒ 不落 partial/gapFrom 两个键（键不出现纪律）', async () => {
    await runTurn([
      ridEvent('agent_start', {}, 'run-77', 4200),
      ridEvent('tool_execution_start', { toolCallId: 'c1', toolName: 't', args: {} }, 'run-77', 4242),
      ridEvent('agent_end', { status: 'completed' }, 'run-77', 4300),
    ])

    const meta = lastAssistantMetadata()
    expect('partial' in meta).toBe(false)
    expect('gapFrom' in meta).toBe(false)
  }, 120_000)

  it('F（边界）：runtime 未透传 runId（滚动升级窗口）⇒ 退回旧行为，照常落库', async () => {
    await runTurn([...TYPICAL_TURN])

    // ⭐ 精确化（2026-10-21，批次 2 对账落地时）：原判据是「findFirst 没被调用」——
    // 那是**代理判据**，把「不按 (threadId, runId) 查存在」误扩成「完全不碰 findFirst」。
    // 新判据锁**真意图**：**没有按 runId 查过**（回合唯一性的读侧判据专属）。
    // ⭐ 批次 2 的对账也用 findFirst（按 threadId+role 取最近一条 user 消息做比对）⇒ 不撞。
    expect(
      agentMessageFindFirst.mock.calls.every(
        ([args]) => !('runId' in ((args as { where?: Record<string, unknown> } | undefined)?.where ?? {})),
      ),
    ).toBe(true)
    const call = assistantCreates().at(-1)?.[0] as { data: { runId?: string } }
    expect(call?.data?.runId).toBeNull()
    expect(assistantCreates()).toHaveLength(1)
  }, 120_000)

  it('H（根因锁）：订阅必须早于 prompt —— agent_start 不得因「订阅晚于 run 起点」而丢失', async () => {
    // 复现生产 partial 账本根因：iteratePiEvents 若是惰性 async generator，
    // streamEvents 会推迟到首个 .next()（消费循环里）才调用，晚于 await client.prompt
    // ⇒ agent_start 在订阅建立前已发出，from=now 又不重放 ⇒ 每轮都丢起点、标 partial，
    // 残尾首事件常是孤儿 tool_result ⇒ 前端「提议生成」卡片顶到思考/工具之前。
    const pi = stubPiClientRace()
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const out: Array<{ type: string; data?: unknown }> = []
    for await (const e of service.streamConversation('s1', '生成一只小乌龟', 'u1', 't1')) {
      out.push(e)
    }

    // owner 正常落库（唯一写者）。
    expect(assistantCreates()).toHaveLength(1)
    const meta = lastAssistantMetadata()
    // agent_start 被捕获 ⇒ 账本完整：不落 partial / gapFrom（键不出现纪律）。
    expect(meta.partial).toBeFalsy()
    expect('gapFrom' in meta).toBe(false)
    // runId 仍照常落库（PR2 唯一键的一半不受影响）。
    const call = assistantCreates().at(-1)?.[0] as { data: { runId?: string } }
    expect(call?.data?.runId).toBe('run-77')
  }, 120_000)
})
