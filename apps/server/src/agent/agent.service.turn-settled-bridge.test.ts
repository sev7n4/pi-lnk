/**
 * 2026-11-04 实时补桥：turn_settled / turn_usage 进 flag-on 权威通道（/runs/events）。
 *
 * 背景（真机实测 cmw1oyqww00b9tm01rpum6z5k）：`STREAM_MAIN_FROM_PIRUNTIME=on` 下，
 * 主流 = runEventStream = pi-runtime buffer + credit_tx 注入；turn_usage（tokens 段）
 * 与 turn_settled（结算段）是 Nest 侧合成事件，yield 帧被后台 drain 丢弃 ⇒ 实时摘要
 * 缺段、刷新重放才出现。本测试钉住补桥两端：
 *   A. generator 侧：streamOpts.bridgeSettledToBus=true ⇒ 结算块 emit 到总线（与流内
 *      yield 同一 data，三口同源）；
 *   B. 消费侧：runEventStream 把 message_end.usage 折叠成 turn_usage 下发；总线
 *      emit 的 turn_settled 注入队列下发；流结束退订。
 */
import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { piEvent, stubPiClient } from './agent.test-utils'
import type { AgentStreamEvent } from '@lnkpi/agent'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

const msgEndWithUsage = () =>
  piEvent('message_end', {
    message: { usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 50 } },
  })

function buildService(eventBus: unknown, points?: unknown, pricing?: unknown): AgentService {
  const args: unknown[] = [
    {
      agentMessage: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
      agentThread: {
        findUnique: vi.fn().mockResolvedValue({ id: 's1:thread-a' }),
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn(),
      },
      session: {
        findUnique: vi.fn().mockResolvedValue({ id: 's1', canvasData: null }),
        update: vi.fn().mockResolvedValue({}),
      },
      idempotencyRecord: {
        create: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
    },
    { createFromAgent: vi.fn() },
    { resolveForGeneration: vi.fn() },
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

describe('turn_settled 实时补桥（flag-on /runs/events）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
  })
  afterEach(() => {
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL
    delete process.env.TEXT_TOKEN_BILLING
    delete process.env.CREDIT_TX
  })

  it('A：bridgeSettledToBus=true ⇒ 结算块 emit 到总线（holdId/credits/sessionId 三口同源）', async () => {
    process.env.TEXT_TOKEN_BILLING = 'on'
    const emitTurnSettled = vi.fn()
    const eventBus = {
      subscribeSession: vi.fn(() => () => {}),
      subscribeUser: vi.fn(() => () => {}),
      subscribeSessionTurnSettled: vi.fn(() => () => {}),
      emitCreditTx: vi.fn(),
      emitTurnSettled,
    }
    const freeze = vi.fn().mockResolvedValue({ id: 'hold-1', amount: 4 })
    const settleFromHold = vi.fn().mockResolvedValue({ settled: 3, released: 0 })
    const release = vi.fn()
    const quoteTextTokens = vi.fn().mockResolvedValue({
      credits: 3,
      ruleVersion: 'price-v2',
      breakdown: { in: 2, cache: 0, out: 1 },
    })
    const service = buildService(
      eventBus,
      { freeze, settleFromHold, release },
      { quoteTextTokens },
    )
    const pi = stubPiClient([msgEndWithUsage(), piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    // 17 个位置参数：…branchFromEntryId, selectedNodeIds, billingSource, streamOpts
    const events: AgentStreamEvent[] = []
    for await (const e of service.streamConversation(
      's1',
      'hi',
      'u1',
      's1:thread-a',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'user',
      { bridgeSettledToBus: true },
    )) {
      events.push(e)
    }

    expect(emitTurnSettled).toHaveBeenCalledTimes(1)
    expect(emitTurnSettled).toHaveBeenCalledWith(
      expect.objectContaining({ holdId: 'hold-1', credits: 3, sessionId: 's1' }),
    )
    // 流内 yield 照旧（flag-off 消费方 / 落库契约不回归）
    expect(events.filter((e) => e.type === 'turn_settled')).toHaveLength(1)
  }, 30_000)

  it('B：缺省（flag-off 主流）不 emit —— 防双发', async () => {
    process.env.TEXT_TOKEN_BILLING = 'on'
    const emitTurnSettled = vi.fn()
    const eventBus = {
      subscribeSession: vi.fn(() => () => {}),
      subscribeUser: vi.fn(() => () => {}),
      subscribeSessionTurnSettled: vi.fn(() => () => {}),
      emitCreditTx: vi.fn(),
      emitTurnSettled,
    }
    const service = buildService(
      eventBus,
      {
        freeze: vi.fn().mockResolvedValue({ id: 'hold-1', amount: 4 }),
        settleFromHold: vi.fn().mockResolvedValue({ settled: 3, released: 0 }),
        release: vi.fn(),
      },
      {
        quoteTextTokens: vi
          .fn()
          .mockResolvedValue({ credits: 3, ruleVersion: 'v', breakdown: { in: 2, cache: 0, out: 1 } }),
      },
    )
    const pi = stubPiClient([msgEndWithUsage(), piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    for await (const _e of service.streamConversation('s1', 'hi', 'u1', 's1:thread-a')) {
      // 消费到底
    }
    expect(emitTurnSettled).not.toHaveBeenCalled()
  }, 30_000)

  it('C：runEventStream 下发 turn_usage（usage 折叠）+ 总线 turn_settled 注入 + 结束退订', async () => {
    let settledFn: ((ev: Record<string, unknown>) => void) | null = null
    let settledUnsubCalled = false
    const eventBus = {
      subscribeSession: vi.fn(() => () => {}),
      subscribeUser: vi.fn(() => () => {}),
      subscribeSessionTurnSettled: vi.fn((_sid: string, fn: (ev: Record<string, unknown>) => void) => {
        settledFn = fn
        return () => {
          settledUnsubCalled = true
        }
      }),
      emitCreditTx: vi.fn(),
      emitTurnSettled: vi.fn(),
    }
    const service = buildService(eventBus)

    // 延迟回放：先 message_end(usage) + agent_end（→ turn_usage），留窗口注入 settled
    const pi = stubPiClient([])
    pi.streamEvents = vi.fn((_sid: string, cb: (e: PiRuntimeEvent) => void) => {
      setTimeout(() => {
        cb(msgEndWithUsage())
        cb(piEvent('agent_end', { status: 'completed' }))
      }, 20)
      return () => {}
    }) as never
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const ac = new AbortController()
    const out: AgentStreamEvent[] = []
    const consume = (async () => {
      for await (const e of service.runEventStream('s1:thread-a', { signal: ac.signal })) {
        out.push(e)
      }
    })()

    await new Promise((r) => setTimeout(r, 60))
    const usage = out.find((e) => e.type === 'turn_usage')
    expect(usage).toBeDefined()
    expect(usage?.data).toMatchObject({ inputTokens: 100, outputTokens: 50 })

    settledFn!({ holdId: 'hold-1', credits: 3, sessionId: 's1:thread-a' })
    await new Promise((r) => setTimeout(r, 30))
    ac.abort()
    await consume

    const settled = out.find((e) => e.type === 'turn_settled')
    expect(settled).toBeDefined()
    // 路由用 sessionId 已剥除（键不出现纪律，与重放契约一致）
    expect(settled?.data).toEqual({ holdId: 'hold-1', credits: 3 })
    expect(settledUnsubCalled).toBe(true)
  }, 30_000)
})
