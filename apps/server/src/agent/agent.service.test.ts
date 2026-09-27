import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasAction } from '@lnkpi/shared'
import { AgentService, deriveLinkedOutputs, buildTurnMetadata } from './agent.service'
import { piEvent, stubPiClient } from './agent.test-utils'

describe('deriveLinkedOutputs', () => {
  it('maps add_node actions to linked outputs', () => {
    const actions: CanvasAction[] = [
      {
        type: 'add_node',
        payload: {
          id: 'image-1',
          nodeType: 'image',
          data: { title: '主视觉海报' },
        },
      },
      {
        type: 'add_node',
        payload: {
          id: 'prompt-1',
          nodeType: 'prompt',
          data: { prompt: '唐朝宰相三视图方案' },
        },
      },
    ]

    expect(deriveLinkedOutputs(actions)).toEqual([
      { nodeId: 'image-1', title: '主视觉海报', nodeType: 'image', status: 'done' },
      { nodeId: 'prompt-1', title: '唐朝宰相三视图方案', nodeType: 'prompt', status: 'done' },
    ])
  })

  it('truncates title to 20 chars and defaults missing fields', () => {
    const actions: CanvasAction[] = [
      {
        type: 'add_node',
        payload: {
          id: 'node-1',
          data: { title: '这是一段非常非常非常非常非常非常非常非常长的标题' },
        },
      },
      {
        type: 'add_node',
        payload: { id: 'node-2' },
      },
    ]

    expect(deriveLinkedOutputs(actions)).toEqual([
      { nodeId: 'node-1', title: '这是一段非常非常非常非常非常非常非常非常', nodeType: 'image', status: 'done' },
      { nodeId: 'node-2', title: '未命名', nodeType: 'image', status: 'done' },
    ])
  })

  it('ignores non-add_node actions and add_node without id', () => {
    const actions: CanvasAction[] = [
      { type: 'update_node', payload: { id: 'x-1', data: { title: 'skip' } } },
      { type: 'add_node', payload: { nodeType: 'image' } },
    ]

    expect(deriveLinkedOutputs(actions)).toEqual([])
  })
})

describe('buildTurnMetadata', () => {
  it('merges presentation and execution events', () => {
    const meta = buildTurnMetadata({
      presentation: { kind: 'macro_scheme_cards', body: { schemes: [] } },
      executionEvents: [{ type: 'step', data: { id: 's1', label: 'x', status: 'done' } }],
    })
    expect(meta?.presentation?.kind).toBe('macro_scheme_cards')
    expect(meta?.executionEvents).toHaveLength(1)
  })

  it('returns undefined when empty', () => {
    expect(buildTurnMetadata({})).toBeUndefined()
  })
})

describe('AgentService streamConversation', () => {
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
    // 退役后 PI_RUNTIME_MODE 默认 active；这里显式设，避免受本地 .env / CI 环境影响
    process.env.PI_RUNTIME_MODE = 'active'
    delete process.env.PI_RUNTIME_URL

    agentMessageCreate.mockResolvedValue({})
    agentMessageFindMany.mockResolvedValue([
      { role: 'user', content: 'hello' },
    ])
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
        agentMessage: {
          create: agentMessageCreate,
          findMany: agentMessageFindMany,
        },
        agentThread: {
          findUnique: agentThreadFindUnique,
          upsert: agentThreadUpsert,
          update: agentThreadUpdate,
        },
        session: {
          findUnique: sessionFindUnique,
          update: sessionUpdate,
        },
        idempotencyRecord: {
          create: idempotencyRecordCreate,
          findUnique: idempotencyRecordFindUnique,
          updateMany: idempotencyRecordUpdateMany,
          deleteMany: idempotencyRecordDeleteMany,
        },
        userAiPreferences: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      } as never,
      { create: vi.fn() } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
  })

  it('returns runtime_unavailable error when PI_RUNTIME_URL is unset', async () => {
    const piSpy = vi.spyOn(service, 'createPiRuntimeClient')

    const events: Array<{ type: string; data?: unknown }> = []
    for await (const event of service.streamConversation('s1', 'hello', 'u1')) {
      events.push(event)
    }

    expect(piSpy).not.toHaveBeenCalled()
    expect(events).toEqual([
      {
        type: 'error',
        data: {
          message: 'Agent 服务暂不可用，请稍后重试。',
          error_type: 'runtime_unavailable',
        },
      },
      { type: 'done', data: {} },
    ])
    expect(agentMessageCreate).toHaveBeenCalledTimes(1)
  })

  it('streams pi-runtime events, collects canvas actions and persists the turn', async () => {
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([
      piEvent('message_update', { event: { type: 'text_delta', delta: 'from-pi' } }),
      piEvent('tool_execution_end', {
        isError: false,
        result: {
          details: {
            actions: [
              {
                type: 'add_node',
                payload: {
                  id: 'prompt-1',
                  nodeType: 'prompt',
                  data: { prompt: '方案' },
                  position: { x: 0, y: 0 },
                },
              },
            ],
          },
        },
      }),
      piEvent('agent_end', { status: 'completed' }),
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const events: Array<{ type: string; data?: unknown }> = []
    for await (const event of service.streamConversation(
      's1',
      '营销',
      'u1',
      's1:thread-a',
    )) {
      events.push(event)
    }

    expect(pi.createSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ userId: 'u1' }),
    )
    // tool_execution_end 同时派生 canvas_action（details.actions）与 tool_result（UI 执行过程）
    expect(events.map((e) => e.type)).toEqual([
      'text_delta',
      'canvas_action',
      'tool_result',
      'done',
    ])
    // pi 路径跳过 canvasData 重写（Nest 内部工具已写）
    expect(sessionUpdate).not.toHaveBeenCalled()
    expect(agentMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        role: 'assistant',
        linkedOutputs: JSON.stringify([
          {
            nodeId: 'prompt-1',
            title: '方案',
            nodeType: 'prompt',
            status: 'done',
          },
        ]),
      }),
    })
  })

  it('returns runtime_unavailable when pi-runtime healthz fails', async () => {
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([], false)
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const events: Array<{ type: string; data?: unknown }> = []
    for await (const event of service.streamConversation('s1', 'hello', 'u1')) {
      events.push(event)
    }

    expect(pi.createSession).not.toHaveBeenCalled()
    expect(events[0]).toEqual({
      type: 'error',
      data: {
        message: 'Agent 服务暂不可用，请稍后重试。',
        error_type: 'runtime_unavailable',
      },
    })
    expect(events[events.length - 1]).toEqual({ type: 'done', data: {} })
  })

  it('forwards validated sidebar attachments to pi session', async () => {
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const attachments = [
      {
        id: 'a1',
        mediaType: 'image' as const,
        sourceKind: 'upload' as const,
        label: 'p.jpg',
        url: 'https://x/a.jpg',
      },
    ]

    for await (const _event of service.streamConversation(
      's1',
      '营销',
      'u1',
      's1:thread-a',
      undefined,
      undefined,
      undefined,
      undefined,
      attachments,
      ['a1'],
    )) {
      // drain
    }

    expect(pi.createSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        attachments,
        refOrder: ['a1'],
      }),
    )
    expect(agentMessageCreate).toHaveBeenCalledWith({
      data: {
        sessionId: 's1',
        threadId: 's1:thread-a',
        role: 'user',
        content: '营销',
        attachments: JSON.stringify(attachments),
      },
    })
  })
})

describe('AgentService idempotency', () => {
  const idempotencyRecordCreate = vi.fn()
  const idempotencyRecordFindUnique = vi.fn()
  const idempotencyRecordUpdateMany = vi.fn()
  const idempotencyRecordDeleteMany = vi.fn()
  const agentMessageCreate = vi.fn()
  const agentMessageFindMany = vi.fn()
  const agentThreadFindUnique = vi.fn()
  const agentThreadUpsert = vi.fn()
  const agentThreadUpdate = vi.fn()
  const sessionFindUnique = vi.fn()
  const sessionUpdate = vi.fn()

  let service: AgentService

  beforeEach(() => {
    vi.restoreAllMocks()
    agentMessageCreate.mockResolvedValue({})
    agentMessageFindMany.mockResolvedValue([])
    sessionFindUnique.mockResolvedValue(null)
    sessionUpdate.mockResolvedValue({})
    idempotencyRecordCreate.mockResolvedValue({})
    idempotencyRecordFindUnique.mockResolvedValue(null)
    idempotencyRecordUpdateMany.mockResolvedValue({ count: 1 })
    idempotencyRecordDeleteMany.mockResolvedValue({ count: 0 })

    service = new AgentService(
      {
        agentMessage: {
          create: agentMessageCreate,
          findMany: agentMessageFindMany,
        },
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
        userAiPreferences: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      } as never,
      { create: vi.fn() } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
  })

  it('checkIdempotencyKey returns null for unknown key', async () => {
    idempotencyRecordFindUnique.mockResolvedValue(null)
    const result = await service.checkIdempotencyKey('unknown-key')
    expect(result).toBeNull()
  })

  it('checkIdempotencyKey returns processing for active key', async () => {
    idempotencyRecordFindUnique.mockResolvedValue({
      idempotencyKey: 'ik-test',
      status: 'processing',
      resultSummary: null,
    })
    const result = await service.checkIdempotencyKey('ik-test')
    expect(result).toEqual({ status: 'processing', resultSummary: undefined })
  })

  it('checkIdempotencyKey returns completed for finished key', async () => {
    idempotencyRecordFindUnique.mockResolvedValue({
      idempotencyKey: 'ik-test',
      status: 'completed',
      resultSummary: '方案已确认',
    })
    const result = await service.checkIdempotencyKey('ik-test')
    expect(result).toEqual({ status: 'completed', resultSummary: '方案已确认' })
  })

  it('checkIdempotencyKey lazily cleans expired records', async () => {
    await service.checkIdempotencyKey('any-key')
    expect(idempotencyRecordDeleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: expect.any(Date) } },
    })
  })

  it('registerIdempotencyKey creates record with 5-min TTL', async () => {
    await service.registerIdempotencyKey('ik-123', 's1', 't1')
    expect(idempotencyRecordCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        idempotencyKey: 'ik-123',
        sessionId: 's1',
        threadId: 't1',
        status: 'processing',
      }),
    })
    const call = idempotencyRecordCreate.mock.calls[0][0] as { data: { expiresAt: Date } }
    const ttl = call.data.expiresAt.getTime() - Date.now()
    expect(ttl).toBeGreaterThan(4 * 60 * 1000) // > 4 min
    expect(ttl).toBeLessThanOrEqual(6 * 60 * 1000) // <= 6 min (buffer)
  })

  it('registerIdempotencyKey ignores unique constraint conflict', async () => {
    idempotencyRecordCreate.mockRejectedValue(new Error('Unique constraint failed'))
    // Should not throw
    await expect(service.registerIdempotencyKey('ik-dupe', 's1', 't1')).resolves.toBeUndefined()
  })

  it('completeIdempotencyKey updates status and resultSummary', async () => {
    await service.completeIdempotencyKey('ik-123', '方案已确认，正在拆解画布')
    expect(idempotencyRecordUpdateMany).toHaveBeenCalledWith({
      where: { idempotencyKey: 'ik-123', status: 'processing' },
      data: { status: 'completed', resultSummary: '方案已确认，正在拆解画布' },
    })
  })

  it('completeIdempotencyKey truncates resultSummary to 500 chars', async () => {
    const longText = 'x'.repeat(600)
    await service.completeIdempotencyKey('ik-123', longText)
    const call = idempotencyRecordUpdateMany.mock.calls[0][0] as { data: { resultSummary: string } }
    expect(call.data.resultSummary.length).toBe(500)
  })
})

describe('AgentService checkRuntimeHealth', () => {
  const agentMessageCreate = vi.fn()
  const agentMessageFindMany = vi.fn()
  const sessionFindUnique = vi.fn()
  const sessionUpdate = vi.fn()
  const idempotencyRecordCreate = vi.fn()
  const idempotencyRecordFindUnique = vi.fn()
  const idempotencyRecordUpdateMany = vi.fn()
  const idempotencyRecordDeleteMany = vi.fn()

  let service: AgentService

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    delete process.env.PI_RUNTIME_URL

    service = new AgentService(
      {
        agentMessage: { create: agentMessageCreate, findMany: agentMessageFindMany },
        session: { findUnique: sessionFindUnique, update: sessionUpdate },
        idempotencyRecord: {
          create: idempotencyRecordCreate,
          findUnique: idempotencyRecordFindUnique,
          updateMany: idempotencyRecordUpdateMany,
          deleteMany: idempotencyRecordDeleteMany,
        },
        userAiPreferences: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      } as never,
      { create: vi.fn() } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
  })

  it('returns ok:false when PI_RUNTIME_URL is unset', async () => {
    const result = await service.checkRuntimeHealth()
    expect(result).toEqual({ ok: false })
  })

  it('returns ok:true when pi-runtime is healthy', async () => {
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(stubPiClient([]))

    const result = await service.checkRuntimeHealth()
    expect(result.ok).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('returns ok:false when pi-runtime is unreachable', async () => {
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(stubPiClient([], false))

    const result = await service.checkRuntimeHealth()
    expect(result).toEqual({ ok: false })
  })

  it('returns ok:false in maintenance mode (PI_RUNTIME_MODE=off)', async () => {
    process.env.PI_RUNTIME_MODE = 'off'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const piSpy = vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(stubPiClient([]))

    expect(await service.checkRuntimeHealth()).toEqual({ ok: false })
    expect(piSpy).not.toHaveBeenCalled()
  })
})
