/**
 * 2026-11-11 插话气泡实时化 + 消费终态（服务端事件链路）。
 *
 * 规格：docs/superpowers/specs/2026-11-11-queue-user-bubble-context-verify-design.md §4.1-§4.3。
 *
 * ⭐ 变异自检映射（判据锚在可观测出口上，不锚实现名）：
 *   ① persist 后删 emitUserUtterance ⇒ queued 事件两条红
 *   ② consumed 写库改丢（updateMany 不调）⇒ 消费终态红
 *   ③ extract 放宽到 assistant message_end ⇒ role 门红
 *   ④ 读时派生压过权威终态（reconciled 行被翻）⇒ 权威门红
 *   ⑤ runEventStream 删 userUtterance 订阅 ⇒ 扇出红
 */
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { SessionEventBus } from '../points/session-event-bus.service'

function buildPrisma(over: Record<string, unknown> = {}) {
  return {
    agentMessage: {
      aggregate: vi.fn().mockResolvedValue({ _max: { seq: null } }),
      upsert: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    agentThread: { update: vi.fn(), upsert: vi.fn(), findUnique: vi.fn() },
    session: { findUnique: vi.fn(), update: vi.fn() },
    userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
    ...over,
  } as never
}

/** eventBus 是第 12 个位置参数（prisma, material, providerResolver, canvasTools, applier, memory, points, pricing, turnState, moduleRef, reaper, bus）。 */
function busArgs(bus: SessionEventBus | undefined) {
  return [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, bus] as const
}

describe('user_utterance_queued 发射（persist 成功后）', () => {
  const agentMessageUpsert = vi.fn()
  let steer: ReturnType<typeof vi.fn>
  let followUp: ReturnType<typeof vi.fn>
  let bus: SessionEventBus

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:30100'
    agentMessageUpsert.mockResolvedValue({})
    steer = vi.fn().mockResolvedValue({ queued: true, entryId: 'E-steer-1' })
    followUp = vi.fn().mockResolvedValue({ queued: true, entryId: 'E-follow-1' })
    bus = new SessionEventBus()
  })

  function newService(prisma: unknown) {
    const service = new AgentService(
      prisma as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
      ...busArgs(bus),
    )
    vi.spyOn(service as never, 'createPiRuntimeClient' as never).mockReturnValue({ steer, followUp } as never)
    return service
  }

  it('steer 落库成功即 emit queued（content=用户原话，非拼装文本）', async () => {
    const prisma = buildPrisma()
    const service = newService(prisma)
    const listener = vi.fn()
    bus.subscribeSessionUserUtterance('t1', listener)

    await service.steerPiRun({ sessionId: 's1', threadId: 't1', text: '再加一只猫' })

    expect(listener).toHaveBeenCalledTimes(1)
    const got = listener.mock.calls[0]![0] as { kind: string; entryId: string; content: string; threadId: string }
    expect(got.kind).toBe('queued')
    expect(got.entryId).toBe('E-steer-1')
    expect(got.content).toBe('再加一只猫')
    expect(got.threadId).toBe('t1')
    expect(got.content).not.toContain('[In=')
  })

  it('followUp 同款 emit', async () => {
    const service = newService(buildPrisma())
    const listener = vi.fn()
    bus.subscribeSessionUserUtterance('t1', listener)
    await service.followUpPiRun({ sessionId: 's1', threadId: 't1', text: '跑完截个图' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect((listener.mock.calls[0]![0] as { kind: string }).kind).toBe('queued')
  })

  it('落库失败 fail-soft：不抛、不 emit（插话本身已入队，不得让前端误判未发出）', async () => {
    const prisma = buildPrisma({ agentMessage: {
      aggregate: vi.fn().mockResolvedValue({ _max: { seq: null } }),
      upsert: vi.fn().mockRejectedValue(new Error('db down')),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
    } })
    const service = newService(prisma)
    const listener = vi.fn()
    bus.subscribeSessionUserUtterance('t1', listener)
    const res = await service.steerPiRun({ sessionId: 's1', threadId: 't1', text: 'x' })
    expect(res.queued).toBe(true)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('consumed 观察挂钩（noteUtteranceConsumed / extractConsumableUtteranceEnd）', () => {
  let bus: SessionEventBus
  beforeEach(() => {
    vi.restoreAllMocks()
    bus = new SessionEventBus()
  })

  function newService(prisma: unknown) {
    return new AgentService(
      prisma as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
      ...busArgs(bus),
    )
  }

  function internals(service: AgentService) {
    return service as unknown as {
      noteUtteranceConsumed: (t: string, e: string) => Promise<void>
      extractConsumableUtteranceEnd: (e: unknown) => string | null
    }
  }

  it('extract：message_end{role:user, entryId} 命中；assistant / 无 entryId / 异型事件一律 null', () => {
    const service = newService(buildPrisma())
    const extract = internals(service).extractConsumableUtteranceEnd
    expect(extract({ type: 'message_end', data: { entryId: 'E1', message: { role: 'user' } } })).toBe('E1')
    expect(extract({ type: 'message_end', data: { entryId: 'E2', message: { role: 'assistant' } } })).toBeNull()
    expect(extract({ type: 'message_end', data: { message: { role: 'user' } } })).toBeNull()
    expect(extract({ type: 'queue_update', data: { entryId: 'E1' } })).toBeNull()
    expect(extract(null)).toBeNull()
  })

  it('noteUtteranceConsumed：queued=true 行翻终态（queued=false + consumedAt）并 emit consumed；count=0 不 emit', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const service = newService(buildPrisma({ agentMessage: {
      aggregate: vi.fn(), upsert: vi.fn(), findFirst: vi.fn(), update: vi.fn(),
      create: vi.fn(), findMany: vi.fn(), updateMany,
    } }))
    const listener = vi.fn()
    bus.subscribeSessionUserUtterance('t1', listener)

    await internals(service).noteUtteranceConsumed('t1', 'E1')

    expect(updateMany).toHaveBeenCalledTimes(1)
    const arg = updateMany.mock.calls[0]![0] as { where: { entryId: string; queued: boolean }; data: { queued: boolean; consumedAt: Date } }
    expect(arg.where).toEqual({ entryId: 'E1', queued: true })
    expect(arg.data.queued).toBe(false)
    expect(arg.data.consumedAt).toBeInstanceOf(Date)
    expect(listener).toHaveBeenCalledTimes(1)
    expect((listener.mock.calls[0]![0] as { kind: string; entryId: string }).kind).toBe('consumed')

    // 幂等：重放时 updateMany count=0 ⇒ 不重复 emit
    updateMany.mockResolvedValue({ count: 0 })
    listener.mockClear()
    await internals(service).noteUtteranceConsumed('t1', 'E1')
    expect(listener).not.toHaveBeenCalled()
  })

  it('写库失败 fail-soft：不抛、不 emit', async () => {
    const updateMany = vi.fn().mockRejectedValue(new Error('db down'))
    const service = newService(buildPrisma({ agentMessage: {
      aggregate: vi.fn(), upsert: vi.fn(), findFirst: vi.fn(), update: vi.fn(),
      create: vi.fn(), findMany: vi.fn(), updateMany,
    } }))
    const listener = vi.fn()
    bus.subscribeSessionUserUtterance('t1', listener)
    await expect(internals(service).noteUtteranceConsumed('t1', 'E1')).resolves.toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('getMessages 权威终态优先（legacy 派生降级为 consumedAt==NULL 时的 fallback）', () => {
  function serviceWithRows(rows: unknown[]) {
    const bus = new SessionEventBus()
    return new AgentService(
      buildPrisma({ agentMessage: {
        aggregate: vi.fn(), upsert: vi.fn(), findFirst: vi.fn(), update: vi.fn(),
        create: vi.fn(), findMany: vi.fn().mockResolvedValue(rows), updateMany: vi.fn(),
      } }) as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
      ...busArgs(bus),
    )
  }

  const later = { id: 'a-later', role: 'assistant', content: '更晚回答', createdAt: new Date('2026-11-11T01:00:00Z') }

  it('reconciled=true（滞留终态）⇒ 派生不得翻 false（「有后续回答」不等于「被接住」）', async () => {
    const s = serviceWithRows([
      { id: 'u1', role: 'user', content: '滞留', createdAt: new Date('2026-11-11T00:00:00Z'), queued: true, reconciled: true, consumedAt: null },
      later,
    ])
    const out = await s.getMessages('s1', 't1')
    expect(out.page.find((m: { id: string }) => m.id === 'u1')?.queued).toBe(true)
  })

  it('consumedAt 非 NULL（历史遗留 queued=true）⇒ 权威值优先，不被派生覆盖', async () => {
    const s = serviceWithRows([
      { id: 'u1', role: 'user', content: '已被接住', createdAt: new Date('2026-11-11T00:00:00Z'), queued: true, reconciled: false, consumedAt: new Date('2026-11-11T00:30:00Z') },
      later,
    ])
    const out = await s.getMessages('s1', 't1')
    expect(out.page.find((m: { id: string }) => m.id === 'u1')?.queued).toBe(true)
    // DB 事实即 queued=true+consumedAt ⇒ 服务端消费翻转写入后 queued=false（本用例锁「派生不得绕过权威门」）
  })

  it('无权威信号（consumedAt/reconciled 双空）⇒ legacy 派生照旧（存量行为不回归）', async () => {
    const s = serviceWithRows([
      { id: 'u1', role: 'user', content: '存量已消费', createdAt: new Date('2026-11-11T00:00:00Z'), queued: true, reconciled: false, consumedAt: null },
      later,
    ])
    const out = await s.getMessages('s1', 't1')
    expect(out.page.find((m: { id: string }) => m.id === 'u1')?.queued).toBe(false)
  })

  it('无更晚 assistant 行 ⇒ queued 保持 true（「待接住」诚实中间态）', async () => {
    const s = serviceWithRows([
      { id: 'u1', role: 'user', content: '排队中', createdAt: new Date('2026-11-11T00:00:00Z'), queued: true, reconciled: false, consumedAt: null },
    ])
    const out = await s.getMessages('s1', 't1')
    expect(out.page.find((m: { id: string }) => m.id === 'u1')?.queued).toBe(true)
  })
})

describe('runEventStream 扇出 user_utterance_* 帧', () => {
  it('bus emit ⇒ generator yield 对应帧；结束后退订', async () => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:30100'
    const bus = new SessionEventBus()
    const service = new AgentService(
      buildPrisma(),
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
      ...busArgs(bus),
    )
    const unsub = vi.fn()
    vi.spyOn(service as never, 'createPiRuntimeClient' as never).mockReturnValue({
      streamEvents: vi.fn(() => unsub),
    } as never)

    const iter = service.runEventStream('t1')
    // 生成器惰性启动：第一次 next() 建立订阅（含 userUtterance 补桥）后阻塞等待
    const pending = iter.next()
    await new Promise((r) => setTimeout(r, 10))
    bus.emitUserUtterance({ sessionId: 't1', threadId: 't1', entryId: 'E9', kind: 'queued', content: 'x', ts: 't' })
    const frame = await Promise.race([
      pending,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no frame in 1s')), 1000)),
    ])
    expect(frame.done).toBe(false)
    expect((frame.value as { type: string }).type).toBe('user_utterance_queued')
    expect((frame.value as { data: { entryId: string } }).data.entryId).toBe('E9')
    await iter.return?.(undefined)
    expect(unsub).toHaveBeenCalled()
  })
})
