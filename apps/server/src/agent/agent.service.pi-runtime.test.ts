/**
 * B4：pi-runtime 开关测试（spec §6.2.0 B4 / §10.3 D-ζ'）
 *
 * 覆盖三态开关语义：
 *   off（默认）  — PI_RUNTIME_URL 存在也不触碰 pi-runtime
 *   active      — healthz 通过 → 事件流走 pi-runtime 并正确映射/清理
 *   active 失败  — healthz 不通过 → 回落 LangGraph 路径（D-ζ' 回退）
 *   shadow      — LangGraph 照常服务，pi 仅接收镜像（事件不进 UI 流）
 */
import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { AgentRuntimeClient } from './agent-runtime.client'
import type { PiRuntimeClient } from './pi-runtime/pi-runtime.client'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

describe('AgentService pi-runtime switch (B4)', () => {
  const agentMessageCreate = vi.fn()
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
    delete process.env.AGENT_RUNTIME_URL
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL

    agentMessageCreate.mockResolvedValue({})
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
        agentMessage: { create: agentMessageCreate },
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
      { create: vi.fn() } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
  })

  afterEach(() => {
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL
  })

  describe('getPiRuntimeMode', () => {
    it('默认 off；仅接受 shadow/active（大小写不敏感）', () => {
      expect(service.getPiRuntimeMode()).toBe('off')
      process.env.PI_RUNTIME_MODE = 'SHADOW'
      expect(service.getPiRuntimeMode()).toBe('shadow')
      process.env.PI_RUNTIME_MODE = ' Active '
      expect(service.getPiRuntimeMode()).toBe('active')
      process.env.PI_RUNTIME_MODE = 'yes'
      expect(service.getPiRuntimeMode()).toBe('off')
    })
  })

  /** 构造一个脚本化 pi-runtime client：订阅时同步回放脚本事件。 */
  function stubPiClient(events: PiRuntimeEvent[], healthzOk = true) {
    const deleteSession = vi.fn().mockResolvedValue(true)
    const createSession = vi.fn().mockResolvedValue({
      sessionId: 'x',
      provider: 'agnes',
      model: 'agnes-2.5-pro',
    })
    const prompt = vi.fn().mockResolvedValue(undefined)
    const healthz = vi.fn().mockResolvedValue(healthzOk ? { status: 'ok' } : null)
    return {
      healthz,
      createSession,
      prompt,
      deleteSession,
      streamEvents: vi.fn(
        (
          _sessionId: string,
          onEvent: (event: PiRuntimeEvent) => void,
        ) => {
          for (const event of events) onEvent(event)
          return () => {}
        },
      ),
    } as unknown as PiRuntimeClient & {
      deleteSession: ReturnType<typeof vi.fn>
    }
  }

  function piEvent(type: PiRuntimeEvent['type'], data: unknown): PiRuntimeEvent {
    return { type, ts: Date.now(), data } as PiRuntimeEvent
  }

  it('off（默认）：即使配置了 PI_RUNTIME_URL 也不触碰 pi-runtime', async () => {
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const events: Array<{ type: string }> = []
    for await (const event of service.streamConversation('s1', 'hello', 'u1')) {
      events.push(event)
    }

    expect(pi.healthz).not.toHaveBeenCalled()
    expect(pi.createSession).not.toHaveBeenCalled()
    // 无 LangGraph runtime → 走 runtime_unavailable（现状行为不变）
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
  })

  it('active + healthz 通过：chat 流路由到 pi-runtime 并正确映射/清理', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([
      piEvent('agent_start', {}),
      piEvent('message_update', { event: { type: 'text_delta', delta: 'pi-' } }),
      piEvent('message_update', { event: { type: 'text_delta', delta: 'hello' } }),
      piEvent('agent_end', { status: 'completed' }),
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const events: Array<{ type: string; data?: unknown }> = []
    for await (const event of service.streamConversation('s1', '你好', 'u1', 't1')) {
      events.push(event)
    }

    expect(pi.createSession).toHaveBeenCalledWith('s1')
    expect(pi.prompt).toHaveBeenCalledWith('s1', '你好')
    expect(events.map((e) => e.type)).toEqual([
      'pi_agent_start',
      'text_delta',
      'text_delta',
      'done',
    ])
    expect(events[1].data).toEqual({ text: 'pi-' })
    expect(events[2].data).toEqual({ text: 'hello' })
    // 会话即时回收
    expect(pi.deleteSession).toHaveBeenCalledWith('s1')
    // 助手消息持久化（finalizeTurn 复用）
    expect(agentMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: 'assistant' }),
      }),
    )
  })

  it('active + healthz 失败：回落 LangGraph 路径（D-ζ’ 回退语义）', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    process.env.AGENT_RUNTIME_URL = 'http://127.0.0.1:8000'
    const pi = stubPiClient([], false)
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const streamRun = vi.fn(async function* () {
      yield { type: 'text_delta', data: { text: 'from-langgraph' } }
      yield { type: 'done', data: {} }
    })
    vi.spyOn(service, 'createRuntimeClient').mockReturnValue({
      healthOk: vi.fn().mockResolvedValue(true),
      streamRun,
    } as unknown as AgentRuntimeClient)

    const events: Array<{ type: string; data?: unknown }> = []
    for await (const event of service.streamConversation('s1', 'hello', 'u1')) {
      events.push(event)
    }

    expect(pi.createSession).not.toHaveBeenCalled()
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'done'])
    expect(events[0].data).toEqual({ text: 'from-langgraph' })
  })

  it('shadow：LangGraph 照常服务，pi 仅接收镜像且事件不进 UI 流', async () => {
    process.env.PI_RUNTIME_MODE = 'shadow'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    process.env.AGENT_RUNTIME_URL = 'http://127.0.0.1:8000'

    const mirror = vi.spyOn(service, 'mirrorToPiRuntime').mockImplementation(() => {})

    const streamRun = vi.fn(async function* () {
      yield { type: 'text_delta', data: { text: 'primary' } }
      yield { type: 'done', data: {} }
    })
    vi.spyOn(service, 'createRuntimeClient').mockReturnValue({
      healthOk: vi.fn().mockResolvedValue(true),
      streamRun,
    } as unknown as AgentRuntimeClient)

    const events: Array<{ type: string; data?: unknown }> = []
    for await (const event of service.streamConversation('s1', 'hello', 'u1')) {
      events.push(event)
    }

    expect(mirror).toHaveBeenCalledTimes(1)
    expect(mirror).toHaveBeenCalledWith(expect.anything(), 'shadow-s1', 'hello')
    // UI 流完全来自 LangGraph（P0 零用户感知）
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'done'])
    expect(events[0].data).toEqual({ text: 'primary' })
  })
})
