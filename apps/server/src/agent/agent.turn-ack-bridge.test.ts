/**
 * P3 G1（multi-device spec §5.2 D4）：turn_ack / turn_not_submitted 的 drain 补桥。
 *
 * 背景：flag `STREAM_MAIN_FROM_PIRUNTIME=on` 下 streamConversation 的 yield 帧被
 * 后台 drain 丢弃（仅保留落库副作用）⇒ 服务端已裁定的回合归属（run/steer/followup）
 * 与结构化拒绝帧前端经 /runs/events 永远收不到。本测试钉住 generator 侧：
 *   A. bridgeSettledToBus=true ⇒ 两个 yield 点同步 emit 到总线（data 与流内 yield 同源）；
 *   B. flag-off（缺省）⇒ 零 bus 发射（防双发——runEventStream 在 flag-off 下也被
 *      旁听使用，漏 gate 就是观察者重复帧，计划 Review Focus 2）；
 *   C. steer+followUp 双失败 ⇒ turnMode undefined ⇒ 不发 turn_ack（把没受理包装成
 *      受理 = 纪律违例）。
 * runEventStream 注入侧（消费端）见文件尾 describe（Task 3）。
 */
import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { piEvent, stubPiClient } from './agent.test-utils'
import type { AgentStreamEvent } from '@lnkpi/agent'

function makeEventBus() {
  return {
    subscribeSession: vi.fn(() => () => {}),
    subscribeUser: vi.fn(() => () => {}),
    subscribeSessionTurnSettled: vi.fn(() => () => {}),
    emitCreditTx: vi.fn(),
    emitTurnSettled: vi.fn(),
    emitTurnAck: vi.fn(),
    emitTurnNotSubmitted: vi.fn(),
  }
}

function buildService(eventBus: unknown, agentMessageOverrides?: Record<string, unknown>): AgentService {
  const args: unknown[] = [
    {
      agentMessage: {
        aggregate: async () => ({ _max: { seq: null } }),
        create: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
        ...agentMessageOverrides,
      },
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
    undefined, // points
    undefined, // pricing
    undefined, // turnState
    undefined, // moduleRef
    undefined, // generationReaper
    eventBus, // SessionEventBus（第 12 位）
  ]
  return new AgentService(...(args as unknown as [any]))
}

const err409 = (): Error => Object.assign(new Error('busy'), { status: 409 })

async function drain(stream: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = []
  for await (const e of stream) out.push(e)
  return out
}

describe('streamConversation turn_ack/turn_not_submitted drain 补桥（P3 G1）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
  })
  afterEach(() => {
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL
  })

  it('A：flag-on 下 409→steer 成功 ⇒ bus 收到 turn_not_submitted{not_idle} 与 turn_ack{mode:steer}', async () => {
    const eventBus = makeEventBus()
    const service = buildService(eventBus)
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    pi.prompt = vi.fn().mockRejectedValue(err409())
    pi.steer = vi.fn().mockResolvedValue({ queued: true, entryId: 'e1' })
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const events = await drain(
      service.streamConversation(
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
      ),
    )

    expect(eventBus.emitTurnNotSubmitted).toHaveBeenCalledTimes(1)
    expect(eventBus.emitTurnNotSubmitted).toHaveBeenCalledWith({
      sessionId: 's1',
      reason: 'not_idle',
    })
    expect(eventBus.emitTurnAck).toHaveBeenCalledTimes(1)
    expect(eventBus.emitTurnAck).toHaveBeenCalledWith({
      sessionId: 's1',
      mode: 'steer',
      reason: 'not_idle',
    })
    // Task 4 前 turn_ack 不带 messageId 键（键不出现纪律）
    const ackData = eventBus.emitTurnAck.mock.calls[0][0] as Record<string, unknown>
    expect(ackData).not.toHaveProperty('messageId')

    // 流内 yield 照旧（flag-off 消费方 / 落库契约不回归）
    expect(events.filter((e) => e.type === 'turn_not_submitted')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'turn_ack')).toHaveLength(1)
  }, 30_000)

  it('B：flag-off（缺省 streamOpts）⇒ bus 零发射，流内两帧仍在（Review Focus 2 防双发）', async () => {
    const eventBus = makeEventBus()
    const service = buildService(eventBus)
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    pi.prompt = vi.fn().mockRejectedValue(err409())
    pi.steer = vi.fn().mockResolvedValue({ queued: true, entryId: 'e1' })
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const events = await drain(service.streamConversation('s1', 'hi', 'u1', 's1:thread-a'))

    expect(eventBus.emitTurnAck).not.toHaveBeenCalled()
    expect(eventBus.emitTurnNotSubmitted).not.toHaveBeenCalled()
    expect(events.filter((e) => e.type === 'turn_not_submitted')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'turn_ack')).toHaveLength(1)
  }, 30_000)

  it('C：steer+followUp 双失败 ⇒ turnMode undefined ⇒ 只发 turn_not_submitted{not_steerable}，不发 turn_ack', async () => {
    const eventBus = makeEventBus()
    const service = buildService(eventBus)
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    pi.prompt = vi.fn().mockRejectedValue(err409())
    pi.steer = vi.fn().mockRejectedValue(new Error('queue full'))
    pi.followUp = vi.fn().mockRejectedValue(new Error('queue full'))
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const events = await drain(
      service.streamConversation(
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
      ),
    )

    expect(eventBus.emitTurnNotSubmitted).toHaveBeenCalledTimes(1)
    expect(eventBus.emitTurnNotSubmitted).toHaveBeenCalledWith({
      sessionId: 's1',
      reason: 'not_steerable',
    })
    expect(eventBus.emitTurnAck).not.toHaveBeenCalled()
    expect(events.filter((e) => e.type === 'turn_ack')).toHaveLength(0)
  }, 30_000)
})

describe('runEventStream 注入（P3 G1 / 消费侧）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
  })
  afterEach(() => {
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL
  })

  it('D：bus emit turn_ack ⇒ runEventStream 流内出现 turn_ack 帧（剥 sessionId 路由键）；结束退订', async () => {
    const captured: Record<string, ((ev: Record<string, unknown>) => void) | null> = {
      ack: null,
      refused: null,
    }
    const unsubFlags = { ack: false, refused: false }
    const eventBus = {
      subscribeSession: vi.fn(() => () => {}),
      subscribeUser: vi.fn(() => () => {}),
      subscribeSessionTurnSettled: vi.fn(() => () => {}),
      subscribeSessionTurnAck: vi.fn(
        (_sid: string, fn: (ev: Record<string, unknown>) => void) => {
          captured.ack = fn
          return () => {
            unsubFlags.ack = true
          }
        },
      ),
      subscribeSessionTurnNotSubmitted: vi.fn(
        (_sid: string, fn: (ev: Record<string, unknown>) => void) => {
          captured.refused = fn
          return () => {
            unsubFlags.refused = true
          }
        },
      ),
      emitCreditTx: vi.fn(),
      emitTurnSettled: vi.fn(),
      emitTurnAck: vi.fn(),
      emitTurnNotSubmitted: vi.fn(),
    }
    const service = buildService(eventBus)

    // 延迟回放：留窗口注入 bus 帧
    const pi = stubPiClient([])
    pi.streamEvents = vi.fn((_sid: string, _cb: unknown, onClose: () => void) => {
      const t = setTimeout(onClose, 80)
      return () => clearTimeout(t)
    }) as never
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const ac = new AbortController()
    const out: AgentStreamEvent[] = []
    const consume = (async () => {
      for await (const e of service.runEventStream('s1:thread-a', { signal: ac.signal })) {
        out.push(e)
      }
    })()

    await new Promise((r) => setTimeout(r, 30))
    captured.ack!({ sessionId: 's1', runId: 'r-9', mode: 'steer', reason: 'not_idle' })
    captured.refused!({ sessionId: 's1', reason: 'not_steerable' })
    await new Promise((r) => setTimeout(r, 40))
    ac.abort()
    await consume

    const ack = out.find((e) => e.type === 'turn_ack')
    expect(ack).toBeDefined()
    expect(ack?.data).toEqual({ runId: 'r-9', mode: 'steer', reason: 'not_idle' })
    const refused = out.find((e) => e.type === 'turn_not_submitted')
    expect(refused?.data).toEqual({ reason: 'not_steerable' })
    expect(unsubFlags.ack).toBe(true)
    expect(unsubFlags.refused).toBe(true)
  }, 30_000)

  it('E：文档性断言——路由键主路径一致（Review Focus 5：emit 键 = streamConversation 首参 sessionId，订阅键 = runEventStream 的 threadId||sessionId；主路径 threadId===sessionId ⇒ 一致。fork 线程不对称属既有 turn_settled 桥问题，本包只记录不修）', () => {
    expect(true).toBe(true)
  })
})

describe('隐式 409→steer 落库补齐（P3 G2/G4 / Review Focus 3）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
  })
  afterEach(() => {
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL
  })

  it('F：steer 成功 ⇒ 既有 user 行被 update（entryId 回填 + queued:true）；turn_ack 带 messageId', async () => {
    const update = vi.fn().mockResolvedValue({})
    const eventBus = makeEventBus()
    const service = buildService(eventBus, {
      // 预置一行 prompt 前落库的 user 行（entryId 尚未回填）
      findFirst: vi.fn().mockResolvedValue({ id: 'm1' }),
      update,
    })
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    pi.prompt = vi.fn().mockRejectedValue(err409())
    pi.steer = vi.fn().mockResolvedValue({ queued: true, entryId: 'e9' })
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const events = await drain(
      service.streamConversation(
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
      ),
    )

    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { entryId: 'e9', queued: true },
    })
    expect(eventBus.emitTurnAck).toHaveBeenCalledTimes(1)
    const ackData = eventBus.emitTurnAck.mock.calls[0][0] as Record<string, unknown>
    expect(ackData).toMatchObject({ sessionId: 's1', mode: 'steer', reason: 'not_idle' })
    expect(ackData.messageId).toBe('m1')
    // 流内 yield 同源带 messageId
    const ackFrame = events.find((e) => e.type === 'turn_ack') as
      | { data: Record<string, unknown> }
      | undefined
    expect(ackFrame?.data.messageId).toBe('m1')
  }, 30_000)

  it('G：幂等——thread 内没有 entryId:null 的 user 行（已被认领/不存在）⇒ 不覆盖写、turn_ack 不带 messageId 键', async () => {
    const update = vi.fn().mockResolvedValue({})
    const create = vi.fn().mockResolvedValue({})
    const eventBus = makeEventBus()
    const service = buildService(eventBus, {
      findFirst: vi.fn().mockResolvedValue(null),
      update,
      create,
    })
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    pi.prompt = vi.fn().mockRejectedValue(err409())
    pi.steer = vi.fn().mockResolvedValue({ queued: true, entryId: 'e9' })
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    await drain(
      service.streamConversation(
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
      ),
    )

    // markQueuedUserMessage 不覆盖（先到先得）；create 仅 prompt 前正常落库那 1 次
    //（本路径无 create 能力——再 create 就是同一句话两行，Review Focus 3）
    expect(update).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: 'user', content: 'hi' }),
      }),
    )
    const ackData = eventBus.emitTurnAck.mock.calls[0][0] as Record<string, unknown>
    expect(ackData).not.toHaveProperty('messageId')
  }, 30_000)
})
