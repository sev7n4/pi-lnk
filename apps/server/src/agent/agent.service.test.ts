import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BadRequestException, ConflictException } from '@nestjs/common'
import type { CanvasAction, SidebarAttachment } from '@lnkpi/shared'
import { AgentService, deriveLinkedOutputs, buildTurnMetadata } from './agent.service'
import { piEvent, stubPiClient } from './agent.test-utils'
import { InsufficientPointsError } from '../points/points.service'

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
                  id: 'text-1',
                  // 2026-10-17 prompt 节点下线：fixture 由 nodeType 'prompt' 改 'text'——
                  // 'prompt' 已退出 NODE_TYPES 白名单，画布动作会被契约校验静默丢弃。
                  nodeType: 'text',
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

    // P0-①：会话键 = threadId（对话），画布上下文改由 prompt turnContext 携带
    expect(pi.createSession).toHaveBeenCalledWith(
      's1:thread-a',
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
            nodeId: 'text-1',
            title: '方案',
            nodeType: 'text',
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

    // P0-①：侧栏素材不再随会话创建注入（会话常驻），改为每轮 prompt 的 turnContext 透传
    expect(pi.prompt).toHaveBeenCalledWith(
      's1:thread-a',
      '营销',
      'main',
      expect.objectContaining({
        turnContext: expect.objectContaining({
          attachments,
          refOrder: ['a1'],
        }),
      }),
    )
    expect(pi.createSession).toHaveBeenCalledWith(
      's1:thread-a',
      expect.objectContaining({ userId: 'u1' }),
    )
    const createOpts = pi.createSession.mock.calls[0]?.[1] as Record<string, unknown>
    expect(createOpts).not.toHaveProperty('attachments')
    expect(createOpts).not.toHaveProperty('refOrder')
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

  it('RB-D3 延伸：非法参考素材（超限）⇒ BadRequestException 400 化，不再裸 500', async () => {
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    // 6 个合法形状实体，仅数量超 SIDEBAR_ATTACHMENT_MAX=5
    const sixValidEntities: SidebarAttachment[] = Array.from({ length: 6 }, (_, i) => ({
      id: `b${i}`,
      mediaType: 'image' as const,
      sourceKind: 'upload' as const,
      label: `b${i}.jpg`,
      url: `https://x/${i}.png`,
    }))

    const drain = async () => {
      for await (const _event of service.streamConversation(
        's1',
        '营销',
        'u1',
        's1:thread-a',
        undefined,
        undefined,
        undefined,
        undefined,
        sixValidEntities,
      )) {
        // drain
      }
    }

    // 校验发生在首个 yield 之前，但 async generator 惰性执行——须驱动首项才触发
    await expect(drain()).rejects.toThrow(BadRequestException)
    await expect(drain()).rejects.toThrow(/最多添加/)
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

// ── P2 T6（token 精确计费）：回合预扣 + 结算 + turn_settled 事件 ──
// 照既有 mock 桩模式：points/pricing 服务整体 mock，pi-runtime 走 stubPiClient。
describe('AgentService turn billing (P2 T6)', () => {
  const agentMessageCreate = vi.fn()
  const agentThreadFindUnique = vi.fn()
  const agentThreadUpsert = vi.fn()
  const agentThreadUpdate = vi.fn()
  const freeze = vi.fn()
  const settleFromHold = vi.fn()
  const release = vi.fn()
  const quoteTextTokens = vi.fn()

  const msgEndWithUsage = (usage: Record<string, unknown>) =>
    piEvent('message_end', { message: { usage } })

  let service: AgentService

  const buildService = () => {
    service = new AgentService(
      {
        agentMessage: { create: agentMessageCreate, findMany: vi.fn().mockResolvedValue([]) },
        agentThread: {
          findUnique: agentThreadFindUnique,
          upsert: agentThreadUpsert,
          update: agentThreadUpdate,
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
      } as never,
      { create: vi.fn() } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
      undefined,
      undefined,
      undefined,
      // P2 T6：points / pricing 服务替身（@Optional 注入，位置参数第 8/9 位）
      { freeze, settleFromHold, release } as never,
      { quoteTextTokens } as never,
    )
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    delete process.env.PI_RUNTIME_URL
    delete process.env.TEXT_TOKEN_BILLING

    agentMessageCreate.mockResolvedValue({})
    agentThreadFindUnique.mockResolvedValue({ id: 's1:thread-a' })
    agentThreadUpsert.mockResolvedValue({})
    agentThreadUpdate.mockResolvedValue({})
    freeze.mockResolvedValue({ id: 'hold-1', amount: 4, status: 'held', createdAt: new Date() })
    settleFromHold.mockResolvedValue({ settled: 3, released: 0 })
    release.mockResolvedValue(undefined)
    quoteTextTokens.mockResolvedValue({
      credits: 3,
      ruleVersion: 'price-v2',
      breakdown: { in: 2, cache: 0, out: 1 },
    })
    buildService()
  })

  afterEach(() => {
    delete process.env.TEXT_TOKEN_BILLING
  })

  /** 驱动一轮成功回合（带 usage 的 message_end + agent_end）。 */
  const runTurn = async (...rest: unknown[]) => {
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([
      msgEndWithUsage({
        input: 8000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 500,
        cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 },
      }),
      piEvent('agent_end', { status: 'completed' }),
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    const events: Array<{ type: string; data?: unknown }> = []
    for await (const event of service.streamConversation('s1', 'hi', 'u1', 's1:thread-a')) {
      events.push(event)
    }
    void rest
    return events
  }

  const assistantMetadata = (): Record<string, unknown> => {
    const call = agentMessageCreate.mock.calls
      .map((c) => (c[0] as { data: { role: string; metadata: string | null } }).data)
      .find((d) => d.role === 'assistant')
    expect(call).toBeDefined()
    return call?.metadata ? (JSON.parse(call.metadata) as Record<string, unknown>) : {}
  }

  it('① flag on + 余额足：预扣 ceil(典型×1.2) + 按实际 usage 结算 + turn_settled 事件', async () => {
    process.env.TEXT_TOKEN_BILLING = 'on'
    const events = await runTurn()

    // 预扣额 = ceil(quote(典型回合 8K in + 0.8K cacheWrite + 0.5K out).credits × 1.2) = ceil(3×1.2) = 4
    expect(freeze).toHaveBeenCalledTimes(1)
    expect(freeze).toHaveBeenCalledWith('u1', 4, '对话回合预扣')
    // modelKey 入口 toLowerCase 规范化：dock 传 'STEP-3.5-Flash' → quote 收 'step-3.5-flash'
    // （runTurn 未传 model → 回落用户默认文本模型，mock 为空 → ''；此处直接断言 quote 入参形状）
    const preCall = quoteTextTokens.mock.calls[0]?.[2] as Record<string, unknown>
    expect(preCall).toMatchObject({
      inputTokens: 8000,
      cacheReadTokens: 0,
      cacheWriteTokens: 800, // 终审 C-2：典型回合含缓存写入
      outputTokens: 500,
    })
    // 结算 quote：turn_usage 折叠值直取 + costUsd=cost + cacheWrite 透传（并入 in 项计费）
    expect(quoteTextTokens).toHaveBeenCalledTimes(2)
    const settleCall = quoteTextTokens.mock.calls[1]
    expect(settleCall?.[0]).toBe('u1')
    expect(settleCall?.[2]).toMatchObject({
      inputTokens: 8000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 500,
      costUsd: 0.02,
    })
    expect(settleFromHold).toHaveBeenCalledTimes(1)
    expect(settleFromHold).toHaveBeenCalledWith(
      'hold-1',
      3,
      '对话回合结算',
      expect.objectContaining({
        category: 'text',
        ruleVersion: 'price-v2',
      }),
    )
    // turn_settled 落 metadata.executionEvents；键不出现：非 degraded 不带 degraded 键
    const meta = assistantMetadata()
    const settled = (meta.executionEvents as Array<{ type: string; data: unknown }>)?.find(
      (e) => e.type === 'turn_settled',
    )
    // 终审 I-1：tokens = 原始 token 数（展示口径，千级）；breakdown = 积分成分（个位）
    expect(settled?.data).toEqual({
      holdId: 'hold-1',
      credits: 3,
      breakdown: { in: 2, cache: 0, out: 1 },
      tokens: { in: 8000, cache: 0, out: 500 },
      ruleVersion: 'price-v2',
    })
    expect(events[events.length - 1]?.type).toBe('done')
  })

  it('①c cacheWrite 结算透传 + turn_settled.tokens 原始 token 明细（终审 C-2/I-1）', async () => {
    process.env.TEXT_TOKEN_BILLING = 'on'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([
      msgEndWithUsage({
        input: 8000,
        cacheRead: 300,
        cacheWrite: 800,
        output: 500,
        cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 },
      }),
      piEvent('agent_end', { status: 'completed' }),
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const events: Array<{ type: string; data?: unknown }> = []
    for await (const event of service.streamConversation('s1', 'hi', 'u1', 's1:thread-a')) {
      events.push(event)
    }

    // 预扣典型口径含 cacheWrite 800（典型回合含缓存写入，与 settle 计费口径同构）
    expect(quoteTextTokens.mock.calls[0]?.[2]).toMatchObject({
      inputTokens: 8000,
      cacheReadTokens: 0,
      cacheWriteTokens: 800,
      outputTokens: 500,
    })
    // 结算 usage：cacheWriteTokens 透传（quoteTextTokens 并入 in 项计费）
    expect(quoteTextTokens.mock.calls[1]?.[2]).toMatchObject({
      inputTokens: 8000,
      cacheReadTokens: 300,
      cacheWriteTokens: 800,
      outputTokens: 500,
    })
    // tokens = 原始 token 数（in=inputTokens / cache=cacheRead / out=output，千级展示口径）
    const meta = assistantMetadata()
    const settled = (meta.executionEvents as Array<{ type: string; data: unknown }>)?.find(
      (e) => e.type === 'turn_settled',
    )
    expect(settled?.data).toMatchObject({
      credits: 3,
      breakdown: { in: 2, cache: 0, out: 1 },
      tokens: { in: 8000, cache: 300, out: 500 },
    })
    expect(events[events.length - 1]?.type).toBe('done')
  })

  it('①b 预扣 quote 用回合参数 model（toLowerCase 规范化）', async () => {
    process.env.TEXT_TOKEN_BILLING = 'on'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    // streamConversation 第 7 个位置参数 = model
    for await (const _event of service.streamConversation(
      's1',
      'hi',
      'u1',
      's1:thread-a',
      undefined,
      undefined,
      'STEP-3.5-Flash',
    )) {
      // drain
    }
    expect(quoteTextTokens.mock.calls[0]?.[1]).toBe('step-3.5-flash')
    expect(freeze).toHaveBeenCalledWith('u1', 4, '对话回合预扣')
  })

  it('② 用户 run 余额不足 → 402 语义拒绝，回合不发起', async () => {
    process.env.TEXT_TOKEN_BILLING = 'on'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    // F1（P2 T6 修复轮）：分类必须走 instanceof InsufficientPointsError，不得字符串匹配。
    // 防回退锚：桩的 message 与 points 层真实文案（'可用积分不足'）完全不同——
    // 若回归为 message.includes('积分不足') 判定，此用例会 fail-open（免费执行）而非拒绝。
    const insufficient = new InsufficientPointsError()
    Object.defineProperty(insufficient, 'message', { value: 'NO_BALANCE_LEFT_AT_ALL' })
    freeze.mockRejectedValue(insufficient)
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const events: Array<{ type: string; data?: unknown }> = []
    for await (const event of service.streamConversation('s1', 'hi', 'u1', 's1:thread-a')) {
      events.push(event)
    }

    const err = events.find((e) => e.type === 'error')
    expect(err?.data).toMatchObject({
      message: '积分不足，请充值后重试。',
      error_type: 'insufficient_credits',
    })
    expect(events[events.length - 1]?.type).toBe('done')
    // 回合未发起：会话创建与 prompt 均未发生
    expect(pi.createSession).not.toHaveBeenCalled()
    expect(pi.prompt).not.toHaveBeenCalled()
    expect(settleFromHold).not.toHaveBeenCalled()
  })

  it('③ error 路径 → release 全退 + turn_settled {released: true}，不走 settle', async () => {
    process.env.TEXT_TOKEN_BILLING = 'on'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([
      msgEndWithUsage({ input: 100, cacheRead: 0, cacheWrite: 0, output: 20 }),
      piEvent('error', { error: { message: 'upstream down' } }),
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const events: Array<{ type: string; data?: unknown }> = []
    for await (const event of service.streamConversation('s1', 'hi', 'u1', 's1:thread-a')) {
      events.push(event)
    }

    expect(events.some((e) => e.type === 'error')).toBe(true)
    expect(settleFromHold).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith('hold-1', '对话回合异常全退')
    const meta = assistantMetadata()
    const settled = (meta.executionEvents as Array<{ type: string; data: unknown }>)?.find(
      (e) => e.type === 'turn_settled',
    )
    // 键不出现：released 场景只带 holdId + released
    expect(settled?.data).toEqual({ holdId: 'hold-1', released: true })
  })

  it('③b settle 抛 409 → release 兜底 + turn_settled {released: true}', async () => {
    process.env.TEXT_TOKEN_BILLING = 'on'
    settleFromHold.mockRejectedValue(new ConflictException('积分状态异常，结算中止'))
    await runTurn()

    expect(settleFromHold).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith('hold-1', '对话回合结算失败全退')
    const meta = assistantMetadata()
    const settled = (meta.executionEvents as Array<{ type: string; data: unknown }>)?.find(
      (e) => e.type === 'turn_settled',
    )
    expect(settled?.data).toEqual({ holdId: 'hold-1', released: true })
  })

  it('⑥ 消费方提前 .return()（generator 中断）→ hold 即时 release，不走 settle', async () => {
    // F2（P2 T6 修复轮）：前端 abort SSE → 消费方 .return() → 生成器收束，
    // 尾部结算块不可达 → 修复前 hold 滞留至 reaper 30min；修复后 finally 即时全退。
    process.env.TEXT_TOKEN_BILLING = 'on'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([
      msgEndWithUsage({ input: 8000, cacheRead: 0, cacheWrite: 0, output: 500 }),
      piEvent('agent_end', { status: 'completed' }),
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const gen = service.streamConversation('s1', 'hi', 'u1', 's1:thread-a')
    const first = await gen.next()
    expect(first.done).toBe(false)
    // 模拟前端 abort：SSE 桥接层对生成器调 .return()，finally 兜底释放
    await gen.return(undefined)

    expect(settleFromHold).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith('hold-1', '回合中断，预扣全退')
    // 中断路径 finalizeTurn 不可达：assistant 消息不落库（turn_settled 只进内存
    // executionEvents，外部可观测信号即 release 调用本身）
    const assistantCall = agentMessageCreate.mock.calls
      .map((c) => (c[0] as { data: { role: string } }).data)
      .find((d) => d.role === 'assistant')
    expect(assistantCall).toBeUndefined()
  })

  it('④ flag off → 零预扣零结算（回归锚：Q2 行为逐字节不变）', async () => {
    await runTurn()

    expect(freeze).not.toHaveBeenCalled()
    expect(quoteTextTokens).not.toHaveBeenCalled()
    expect(settleFromHold).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    const meta = assistantMetadata()
    const settled = (meta.executionEvents as Array<{ type: string; data: unknown }>)?.find(
      (e) => e.type === 'turn_settled',
    )
    expect(settled).toBeUndefined()
  })

  it('⑤ automation run 预扣失败 → 降级不预扣照常执行 + warn', async () => {
    process.env.TEXT_TOKEN_BILLING = 'on'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    freeze.mockRejectedValue(new BadRequestException('可用积分不足'))
    const pi = stubPiClient([
      msgEndWithUsage({ input: 100, cacheRead: 0, cacheWrite: 0, output: 20 }),
      piEvent('agent_end', { status: 'completed' }),
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    // billingSource 作为末位参数透传（automation 触发方标识）
    const events: Array<{ type: string; data?: unknown }> = []
    for await (const event of service.streamConversation(
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
      'automation',
    )) {
      events.push(event)
    }

    expect(freeze).toHaveBeenCalledTimes(1)
    // 无 402 拒绝：回合照常发起并完成
    expect(events.some((e) => e.type === 'error' && (e.data as { error_type?: string }).error_type === 'insufficient_credits')).toBe(false)
    expect(pi.prompt).toHaveBeenCalledTimes(1)
    expect(events[events.length - 1]?.type).toBe('done')
    expect(settleFromHold).not.toHaveBeenCalled()
  })
})
