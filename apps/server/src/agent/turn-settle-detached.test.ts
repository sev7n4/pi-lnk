/**
 * 落库与请求生命周期解耦（multi-device Task 2 · D2）
 *
 * ## 这个测试要钉住什么
 *
 * spec §4.2 的 D2 判据：「**执行完成即应有记录**，与发起的 HTTP 连接是否存活无关」。
 * 可观测形式：断网 10 分钟再回来，**历史里那轮在**。
 *
 * ## 为什么不用「消费方抛错」当断连形态（这是本测试最关键的一处纠正）
 *
 * 计划的 Task 1/2 假设「nginx 300s 掐断 ⇒ 消费方在 yield 处抛错 ⇒ generator 提前终止」。
 * **该假设已被生产取证证伪**（详见 .superpowers/sdd/2026-10-21-multi-device-consistency/progress.md）：
 *
 * 1. Node 上 `res.write` 对已销毁的 socket **只返回 false，不抛错**
 *    （探针：write#0 returned false / res.destroyed = true ⇒ 无 throw、无 uncaughtException）；
 * 2. 生产 nginx 日志里该 POST 是 **201 正常完成**（不是 499/504）⇒ nginx 没掐它；
 * 3. 同 session 有一个 **438.2s** 的 run 照样落了库 ⇒「>300s ⇒ 必丢」不成立。
 *
 * ⇒ 真实缺陷不是「消费方抛错」，而是：**Nest 侧流提前收尾时，权威的 agent_end 还没到**
 * （pi 侧那轮继续跑完、transcript 里 completed），而旧判据「有内容才落库」在那种情况下
 * 内容恰好为空 ⇒ **整轮零记录**（生产：618.6s 的 run，Nest 表 0 行 ⇒「有执行、无记录」）。
 *
 * 所以本测试用**真实形态**建模：pi 事件流在 agent_end 之前**提前结束**（流耗尽），
 * 断言这轮**仍须落库**且 metadata 标 truncated。
 *
 * ## 判据落在哪（为什么不是 spy）
 *
 * 断言落在**实际写库值**上（`agentMessage.create` 的入参），不是「finalizeTurn 被调用了几次」——
 * 后者对「写了一条空气泡」也恒真。而「空气泡」正是本仓已知的坑
 * （agent.service.pi-runtime.test.ts 的 R-1：空 content 不得伪装成单空格）。
 */
import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { piEvent, stubPiClient, type PiClientStub } from './agent.test-utils'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

describe('落库与请求生命周期解耦 (multi-device Task 2 · D2)', () => {
  const agentMessageCreate = vi.fn()
  const agentThreadFindUnique = vi.fn()
  const agentThreadUpsert = vi.fn()
  const agentThreadUpdate = vi.fn()
  const sessionFindUnique = vi.fn()
  const sessionUpdate = vi.fn()
  const idempotencyRecordCreate = vi.fn()
  const idempotencyRecordFindUnique = vi.fn()
  const idempotencyRecordUpdateMany = vi.fn()
  const idempotencyRecordDeleteMany = vi.fn()

  let service: AgentService

  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL
    agentMessageCreate.mockResolvedValue({})
    agentThreadFindUnique.mockResolvedValue(null)
    agentThreadUpsert.mockResolvedValue({})
    agentThreadUpdate.mockResolvedValue({})
    sessionFindUnique.mockResolvedValue({ id: 's1', canvasData: null })
    sessionUpdate.mockResolvedValue({})
    idempotencyRecordCreate.mockResolvedValue({})
    idempotencyRecordFindUnique.mockResolvedValue(null)
    idempotencyRecordUpdateMany.mockResolvedValue({ count: 1 })
    idempotencyRecordDeleteMany.mockResolvedValue({ count: 0 })

    service = new AgentService(
      {
        agentMessage: { create: agentMessageCreate, findMany: vi.fn().mockResolvedValue([]) },
        agentThread: {
          findUnique: agentThreadFindUnique,
          upsert: agentThreadUpsert,
          update: agentThreadUpdate,
        },
        session: { findUnique: sessionFindUnique, update: sessionUpdate },
        idempotencyRecord: {
          create: idempotencyRecordCreate,
          findUnique: idempotencyRecordFindUnique,
          updateMany: idempotencyRecordUpdateMany,
          deleteMany: idempotencyRecordDeleteMany,
        },
        userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn().mockResolvedValue(null) } as never,
    )
  })

  afterEach(() => {
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL
  })

  /** 取实际写入的 assistant 行（按 role 过滤，避免 user 行混入）。 */
  function persistedAssistantRows(): Array<{
    content: string
    runId: string | null
    metadata: Record<string, unknown> | null
  }> {
    return agentMessageCreate.mock.calls
      .map((c) => (c[0] as { data?: Record<string, unknown> }).data)
      .filter((d) => d?.role === 'assistant')
      .map((d) => ({
        content: String(d?.content ?? ''),
        runId: (d?.runId as string | null) ?? null,
        metadata: d?.metadata ? (JSON.parse(String(d.metadata)) as Record<string, unknown>) : null,
      }))
  }

  /**
   * 跑一轮对话，pi 事件流送完 events 后**结束**（= Nest 侧流提前收尾的形态）。
   *
   * ⚠️ 为什么要自己造桩而不是用共享的 `stubPiClient`：
   * 共享桩的 `streamEvents` 送完事件后**既不报 end-of-stream 也不 onError**，
   * 于是 `iteratePiEvents` 的 `next()` 永远挂在 `await new Promise(...)` 上
   * ⇒ 消费方 await 不完 ⇒ 用例超时（60s）。
   * 而「流提前结束」正是本测试要建模的形态，所以这里必须能显式表达「流结束了」。
   *
   * 真实链路上「流结束」有两条路（`iteratePiEvents` 的 closed=true）：
   * ① pi-runtime 的 SSE body 收尾（会话删除/turn 结束）；
   * ② 客户端 `streamEvents` 的 onError（404/409/重连预算耗尽 504）。
   * ② 更贴近生产（Nest 侧流提前收尾 ⇒ 权威 agent_end 还没到），故桩走 onError。
   */
  async function runTurn(events: Array<ReturnType<typeof piEvent>>): Promise<number> {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient(events)
    // 送完事件后**显式结束流**（onError ⇒ iteratePiEvents 的 closed=true ⇒ next() 返回 done）。
    pi.streamEvents.mockImplementation(
      (
        _sessionId: string,
        onEvent: (event: PiRuntimeEvent) => void,
        onError?: (err: unknown) => void,
      ) => {
        for (const event of events) onEvent(event)
        onError?.(new Error('stream ended before agent_end (simulated early stream end)'))
        return () => {}
      },
    )
    vi.spyOn(service as unknown as { createPiRuntimeClient: () => unknown }, 'createPiRuntimeClient').mockReturnValue(pi)

    let seen = 0
    for await (const _e of service.streamConversation('s1', '生成一只老山羊', 'u1')) {
      seen++
    }
    return seen
  }

  it('流在 agent_end 之前结束（pi 侧那轮仍在跑）⇒ 这轮仍须落库，且标 truncated', async () => {
    // 形态：本流收到 run 起点 + 一条正文，然后**流就结束了**（没有 agent_end / 没有 turn_usage）。
    // 这正是生产 618.6s 那一轮在 Nest 侧的形态：Nest 提前收尾，pi 侧继续跑完。
    await runTurn([
      piEvent('agent_start', { runId: 'run-1' }),
      piEvent('message_start', {}),
      piEvent('message_update', { event: { type: 'text_delta', delta: '老山羊已经生成好了' } }),
    ])

    const rows = persistedAssistantRows()
    expect(
      rows.length,
      '本流没见到 agent_end，但 pi 侧这轮确实在跑 ⇒ 历史里必须有这轮（spec D2「执行完成即应有记录」）',
    ).toBeGreaterThan(0)

    // 内容是**前缀快照**，不是全量 ⇒ 必须显式标注，否则读端会当完整过程重放。
    expect(rows[0].metadata?.truncated, '未见到 agent_end ⇒ 必须标 truncated（尾部未捕获）').toBe(true)
    // 键不出现纪律：内容拿到了，但尾部没拿到 ⇒ partial（头部缺口）不成立。
    expect(rows[0].metadata?.partial, '本流看到了 run 起点 ⇒ 不是头部缺口，partial 不应成立').toBeUndefined()
  })

  it('本流一个字都没收到（流立刻结束）⇒ 这轮仍须留痕（观测缺失 ≠ 事实缺失）', async () => {
    // 极端形态：Nest 侧流在收到任何事件前就结束了。
    // 但 prompt 已被 pi 接受（runStarted=true）⇒ pi 侧那轮**确实在跑**⇒
    // 「Nest 没看到」不等于「这轮没发生」⇒ 历史里必须有可查的痕迹。
    await runTurn([])

    const rows = persistedAssistantRows()
    expect(
      rows.length,
      '本流没收到任何事件，但 prompt 已被接受 ⇒ 这轮在 pi 侧确实执行了 ⇒ 必须留痕',
    ).toBeGreaterThan(0)
    expect(rows[0].metadata?.truncated, '没见到 agent_end ⇒ 必须标 truncated').toBe(true)
  })

  it('正常见到 agent_end ⇒ 落库且**不**标 truncated（键不出现纪律）', async () => {
    await runTurn([
      piEvent('agent_start', { runId: 'run-2' }),
      piEvent('message_start', {}),
      piEvent('message_update', { event: { type: 'text_delta', delta: '完整回答' } }),
      piEvent('message_end', {}),
      piEvent('agent_end', { status: 'completed' }),
    ])

    const rows = persistedAssistantRows()
    expect(rows.length, '正常轮次必须落库').toBeGreaterThan(0)
    expect(rows[0].content, '正常轮次的内容是完整的').toContain('完整回答')
    expect(rows[0].metadata?.truncated, '正常见到 agent_end ⇒ 不写 truncated').toBeUndefined()
  })

  it('见到 error（run 失败收束）⇒ 落库且**不**标 truncated（失败也是「结束了」）', async () => {
    // ⚠️ `error` 是**权威收束事件**：run 失败**也是**结束，不是「尾部缺失」。
    // 把它标成 truncated 会谎报缺口（读端会以为还有内容没到）。
    await runTurn([
      piEvent('agent_start', { runId: 'run-3' }),
      piEvent('message_update', { event: { type: 'text_delta', delta: '部分内容' } }),
      piEvent('error', { message: 'upstream failed' }),
    ])

    const rows = persistedAssistantRows()
    expect(rows.length, '失败轮也要落库（有内容时）').toBeGreaterThan(0)
    expect(rows[0].metadata?.truncated, '见到 error ⇒ 这轮已结束 ⇒ 不写 truncated').toBeUndefined()
  })

  it('prompt 未被接受（pi 侧整轮不存在）⇒ 不造假记录', async () => {
    // 边界：prompt 被上游拒绝 ⇒ pi 侧**整轮不存在** ⇒ 造一条 assistant 行是撒谎。
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi: PiClientStub = stubPiClient([])
    pi.prompt.mockRejectedValue(Object.assign(new Error('upstream boom'), { status: 500 }))
    pi.streamEvents.mockImplementation(
      (
        _sessionId: string,
        _onEvent: (event: PiRuntimeEvent) => void,
        onError?: (err: unknown) => void,
      ) => {
        onError?.(new Error('stream ended'))
        return () => {}
      },
    )
    vi.spyOn(service as unknown as { createPiRuntimeClient: () => unknown }, 'createPiRuntimeClient').mockReturnValue(pi)

    for await (const _e of service.streamConversation('s1', '生成一只老山羊', 'u1')) {
      // 消费全部事件
    }

    const rows = persistedAssistantRows()
    expect(
      rows.length,
      'prompt 未被接受 ⇒ pi 侧整轮不存在 ⇒ 不得落 assistant 行（否则是假记录）',
    ).toBe(0)
  })
})
