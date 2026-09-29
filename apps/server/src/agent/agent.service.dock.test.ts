import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { piEvent, stubPiClient } from './agent.test-utils'

/**
 * dock（UI 技能选择器 + 模型选择）在退役后的转接断言：
 * 老链路把这些字段塞进 LangGraph `streamRun` body（llmProviderRef/llmModel/...），
 * pi 链路换成两个出口——skillId → prompt 的 forceSkills，模型 → 会话级 llm 覆盖。
 */
describe('AgentService dock forwarding (pi-runtime)', () => {
  const agentMessageCreate = vi.fn()
  const resolveForGeneration = vi.fn()
  const userAiPreferencesFindUnique = vi.fn()

  let service: AgentService

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    agentMessageCreate.mockResolvedValue({})
    userAiPreferencesFindUnique.mockResolvedValue(null)
    resolveForGeneration.mockResolvedValue({
      channelId: 'platform',
      modelName: 'gpt-4o-mini',
      apiFormat: 'openai',
      credentials: { apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1' },
      source: 'platform',
    })

    service = new AgentService(
      {
        agentMessage: {
          create: agentMessageCreate,
          findMany: vi.fn().mockResolvedValue([]),
        },
        agentThread: {
          findUnique: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
        },
        session: {
          findUnique: vi.fn(),
          update: vi.fn(),
        },
        idempotencyRecord: {
          create: vi.fn(),
          findUnique: vi.fn(),
          updateMany: vi.fn(),
          deleteMany: vi.fn(),
        },
        userAiPreferences: {
          findUnique: userAiPreferencesFindUnique,
        },
      } as never,
      { create: vi.fn() } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration } as never,
    )
  })

  it('forwards mapped skillId to forceSkills; platform model stays on pi env (K-1 决策 A)', async () => {
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })], true, [
      { name: 'ecommerce-product-photo' },
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    for await (const _ of service.streamConversation(
      's1',
      'hello',
      'u1',
      'thread-1',
      undefined,
      'product-visual',
      'platform::gpt-4o-mini',
    )) {
      // drain
    }

    expect(resolveForGeneration).toHaveBeenCalledWith('u1', 'platform::gpt-4o-mini', 'text')
    // dock 短 id 经 mapUiSkillId 映射为 runtime 技能名 → forceSkills
    // P0-①：会话键 = threadId（对话），第 4 参另有 turnContext（画布/侧栏逐轮透传）
    expect(pi.prompt).toHaveBeenCalledWith(
      'thread-1',
      'hello',
      'main',
      expect.objectContaining({ forceSkills: ['ecommerce-product-photo'] }),
    )
    // 平台渠道（source=platform）不透传——生产上 Nest 平台通道与 pi env 不同源
    expect(pi.createSession).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({ llm: undefined }),
    )
  })

  it('falls back to user defaultTextModel; BYOK (source=user) is injected into the pi session', async () => {
    userAiPreferencesFindUnique.mockResolvedValue({
      defaultTextModel: 'ch-deepseek::deepseek-v4-flash',
    })
    resolveForGeneration.mockResolvedValue({
      channelId: 'ch-deepseek',
      modelName: 'deepseek-v4-flash',
      apiFormat: 'openai',
      credentials: { apiKey: 'sk-byok', baseUrl: 'https://api.deepseek.example/v1' },
      source: 'user',
    })
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    for await (const _ of service.streamConversation(
      's1',
      'hello',
      'u1',
      undefined,
      undefined,
      'storyboard',
    )) {
      // drain
    }

    expect(userAiPreferencesFindUnique).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      select: { defaultTextModel: true },
    })
    expect(resolveForGeneration).toHaveBeenCalledWith(
      'u1',
      'ch-deepseek::deepseek-v4-flash',
      'text',
    )
    // BYOK 真进 pi：会话创建即装配模型
    expect(pi.createSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        llm: expect.objectContaining({
          model: 'deepseek-v4-flash',
          apiKey: 'sk-byok',
          baseUrl: 'https://api.deepseek.example/v1',
          providerRef: 'ch-deepseek::deepseek-v4-flash',
          source: 'user',
        }),
      }),
    )
    // storyboard 未接入 → fail-soft 原文发送、无 forceSkills
    expect(pi.prompt).toHaveBeenCalledWith(
      's1',
      'hello',
      'main',
      expect.objectContaining({ forceSkills: undefined }),
    )
  })

  it('skips provider resolution when model and defaultTextModel are both omitted', async () => {
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    for await (const _ of service.streamConversation(
      's1',
      'hello',
      'u1',
      undefined,
      undefined,
      'storyboard',
    )) {
      // drain
    }

    expect(resolveForGeneration).not.toHaveBeenCalled()
    expect(pi.createSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ llm: undefined }),
    )
    expect(pi.prompt).toHaveBeenCalledWith(
      's1',
      'hello',
      'main',
      expect.objectContaining({ forceSkills: undefined }),
    )
  })
})
