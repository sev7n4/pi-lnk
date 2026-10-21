/**
 * 长任务断连丢库 · 复现测试（multi-device consistency · Task 1，证据先行）
 *
 * 背景（取证详见 `docs/superpowers/specs/2026-10-21-multi-device-consistency-evidence.md`）：
 * 生产样本 `cmvgfa46b000npi01znkg9dos` 第一个 run 跑了 618.6s（completed），但 Nest 表
 * 零助手消息。强相关根因假设 = nginx `proxy_read_timeout 300s` 掐断 SSE 连接 ⇒
 * 消费方在 `yield` 处抛错 ⇒ `streamConversation` 这个 async generator 被中断 ⇒
 * 位于 yield 循环**之后**的 `finalizeTurn`（agent.service.ts:2097）永远不可达 ⇒ 整轮不落库。
 *
 * 本测试**时间压缩**复现：不真等 400s，而是让消费方在收到第 1 个事件后模拟「连接被掐断」
 * （抛错）。若根因假设成立，generator 会在 yield 处中断、跳过 finalizeTurn，
 * 断言「助手消息应落库」应失败 ⇒ `it.fails` 通过（= 复现成功）。
 *
 * ⚠️ 这是 `it.fails`：用例「失败时通过」。Task 2（落库与请求生命周期解耦）修复后，
 * 把本文件的 `it.fails(` 改为 `it(` 即可让其变绿——届时 PR 正文附「红→绿」证据。
 *
 * 控制变量：断言用户消息已落库（line 428，早于 yield 循环），证明流已启动、断连发生在
 * 进行中，而非「流根本没起来」导致的 0 落库。
 */
import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { piEvent, stubPiClient } from './agent.test-utils'

describe('长任务断连丢库复现 (multi-device Task 1)', () => {
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
   * 跑一轮对话，消费方在收到第 `disconnectAfter` 个事件后抛错，模拟 nginx 300s 掐断。
   * 返回时在 `agentMessageCreate` 上已留下调用痕迹，供断言使用。
   */
  async function runTurnWithDisconnect(disconnectAfter: number) {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    // 带 message_delta(text) ⇒ 正常收尾时 assistantText 非空 ⇒ finalizeTurn 会落库助手。
    const events = [
      piEvent('agent_start', { runId: 'run-1' }),
      piEvent('message_start', {}),
      piEvent('message_delta', { text: '老山羊已经生成好了' }),
      piEvent('message_end', {}),
      piEvent('agent_end', { status: 'completed' }),
    ]
    const pi = stubPiClient(events)
    vi.spyOn(service as unknown as { createPiRuntimeClient: () => unknown }, 'createPiRuntimeClient').mockReturnValue(pi)

    let seen = 0
    try {
      for await (const _e of service.streamConversation('s1', '生成一只老山羊', 'u1')) {
        seen++
        if (seen >= disconnectAfter) {
          // 模拟 nginx proxy_read_timeout 300s 掐断：响应 write 抛错，连接消失。
          throw new Error('write ECONNRESET (simulated nginx 300s kill)')
        }
      }
    } catch {
      // 消费方断连是预期内（模拟外部连接消失）；忽略，继续断言落库结果。
    }
    return seen
  }

  it.fails('连接中途断开后，owner 流仍应落库助手消息（当前：红 = 复现成功）', async () => {
    const seen = await runTurnWithDisconnect(1)

    // 控制变量：用户消息必须已落库（证明流已启动、断连发生在进行中，而非流未起来）。
    const userCalls = agentMessageCreate.mock.calls.filter(
      (c) => (c[0] as { data?: { role?: string } })?.data?.role === 'user',
    )
    expect(userCalls.length, `控制变量失败：流未启动（已收到 ${seen} 个事件，用户消息应已落库）`).toBeGreaterThan(0)

    // 真值判据：断连后 finalizeTurn 仍应执行 ⇒ 助手消息必须落库。
    // 当前（bug 在）generator 在 yield 处中断、跳过 finalizeTurn ⇒ 此断言失败 ⇒ it.fails 通过。
    const assistantCalls = agentMessageCreate.mock.calls.filter(
      (c) => (c[0] as { data?: { role?: string } })?.data?.role === 'assistant',
    )
    expect(
      assistantCalls.length,
      `断连后 owner 流必须仍落库助手消息（重现生产样本 618.6s 轮零落库；已收 ${seen} 事件）`,
    ).toBeGreaterThan(0)
  })
})
