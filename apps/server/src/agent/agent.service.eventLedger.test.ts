/**
 * P1a PR-B（事件一等化）行为级测试：AgentEvent 账本双写 + 双只读 API。
 * spec: docs/superpowers/plans/2026-11-11-sse-event-firstclass-p1a.md §2.2/§2.3
 *
 * S2 双写（派生即 append，gSeq/sSeq/type/data 正确）
 * S3 不半条（text_delta 段折叠，flush 边界落完整 text 事件）
 * S5 state API（双源裁决映射 + lastGSeq）
 * S4 events API（since 游标 / nextCursor / 超尾空数组 / limit 钳制）
 * S6 属主校验（非本人会话 403，且不区分 404）
 * S7 fail-open（账本写失败不阻断主链路）
 */
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenException } from '@nestjs/common'
import { AgentService } from './agent.service'
import { stubPiClient } from './agent.test-utils'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

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
const idempotencyRecordFindMany = vi.fn()
const agentEventUpsert = vi.fn()
const agentEventFindMany = vi.fn()
const agentEventAggregate = vi.fn()

function buildService(): AgentService {
  return new AgentService(
    {
      agentMessage: { create: agentMessageCreate, findMany: agentMessageFindMany, aggregate: vi.fn().mockResolvedValue({ _max: { seq: null } }) },
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
        findMany: idempotencyRecordFindMany,
      },
      agentEvent: {
        upsert: agentEventUpsert,
        findMany: agentEventFindMany,
        aggregate: agentEventAggregate,
      },
      userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
    } as never,
    { createFromAgent: vi.fn() } as never,
    { resolveForGeneration: vi.fn().mockRejectedValue(new Error('channel not found')) } as never,
  )
}

function setEnv(): void {
  process.env.PI_RUNTIME_MODE = 'active'
  process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
}

async function drain(stream: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const e of stream) out.push(e)
  return out
}

describe('P1a PR-B · AgentEvent 账本双写（S2/S3/S7）', () => {
  let service: AgentService

  beforeEach(() => {
    vi.restoreAllMocks()
    setEnv()
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
    idempotencyRecordFindMany.mockResolvedValue([])
    agentEventUpsert.mockResolvedValue({})
    agentEventFindMany.mockResolvedValue([])
    agentEventAggregate.mockResolvedValue({ _max: { gSeq: null } })
    service = buildService()
  })

  const toolStart = (seq: number, runId: string): PiRuntimeEvent =>
    ({
      type: 'tool_execution_start',
      seq,
      runId,
      ts: 1_700_000_000_000,
      data: { toolCallId: 'c1', toolName: 'gen_image', args: { prompt: 'x' } },
    }) as PiRuntimeEvent

  it('S2: 结构事件派生即 append —— (threadId, gSeq, sSeq, type, data) 与 SSE 帧同构', async () => {
    const pi = stubPiClient([
      toolStart(11, 'run-A'),
      { type: 'agent_end', seq: 12, runId: 'run-A', ts: 1, data: { status: 'completed' } } as PiRuntimeEvent,
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    await drain(service.streamConversation('s1', '画一张图', 'u1'))

    expect(agentEventUpsert).toHaveBeenCalledTimes(1)
    const call = agentEventUpsert.mock.calls[0]![0] as {
      where: { threadId_gSeq_sSeq: { threadId: string; gSeq: number; sSeq: number } }
      create: { threadId: string; gSeq: number; sSeq: number; type: string; runId: string; data: string; ts: Date }
    }
    // threadId 落点：streamConversation 未传 threadId ⇒ effectiveThreadId = sessionId
    expect(call.where.threadId_gSeq_sSeq).toEqual({ threadId: 's1', gSeq: 11, sSeq: 1 })
    expect(call.create.type).toBe('tool_call')
    expect(call.create.gSeq).toBe(11)
    expect(call.create.sSeq).toBe(1)
    expect(call.create.runId).toBe('run-A')
    expect(JSON.parse(call.create.data)).toEqual({
      toolCallId: 'c1',
      name: 'gen_image',
      toolName: 'gen_image',
      args: { prompt: 'x' },
    })
    expect(call.create.ts).toBeInstanceOf(Date)
  })

  it('S2-阴: 合成事件（无 pi seq）与白名单外事件不落账本', async () => {
    // agent_end → 'done'（不在 tool_call/tool_result/node_status/waiting_user 白名单）；
    // 末尾 turn_settled 为合成事件（无 currentPiEvent ⇒ 无 gSeq）——两者都不落账本。
    const pi = stubPiClient([
      { type: 'agent_end', seq: 13, runId: 'run-B', ts: 1, data: { status: 'completed' } } as PiRuntimeEvent,
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    const events = await drain(service.streamConversation('s1', 'hi', 'u1'))

    expect(agentEventUpsert).not.toHaveBeenCalled()
    // 主链路不受影响：done 照常产出
    expect(events.some((e) => (e as { type?: string }).type === 'done')).toBe(true)
  })

  it('S3: text_delta 段折叠 —— 只在 flush 边界落完整 text 事件，不逐 delta 半条', async () => {
    const mkDelta = (seq: number, delta: string): PiRuntimeEvent =>
      ({
        type: 'message_update',
        seq,
        runId: 'run-C',
        ts: 1,
        data: { assistantMessageEvent: { type: 'text_delta', delta } },
      }) as PiRuntimeEvent
    const pi = stubPiClient([
      mkDelta(20, '你'),
      mkDelta(21, '好'),
      mkDelta(22, '世界'),
      toolStart(23, 'run-C'),
      { type: 'agent_end', seq: 24, runId: 'run-C', ts: 1, data: { status: 'completed' } } as PiRuntimeEvent,
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    await drain(service.streamConversation('s1', 'hi', 'u1'))

    // 3 个 delta 只落 1 条完整 text（工具起手边界 flush）+ 1 条 tool_call = 2 条 upsert
    expect(agentEventUpsert).toHaveBeenCalledTimes(2)
    const first = agentEventUpsert.mock.calls[0]![0] as { create: { type: string; data: string; gSeq: number } }
    expect(first.create.type).toBe('text')
    expect(JSON.parse(first.create.data)).toEqual({ text: '你好世界' })
    // text 事件 gSeq 取 flush 时当前 pi 事件（第一个非文本边界事件前一帧的 seq 语义）——
    // 关键不变式：text 行的 sSeq < tool_call 行的 sSeq（时序保持）
    const second = agentEventUpsert.mock.calls[1]![0] as { create: { type: string; sSeq: number } }
    expect(second.create.type).toBe('tool_call')
    expect((agentEventUpsert.mock.calls[0]![0] as { create: { sSeq: number } }).create.sSeq).toBe(1)
    expect(second.create.sSeq).toBe(2)
  })

  it('S7: 账本写失败 fail-open —— 主链路完整收束，不抛错', async () => {
    agentEventUpsert.mockRejectedValue(new Error('ledger down'))
    const pi = stubPiClient([
      toolStart(11, 'run-D'),
      { type: 'agent_end', seq: 12, runId: 'run-D', ts: 1, data: { status: 'completed' } } as PiRuntimeEvent,
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    const events = await drain(service.streamConversation('s1', 'hi', 'u1'))

    expect(agentEventUpsert).toHaveBeenCalledTimes(1)
    expect(events.some((e) => (e as { type?: string }).type === 'done')).toBe(true)
    // unhandled rejection 守护：upsert 的 rejected promise 必须被 .catch 消费
    await new Promise((r) => setTimeout(r, 20))
    expect(vi.isMockFunction(agentEventUpsert)).toBe(true)
  })
})

describe('P1a PR-B · 双只读 API（S4/S5/S6）', () => {
  let service: AgentService

  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL
    agentThreadFindUnique.mockResolvedValue({ session: { userId: 'u1' } })
    agentEventFindMany.mockResolvedValue([])
    agentEventAggregate.mockResolvedValue({ _max: { gSeq: null } })
    idempotencyRecordFindMany.mockResolvedValue([])
    service = buildService()
  })

  it('S5: state —— processing ⇒ in_progress + lastGSeq 取账本 max', async () => {
    idempotencyRecordFindMany.mockResolvedValue([{ status: 'processing' }])
    agentEventAggregate.mockResolvedValue({ _max: { gSeq: 42 } })
    const s = await service.getThreadResumeState('t1', 'u1')
    expect(s.status).toBe('in_progress')
    expect(s.lastGSeq).toBe(42)
    expect(s.pendingInterruption).toBeNull()
  })

  it('S5: state —— 无 processing 证据 ⇒ complete（settled/missing 同映射）', async () => {
    idempotencyRecordFindMany.mockResolvedValue([{ status: 'completed', createdAt: new Date() }])
    const s = await service.getThreadResumeState('t1', 'u1')
    expect(s.status).toBe('complete')
  })

  it('S4: events —— 升序映射 + nextCursor=末条 gSeq', async () => {
    agentEventFindMany.mockResolvedValue([
      { gSeq: 11, sSeq: 1, runId: 'r', type: 'tool_call', ts: new Date(0), data: '{"a":1}' },
      { gSeq: 11, sSeq: 2, runId: null, type: 'tool_result', ts: new Date(0), data: '{"b":2}' },
    ])
    const r = await service.getThreadEvents('t1', 'u1', 10, 500)
    expect(r.events.map((e) => [e.gSeq, e.sSeq])).toEqual([
      [11, 1],
      [11, 2],
    ])
    expect(r.events[0]!.data).toEqual({ a: 1 })
    expect(r.events[1]!.runId).toBeNull()
    expect(r.nextCursor).toBe(11)
    // where 游标：严格大于 since
    expect((agentEventFindMany.mock.calls[0]![0] as { where: { gSeq: { gt: number } } }).where.gSeq.gt).toBe(10)
  })

  it('S4: events —— 超尾空数组非 404，nextCursor 原样回传', async () => {
    const r = await service.getThreadEvents('t1', 'u1', 99, 500)
    expect(r.events).toEqual([])
    expect(r.nextCursor).toBe(99)
  })

  it('S4: events —— limit 钳制 [1, 500]', async () => {
    await service.getThreadEvents('t1', 'u1', 0, 9999)
    expect((agentEventFindMany.mock.calls[0]![0] as { take: number }).take).toBe(500)
  })

  it('S6: 属主校验 —— 非本人会话 403；线程不存在同样 403（不泄露存在性）', async () => {
    agentThreadFindUnique.mockResolvedValue({ session: { userId: 'someone-else' } })
    await expect(service.getThreadEvents('t1', 'u1', 0, 100)).rejects.toBeInstanceOf(ForbiddenException)
    agentThreadFindUnique.mockResolvedValue(null)
    await expect(service.getThreadResumeState('t1', 'u1')).rejects.toBeInstanceOf(ForbiddenException)
  })
})
