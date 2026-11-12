/**
 * P2 待确认门 durable（AgentService 接线层行为级测试）。
 * spec: docs/superpowers/plans/2026-11-11-sse-p2-durable-interruption.md §4
 *
 * T4 late answer 不复活门（终态 ⇒ 不注入 runtime、不改表）
 * T6 一致性：终态门 SSE 不下发活卡片 + 历史重放剔除终态卡
 * T7 阴性/回归：未装配 P2 service ⇒ 旧行为逐字节不变；老会话零门记录直通
 * T8 state API：pending 摘要 / 无门 null
 *
 * 变异自检：
 *  M4 去掉 canvas_command 分支 `if (!live) continue` → T6 SSE RED
 *  M5 去掉 adjudicateLateAnswer 前置表判定 → T4 RED
 *  M6 去掉 suppressTerminalGateCards 的过滤 → T6 历史 RED
 */
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { stubPiClient } from './agent.test-utils'
import { PendingInterruptionService } from './pending-interruption.service'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

const NOW = 1_800_000_000_000

/** 极简持久化门表（跨实例共享，用于模拟重启）。 */
class FakeGates {
  rows: Array<{
    id: string
    threadId: string
    callId: string
    kind: string
    questionsJson: string | null
    status: string
    answerJson: string | null
    expiresAt: Date
  }> = []
  private seq = 0
  async findUnique(args: any) {
    const k = args.where.threadId_callId
    return this.rows.find((r) => r.threadId === k.threadId && r.callId === k.callId) ?? null
  }
  async create(args: any) {
    const row = { id: `r${++this.seq}`, ...args.data }
    this.rows.push(row)
    return row
  }
  async update(args: any) {
    const row = this.rows.find((r) => r.id === args.where.id)!
    Object.assign(row, args.data)
    return row
  }
  async updateMany(args: any) {
    const w = args.where
    let count = 0
    for (const r of this.rows) {
      if (w.callId !== undefined && r.callId !== w.callId) continue
      if (w.threadId !== undefined && r.threadId !== w.threadId) continue
      if (w.status !== undefined && r.status !== w.status) continue
      if (w.expiresAt?.lt && !(r.expiresAt.getTime() < w.expiresAt.lt.getTime())) continue
      Object.assign(r, args.data)
      count++
    }
    return { count }
  }
  async findFirst(args: any) {
    const w = args.where
    return (
      this.rows.find((r) => {
        if (w.callId !== undefined && r.callId !== w.callId) return false
        if (w.threadId !== undefined && r.threadId !== w.threadId) return false
        if (w.status !== undefined && r.status !== w.status) return false
        if (w.expiresAt?.gt && !(r.expiresAt.getTime() > w.expiresAt.gt.getTime())) return false
        return true
      }) ?? null
    )
  }
  async findMany(args: any) {
    const inList: string[] | undefined = args.where.callId?.in
    return this.rows.filter((r) => !inList || inList.includes(r.callId))
  }
}

const agentMessageFindMany = vi.fn()
const agentEventFindMany = vi.fn()
const agentEventAggregate = vi.fn()

function buildService(p2?: PendingInterruptionService): AgentService {
  const prisma = {
    agentMessage: {
      findMany: agentMessageFindMany,
      create: vi.fn().mockResolvedValue({}),
      aggregate: vi.fn().mockResolvedValue({ _max: { seq: null } }),
    },
    agentThread: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    session: { findUnique: vi.fn().mockResolvedValue({ id: 's1', canvasData: null }), update: vi.fn() },
    idempotencyRecord: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    agentEvent: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: agentEventFindMany,
      aggregate: agentEventAggregate,
    },
    userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
  }
  const args: unknown[] = [
    prisma,
    { createFromAgent: vi.fn() },
    { resolveForGeneration: vi.fn().mockRejectedValue(new Error('channel not found')) },
    undefined, // canvasTools
    undefined, // canvasActionApplier
    undefined, // agentMemory
    undefined, // points
    undefined, // pricing
    undefined, // turnState
    undefined, // moduleRef
    undefined, // generationReaper
    undefined, // eventBus
    undefined, // canvasDigest
    p2, // 第 14 位：P2 durable service（@Optional）
  ]
  return new AgentService(...(args as unknown as [any]))
}

async function drain(stream: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const e of stream) out.push(e)
  return out
}

const askCardEvents = (): PiRuntimeEvent[] =>
  [
    {
      type: 'tool_execution_update',
      seq: 20,
      runId: 'run-1',
      ts: NOW,
      data: {
        partialResult: {
          details: {
            canvasCommands: [{ type: 'ask_user', callId: 'call-1', questions: [{ id: 'q1', question: '选哪个？' }] }],
          },
        },
      },
    },
    {
      type: 'waiting_user',
      seq: 21,
      runId: 'run-1',
      ts: NOW,
      data: { status: 'waiting', callId: 'call-1', toolName: 'ask_user', timeoutMs: 120_000 },
    },
    { type: 'agent_end', seq: 22, runId: 'run-1', ts: NOW, data: { status: 'completed' } },
  ] as PiRuntimeEvent[]

describe('P2 待确认门 durable · AgentService 接线层', () => {
  let gates: FakeGates
  let p2: PendingInterruptionService

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    delete process.env.TEXT_TOKEN_BILLING
    gates = new FakeGates()
    p2 = new PendingInterruptionService({ pendingInterruption: gates } as any)
    agentMessageFindMany.mockResolvedValue([])
    agentEventFindMany.mockResolvedValue([])
    agentEventAggregate.mockResolvedValue({ _max: { gSeq: null } })
  })

  it('T6: 终态门 SSE 不下发活卡片（P1c-6）；waiting 帧不复活终态门', async () => {
    await p2.openGate({ threadId: 'thread-A', callId: 'call-1', expiresAt: NOW + 120_000, startedAt: NOW })
    await p2.settleGate({ threadId: 'thread-A', callId: 'call-1', status: 'answered' })

    const service = buildService(p2)
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(stubPiClient(askCardEvents()))
    const events = await drain(service.streamConversation('s1', 'hi', 'u1', 'thread-A'))

    const liveCards = events.filter((e) => {
      const ev = e as { type?: string; data?: { type?: string } }
      return ev.type === 'canvas_command' && ev.data?.type === 'ask_user'
    })
    expect(liveCards).toHaveLength(0) // M4 变异点
    expect(gates.rows[0]!.status).toBe('answered') // waiting 帧未复活终态门
    expect(gates.rows).toHaveLength(1)
  })

  it('T7 阴性: 未装配 P2 service ⇒ 卡片照常下发（旧行为零回归）', async () => {
    const service = buildService() // 第 14 参 undefined
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(stubPiClient(askCardEvents()))
    const events = await drain(service.streamConversation('s1', 'hi', 'u1', 'thread-A'))
    expect(
      events.filter((e) => {
        const ev = e as { type?: string; data?: { type?: string } }
        return ev.type === 'canvas_command' && ev.data?.type === 'ask_user'
      }),
    ).toHaveLength(1)
  })

  it('T4: late answer 撞终态门 ⇒ 只回终态回执，不注入 runtime、不改表', async () => {
    await p2.openGate({ threadId: 'thread-A', callId: 'call-1', expiresAt: NOW + 1_000, startedAt: NOW })
    await p2.sweepExpired(NOW + 2_000) // 扫描翻 expired
    const service = buildService(p2)
    const lateAnswer = vi.fn()
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue({
      answer: vi.fn().mockResolvedValue({ ok: true, deduped: true }), // deduped 无 prior
      lateAnswer,
    } as any)

    const res = await service.answerPiPending({
      sessionId: 's1',
      threadId: 'thread-A',
      callId: 'call-1',
      answers: { q1: ['A'] },
    })
    expect(res.expired).toBe(true) // M5 变异点
    expect(lateAnswer).not.toHaveBeenCalled() // 不注入 runtime
    expect(gates.rows[0]!.status).toBe('expired') // 门不复活
  })

  it('T8: state API 返回 durable pending 摘要；无门时 null（旧形状兼容）', async () => {
    const service = buildService(p2)
    vi.spyOn(service as any, 'assertThreadOwner').mockResolvedValue(undefined)
    vi.spyOn(service as any, 'reconcileLatestAssistant').mockResolvedValue({ outcome: 'active' })

    const empty = await service.getThreadResumeState('thread-A', 'u1')
    expect(empty.pendingInterruption).toBeNull()

    await p2.openGate({
      threadId: 'thread-A',
      callId: 'call-1',
      kind: 'propose_plan',
      questions: [{ id: 'p1', question: '确认？' }],
      expiresAt: NOW + 60_000,
      startedAt: NOW,
    })
    // 模拟进程重启：新的 service 实例，但读同一持久化表
    const restarted = buildService(new PendingInterruptionService({ pendingInterruption: gates } as any))
    vi.spyOn(restarted as any, 'assertThreadOwner').mockResolvedValue(undefined)
    vi.spyOn(restarted as any, 'reconcileLatestAssistant').mockResolvedValue({ outcome: 'active' })
    const state = await restarted.getThreadResumeState('thread-A', 'u1')
    expect(state.pendingInterruption?.callId).toBe('call-1') // P1c-5 重启存活
    expect(state.pendingInterruption?.kind).toBe('propose_plan')
  })

  it('T9 (W1c D1=A): state API 返回终态 interruption 摘要，且 pendingInterruption 为 null（信息双补）', async () => {
    await p2.openGate({
      threadId: 'thread-A',
      callId: 'call-1',
      kind: 'ask_user',
      questions: [{ id: 'q1', question: '选哪个？' }],
      expiresAt: NOW + 60_000,
      startedAt: NOW,
    })
    // 门已终态（用户已答）
    await p2.settleGate({ threadId: 'thread-A', callId: 'call-1', status: 'answered' })

    const service = buildService(p2)
    vi.spyOn(service as any, 'assertThreadOwner').mockResolvedValue(undefined)
    vi.spyOn(service as any, 'reconcileLatestAssistant').mockResolvedValue({ outcome: 'complete' })

    const state = await service.getThreadResumeState('thread-A', 'u1')
    // W1c-2：前端能拿到终态门数据 ⇒ 重建「已回答」终态卡
    expect(state.interruption).not.toBeNull()
    expect(state.interruption!.callId).toBe('call-1')
    expect(state.interruption!.status).toBe('answered')
    expect(state.interruption!.questions).toEqual([{ id: 'q1', question: '选哪个？' }])
    // 旧形状兼容：活门仍为 null（不破坏现有 pending 消费方）
    expect(state.pendingInterruption).toBeNull()
  })

  it('T6: 历史重放剔除终态门卡片；老行（无门记录）直通不改', async () => {
    await p2.openGate({ threadId: 'thread-A', callId: 'call-1', expiresAt: NOW + 60_000, startedAt: NOW })
    await p2.settleGate({ threadId: 'thread-A', callId: 'call-1', status: 'answered' })
    const card = (callId: string) => ({
      type: 'canvas_command',
      data: { type: 'ask_user', callId, questions: [] },
      seq: 1,
    })
    const oldMetadata = JSON.stringify({ executionEvents: [card('legacy-no-gate')] })
    const newMetadata = JSON.stringify({
      eventsShrunk: true,
      executionEvents: [card('call-1'), { type: 'turn_settled', data: {}, seq: 2 }],
    })
    const row = (id: string, metadata: string) => ({
      id,
      role: 'assistant',
      runId: 'run-1',
      metadata,
      createdAt: new Date(NOW + (id === 'm2' ? 1 : 0)),
      queued: false,
      reconciled: false,
      consumedAt: null,
      supersededBy: null,
    })
    agentMessageFindMany.mockResolvedValue([row('m2', newMetadata), row('m1', oldMetadata)])

    const service = buildService(p2)
    const result = await service.getMessages('s1', 'thread-A')
    const page = (result as any).page as Array<{ id: string; metadata: string }>
    const newRow = page.find((r) => r.id === 'm2')!
    const oldRow = page.find((r) => r.id === 'm1')!
    const newEvents = JSON.parse(newRow.metadata).executionEvents as Array<{ type: string }>
    expect(newEvents.some((e) => e.type === 'canvas_command')).toBe(false) // M6 变异点
    expect(newEvents.map((e) => e.type)).toContain('turn_settled') // 其余事件不受影响
    expect(oldRow.metadata).toBe(oldMetadata) // 阴性：老行零改动
  })
})
