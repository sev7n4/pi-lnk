/**
 * P1c 清债（账本投影 + metadata 双写消除）行为级测试。
 * spec: docs/superpowers/plans/2026-11-11-sse-p1c-ledger-projection-metadata-shrink.md §3
 *
 * T1 写面分流（metadata 只留 waiting_user/turn_settled/合成事件；text/tool 全量只在账本）
 * T3 turn_settled 权威（计费收束路径：账本写失败回合，metadata 仍含 turn_settled）
 * T4 eventCount 修正（分流后 partial 判据用 traceSeq 总计数，不冒充全量）
 * T5 enrichment 投影（eventsShrunk 行按 runId 合并账本投影注入响应副本）
 * T6 enrichment 阴性（旧行/runId NULL/账本空/坏 metadata/读失败 直通不改键）
 * T7 归并（mergeShrunkEvents / ledgerRowToPersistedEvent / buildTurnMetadata 纯函数面）
 * T8 messageIndex 落账（message_end 分段后事件带段序）
 */
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService, buildTurnMetadata, ledgerRowToPersistedEvent, mergeShrunkEvents } from './agent.service'
import { stubPiClient } from './agent.test-utils'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'
import type { PersistedExecutionEvent } from '@lnkpi/shared'

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

function buildService(points?: unknown, pricing?: unknown, eventBus?: unknown): AgentService {
  const args: unknown[] = [
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
    },
    { createFromAgent: vi.fn() },
    { resolveForGeneration: vi.fn().mockRejectedValue(new Error('channel not found')) },
    undefined, // canvasTools
    undefined, // canvasActionApplier
    undefined, // agentMemory
    points, // PointsService（@Optional 第 7 位）
    pricing, // PricingService（第 8 位）
    undefined, // turnState
    undefined, // moduleRef
    undefined, // generationReaper
    eventBus, // SessionEventBus（第 12 位）
  ]
  return new AgentService(...(args as unknown as [any]))
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

/** finalizeTurn 落库的 assistant 行 metadata（字符串）解析。 */
function createdMetadata(): Record<string, unknown> {
  const call = agentMessageCreate.mock.calls.find((c) =>
    (c[0] as { data?: { role?: string } }).data?.role === 'assistant',
  )
  expect(call, 'finalizeTurn 必须落 assistant 行').toBeDefined()
  const raw = (call![0] as { data: { metadata: string | null } }).data.metadata
  expect(raw, '分流行必带 metadata').not.toBeNull()
  return JSON.parse(raw as string) as Record<string, unknown>
}

const textDelta = (seq: number, runId: string, delta: string): PiRuntimeEvent =>
  ({
    type: 'message_update',
    seq,
    runId,
    ts: 1,
    data: { assistantMessageEvent: { type: 'text_delta', delta } },
  }) as PiRuntimeEvent

const toolStart = (seq: number, runId: string): PiRuntimeEvent =>
  ({
    type: 'tool_execution_start',
    seq,
    runId,
    ts: 1_700_000_000_000,
    data: { toolCallId: 'c1', toolName: 'gen_image', args: { prompt: 'x' } },
  }) as PiRuntimeEvent

const stubEventBus = () => ({
  subscribeSession: vi.fn(() => () => {}),
  subscribeUser: vi.fn(() => () => {}),
  subscribeSessionTurnSettled: vi.fn(() => () => {}),
  subscribeSessionTurnAck: vi.fn(() => () => {}),
  subscribeSessionTurnNotSubmitted: vi.fn(() => () => {}),
  emitCreditTx: vi.fn(),
  emitTurnSettled: vi.fn(),
  emitTurnAck: vi.fn(),
  emitTurnNotSubmitted: vi.fn(),
})

describe('P1c 清债 · 写面分流（T1/T3/T4/T8）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    setEnv()
    delete process.env.TEXT_TOKEN_BILLING
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
  })

  it('T1: 分流 —— metadata 不再携带 text/tool 大事件；全量只在账本；标记与键纪律正确', async () => {
    const service = buildService()
    const pi = stubPiClient([
      textDelta(20, 'run-T1', '你'),
      textDelta(21, 'run-T1', '好'),
      toolStart(22, 'run-T1'),
      { type: 'agent_end', seq: 23, runId: 'run-T1', ts: 1, data: { status: 'completed' } } as PiRuntimeEvent,
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    await drain(service.streamConversation('s1', 'hi', 'u1'))

    const meta = createdMetadata()
    // ① 分流标记：分流发生必带（键不出现纪律的对偶面）
    expect(meta.eventsShrunk).toBe(true)
    // ② metadata.executionEvents 只含保留集（waiting_user/turn_settled/无 gSeq 合成）；
    //    本回合无计费（billing off）⇒ 无 turn_settled，保留集为空数组或缺席皆合法
    const kept = (meta.executionEvents ?? []) as PersistedExecutionEvent[]
    for (const ev of kept) {
      expect(
        ev.type === 'waiting_user' || ev.type === 'turn_settled' || typeof ev.gSeq !== 'number',
        `保留集外事件 ${ev.type} 不应再进 metadata`,
      ).toBe(true)
    }
    expect(kept.map((e) => e.type)).not.toContain('text')
    expect(kept.map((e) => e.type)).not.toContain('tool_call')
    // ③ 账本全量：text + tool_call 均在
    const ledgerTypes = agentEventUpsert.mock.calls.map(
      (c) => (c[0] as { create: { type: string } }).create.type,
    )
    expect(ledgerTypes).toContain('text')
    expect(ledgerTypes).toContain('tool_call')
    // ④ 债消除实证：metadata 不再携带 text/tool 大 data（生产债主体 530KB/行）
    expect(JSON.stringify(meta).length).toBeLessThan(2000)
  })

  it('T3: turn_settled 权威 —— 计费收束路径 metadata 仍含 turn_settled；账本写失败不回退', async () => {
    process.env.TEXT_TOKEN_BILLING = 'on'
    agentEventUpsert.mockRejectedValue(new Error('ledger down')) // 账本全挂
    const service = buildService(
      {
        freeze: vi.fn().mockResolvedValue({ id: 'hold-1', amount: 4 }),
        settleFromHold: vi.fn().mockResolvedValue({ settled: 3, released: 0 }),
        release: vi.fn(),
      },
      { quoteTextTokens: vi.fn().mockResolvedValue({ credits: 3, ruleVersion: 'price-v2', breakdown: { in: 2, cache: 0, out: 1 } }) },
      stubEventBus(),
    )
    const pi = stubPiClient([
      textDelta(20, 'run-T3', '你好'),
      toolStart(22, 'run-T3'),
      { type: 'agent_end', seq: 23, runId: 'run-T3', ts: 1, data: { status: 'completed' } } as PiRuntimeEvent,
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    const events = await drain(service.streamConversation('s1', 'hi', 'u1', 's1:thread-a'))

    expect(events.some((e) => (e as { type?: string }).type === 'turn_settled')).toBe(true)
    const meta = createdMetadata()
    // turn_settled 经 awaited finalizeTurn 落 metadata（计费块在 finalize 前推），
    // 账本 fire-and-forget 失败窗口不影响前端已结算探测语义
    expect(((meta.executionEvents ?? []) as PersistedExecutionEvent[]).some((e) => e.type === 'turn_settled')).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    delete process.env.TEXT_TOKEN_BILLING
  })

  it('T4: eventCount 修正 —— 半路接入且只见保留集外事件，partial 不误判 complete', async () => {
    // 半路接入：无 agent_start（sawRunStart=false）、无 agent_end（sawTerminalEvent=false
    // ⇒ D2 留痕路径落库），事件只有 tool_call（分流后不进数组）。
    // 旧判据 eventCount=executionEvents.length=0 会误判 complete；R8 修复用 traceSeq=1。
    // 收束走 onError（longturn-persistence 范式：stub 送完事件不报 end ⇒ next() 永挂）。
    const service = buildService()
    const events = [toolStart(41, 'run-T4')]
    const pi = stubPiClient(events)
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
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    await drain(service.streamConversation('s1', 'hi', 'u1'))
    await new Promise((r) => setTimeout(r, 20)) // detached finalizeTurn fire-and-forget 落库

    const meta = createdMetadata()
    expect(meta.partial).toBe(true)
    expect(meta.gapFrom).toBe(41)
  })

  it('T8: messageIndex 落账 —— message_end 分段后的事件带段序', async () => {
    const service = buildService()
    const pi = stubPiClient([
      textDelta(50, 'run-T8', '第一段'),
      { type: 'message_end', seq: 51, runId: 'run-T8', ts: 1, data: { role: 'assistant' } } as PiRuntimeEvent,
      toolStart(52, 'run-T8'),
      { type: 'agent_end', seq: 53, runId: 'run-T8', ts: 1, data: { status: 'completed' } } as PiRuntimeEvent,
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    await drain(service.streamConversation('s1', 'hi', 'u1'))

    const byType = new Map<string, number>()
    for (const c of agentEventUpsert.mock.calls) {
      const create = (c[0] as { create: { type: string; messageIndex: number; sSeq: number } }).create
      byType.set(`${create.type}@${create.sSeq}`, create.messageIndex)
    }
    // message_end 前的 text 归段 0；其后 tool_call 归段 1
    expect(byType.get('text@1')).toBe(0)
    expect(byType.get('tool_call@2')).toBe(1)
  })
})

describe('P1c 清债 · 读时 enrichment（T5/T6）', () => {
  let service: AgentService

  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL
    agentThreadFindUnique.mockResolvedValue({ session: { userId: 'u1' } })
    agentEventAggregate.mockResolvedValue({ _max: { gSeq: null } })
    idempotencyRecordFindMany.mockResolvedValue([])
    service = buildService()
  })

  const ledgerRow = (over: Partial<{ gSeq: number; sSeq: number; type: string; data: string; messageIndex: number }> = {}) => ({
    runId: 'r1',
    gSeq: 11,
    sSeq: 1,
    type: 'tool_call',
    ts: new Date(1_700_000_000_000),
    messageIndex: 0,
    data: JSON.stringify({ toolCallId: 'c1', toolName: 'gen_image' }),
    ...over,
  })

  it('T5: eventsShrunk 行按 runId 合并账本投影注入响应副本', async () => {
    const shrinkMeta = JSON.stringify({
      eventsShrunk: true,
      executionEvents: [
        { type: 'turn_settled', data: { credits: 1 }, seq: 3, gSeq: 13, ts: 1700000000200, messageIndex: 0 },
      ],
    })
    agentMessageFindMany.mockResolvedValue([
      {
        id: 'm2',
        role: 'assistant',
        runId: 'r1',
        metadata: shrinkMeta,
        createdAt: new Date(2),
      },
      { id: 'm1', role: 'user', runId: null, metadata: null, createdAt: new Date(1) },
    ])
    agentEventFindMany.mockResolvedValue([
      ledgerRow({ gSeq: 11, sSeq: 1, type: 'tool_call' }),
      ledgerRow({ gSeq: 12, sSeq: 2, type: 'text', data: JSON.stringify({ text: '你好' }) }),
      // 与保留集同帧去重锚：turn_settled 账本行（同 gSeq+sSeq）——归并不得双份
      ledgerRow({ gSeq: 13, sSeq: 3, type: 'turn_settled', data: JSON.stringify({ credits: 1 }) }),
    ])

    const r = await service.getMessages('s1', 't1')
    // 账本查询：threadId + runId in 窗口
    const where = (agentEventFindMany.mock.calls[0]![0] as { where: { threadId: string; runId: { in: string[] } } }).where
    expect(where.threadId).toBe('t1')
    expect(where.runId.in).toEqual(['r1'])

    const assistant = r.page.find((m) => m.role === 'assistant')!
    const meta = JSON.parse(assistant.metadata as string) as { executionEvents: PersistedExecutionEvent[] }
    // 归并结果：seq 升序 + turn_settled 只一份（去重）+ data JSON 还原
    expect(meta.executionEvents.map((e) => e.seq)).toEqual([1, 2, 3])
    const types = meta.executionEvents.map((e) => e.type)
    expect(types).toEqual(['tool_call', 'text', 'turn_settled'])
    expect(meta.executionEvents.find((e) => e.type === 'text')!.data).toEqual({ text: '你好' })
    expect(meta.executionEvents.find((e) => e.type === 'text')!.gSeq).toBe(12)
    expect(meta.executionEvents.filter((e) => e.type === 'turn_settled')).toHaveLength(1)
    // user 行不动
    const user = r.page.find((m) => m.role === 'user')!
    expect(user.metadata).toBeNull()
  })

  it('T6-阴: 旧行（无标记）直通不改键；账本空不注入', async () => {
    const legacyMeta = JSON.stringify({
      executionEvents: [{ type: 'text', data: { text: '旧' }, seq: 1, gSeq: 1 }],
    })
    agentMessageFindMany.mockResolvedValue([
      { id: 'm1', role: 'assistant', runId: 'r-old', metadata: legacyMeta, createdAt: new Date(1) },
    ])
    agentEventFindMany.mockResolvedValue([]) // 账本空（早于账本时代）
    const r1 = await service.getMessages('s1', 't1')
    expect((r1.page[0] as { metadata: string }).metadata).toBe(legacyMeta)

    // 账本有行但目标行是旧行 ⇒ 直通（查询仍发生，注入被标记门挡住）
    agentEventFindMany.mockResolvedValue([ledgerRow({})])
    const r2 = await service.getMessages('s1', 't1')
    expect((r2.page[0] as { metadata: string }).metadata).toBe(legacyMeta)
  })

  it('T6-阴: 账本读失败 fail-open —— 响应回退 DB 原样', async () => {
    agentMessageFindMany.mockResolvedValue([
      { id: 'm1', role: 'assistant', runId: 'r1', metadata: JSON.stringify({ eventsShrunk: true }), createdAt: new Date(1) },
    ])
    agentEventFindMany.mockRejectedValue(new Error('ledger down'))
    const r = await service.getMessages('s1', 't1')
    expect(JSON.parse((r.page[0] as { metadata: string }).metadata)).toEqual({ eventsShrunk: true })
  })
})

describe('P1c 清债 · 纯函数（T7）', () => {
  it('ledgerRowToPersistedEvent: data JSON 还原 + sSeq→seq + ts→epoch ms；坏 JSON 不炸', () => {
    const ev = ledgerRowToPersistedEvent({
      runId: 'r',
      gSeq: 7,
      sSeq: 2,
      type: 'text',
      data: JSON.stringify({ text: 'hi' }),
      ts: new Date(1_700_000_000_000),
      messageIndex: 1,
    })
    expect(ev).toEqual({ type: 'text', data: { text: 'hi' }, seq: 2, gSeq: 7, ts: 1_700_000_000_000, messageIndex: 1 })
    const bad = ledgerRowToPersistedEvent({
      runId: 'r',
      gSeq: 7,
      sSeq: 2,
      type: 'text',
      data: 'not-json{',
      ts: new Date(0),
      messageIndex: 0,
    })
    expect(bad.data).toBeNull()
  })

  it('mergeShrunkEvents: (gSeq,sSeq) 去重先到者留 + seq 升序', () => {
    const left: PersistedExecutionEvent[] = [
      { type: 'turn_settled', data: {}, seq: 3, gSeq: 13, messageIndex: 0 },
      { type: 'syn', data: {}, seq: 4 }, // 无 gSeq 合成事件
    ]
    const projected: PersistedExecutionEvent[] = [
      { type: 'tool_call', data: {}, seq: 1, gSeq: 11, messageIndex: 0 },
      { type: 'turn_settled', data: {}, seq: 3, gSeq: 13, messageIndex: 0 }, // 重复
      { type: 'text', data: {}, seq: 2, gSeq: 12, messageIndex: 0 },
    ]
    const merged = mergeShrunkEvents(left, projected)
    expect(merged.map((e) => [e.type, e.seq])).toEqual([
      ['tool_call', 1],
      ['text', 2],
      ['turn_settled', 3],
      ['syn', 4],
    ])
  })

  it('buildTurnMetadata: eventsShrunk 键出现纪律（未分流不写）', () => {
    const withFlag = buildTurnMetadata({ executionEvents: [{ type: 'turn_settled', data: {} }], eventsShrunk: true })
    expect(withFlag?.eventsShrunk).toBe(true)
    const without = buildTurnMetadata({ executionEvents: [{ type: 'turn_settled', data: {} }] })
    expect('eventsShrunk' in (without ?? {})).toBe(false)
  })
})
