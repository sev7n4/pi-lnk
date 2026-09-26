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
import { PiRuntimeError } from './pi-runtime/pi-runtime.client'
import type { PiRuntimeClient } from './pi-runtime/pi-runtime.client'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

describe('AgentService pi-runtime switch (B4)', () => {
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

  let service: AgentService

  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.AGENT_RUNTIME_URL
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL

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

    service = new AgentService(
      {
        agentMessage: { create: agentMessageCreate, findMany: agentMessageFindMany },
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
  function stubPiClient(
    events: PiRuntimeEvent[],
    healthzOk = true,
    knownSkills: Array<{ name: string }> = [],
  ) {
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
      // ensurePiSession 走 409 安全路径：409 → 删除陈旧会话 → 重建（与真实 client 同语义）
      createSessionReplacingStale: vi.fn(async (sid: string, opts: never) => {
        try {
          return await createSession(sid, opts)
        } catch (err) {
          if (err instanceof PiRuntimeError && err.status === 409) {
            await deleteSession(sid)
            return await createSession(sid, opts)
          }
          throw err
        }
      }),
      prompt,
      deleteSession,
      listSkills: vi.fn().mockResolvedValue({ skills: knownSkills }),
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

    expect(pi.createSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ userId: 'u1' }),
    )
    expect(pi.prompt).toHaveBeenCalledWith('s1', '你好', 'main', {
      forceSkills: undefined,
    })
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

  it('T2-5：dock 短 skillId（product-visual）经 mapUiSkillId 映射命中白名单 → forceSkills 注入', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })], true, [
      { name: 'ecommerce-product-photo' },
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    for await (const _ of service.streamConversation(
      's1',
      '做个营销方案',
      'u1',
      't1',
      undefined,
      undefined,
      'product-visual',
    )) {
      // drain
    }

    expect(pi.prompt).toHaveBeenCalledWith('s1', '做个营销方案', 'main', {
      forceSkills: ['ecommerce-product-photo'],
    })
  })

  it('T2-6：未接入占位 skillId（storyboard）→ fail-soft 原文发送、无 forceSkills', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })], true, [
      { name: 'enterprise-marketing-campaign' },
      { name: 'ecommerce-product-visual' },
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    for await (const _ of service.streamConversation(
      's1',
      'hello',
      'u1',
      't1',
      undefined,
      undefined,
      'storyboard',
    )) {
      // drain
    }

    expect(pi.prompt).toHaveBeenCalledWith('s1', 'hello', 'main', {
      forceSkills: undefined,
    })
  })

  it('T2-6b：未迁移的老 dock 技能（canvas → enterprise-marketing-campaign）→ fail-soft 无 forceSkills', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })], true, [
      { name: 'ecommerce-product-photo' },
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    for await (const _ of service.streamConversation(
      's1',
      'hello',
      'u1',
      't1',
      undefined,
      undefined,
      'canvas',
    )) {
      // drain
    }

    expect(pi.prompt).toHaveBeenCalledWith('s1', 'hello', 'main', {
      forceSkills: undefined,
    })
  })

  it('pi 路径 canvas_action：extractCanvasActions 派生同步入 canvasActions 与 executionEvents（修死分支）', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const action = { type: 'update_node', payload: { id: 'n_1', data: { status: 'completed' } } }
    const pi = stubPiClient([
      piEvent('agent_start', {}),
      piEvent('tool_execution_end', {
        toolCallId: 'c1',
        toolName: 'gen',
        result: { content: [], details: { actions: [action] } },
      }),
      piEvent('agent_end', { status: 'completed' }),
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const events: Array<{ type: string; data?: unknown }> = []
    for await (const event of service.streamConversation('s1', '画一下', 'u1', 't1')) {
      events.push(event)
    }

    // 流内 canvas_action 仍直通前端（实时语义不变）
    expect(events.filter((e) => e.type === 'canvas_action')).toEqual([
      { type: 'canvas_action', data: action },
    ])
    // 持久化：toolCalls 经 canvasActions 收到 action，metadata.executionEvents
    // 经 executionEvents 收到同一 action（此前死分支导致两者均丢失）
    expect(agentMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          toolCalls: JSON.stringify([action]),
          metadata: expect.any(String),
        }),
      }),
    )
    const persisted = agentMessageCreate.mock.calls.at(-1)?.[0] as {
      data: { metadata: string }
    }
    const metadata = JSON.parse(persisted.data.metadata) as {
      executionEvents: Array<{ type: string; data: unknown }>
    }
    expect(metadata.executionEvents).toContainEqual({ type: 'canvas_action', data: action })
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
    expect(mirror).toHaveBeenCalledWith(
      expect.anything(),
      'shadow-s1',
      'hello',
      'u1',
      's1',
      expect.anything(),
    )
    // UI 流完全来自 LangGraph（P0 零用户感知）
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'done'])
    expect(events[0].data).toEqual({ text: 'primary' })
  })
})

describe('AgentService pi-runtime prompt assembly (#12)', () => {
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

  let service: AgentService

  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.AGENT_RUNTIME_URL
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL

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

    service = new AgentService(
      {
        agentMessage: { create: agentMessageCreate, findMany: agentMessageFindMany },
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

  function stubPiClient(events: PiRuntimeEvent[], healthzOk = true) {
    const createSession = vi.fn().mockResolvedValue({
      sessionId: 'x',
      provider: 'agnes',
      model: 'agnes-2.5-pro',
    })
    const deleteSession = vi.fn().mockResolvedValue(true)
    return {
      healthz: vi.fn().mockResolvedValue(healthzOk ? { status: 'ok' } : null),
      createSession,
      // 同 stubPiClient：409 → 删陈旧 + 重建
      createSessionReplacingStale: vi.fn(async (sid: string, opts: never) => {
        try {
          return await createSession(sid, opts)
        } catch (err) {
          if (err instanceof PiRuntimeError && err.status === 409) {
            await deleteSession(sid)
            return await createSession(sid, opts)
          }
          throw err
        }
      }),
      prompt: vi.fn().mockResolvedValue(undefined),
      deleteSession,
      streamEvents: vi.fn(
        (_sessionId: string, onEvent: (event: PiRuntimeEvent) => void) => {
          for (const event of events) onEvent(event)
          return () => {}
        },
      ),
    } as unknown as PiRuntimeClient & { createSession: ReturnType<typeof vi.fn> }
  }

  function piEvent(type: PiRuntimeEvent['type'], data: unknown): PiRuntimeEvent {
    return { type, ts: Date.now(), data } as PiRuntimeEvent
  }

  function stubAssembler(prompt: string) {
    const assemble = vi.fn().mockResolvedValue(prompt)
    vi.spyOn(service, 'createPiPromptAssembler').mockReturnValue({ assemble } as never)
    return assemble
  }

  it('active：createSession 收到组装后的 systemPrompt + userId + 画布上下文', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    stubAssembler('PROMPT-s1')

    const events: Array<{ type: string }> = []
    for await (const event of service.streamConversation(
      's1', '你好', 'u1', 't1',
      undefined, undefined, undefined, undefined,
      'node-9',
      [{ id: 'a1', mediaType: 'image', sourceKind: 'upload', label: 'a.png', url: 'https://x/a.png', role: 'product' }],
      ['I1'], ['I1'],
    )) {
      events.push(event)
    }

    expect(pi.createSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        systemPrompt: 'PROMPT-s1',
        userId: 'u1',
        focusNodeId: 'node-9',
        mentionedKeys: ['I1'],
        attachments: [{ id: 'a1', mediaType: 'image', sourceKind: 'upload', label: 'a.png', url: 'https://x/a.png', role: 'product' }],
      }),
    )
    expect(events.map((e) => e.type)).toContain('done')
  })

  it('priorMessages 取自 AgentMessage 历史且不含本轮 user 消息', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    agentMessageFindMany.mockResolvedValue([
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第一问' },
    ])
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    const assemble = stubAssembler('PROMPT-s1')

    for await (const _event of service.streamConversation('s1', '本轮新消息', 'u1', 't1')) {
      void _event
    }

    expect(agentMessageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: 't1' } }),
    )
    const input = assemble.mock.calls[0][0] as {
      priorMessages: Array<{ role: string; content: string }>
    }
    expect(input.priorMessages).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
    ])
    // 本轮消息单独持久化（不在 priorMessages 里）
    expect(agentMessageCreate).toHaveBeenCalled()
  })

  it('createSession 409：删除陈旧会话后重建（不静默复用），本轮不阻塞', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    pi.createSession
      .mockRejectedValueOnce(new PiRuntimeError('session exists: s1', 409))
      .mockResolvedValue({ sessionId: 's1', provider: 'agnes', model: 'agnes-2.5-pro' })
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    stubAssembler('PROMPT-s1')

    const events: Array<{ type: string }> = []
    for await (const event of service.streamConversation('s1', '你好', 'u1')) {
      events.push(event)
    }
    expect(events.map((e) => e.type)).toEqual(['done'])
    // 409 → 删陈旧 + 重建（第二次 createSession 成功）；本轮结束的 finally 也会再删一次
    expect(pi.createSession).toHaveBeenCalledTimes(2)
    expect(pi.deleteSession).toHaveBeenCalledWith('s1')
  })

  it('同一会话连发两轮：本轮 create 必须晚于上一轮 DELETE 完成（防迟到删除误杀新会话）', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    // 记录关键事件的真实时序；DELETE 放大 40ms，制造「删除已调用未完成」的飞行窗口
    const order: string[] = []
    pi.deleteSession.mockImplementation(async () => {
      order.push('delete-called')
      await new Promise((r) => setTimeout(r, 40))
      order.push('delete-resolved')
      return true
    })
    pi.createSession.mockImplementation(async () => {
      order.push('create-called')
      return { sessionId: 'x', provider: 'agnes', model: 'agnes-2.5-pro' }
    })
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    stubAssembler('PROMPT-s1')

    const drain = async () => {
      const out: string[] = []
      for await (const event of service.streamConversation('s1', 'hi', 'u1')) out.push(event.type)
      return out
    }

    const first = drain()
    await new Promise((r) => setTimeout(r, 5))
    const second = drain()
    const [a, b] = await Promise.all([first, second])

    expect(a).toEqual(['done'])
    expect(b).toEqual(['done'])
    // 不变量：第二次 create 必须在第一次 DELETE 真正完成之后
    // （只看调用顺序抓不住竞态——生产事故里 DELETE 已调用、迟到解析时误删了新会话）
    const firstDeleteResolved = order.indexOf('delete-resolved')
    expect(firstDeleteResolved).toBeGreaterThanOrEqual(0)
    const createIdxs = order.reduce<number[]>((acc, e, i) => (e === 'create-called' ? [...acc, i] : acc), [])
    expect(createIdxs).toHaveLength(2)
    expect(createIdxs[1]).toBeGreaterThan(firstDeleteResolved)
  })

  it('shadow 镜像：createSession 收到以真实 sessionId 组装的 systemPrompt + userId', async () => {
    process.env.PI_RUNTIME_MODE = 'shadow'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    process.env.AGENT_RUNTIME_URL = 'http://127.0.0.1:8000'

    const pi = stubPiClient([])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    stubAssembler('PROMPT-real')
    vi.spyOn(service, 'createRuntimeClient').mockReturnValue({
      healthOk: vi.fn().mockResolvedValue(true),
      streamRun: vi.fn(async function* () {
        yield { type: 'done', data: {} }
      }),
    } as unknown as AgentRuntimeClient)

    for await (const _event of service.streamConversation('s1', 'hello', 'u1', 't1')) {
      void _event
    }

    await vi.waitFor(() => {
      expect(pi.createSession).toHaveBeenCalledWith(
        'shadow-s1',
        expect.objectContaining({ systemPrompt: 'PROMPT-real', userId: 'u1' }),
      )
    })
  })
})

describe('AgentService B-2 ruleGroups + minors', () => {
  it('active：assemble 收到 ruleGroups [core, writeTools, genTools]（B-5）', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'

    const agentMessageFindMany = vi.fn().mockResolvedValue([])
    const agentMessageCreate = vi.fn().mockResolvedValue({})
    const agentThreadFindUnique = vi.fn().mockResolvedValue(null)
    const agentThreadUpsert = vi.fn().mockResolvedValue({})
    const sessionFindUnique = vi.fn().mockResolvedValue({ id: 's1', canvasData: null })
    const service = new AgentService(
      {
        agentMessage: { create: agentMessageCreate, findMany: agentMessageFindMany },
        agentThread: { findUnique: agentThreadFindUnique, upsert: agentThreadUpsert, update: vi.fn() },
        session: { findUnique: sessionFindUnique, update: vi.fn() },
        idempotencyRecord: {
          create: vi.fn(),
          findUnique: vi.fn().mockResolvedValue(null),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
      { create: vi.fn() } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
      { getCanvasSummary: vi.fn().mockResolvedValue({ nodes: [] }) } as never,
    )
    const pi = {
      healthz: vi.fn().mockResolvedValue({ status: 'ok' }),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'x', provider: 'agnes', model: 'm' }),
      createSessionReplacingStale: vi.fn().mockResolvedValue({ sessionId: 'x', provider: 'agnes', model: 'm' }),
      prompt: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(true),
      streamEvents: vi.fn((_sid: string, onEvent: (e: { type: string; ts: number; data: unknown }) => void) => {
        onEvent({ type: 'agent_end', ts: Date.now(), data: { status: 'completed' } })
        return () => {}
      }),
    } as never
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    const assemble = vi.fn().mockResolvedValue('PROMPT')
    vi.spyOn(service, 'createPiPromptAssembler').mockReturnValue({ assemble } as never)

    const events: Array<{ type: string }> = []
    for await (const event of service.streamConversation('s1', '你好', 'u1', 't1')) {
      events.push(event)
    }
    expect(events.map((e) => e.type)).toContain('done')
    expect(assemble.mock.calls[0][0]).toMatchObject({ ruleGroups: ['core', 'writeTools', 'genTools'] })
  })

  it('F3：老链路（pi off）不再触发 priorMessages 查询', async () => {
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL

    const agentMessageFindMany = vi.fn().mockResolvedValue([])
    const agentMessageCreate = vi.fn().mockResolvedValue({})
    const service = new AgentService(
      {
        agentMessage: { create: agentMessageCreate, findMany: agentMessageFindMany },
        agentThread: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn(), update: vi.fn() },
        session: { findUnique: vi.fn().mockResolvedValue({ id: 's1', canvasData: null }), update: vi.fn() },
        idempotencyRecord: {
          create: vi.fn(),
          findUnique: vi.fn().mockResolvedValue(null),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
      { create: vi.fn() } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
      { getCanvasSummary: vi.fn().mockResolvedValue({ nodes: [] }) } as never,
    )
    // LangGraph 客户端打桩，让它自然走完（不 emit 也行，只看 findMany 是否被调用）
    vi.spyOn(service, 'createRuntimeClient').mockReturnValue({
      healthOk: vi.fn().mockResolvedValue(true),
      streamRun: vi.fn(async function* () {
        yield { type: 'done', data: {} }
      }),
    } as never)

    const events: Array<{ type: string }> = []
    for await (const event of service.streamConversation('s1', '你好', 'u1', 't1')) {
      events.push(event)
    }
    expect(agentMessageFindMany).not.toHaveBeenCalled()
    expect(events.map((e) => e.type)).toContain('done')
  })
})
