/**
 * Epic 1 Task 5：回合结算透传 + 在飞流注入 credit_tx。
 *
 * 钉住两件事（任一被改回即红灯）：
 *   A. 会话在飞期间，PointsService 经 SessionEventBus 发出的 credit_tx
 *      必须进本会话的 SSE 流（实时累计「本次使用」扣费，C3 会话归属正确）。
 *   B. 流结束（自然收尾 / 消费方断连）后必须退订，退订后不再向该流推送。
 *
 * 说明：本测试直接驱动总线订阅机制（settleFromHold 的真实发射由 PointsService
 * 单测 Task 3 覆盖），聚焦「流注入 + 退订」这一 Task 5 自身职责。构造 `AgentService`
 * 时把 `eventBus` 作为最后一个可选构造参传入（其余 @Optional 服务置 undefined）。
 */
import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { stubPiClient } from './agent.test-utils'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

function sampleCreditTx() {
  return {
    txId: 'tx-1',
    userId: 'u1',
    sessionId: 's1',
    amount: -12,
    kind: 'consume' as const,
    category: 'text' as const,
    reason: '对话回合结算',
    model: 'agnes-2.5-pro',
    generationId: null,
    ruleVersion: 'v1',
    balanceAfter: 988,
    ts: Date.now(),
  }
}

/** 异步回放的 pi 桩：agent_start 经微任务，text_delta / agent_end 延后到 +30ms，
 *  制造 `await iterator.next()` 的悬挂窗口，便于在飞期间注入 credit_tx。 */
function stubPiClientDelayed(): any {
  const base = stubPiClient([])
  base.streamEvents = vi.fn((_sid: string, cb: (e: PiRuntimeEvent) => void) => {
    queueMicrotask(() => cb({ type: 'agent_start', ts: 1, data: {} } as PiRuntimeEvent))
    setTimeout(() => {
      cb({
        type: 'message_update',
        ts: 2,
        data: { event: { type: 'text_delta', delta: '好' } },
      } as PiRuntimeEvent)
      cb({ type: 'agent_end', ts: 3, data: { status: 'completed' } } as PiRuntimeEvent)
    }, 30)
    return () => {}
  }) as never
  return base
}

describe('AgentService 在飞流注入 credit_tx（Epic 1 Task 5）', () => {
  const agentMessageCreate = vi.fn()
  const agentThreadFindUnique = vi.fn()
  const agentThreadUpsert = vi.fn()
  const sessionFindUnique = vi.fn()

  let subscribeFn: ((ev: any) => void) | null = null
  let unsubCalled = false
  let eventBus: any

  function buildService(): AgentService {
    unsubCalled = false
    subscribeFn = null
    eventBus = {
      subscribeSession: vi.fn((_sid: string, fn: (ev: any) => void) => {
        subscribeFn = fn
        return () => {
          unsubCalled = true
        }
      }),
      subscribeUser: vi.fn(() => () => {}),
      emitCreditTx: vi.fn(),
    }
    // AgentService 构造：前 3 个必填（prisma / material / providerResolver），
    // 其后 8 个 @Optional 服务置 undefined，最后 1 个可选构造参 = eventBus。
    const args: any[] = [
      {
        agentMessage: {
          create: agentMessageCreate,
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: vi.fn(),
        },
        agentThread: {
          findUnique: agentThreadFindUnique,
          upsert: agentThreadUpsert,
          update: vi.fn(),
        },
        session: { findUnique: sessionFindUnique, update: vi.fn() },
        userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    ]
    for (let i = 0; i < 8; i++) args.push(undefined)
    args.push(eventBus)
    return new AgentService(...(args as unknown as [any]))
  }

  let service: AgentService
  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    process.env.CREDIT_TX = 'on'
    agentMessageCreate.mockResolvedValue({})
    agentThreadFindUnique.mockResolvedValue(null)
    agentThreadUpsert.mockResolvedValue({})
    sessionFindUnique.mockResolvedValue({ id: 's1', canvasData: null })
    service = buildService()
  })
  afterEach(() => {
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL
    delete process.env.CREDIT_TX
  })

  it('A：在飞期间发出的 credit_tx 进入本会话 SSE 流', async () => {
    const pi = stubPiClientDelayed()
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const out: Array<{ type: string; data?: any }> = []
    const consume = (async () => {
      for await (const e of service.streamConversation('s1', '生成一只小乌龟', 'u1', 't1')) {
        out.push(e)
      }
    })()

    // 订阅已建立 + 流悬挂在 await iterator.next（等待 +30ms 的 agent_end 窗口）
    await new Promise((r) => setTimeout(r, 15))
    expect(subscribeFn).not.toBeNull()
    subscribeFn!(sampleCreditTx())

    await consume
    await new Promise((r) => setTimeout(r, 5))

    const creditEvents = out.filter((e) => e.type === 'credit_tx')
    expect(creditEvents).toHaveLength(1)
    expect(creditEvents[0].data).toMatchObject({
      txId: 'tx-1',
      kind: 'consume',
      category: 'text',
      sessionId: 's1',
    })
  }, 30_000)

  it('B：流结束后退订，且退订后不再向已结束的流推送', async () => {
    const pi = stubPiClientDelayed()
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const out: Array<{ type: string }> = []
    const consume = (async () => {
      for await (const e of service.streamConversation('s1', '生成一只小乌龟', 'u1', 't1')) {
        out.push(e)
      }
    })()

    // 在飞期间注入一次，应被流捕获
    await new Promise((r) => setTimeout(r, 15))
    subscribeFn!(sampleCreditTx())
    await consume
    await new Promise((r) => setTimeout(r, 5))

    // 流已收口 ⇒ 退订
    expect(unsubCalled).toBe(true)
    const capturedDuringRun = out.filter((e) => e.type === 'credit_tx').length
    expect(capturedDuringRun).toBe(1)

    // 退订后即便总线再推，也不会出现在已结束的流里
    subscribeFn?.(sampleCreditTx())
    expect(out.filter((e) => e.type === 'credit_tx').length).toBe(capturedDuringRun)
  }, 30_000)
})
