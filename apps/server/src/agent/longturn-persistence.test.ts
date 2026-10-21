/**
 * 长任务丢库 · 复现测试（multi-device consistency · Task 1，证据先行）
 *
 * ## 复现的是哪个形态（这里有一处重要的纠正）
 *
 * 原版本文件按计划/spec 的 R1 假设建模：「nginx 300s 掐断 ⇒ 消费方在 `yield` 处抛错
 * ⇒ `streamConversation` 这个 async generator 被中断 ⇒ yield 循环**之后**的
 * `finalizeTurn` 永远不可达 ⇒ 整轮不落库」。
 *
 * ⛔ **2026-10-21 生产取证推翻了这条机制假设**（详见 .superpowers/sdd ledger）：
 *
 * 1. **Node 上 `res.write` 对已销毁的 socket 只返回 false、不抛错**
 *    （探针：write#0 returned false / res.destroyed = true ⇒ 无 throw、无 uncaughtException）；
 *    忠实复刻 controller 消费形态的 Express 探针里，generator **照常跑到自然结束**
 *    （⇒「消费方抛错 ⇒ generator 提前终止」这条链在真实 Node/Express 上不成立）。
 * 2. **生产 nginx 日志里该 POST 是 `201` 正常完成**（不是 499/504）⇒ nginx 没掐它。
 * 3. **同 session 一个 438.2s 的 run 照样落了库** ⇒「>300s ⇒ 必丢」不成立。
 *
 * ⇒ 真实形态是：**Nest 侧 SSE 提前收尾**（本流在 pi 侧的 `agent_end` 到达之前就结束了），
 * 而 pi 侧那轮**继续跑完**（transcript 里 completed）⇒ 旧判据「有内容才落库」在那种情况下
 * 内容恰好为空 ⇒ **整轮在 Nest 侧零记录** ⇒「有执行、无记录」。
 *
 * 本文件按**真实形态**复现：pi 事件流在 `agent_end` 之前结束（= Nest 侧流提前收尾）。
 * 断言「这轮在 Nest 侧必须有 assistant 行」⇒ 修复前失败（0 行），修复后通过。
 *
 * ## 为什么 Task 1 与 Task 2 的测试是两份
 *
 * Task 1 = **取证**：证明「有执行、无记录」这个缺陷形态真实存在，且判据落在**实际写库值**上。
 * Task 2 = **修复契约**：把「落库判据不依赖是否见到 agent_end」钉成可回归的用例
 * （turn-settle-detached.test.ts），含「不得造假记录」的反向边界。
 */
import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { piEvent, stubPiClient, type PiClientStub } from './agent.test-utils'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

describe('长任务丢库复现 (multi-device Task 1)', () => {
  const agentMessageCreate = vi.fn()
  const agentMessageFindMany = vi.fn()
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
    agentMessageFindMany.mockResolvedValue([])
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
        agentMessage: { create: agentMessageCreate, findMany: agentMessageFindMany },
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

  /**
   * 跑一轮长任务，Nest 侧 SSE 在 `agent_end` 到达**之前**收尾（生产真实形态）。
   *
   * @param eventsBeforeEnd pi 侧在收尾前送出的事件（生产上：思考 + 工具轨迹 + 部分正文）
   * @param withBody        收尾前是否已有正文（生产上 618.6s 那一轮：有）
   */
  async function runLongTurn(
    eventsBeforeEnd: Array<ReturnType<typeof piEvent>>,
    withBody: boolean,
  ): Promise<number> {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const events = [
      piEvent('agent_start', { runId: 'run-long' }),
      ...(withBody
        ? [piEvent('message_update', { event: { type: 'text_delta', delta: '老山羊已经生成好了' } })]
        : []),
      ...eventsBeforeEnd,
    ]
    const pi: PiClientStub = stubPiClient(events)
    // Nest 侧流提前收尾：送完这些事件后连接结束（**没有** agent_end）。
    // ⚠️ 共享桩 `stubPiClient` 送完事件后既不报 end-of-stream 也不 onError
    // ⇒ `iteratePiEvents.next()` 会永远挂着 ⇒ 用例超时。真实链路上「流结束」有两条路
    // （SSE body 收尾 / onError），这里走 onError（更贴近生产：Nest 侧流提前收尾）。
    pi.streamEvents.mockImplementation(
      (
        _sessionId: string,
        onEvent: (event: PiRuntimeEvent) => void,
        onError?: (err: unknown) => void,
      ) => {
        for (const event of events) onEvent(event)
        onError?.(new Error('stream ended before agent_end'))
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

  function assistantRows(): Array<{ content: string; metadata: Record<string, unknown> | null }> {
    return agentMessageCreate.mock.calls
      .map((c) => (c[0] as { data?: Record<string, unknown> }).data)
      .filter((d) => d?.role === 'assistant')
      .map((d) => ({
        content: String(d?.content ?? ''),
        metadata: d?.metadata ? (JSON.parse(String(d.metadata)) as Record<string, unknown>) : null,
      }))
  }

  it('长任务在 Nest 侧流提前收尾后，这轮在 Nest 侧必须有 assistant 行（生产：618.6s 的 run 零落库）', async () => {
    // 生产形态：Nest 侧 SSE 提前收尾（pi 侧那轮继续跑完）。
    // 断言：用户消息已落库（证明流确实起来了）+ **助手行也必须有**（旧判据下这里是 0 行）。
    const seen = await runLongTurn([], true)

    const userCalls = agentMessageCreate.mock.calls.filter(
      (c) => (c[0] as { data?: { role?: string } })?.data?.role === 'user',
    )
    expect(userCalls.length, `控制变量失败：流未启动（已收 ${seen} 事件，用户消息应已落库）`).toBeGreaterThan(0)

    const rows = assistantRows()
    expect(
      rows.length,
      `Nest 侧流提前收尾 ⇒ 这轮在 Nest 侧必须有 assistant 行（生产实证：618.6s 的 run 在 Nest 表里 0 行 ⇒「有执行、无记录」）`,
    ).toBeGreaterThan(0)
    // 内容是**前缀快照**（本流手上的一切）⇒ 必须显式标注尾部未捕获，
    // 否则读端会把前缀当完整过程重放（比缺行更糟）。
    expect(rows[0].metadata?.truncated, '未见到 agent_end ⇒ 必须标 truncated（尾部未捕获）').toBe(true)
  })

  it('长任务在 Nest 侧流提前收尾、且本流一个字都没收到时，这轮也必须有痕迹', async () => {
    // 最恶劣形态：Nest 侧在收到任何事件前就收尾了。
    // 但 prompt 已被 pi 接受 ⇒ pi 侧那轮**确实执行了** ⇒
    // 「Nest 没看到」≠「这轮没发生」⇒ 历史里必须有可查的痕迹。
    await runLongTurn([], false)

    const rows = assistantRows()
    expect(
      rows.length,
      'Nest 侧一个字都没收到，但 prompt 已被接受 ⇒ 这轮在 pi 侧确实执行了 ⇒ 必须留痕',
    ).toBeGreaterThan(0)
    expect(rows[0].metadata?.truncated, '没见到 agent_end ⇒ 必须标 truncated').toBe(true)
  })
})
