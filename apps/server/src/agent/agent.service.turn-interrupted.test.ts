import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { piEvent, stubPiClient } from './agent.test-utils'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

function seqEvent(type: string, data: unknown, seq: number): PiRuntimeEvent {
  return { type, ts: 1_700_000_000_000, seq, data } as PiRuntimeEvent
}
function ridEvent(type: string, data: unknown, runId: string, seq: number): PiRuntimeEvent {
  return { type, ts: 1_700_000_000_000, seq, runId, data } as PiRuntimeEvent
}

/** 生产事故形态（会话 cmwbvfp4p000qrk01pch77w13）：spawn 工具调用后流耗尽。 */
function spawnWithoutResult(): PiRuntimeEvent[] {
  return [
    ridEvent('agent_start', {}, 'run-A', 140),
    seqEvent('tool_execution_start',
      { toolCallId: 'call_A', toolName: 'spawn_subagent', args: { task: '调研X' } }, 152),
  ]
}

describe('turn_interrupted：上游流耗尽且无权威收束', () => {
  let service: AgentService

  beforeEach(() => {
    // ⚠️ 不能用 vi.restoreAllMocks()：它会 mockRestore 掉本文件模块级计费桩的
    // implementation，导致第二个 describe 的 freeze 返回 undefined ⇒ 结算块整体
    // 短路 ⇒ 出现与实现无关的假红灯。clearAllMocks 只清调用记录。
    vi.clearAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    delete process.env.TEXT_TOKEN_BILLING
    service = new AgentService(
      {
        agentMessage: {
          create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'm1', ...data })),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { seq: null } }),
        },
        agentThread: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
        },
        session: {
          findUnique: vi.fn().mockResolvedValue(null),
          update: vi.fn().mockResolvedValue({}),
        },
        userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn().mockResolvedValue(null) } as never,
    )
  })

  /** 构造「流自然耗尽、无 agent_end」——必须显式 onClosed()（桩默认不收口会永久挂起）。 */
  async function runNaturallyExhausted(events: PiRuntimeEvent[]) {
    const pi = stubPiClient([])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    pi.streamEvents.mockImplementation(
      (_sid: string, onEvent: (e: PiRuntimeEvent) => void, onClosed: () => void) => {
        for (const e of events) onEvent(e)
        onClosed()
        return () => {}
      },
    )
    const out: Array<{ type: string; data?: unknown }> = []
    for await (const e of service.streamConversation('s1', '帮我调研市场', 'u1', 't1')) out.push(e)
    return out
  }

  it('阳性：恰一个 turn_interrupted，data 带 reason/lastSeq/未配对 id', async () => {
    const out = await runNaturallyExhausted(spawnWithoutResult())
    const ev = out.filter((e) => e.type === 'turn_interrupted')
    expect(ev).toHaveLength(1)
    expect(ev[0]?.data).toMatchObject({
      reason: 'no_terminal_event',
      lastSeq: 152,
      outstandingToolCallIds: ['call_A'],
    })
  }, 120_000)

  it('落库：executionEvents 含 turn_interrupted（刷新/重连可重放）', async () => {
    const create = vi.spyOn(
      (service as unknown as { prisma: { agentMessage: { create: (...a: unknown[]) => Promise<unknown> } } }).prisma.agentMessage,
      'create',
    )
    await runNaturallyExhausted(spawnWithoutResult())
    const rows = create.mock.calls
      .map((c) => (c[0] as { data?: { role?: string; metadata?: string } })?.data)
      .filter((d) => d?.role === 'assistant')
    expect(rows.length).toBeGreaterThan(0)
    const parsed = JSON.parse(rows[0]?.metadata ?? '{}') as { executionEvents?: Array<{ type: string }> }
    expect(parsed.executionEvents?.some((e) => e.type === 'turn_interrupted')).toBe(true)
  }, 120_000)

  // 跨窗口契约锁（master 41490feb 的 P1c 写面分流 × D1 权威终态帧）。
  // P1c 把带 gSeq 的 tool_call/turn_usage 只写账本，metadata 保留「最小兼容集」；
  // D1 的完成判定必须读**全量事实视图**，不能读被裁剪的落库数组，也不能反过来
  // 依赖 fire-and-forget 账本读回。两端任一被改坏，下面三条同时给出信号：
  // ① 判据仍能算出未配对工具（⇒ 用全量视图）；
  // ② 元数据仍被裁剪（⇒ 没有把全量又写回 metadata，不破坏 P1c 清债目标）；
  // ③ 权威终态帧仍在保留集（⇒ 刷新/断连重放不依赖账本投影）。
  it('★ 跨窗口回归锁：P1c 分流形态下判据用全量视图、终态帧仍在保留集', async () => {
    const create = vi.spyOn(
      (service as unknown as { prisma: { agentMessage: { create: (...a: unknown[]) => Promise<unknown> } } }).prisma.agentMessage,
      'create',
    )
    const out = await runNaturallyExhausted(spawnWithoutResult())
    // ① 判据：未配对 id 不因 P1c 把 tool_call 裁出 metadata 而丢失
    const interrupted = out.find((e) => e.type === 'turn_interrupted')
    expect((interrupted?.data as { outstandingToolCallIds?: string[] })?.outstandingToolCallIds)
      .toContain('call_A')
    // ② / ③ 落库：tool_call 不在保留集（清债仍生效），turn_interrupted 在
    const rows = create.mock.calls
      .map((c) => (c[0] as { data?: { role?: string; metadata?: string } })?.data)
      .filter((d) => d?.role === 'assistant')
    const parsed = JSON.parse(rows[0]?.metadata ?? '{}') as {
      executionEvents?: Array<{ type: string }>
      eventsShrunk?: boolean
    }
    const keptTypes = (parsed.executionEvents ?? []).map((e) => e.type)
    expect(keptTypes).toContain('turn_interrupted')
    expect(keptTypes).not.toContain('tool_call')
    expect(parsed.eventsShrunk).toBe(true)
  }, 120_000)

  it('阴性（规格 §6 会话 B 形态）：见到 agent_end ⇒ 不发 turn_interrupted', async () => {
    const out = await runNaturallyExhausted([
      ridEvent('agent_start', {}, 'run-B', 4665),
      seqEvent('tool_execution_start',
        { toolCallId: 'call_B', toolName: 'spawn_subagent', args: { task: '调研Y' } }, 4783),
      seqEvent('tool_execution_end', { toolCallId: 'call_B', toolName: 'spawn_subagent', result: 'ok' }, 4784),
      piEvent('agent_end', { status: 'completed' }),
    ])
    expect(out.some((e) => e.type === 'turn_interrupted')).toBe(false)
    expect(out.some((e) => e.type === 'turn_suspended')).toBe(false)
  }, 120_000)

  it('阴性：waiting_user{waiting} 挂起 ⇒ 只发 turn_suspended，不发 turn_interrupted', async () => {
    const out = await runNaturallyExhausted([
      ridEvent('agent_start', {}, 'run-W', 1),
      seqEvent('waiting_user', { status: 'waiting', toolName: 'propose_generation' }, 2),
    ])
    expect(out.some((e) => e.type === 'turn_suspended')).toBe(true)
    expect(out.some((e) => e.type === 'turn_interrupted')).toBe(false)
  }, 120_000)
})

describe('turn_interrupted：零交付不扣费', () => {
  /** points 是构造参第 7 位、pricing 第 8 位（agent.service.ts:288-345）。 */
  const release = vi.fn().mockResolvedValue(undefined)
  const settleFromHold = vi.fn().mockResolvedValue({ settled: 12 })
  const freeze = vi.fn().mockResolvedValue({ id: 'hold-1' })
  const quoteTextTokens = vi.fn().mockResolvedValue({ credits: 12, ruleVersion: 'v1' })
  let billingService: AgentService

  beforeEach(() => {
    vi.clearAllMocks()
    // 显式重建 implementation：与第一个 describe 的 mock 生命周期隔离。
    release.mockResolvedValue(undefined)
    settleFromHold.mockResolvedValue({ settled: 12 })
    freeze.mockResolvedValue({ id: 'hold-1' })
    quoteTextTokens.mockResolvedValue({ credits: 12, ruleVersion: 'v1' })
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    process.env.TEXT_TOKEN_BILLING = 'on'
    billingService = new AgentService(
      {
        agentMessage: {
          create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'm1', ...data })),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { seq: null } }),
        },
        agentThread: {
          findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
        },
        session: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue({}) },
        userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn().mockResolvedValue({ providerRef: 'agnes', model: 'agnes-2.5-pro' }) } as never,
      undefined, undefined, undefined,
      { freeze, release, settleFromHold } as never,
      { quoteTextTokens } as never,
    )
  })

  async function drain(events: PiRuntimeEvent[]) {
    const pi = stubPiClient([])
    vi.spyOn(billingService, 'createPiRuntimeClient').mockReturnValue(pi)
    pi.streamEvents.mockImplementation(
      (_sid: string, onEvent: (e: PiRuntimeEvent) => void, onClosed: () => void) => {
        for (const e of events) onEvent(e)
        onClosed()
        return () => {}
      },
    )
    const out: Array<{ type: string; data?: unknown }> = []
    for await (const e of billingService.streamConversation('s1', '帮我调研', 'u1', 't1')) out.push(e)
    return out
  }

  it('release hold，turn_settled 只带 released:true，settleFromHold 零调用', async () => {
    const out = await drain(spawnWithoutResult())
    expect(release).toHaveBeenCalledWith('hold-1', '回合未收到完成确认，零交付不扣费')
    expect(settleFromHold).not.toHaveBeenCalled()
    const settled = out.filter((e) => e.type === 'turn_settled')
    expect(settled).toHaveLength(1)
    expect(settled[0]?.data).toMatchObject({ holdId: 'hold-1', released: true })
    expect((settled[0]?.data as Record<string, unknown>).credits).toBeUndefined()
  }, 120_000)

  it('阴性：有 agent_end 的正常回合照常结算（不误伤长回合）', async () => {
    await drain([
      ridEvent('agent_start', {}, 'run-B', 1),
      piEvent('agent_end', { status: 'completed' }),
    ])
    expect(release).not.toHaveBeenCalled()
    expect(settleFromHold).toHaveBeenCalledOnce()
  }, 120_000)
})
