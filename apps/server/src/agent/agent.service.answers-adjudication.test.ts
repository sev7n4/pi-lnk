/**
 * P1-A（规格 2026-11-01 §4.2）裁决单测：/answers 真丢失（runtime deduped:true 无 prior）时
 * 按 durable part 裁决的四分支 + CAS 双闸 + 注入失败回滚。
 *
 * 构造方式对齐 agent.service.turn-identity.test.ts：new AgentService(prismaMock, ...) +
 * 实例级 spy 替换 createPiRuntimeClient / resolvePiSessionLlm（不发真网络请求）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { AgentService } from './agent.service'

const agentMessageFindMany = vi.fn()
const agentMessageFindUnique = vi.fn()
const agentMessageUpdateMany = vi.fn()

function makeService(): AgentService {
  const service = new AgentService(
    {
      agentMessage: {
        findMany: agentMessageFindMany,
        findUnique: agentMessageFindUnique,
        updateMany: agentMessageUpdateMany,
      },
    } as never,
    { createFromAgent: vi.fn() } as never,
    { resolveForGeneration: vi.fn() } as never,
  )
  return service
}

function stubClient(service: AgentService, answerResult: Record<string, unknown>) {
  const lateAnswer = vi.fn().mockResolvedValue({ queued: true, entryId: 'e1' })
  const client = {
    answer: vi.fn().mockResolvedValue(answerResult),
    lateAnswer,
  }
  vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(client as never)
  // resolvePiSessionLlm 是私有装配链（providerResolver 等），测试桩化为无 llm（env 装配）
  ;(service as unknown as Record<string, unknown>)['resolvePiSessionLlm'] = vi
    .fn()
    .mockResolvedValue(undefined)
  return client
}

function waitingRow(opts: {
  callId: string
  ts: number
  timeoutMs?: number
  metadataRaw?: string
}): { id: string; metadata: string } {
  const events = [
    {
      type: 'waiting_user',
      data: {
        status: 'waiting',
        toolName: 'propose_generation',
        callId: opts.callId,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      },
      seq: 1,
      ts: opts.ts,
      messageIndex: 0,
    },
  ]
  return { id: 'msg-1', metadata: JSON.stringify({ executionEvents: events }) }
}

const ANSWERS = { propose: ['confirm'] }

/** 在 metadata JSON 串里追加一条 resolved waiting_user（模拟 append 生效后的存储态）。 */
function withResolved(metadataRaw: string, reason: string): string {
  const meta = JSON.parse(metadataRaw) as {
    executionEvents: Array<{ data: Record<string, unknown>; seq: number; ts: number; messageIndex: number }>
  }
  const last = meta.executionEvents[meta.executionEvents.length - 1]
  meta.executionEvents.push({
    type: 'waiting_user',
    data: { status: 'resolved', toolName: 'propose_generation', callId: last.data.callId, reason },
    seq: last.seq + 1,
    ts: Date.now(),
    messageIndex: 0,
  })
  return JSON.stringify(meta)
}

describe('answerPiPending P1-A 裁决（规格 2026-11-01 §4.2/§6）', () => {
  beforeEach(() => {
    // ⭐ resetAllMocks 而非 clearAllMocks：clear 不清 mockResolvedValueOnce 队列，
    // 前序用例残留的 once 会被后续用例误消费（A1 的第二个 once 让 A2 拿到新鲜 ts →
    // 过期误判未过期，实测踩中）。各用例的 stub 均为用例内新建，reset 无副作用。
    vi.resetAllMocks()
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:6060'
  })

  it('A3 正常 settle：registry hit（deduped:false）直通返回，不触发裁决查询', async () => {
    const service = makeService()
    const client = stubClient(service, { ok: true, deduped: false })
    const res = await service.answerPiPending({
      sessionId: 'canvas-1',
      threadId: 'thread-1',
      callId: 'c1',
      answers: ANSWERS,
      userId: 'u1',
    })
    expect(res).toEqual({ ok: true, deduped: false })
    expect(client.lateAnswer).not.toHaveBeenCalled()
    expect(agentMessageFindMany).not.toHaveBeenCalled()
  })

  it('幂等回执：deduped:true 带 prior（墓碑命中）→ 收口，不裁决不注入', async () => {
    const service = makeService()
    const client = stubClient(service, { ok: true, deduped: true, prior: 'answered' })
    const res = await service.answerPiPending({
      sessionId: 'canvas-1',
      threadId: 'thread-1',
      callId: 'c1',
      answers: ANSWERS,
      userId: 'u1',
    })
    expect(res).toEqual({ ok: true, deduped: true, prior: 'answered' })
    expect(client.lateAnswer).not.toHaveBeenCalled()
    expect(agentMessageFindMany).not.toHaveBeenCalled()
  })

  it('A6 脏 callId：runtime 真丢失但无 waiting part → 幂等回执不注入', async () => {
    const service = makeService()
    const client = stubClient(service, { ok: true, deduped: true })
    agentMessageFindMany.mockResolvedValue([{ id: 'msg-1', metadata: null }])
    const res = await service.answerPiPending({
      sessionId: 'canvas-1',
      threadId: 'thread-1',
      callId: 'ghost',
      answers: ANSWERS,
      userId: 'u1',
    })
    expect(res).toEqual({ ok: true, deduped: true })
    expect(client.lateAnswer).not.toHaveBeenCalled()
    expect(agentMessageUpdateMany).not.toHaveBeenCalled()
  })

  it('A1 重启恢复：真丢失 + waiting part 未过期 → CAS 翻 answered + late 注入', async () => {
    const service = makeService()
    const client = stubClient(service, { ok: true, deduped: true })
    agentMessageFindMany
      .mockResolvedValueOnce([waitingRow({ callId: 'c1', ts: Date.now() - 1000, timeoutMs: 780_000 })])
      .mockResolvedValueOnce([waitingRow({ callId: 'c1', ts: Date.now() - 1000, timeoutMs: 780_000 })])
    agentMessageFindUnique.mockResolvedValue(waitingRow({ callId: 'c1', ts: Date.now() - 1000, timeoutMs: 780_000 }))
    agentMessageUpdateMany.mockResolvedValue({ count: 1 })
    const res = await service.answerPiPending({
      sessionId: 'canvas-1',
      threadId: 'thread-1',
      callId: 'c1',
      answers: ANSWERS,
      userId: 'u1',
    })
    expect(res).toEqual({ ok: true, deduped: false, late: true })
    expect(client.lateAnswer).toHaveBeenCalledTimes(1)
    const arg = client.lateAnswer.mock.calls[0][1] as Record<string, unknown>
    expect(arg.callId).toBe('c1')
    expect(arg.kind).toBe('answer')
    expect(arg.userId).toBe('u1')
    // CAS 翻终态：append 的 resolved 条目 reason=answered（#654 映射 → 前端 confirmed）
    const casArg = agentMessageUpdateMany.mock.calls[0][0] as {
      data: { metadata: string }
    }
    const next = JSON.parse(casArg.data.metadata) as {
      executionEvents: Array<{ data: { status?: string; reason?: string } }>
    }
    const resolved = next.executionEvents.filter((e) => e.data?.status === 'resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0].data.reason).toBe('answered')
  })

  it('A2 过期显式化：超过 deadline → part 翻 timeout，不注入，返回 expired', async () => {
    const service = makeService()
    const client = stubClient(service, { ok: true, deduped: true })
    const oldTs = Date.now() - 800_000
    agentMessageFindMany.mockResolvedValue([waitingRow({ callId: 'c1', ts: oldTs, timeoutMs: 780_000 })])
    agentMessageFindUnique.mockResolvedValue(waitingRow({ callId: 'c1', ts: oldTs, timeoutMs: 780_000 }))
    agentMessageUpdateMany.mockResolvedValue({ count: 1 })
    const res = await service.answerPiPending({
      sessionId: 'canvas-1',
      threadId: 'thread-1',
      callId: 'c1',
      answers: ANSWERS,
      userId: 'u1',
    })
    expect(res).toEqual({ ok: true, deduped: false, expired: true })
    expect(client.lateAnswer).not.toHaveBeenCalled()
  })

  it('§8-2 双闸：CAS 输掉（count:0，并发裁决方先到）→ 幂等回执，不注入', async () => {
    const service = makeService()
    const client = stubClient(service, { ok: true, deduped: true })
    agentMessageFindMany.mockResolvedValue([waitingRow({ callId: 'c1', ts: Date.now() - 1000, timeoutMs: 780_000 })])
    agentMessageFindUnique.mockResolvedValue(waitingRow({ callId: 'c1', ts: Date.now() - 1000, timeoutMs: 780_000 }))
    agentMessageUpdateMany.mockResolvedValue({ count: 0 })
    const res = await service.answerPiPending({
      sessionId: 'canvas-1',
      threadId: 'thread-1',
      callId: 'c1',
      answers: ANSWERS,
      userId: 'u1',
    })
    expect(res).toEqual({ ok: true, deduped: true, prior: 'answered' })
    expect(client.lateAnswer).not.toHaveBeenCalled()
  })

  it('§8-3 注入失败：回滚 CAS（part 保持 waiting）并抛 503 可重试', async () => {
    const service = makeService()
    const client = stubClient(service, { ok: true, deduped: true })
    ;(client.lateAnswer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('HTTP 503'))
    const baseRow = waitingRow({ callId: 'c1', ts: Date.now() - 1000, timeoutMs: 780_000 })
    // append 的 findUnique 返回 waiting-only 行；回滚的 findUnique 返回**已追加 resolved** 的行
    // （模拟 append 真实生效后的存储态）——否则回滚读不到 resolved 条目会提前视为「已还原」。
    agentMessageFindUnique
      .mockResolvedValueOnce(baseRow)
      .mockResolvedValueOnce({ ...baseRow, metadata: withResolved(baseRow.metadata, 'answered') })
    agentMessageFindMany.mockResolvedValue([baseRow])
    agentMessageUpdateMany.mockResolvedValue({ count: 1 })
    await expect(
      service.answerPiPending({
        sessionId: 'canvas-1',
        threadId: 'thread-1',
        callId: 'c1',
        answers: ANSWERS,
        userId: 'u1',
      }),
    ).rejects.toMatchObject({ status: 503 })
    // updateMany 两次：append + rollback（还原旧 metadata 串）
    expect(agentMessageUpdateMany).toHaveBeenCalledTimes(2)
    const rollbackArg = agentMessageUpdateMany.mock.calls[1][0] as {
      where: { metadata?: string }
      data: { metadata: string }
    }
    const rolledBack = JSON.parse(rollbackArg.data.metadata) as {
      executionEvents: Array<{ data: { status?: string } }>
    }
    expect(rolledBack.executionEvents.filter((e) => e.data?.status === 'resolved')).toHaveLength(0)
  })

  it('late decline：part 翻 aborted（reason 映射 declined），注入 kind=decline 不带 answers', async () => {
    const service = makeService()
    const client = stubClient(service, { ok: true, deduped: true })
    agentMessageFindMany.mockResolvedValue([waitingRow({ callId: 'c1', ts: Date.now() - 1000, timeoutMs: 780_000 })])
    agentMessageFindUnique.mockResolvedValue(waitingRow({ callId: 'c1', ts: Date.now() - 1000, timeoutMs: 780_000 }))
    agentMessageUpdateMany.mockResolvedValue({ count: 1 })
    const res = await service.answerPiPending({
      sessionId: 'canvas-1',
      threadId: 'thread-1',
      callId: 'c1',
      answers: {},
      decision: 'decline',
      userId: 'u1',
    })
    expect(res).toEqual({ ok: true, deduped: false, late: true })
    const arg = client.lateAnswer.mock.calls[0][1] as Record<string, unknown>
    expect(arg.kind).toBe('decline')
    expect(arg.answers).toBeUndefined()
    const casArg = agentMessageUpdateMany.mock.calls[0][0] as { data: { metadata: string } }
    const next = JSON.parse(casArg.data.metadata) as {
      executionEvents: Array<{ data: { reason?: string } }>
    }
    expect(next.executionEvents.some((e) => e.data?.reason === 'aborted')).toBe(true)
  })
})
