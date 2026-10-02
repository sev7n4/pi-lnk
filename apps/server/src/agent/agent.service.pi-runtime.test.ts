/**
 * pi-runtime 开关与链路测试（老 LangGraph runtime 已于 2026-09-27 退役）
 *
 * 覆盖二态开关语义：
 *   active（默认） — healthz 通过 → 事件流走 pi-runtime 并正确映射/清理
 *   active 失败    — healthz 不通过 → 直接报不可用（没有第二条链路）
 *   off（维护态）  — 停用 agent 服务，chat 与心跳都报不可用
 *
 * 退役变化：原三态里的 shadow（镜像到 pi、LangGraph 照常服务）随老 runtime 一起删除，
 * `off` 的语义从「切回 LangGraph」变成「维护态关停」。
 */
import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { piEvent, stubPiClient } from './agent.test-utils'
import { type PiRuntimeClient } from './pi-runtime/pi-runtime.client'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'
import type { SidebarAttachment } from '@lnkpi/shared'
import { resetSidebarParseCache } from './sidebar-vision'

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

  describe('K-1 BYOK 透传 pi-runtime（决策 A：只透传 source=user）', () => {
    const BYOK_RESOLVED = {
      modelName: 'deepseek-flash',
      credentials: { apiKey: 'sk-BYOK', baseUrl: 'https://api.deepseek.com/' },
      source: 'user' as const,
    }
    const PLATFORM_RESOLVED = {
      modelName: 'agnes-2.0-flash',
      credentials: { apiKey: 'sk-PLATFORM', baseUrl: 'https://apihub.agnes-ai.cn/v1' },
      source: 'platform' as const,
    }

    function setResolver(resolved: typeof BYOK_RESOLVED | null) {
      const resolver = (service as unknown as { providerResolver: { resolveForGeneration: unknown } })
        .providerResolver as { resolveForGeneration: ReturnType<typeof vi.fn> }
      if (!resolved) {
        resolver.resolveForGeneration.mockRejectedValue(new Error('channel not found'))
      } else {
        resolver.resolveForGeneration.mockResolvedValue(resolved)
      }
    }

    /** 跑一轮 active 对话，返回 createSession 收到的 opts。 */
    async function runTurn(model?: string) {
      process.env.PI_RUNTIME_MODE = 'active'
      process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
      const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
      vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
      for await (const _e of service.streamConversation(
        's1',
        'hello',
        'u1',
        undefined,
        undefined,
        undefined,
        model,
      )) {
        // drain
      }
      return pi.createSession.mock.calls[0]?.[1] as Record<string, unknown> | undefined
    }

    afterEach(() => {
      delete process.env.PI_LLM_PASSTHROUGH
    })

    it('BYOK 模型 → create body 带 llm（source=user + 能力字段）', async () => {
      setResolver(BYOK_RESOLVED)
      const opts = await runTurn('ch_byok::deepseek-flash')
      expect(opts?.llm).toEqual({
        model: 'deepseek-flash',
        apiKey: 'sk-BYOK',
        baseUrl: 'https://api.deepseek.com/',
        providerRef: 'ch_byok::deepseek-flash',
        source: 'user',
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 8_192,
      })
    })

    it('平台模型 → 不带 llm（决策 A：平台用户保持 pi env 装配，零变化）', async () => {
      setResolver(PLATFORM_RESOLVED)
      const opts = await runTurn('platform::agnes-2.0-flash')
      expect(opts?.llm).toBeUndefined()
    })

    it('PI_LLM_PASSTHROUGH=off → 不发 llm（回滚开关）', async () => {
      process.env.PI_LLM_PASSTHROUGH = 'off'
      setResolver(BYOK_RESOLVED)
      const opts = await runTurn('ch_byok::deepseek-flash')
      expect(opts?.llm).toBeUndefined()
    })

    it('resolve 失败（渠道停用/无 key）→ fail-soft 不发 llm', async () => {
      setResolver(null)
      const opts = await runTurn('ch_byok::deepseek-flash')
      expect(opts?.llm).toBeUndefined()
    })

    it('未指定 model 且无默认模型 → 不发 llm', async () => {
      setResolver(BYOK_RESOLVED)
      const opts = await runTurn(undefined)
      expect(opts?.llm).toBeUndefined()
    })
  })

  describe('409 → steer 回退（原先 `catch(() => {})` 静默吞消息，2026-10-02 修）', () => {
    /**
     * 跑一轮 active 对话，可调 prompt / steer 的行为。
     *
     * 为什么这条值得单独立一个用例：409 表示「上一轮还在跑，这次发言没进去」，
     * 此时 SSE 里**不会有任何东西**（没有 error 事件，因为压根没进 run），
     * 所以老代码的空 catch 让「用户发了、世界没反应」彻底不可观测。
     */
    async function runTurnWith(
      promptImpl: () => Promise<unknown>,
      steerImpl: () => Promise<unknown>,
      opts: { expectSteer?: boolean } = {},
    ) {
      process.env.PI_RUNTIME_MODE = 'active'
      process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
      const prompt = vi.fn(promptImpl)
      const steer = vi.fn(steerImpl)
      const client = {
        healthz: vi.fn().mockResolvedValue({ status: 'ok' }),
        createSession: vi.fn().mockResolvedValue({
          sessionId: 'x',
          provider: 'agnes',
          model: 'agnes-2.5-pro',
          status: 'created',
        }),
        prompt,
        steer,
        listSkills: vi.fn().mockResolvedValue({ skills: [] }),
        streamEvents: vi.fn((_id: string, onEvent: (event: PiRuntimeEvent) => void) => {
          onEvent(piEvent('agent_end', { status: 'completed' }))
          return () => {}
        }),
      }
      vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(client as never)
      for await (const _e of service.streamConversation('s1', 'hello', 'u1')) {
        /* drain */
      }
      // prompt 的 catch 挂在 `void` 上异步收尾：本轮流结束≠回退跑完，
      // 因此这里显式等一次，避免断言跑在回退之前（flaky 而非失败）。
      // 只等 prompt —— 「steer 该不该被调」由各用例自己断言（503 用例就该是 false）。
      await vi.waitFor(() => expect(prompt).toHaveBeenCalled())
      if (opts.expectSteer) await vi.waitFor(() => expect(steer).toHaveBeenCalled())
      return { prompt, steer }
    }

    it('prompt 409 → 自动改走 steer 队列（消息不蒸发，且能被 vendor 下一 turn 边界接住）', async () => {
      const busy = Object.assign(new Error('session busy'), { status: 409 })
      const { steer } = await runTurnWith(
        () => Promise.reject(busy),
        () => Promise.resolve({ queued: true }),
        { expectSteer: true },
      )
      expect(steer).toHaveBeenCalledTimes(1)
      expect(steer.mock.calls[0]?.[1]).toBe('hello') // 原文透传，不多轮一次组装
    })

    it('prompt 409 且 steer 也失败 → 留 warn 痕迹（不留黑洞）', async () => {
      const warn = vi.spyOn(
        (service as unknown as { piLogger: { warn: (m: string) => void } }).piLogger,
        'warn',
      )
      const busy = Object.assign(new Error('session busy'), { status: 409 })
      const { steer } = await runTurnWith(
        () => Promise.reject(busy),
        () => Promise.reject(new Error('queue rejected')),
        { expectSteer: true },
      )
      expect(steer).toHaveBeenCalledTimes(1)
      // 用真实字符串断言而非 /regex/：stderr 里的 Nest 前缀会干扰正则匹配
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n')
      expect(logged).toContain('pi steer fallback failed')
      expect(logged).toContain('queue rejected')
      warn.mockRestore()
    })

    it('非 409 的 prompt 失败（503/上游）→ 不劫持成 steer，只留 warn', async () => {
      const warn = vi.spyOn(
        (service as unknown as { piLogger: { warn: (m: string) => void } }).piLogger,
        'warn',
      )
      const { steer } = await runTurnWith(
        () => Promise.reject(Object.assign(new Error('upstream 503'), { status: 503 })),
        () => Promise.resolve({ queued: true }),
      )
      expect(steer).not.toHaveBeenCalled()
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n')
      expect(logged).toContain('pi prompt failed')
      warn.mockRestore()
    })
  })

  describe('③ 侧栏识图进 pi（老 runtime parse_sidebar_media 等价物）', () => {
    const IMAGE_ATTACHMENT: SidebarAttachment[] = [
      { id: 'a1', mediaType: 'image', sourceKind: 'upload', label: '参考图 1', url: 'https://cdn/1.png' },
    ]
    const VISION_OK = {
      pass: true,
      reason: 'ok',
      visionUsed: true,
      userFacingSummary: '一双白色运动鞋，侧拍',
      category: '运动鞋',
    }

    /**
     * 注意：基础 systemPrompt 的规则 7 里本身就有「若已提供【侧栏参考图解析】」这句字面量，
     * 所以断言不能用裸的【侧栏参考图解析】，要用解析块的起始行做标记。
     */
    const PARSE_BLOCK_MARKER = '【侧栏参考图解析】\n摘要：'

    // 解析缓存是模块级 Map，跨用例必须清（否则前一条用例的成功块会被下一条命中）
    beforeEach(() => {
      resetSidebarParseCache()
    })

    function setResolver(modelName: string) {
      const resolver = (service as unknown as { providerResolver: { resolveForGeneration: unknown } })
        .providerResolver as { resolveForGeneration: ReturnType<typeof vi.fn> }
      resolver.resolveForGeneration.mockResolvedValue({
        modelName,
        credentials: { apiKey: 'sk-x', baseUrl: 'https://gw/v1' },
        source: 'user',
      })
    }

    function setVisionTools(impl: (input: unknown) => Promise<unknown>) {
      ;(service as unknown as { canvasTools: unknown }).canvasTools = { runVisionQa: vi.fn(impl) }
      return (service as unknown as { canvasTools: { runVisionQa: ReturnType<typeof vi.fn> } })
        .canvasTools.runVisionQa
    }

    /**
     * 跑一轮并返回本轮的动态上下文块（P0-①：侧栏识图结果随 turnContext.dynamicBlocks
     * 逐轮透传，不再并入 create 的 systemPrompt）。
     */
    async function runTurnWithAttachments(attachments?: SidebarAttachment[]) {
      process.env.PI_RUNTIME_MODE = 'active'
      process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
      const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
      vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
      for await (const _e of service.streamConversation(
        's1',
        '这图是什么',
        'u1',
        undefined,
        undefined,
        undefined,
        'ch_x::deepseek-flash',
        undefined,
        attachments,
      )) {
        // drain
      }
      const promptOpts = pi.prompt.mock.calls[0]?.[3] as
        | { turnContext?: { dynamicBlocks?: string[] } }
        | undefined
      return (promptOpts?.turnContext?.dynamicBlocks ?? []).join('\n')
    }

    afterEach(() => {
      delete process.env.PI_SIDEBAR_VISION
      ;(service as unknown as { canvasTools?: unknown }).canvasTools = undefined
    })

    it('贴图 + 视觉模型 → 调 runVisionQa，解析块并入 dynamicBlocks', async () => {
      setResolver('deepseek-flash')
      const runVisionQa = setVisionTools(async () => VISION_OK)
      const blocks = await runTurnWithAttachments(IMAGE_ATTACHMENT)
      expect(runVisionQa).toHaveBeenCalledTimes(1)
      const call = runVisionQa.mock.calls[0]?.[0] as { imageUrls: string[]; model: string }
      expect(call.imageUrls).toEqual(['https://cdn/1.png'])
      expect(call.model).toBe('deepseek-flash')
      expect(blocks).toContain(PARSE_BLOCK_MARKER)
      expect(blocks).toContain('摘要：一双白色运动鞋，侧拍')
    })

    it('非视觉模型 → 不调 runVisionQa，但出「未能识别」块（对齐 VISION_UNSUPPORTED）', async () => {
      setResolver('deepseek-v4-pro')
      const runVisionQa = setVisionTools(async () => VISION_OK)
      const blocks = await runTurnWithAttachments(IMAGE_ATTACHMENT)
      expect(runVisionQa).not.toHaveBeenCalled()
      // 老链路在 vision_used=false 时仍输出块（摘要=未知）+ 兜底话术，
      // 目的是不让模型拿着文件名去编一版空品类的上架方案。
      expect(blocks).toContain('【侧栏参考图解析】')
      expect(blocks).toContain('摘要：未知')
      expect(blocks).toContain('参考图未能识别')
    })

    it('识图抛错 → fail-soft：出「未能识别」块，不阻断对话', async () => {
      setResolver('deepseek-flash')
      setVisionTools(async () => {
        throw new Error('vision upstream 500')
      })
      const blocks = await runTurnWithAttachments(IMAGE_ATTACHMENT)
      expect(blocks).toContain('摘要：未知')
      expect(blocks).toContain('参考图未能识别')
    })

    it('无贴图 / 开关 off → 不调 runVisionQa，且不注入任何解析块', async () => {
      setResolver('deepseek-flash')
      const runVisionQa = setVisionTools(async () => VISION_OK)
      const noAtt = await runTurnWithAttachments(undefined)
      expect(runVisionQa).not.toHaveBeenCalled()
      expect(noAtt).not.toContain('【侧栏参考图解析】\n摘要')

      process.env.PI_SIDEBAR_VISION = 'off'
      const off = await runTurnWithAttachments(IMAGE_ATTACHMENT)
      expect(runVisionQa).not.toHaveBeenCalled()
      expect(off).not.toContain('【侧栏参考图解析】\n摘要')
    })

    it('跨轮复用：同 provider + 同图片集合，第二轮不再调 vision', async () => {
      setResolver('deepseek-flash')
      const runVisionQa = setVisionTools(async () => VISION_OK)
      const first = await runTurnWithAttachments(IMAGE_ATTACHMENT)
      const second = await runTurnWithAttachments(IMAGE_ATTACHMENT)
      expect(runVisionQa).toHaveBeenCalledTimes(1)
      expect(first).toContain('摘要：一双白色运动鞋，侧拍')
      expect(second).toContain('摘要：一双白色运动鞋，侧拍')
    })
  })

  describe('getPiRuntimeMode', () => {
    it('二态：默认 active；仅 OFF 显式关停（大小写/空白不敏感）', () => {
      expect(service.getPiRuntimeMode()).toBe('active')
      process.env.PI_RUNTIME_MODE = 'OFF'
      expect(service.getPiRuntimeMode()).toBe('off')
      process.env.PI_RUNTIME_MODE = ' off '
      expect(service.getPiRuntimeMode()).toBe('off')
      process.env.PI_RUNTIME_MODE = ' Active '
      expect(service.getPiRuntimeMode()).toBe('active')
      // 退役后 shadow 不再是合法态：镜像通道已随老 runtime 一起删除
      process.env.PI_RUNTIME_MODE = 'shadow'
      expect(service.getPiRuntimeMode()).toBe('active')
    })
  })

  it('off（维护态）：即使配置了 PI_RUNTIME_URL 也不触碰 pi-runtime', async () => {
    process.env.PI_RUNTIME_MODE = 'off'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const events: Array<{ type: string }> = []
    for await (const event of service.streamConversation('s1', 'hello', 'u1')) {
      events.push(event)
    }

    expect(pi.healthz).not.toHaveBeenCalled()
    expect(pi.createSession).not.toHaveBeenCalled()
    // 维护态下没有第二条链路可退 → 直接 runtime_unavailable
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
  })

  it('默认（未设 PI_RUNTIME_MODE）即 active：chat 走 pi-runtime', async () => {
    delete process.env.PI_RUNTIME_MODE
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([
      piEvent('message_update', { event: { type: 'text_delta', delta: 'hi' } }),
      piEvent('agent_end', { status: 'completed' }),
    ])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const events: Array<{ type: string }> = []
    for await (const event of service.streamConversation('s1', 'hello', 'u1')) {
      events.push(event)
    }

    expect(pi.healthz).toHaveBeenCalled()
    expect(events.map((e) => e.type)).toContain('text_delta')
  })

  it('active + healthz 通过：chat 流路由到 pi-runtime 并正确映射（会话保留不清理）', async () => {
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

    // P0-①：会话键 = threadId（对话）；画布上下文随 prompt turnContext 走
    expect(pi.createSession).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ userId: 'u1' }),
    )
    expect(pi.prompt).toHaveBeenCalledWith(
      't1',
      '你好',
      'main',
      expect.objectContaining({ forceSkills: undefined }),
    )
    expect(events.map((e) => e.type)).toEqual([
      'pi_agent_start',
      'text_delta',
      'text_delta',
      'done',
    ])
    expect(events[1].data).toEqual({ text: 'pi-' })
    expect(events[2].data).toEqual({ text: 'hello' })
    // P0-①：会话跨轮保留，一轮结束不再删会话（回收交给 pi-runtime 的 TTL / LRU）
    expect(pi.deleteSession).not.toHaveBeenCalled()
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
      'product-visual',
    )) {
      // drain
    }

    expect(pi.prompt).toHaveBeenCalledWith(
      't1',
      '做个营销方案',
      'main',
      expect.objectContaining({ forceSkills: ['ecommerce-product-photo'] }),
    )
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
      'storyboard',
    )) {
      // drain
    }

    expect(pi.prompt).toHaveBeenCalledWith(
      't1',
      'hello',
      'main',
      expect.objectContaining({ forceSkills: undefined }),
    )
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
      'canvas',
    )) {
      // drain
    }

    expect(pi.prompt).toHaveBeenCalledWith(
      't1',
      'hello',
      'main',
      expect.objectContaining({ forceSkills: undefined }),
    )
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

  it('active + healthz 失败：直接报不可用——老 runtime 已删，没有任何回落链路', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([], false)
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const events: Array<{ type: string; data?: unknown }> = []
    for await (const event of service.streamConversation('s1', 'hello', 'u1')) {
      events.push(event)
    }

    expect(pi.createSession).not.toHaveBeenCalled()
    expect(pi.prompt).not.toHaveBeenCalled()
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
    expect(events[0].data).toEqual(
      expect.objectContaining({ error_type: 'runtime_unavailable' }),
    )
  })

  it('off（维护态）：chat 直接报不可用（老 runtime 已无，off 不再是切链路）', async () => {
    process.env.PI_RUNTIME_MODE = 'off'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)

    const events: Array<{ type: string; data?: unknown }> = []
    for await (const event of service.streamConversation('s1', 'hello', 'u1')) {
      events.push(event)
    }

    expect(pi.healthz).not.toHaveBeenCalled()
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
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
      {
        getCanvasSummary: vi.fn().mockResolvedValue({
          nodes: [{ id: 'n1', type: 'image', title: 'T', status: 'ready' }],
        }),
      } as never,
    )
  })

  afterEach(() => {
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL
  })

  function stubAssembler(prompt: string) {
    // P0-① Task 10：装配器拆静态/动态两段；返回静态段 mock 以便断言 ruleGroups。
    const assembleStatic = vi.fn().mockResolvedValue(prompt)
    const assembleDynamic = vi.fn().mockResolvedValue([])
    vi.spyOn(service, 'createPiPromptAssembler').mockReturnValue({
      assembleStatic,
      assembleDynamic,
    } as never)
    return assembleStatic
  }

  it('active：createSession 收到静态 systemPrompt + userId；画布上下文改由 prompt turnContext 携带', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    stubAssembler('PROMPT-s1')

    const events: Array<{ type: string }> = []
    for await (const event of service.streamConversation(
      's1', '你好', 'u1', 't1',
      undefined, undefined, undefined,
      'node-9',
      [{ id: 'a1', mediaType: 'image', sourceKind: 'upload', label: 'a.png', url: 'https://x/a.png', role: 'product' }],
      ['I1'], ['I1'],
    )) {
      events.push(event)
    }

    expect(pi.createSession).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        // P1#5：组装后的 systemPrompt 尾部含任务计划汇报约定（plan 内联标记）
        systemPrompt: expect.stringContaining('PROMPT-s1'),
        userId: 'u1',
      }),
    )
    // P0-①：画布/侧栏上下文不再随会话创建注入（会话跨轮常驻，创建只发生一次）
    const createOpts = pi.createSession.mock.calls[0][1] as Record<string, unknown>
    expect(createOpts).not.toHaveProperty('attachments')
    expect(createOpts).not.toHaveProperty('focusNodeId')
    // …改为每轮 prompt 的 turnContext 透传
    const [, , , promptOpts] = pi.prompt.mock.calls[0] as [
      string,
      string,
      string,
      { turnContext: Record<string, unknown> },
    ]
    expect(promptOpts.turnContext).toMatchObject({
      focusNodeId: 'node-9',
      mentionedKeys: ['I1'],
      refOrder: ['I1'],
      attachments: [{ id: 'a1', mediaType: 'image', sourceKind: 'upload', label: 'a.png', url: 'https://x/a.png', role: 'product' }],
    })
    // P1#5：静态 systemPrompt 尾部含任务计划汇报约定（⟦plan⟧/⟦task-done⟧ 内联标记）
    expect(createOpts.systemPrompt).toContain('⟦plan⟧')
    expect(createOpts.systemPrompt).toContain('⟦task-done⟧')
    expect(events.map((e) => e.type)).toContain('done')
  })

  it('P0-①：prompt 携带 turnContext.dynamicBlocks（画布摘要层）', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    // 不桩装配器：走真实 assembler，画布摘要由 canvasTools 桩提供

    for await (const _event of service.streamConversation('s1', '你好', 'u1')) {
      void _event
    }

    const [, , , promptOpts] = pi.prompt.mock.calls[0] as [
      string,
      string,
      string,
      { turnContext: { dynamicBlocks: string[] } },
    ]
    expect(promptOpts.turnContext.dynamicBlocks.join('\n')).toContain('当前画布摘要')
  })

  it('P0-①：会话键 = threadId（新对话即新键）', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    stubAssembler('PROMPT')

    for await (const _event of service.streamConversation('s1', '你好', 'u1', 's1:t9')) {
      void _event
    }

    expect(pi.createSession.mock.calls[0][0]).toBe('s1:t9')
    expect(pi.prompt.mock.calls[0][0]).toBe('s1:t9')
    // hotfix 回归锁（2026-09-29）：pi 会话键是复合键 `s1:t9`，但画布会话 id 必须是 `s1`。
    // 漏传会让 pi-runtime 把哈希后的会话键当画布 id 发回 Nest /agent/internal/* → 全部画布工具 404。
    expect(pi.createSession.mock.calls[0][1]).toMatchObject({ canvasSessionId: 's1' })
    // P0-A 回归锁：订阅必须 live（from=now），否则每轮重放上一轮缓冲 → 本轮回答被上一轮顶替
    // streamEvents(sessionId, onEvent, onError, opts) → opts 在第 4 参
    expect(pi.streamEvents.mock.calls[0][3]).toEqual({ live: true })
  })

  it('P0-①：不传 threadId 时回落到 sessionId（老客户端兼容）', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    stubAssembler('PROMPT')

    for await (const _event of service.streamConversation('s1', '你好', 'u1')) {
      void _event
    }

    expect(pi.createSession.mock.calls[0][0]).toBe('s1')
    expect(pi.prompt.mock.calls[0][0]).toBe('s1')
    // hotfix：回落路径同样要带画布会话 id（两种键相等时也不能漏传）
    expect(pi.createSession.mock.calls[0][1]).toMatchObject({ canvasSessionId: 's1' })
  })

  it('审计 #7：长期记忆注入——最近 5 条进 memoryBlock，只含 content 行', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    const assembleDynamic = vi.fn().mockResolvedValue([])
    vi.spyOn(service, 'createPiPromptAssembler').mockReturnValue({
      assembleStatic: vi.fn().mockResolvedValue('PROMPT'),
      assembleDynamic,
    } as never)
    const fakeMemory = {
      searchMemory: vi
        .fn()
        .mockResolvedValue({ items: [{ id: 'm1', content: '用户偏好深色主题', createdAt: '2026-01-01' }] }),
    }
    ;(service as unknown as { agentMemory?: unknown }).agentMemory = fakeMemory

    for await (const _event of service.streamConversation('s1', '你好', 'u1', 's1:t-mem')) {
      void _event
    }

    expect(fakeMemory.searchMemory).toHaveBeenCalledWith({ userId: 'u1', limit: 5 })
    const block = assembleDynamic.mock.calls[0][0].memoryBlock as string
    expect(block).toContain('长期记忆')
    expect(block).toContain('用户偏好深色主题')
    // 安全红线：绝不投影 id/userId 等元数据
    expect(block).not.toContain('m1')
    expect(block).not.toContain('u1')
  })

  it('审计 #7：memory 服务抛错 → 注入缺席但流照常完成（fail-soft）', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    const assembleDynamic = vi.fn().mockResolvedValue([])
    vi.spyOn(service, 'createPiPromptAssembler').mockReturnValue({
      assembleStatic: vi.fn().mockResolvedValue('PROMPT'),
      assembleDynamic,
    } as never)
    ;(service as unknown as { agentMemory?: unknown }).agentMemory = {
      searchMemory: vi.fn().mockRejectedValue(new Error('db down')),
    }

    const events: string[] = []
    for await (const event of service.streamConversation('s1', '你好', 'u1', 's1:t-mem2')) {
      events.push(event.type)
    }
    expect(assembleDynamic.mock.calls[0][0].memoryBlock).toBeUndefined()
    // UI 流以 done 收口（agent_end 经映射），证明 memory 挂掉没有打断会话
    expect(events).toContain('done')
  })

  it('P0-①：status=rebuilt 时打 warn（上下文已丢，需可观测）', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    pi.createSession.mockResolvedValueOnce({
      sessionId: 's1',
      provider: 'byok-abc',
      model: 'm',
      status: 'rebuilt',
    })
    const warn = vi.spyOn(service['piLogger'] as never, 'warn' as never).mockImplementation(() => undefined)
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    stubAssembler('PROMPT')

    for await (const _event of service.streamConversation('s1', '你好', 'u1')) {
      void _event
    }

    expect(warn).toHaveBeenCalled()
  })

  it('P0-①：一轮结束后不再删除 pi 会话（负例锁）', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    stubAssembler('PROMPT')

    for await (const _event of service.streamConversation('s1', '你好', 'u1')) {
      void _event
    }

    expect(pi.deleteSession).not.toHaveBeenCalled()
  })

  it('P0-①：不再查询历史消息表（持久会话已含历史）', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    stubAssembler('PROMPT')

    for await (const _event of service.streamConversation('s1', '你好', 'u1', 't1')) {
      void _event
    }

    expect(agentMessageFindMany).not.toHaveBeenCalled()
    // 本轮消息仍照常落库（DB 侧归属不受影响）
    expect(agentMessageCreate).toHaveBeenCalled()
  })

  it('P0-①：同一会话连发两轮——两轮各自 ensure 会话，且都不删会话', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const pi = stubPiClient([piEvent('agent_end', { status: 'completed' })])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    stubAssembler('PROMPT')

    const drain = async () => {
      const out: string[] = []
      for await (const event of service.streamConversation('s1', 'hi', 'u1')) out.push(event.type)
      return out
    }
    const first = drain()
    const second = drain()
    const [a, b] = await Promise.all([first, second])

    expect(a).toEqual(['done'])
    expect(b).toEqual(['done'])
    // 常驻会话：每轮都走一次幂等 create（resume），但没有任何删除
    expect(pi.createSession).toHaveBeenCalledTimes(2)
    expect(pi.deleteSession).not.toHaveBeenCalled()
  })

  it('退役后 getThreadState 恒 null——checkpoint 概念随老 LangGraph runtime 一起移除', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const piSpy = vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(stubPiClient([]))

    expect(await service.getThreadState('t1')).toBeNull()
    // 端点只是保留给前端重连用，实现里不再有任何下游调用
    expect(piSpy).not.toHaveBeenCalled()
  })

  it('退役后 getThreadTimeline 同样恒 null', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'

    expect(await service.getThreadTimeline('t1')).toBeNull()
  })

  it('active：runtime-health 心跳探 pi-runtime', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const piSpy = vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(stubPiClient([]))

    const result = await service.checkRuntimeHealth()
    expect(result.ok).toBe(true)
    expect(typeof result.latencyMs).toBe('number')
    expect(piSpy).toHaveBeenCalledWith('http://127.0.0.1:8100')
  })

  it('active + pi 不可达：心跳如实报不可用（与 chat 不回落一致）', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(stubPiClient([], false))

    const result = await service.checkRuntimeHealth()
    expect(result.ok).toBe(false)
    expect(result.latencyMs).toBeUndefined()
  })

  it('off（维护态）：心跳报不可用——off 不再代表「切到另一条链路」', async () => {
    process.env.PI_RUNTIME_MODE = 'off'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const piSpy = vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(stubPiClient([]))

    expect(await service.checkRuntimeHealth()).toEqual({ ok: false })
    expect(piSpy).not.toHaveBeenCalled()
  })

  it('未配 PI_RUNTIME_URL：心跳报不可用（chat 同样不可用，两者不矛盾）', async () => {
    process.env.PI_RUNTIME_MODE = 'active'
    delete process.env.PI_RUNTIME_URL

    expect(await service.checkRuntimeHealth()).toEqual({ ok: false })
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
    const assembleStatic = vi.fn().mockResolvedValue('PROMPT')
    vi.spyOn(service, 'createPiPromptAssembler').mockReturnValue({
      assembleStatic,
      assembleDynamic: vi.fn().mockResolvedValue([]),
    } as never)

    const events: Array<{ type: string }> = []
    for await (const event of service.streamConversation('s1', '你好', 'u1', 't1')) {
      events.push(event)
    }
    expect(events.map((e) => e.type)).toContain('done')
    expect(assembleStatic.mock.calls[0][0]).toMatchObject({ ruleGroups: ['core', 'writeTools', 'genTools'] })
  })

  it('链路不可用（未配 PI_RUNTIME_URL）：直接 runtime_unavailable，且不产生任何 DB 查询', async () => {
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
    // 未配 PI_RUNTIME_URL → 无可用链路，直接 runtime_unavailable
    // 退役前这里靠桩 LangGraph client 让流程走完；现在没有第二条链路可桩。

    const events: Array<{ type: string }> = []
    for await (const event of service.streamConversation('s1', '你好', 'u1', 't1')) {
      events.push(event)
    }
    expect(agentMessageFindMany).not.toHaveBeenCalled()
    expect(events.map((e) => e.type)).toContain('done')
  })
})

describe('AgentService.answerPiPending（B-2 ask_user 阻塞透传）', () => {
  /** 最小构造（沿用 cancel-run.test.ts 惯例）。 */
  function createService() {
    return new AgentService(
      {} as never,
      { create: vi.fn() } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
  }

  /** 替换私有取址/工厂方法，避免依赖真实 env 与网络。 */
  function stubPi(svc: AgentService, url: string | null, client: unknown) {
    const anySvc = svc as unknown as {
      getPiRuntimeUrl: () => string | null
      createPiRuntimeClient: (_url: string) => unknown
    }
    anySvc.getPiRuntimeUrl = () => url
    anySvc.createPiRuntimeClient = () => client
  }

  it('answerPiPending：threadId 优先推导 sessionKey 并透传 callId/answers', async () => {
    const svc = createService()
    const answer = vi.fn(async () => ({ ok: true, deduped: false }))
    stubPi(svc, 'http://pi-runtime', { answer })

    const result = await svc.answerPiPending({
      sessionId: 's1',
      threadId: 'tid-1',
      callId: 'c1',
      answers: { choice: ['a'] },
    })
    expect(result).toEqual({ ok: true, deduped: false })
    expect(answer).toHaveBeenCalledWith('tid-1', {
      callId: 'c1',
      answers: { choice: ['a'] },
    })
  })

  it('answerPiPending：无 threadId 回落 sessionId', async () => {
    const svc = createService()
    const answer = vi.fn(async () => ({ ok: true, deduped: true }))
    stubPi(svc, 'http://pi-runtime', { answer })

    const result = await svc.answerPiPending({
      sessionId: 's1',
      threadId: '   ',
      callId: 'c1',
      answers: { choice: ['b'] },
    })
    expect(result).toEqual({ ok: true, deduped: true })
    expect(answer).toHaveBeenCalledWith('s1', { callId: 'c1', answers: { choice: ['b'] } })
    const body = answer.mock.calls[0]?.[1] as Record<string, unknown>
    // 锁死：answerId 已从链路删除（registry.answer 从不读它），任何形态都不该再冒出来
    expect(body).not.toHaveProperty('answerId')
  })
})

describe('AgentService.steerPiRun（2026-10-02 steering/followUp 双模式闭环）', () => {
  function createService() {
    return new AgentService(
      {} as never,
      { create: vi.fn() } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
  }

  function stubPi(svc: AgentService, url: string | null, client: unknown) {
    const anySvc = svc as unknown as {
      getPiRuntimeUrl: () => string | null
      createPiRuntimeClient: (_url: string) => unknown
    }
    anySvc.getPiRuntimeUrl = () => url
    anySvc.createPiRuntimeClient = () => client
  }

  it('steer：threadId 优先推导 sessionKey（与 cancelRun/answerPiPending 同一口径）', async () => {
    const svc = createService()
    const steer = vi.fn(async () => ({ queued: true }))
    stubPi(svc, 'http://pi-runtime', { steer })

    const result = await svc.steerPiRun({ sessionId: 's1', threadId: 'tid-1', text: '插话' })
    expect(result).toEqual({ queued: true })
    expect(steer).toHaveBeenCalledWith('tid-1', '插话')
  })

  it('steer：threadId 空白 / 未传时回落 sessionId（常驻会话必须打中）', async () => {
    const svc = createService()
    const steer = vi.fn(async () => ({ queued: true }))
    stubPi(svc, 'http://pi-runtime', { steer })

    await svc.steerPiRun({ sessionId: 's1', threadId: '   ', text: '插话' })
    expect(steer).toHaveBeenCalledWith('s1', '插话')
  })

  it('steer：PI_RUNTIME_MODE=off（无 url）返回 queued:false 且不打网络', async () => {
    const svc = createService()
    const steer = vi.fn(async () => ({ queued: true }))
    stubPi(svc, null, { steer })

    await expect(svc.steerPiRun({ sessionId: 's1', text: '插话' })).resolves.toEqual({ queued: false })
    expect(steer).not.toHaveBeenCalled()
  })

  it('steer：vendor 拒收（QueueRejectedError）向上冒泡——插话失败必须可观测，不可静默', async () => {
    const svc = createService()
    const steer = vi.fn(async () => {
      throw new Error('queue rejected')
    })
    stubPi(svc, 'http://pi-runtime', { steer })

    await expect(svc.steerPiRun({ sessionId: 's1', text: '插话' })).rejects.toThrow(/queue rejected/)
  })
})

describe('T1 多模态直通组装（Nest → pi-runtime prompt 顶层 images）', () => {
  // 顶部 describe 内的 service 不在本作用域：自建最小 AgentService（prisma mock 与 :34 同款）
  const agentMessageCreate = vi.fn().mockResolvedValue({})
  const agentMessageFindMany = vi.fn().mockResolvedValue([])
  const agentThreadFindUnique = vi.fn().mockResolvedValue(null)
  const agentThreadUpsert = vi.fn().mockResolvedValue({})
  const agentThreadUpdate = vi.fn().mockResolvedValue({})
  const sessionFindUnique = vi.fn().mockResolvedValue({ id: 's1', canvasData: null })
  const sessionUpdate = vi.fn().mockResolvedValue({})
  let service: AgentService

  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL
    agentMessageCreate.mockResolvedValue({})
    agentMessageFindMany.mockResolvedValue([])
    agentThreadFindUnique.mockResolvedValue(null)
    agentThreadUpsert.mockResolvedValue({})
    agentThreadUpdate.mockResolvedValue({})
    sessionFindUnique.mockResolvedValue({ id: 's1', canvasData: null })
    sessionUpdate.mockResolvedValue({})
    service = new AgentService(
      {
        agentMessage: { create: agentMessageCreate, findMany: agentMessageFindMany },
        agentThread: { findUnique: agentThreadFindUnique, upsert: agentThreadUpsert, update: agentThreadUpdate },
        session: { findUnique: sessionFindUnique, update: sessionUpdate },
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
    )
  })

  async function runPromptCapture(
    model: string | undefined,
    opts: { mockBuilder?: boolean } = {},
  ) {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    const prompt = vi.fn(async () => undefined)
    const client = {
      healthz: vi.fn().mockResolvedValue({ status: 'ok' }),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'x',
        provider: 'agnes',
        model: 'm',
        status: 'created',
      }),
      prompt,
      steer: vi.fn(),
      listSkills: vi.fn().mockResolvedValue({ skills: [] }),
      streamEvents: vi.fn((_id: string, onEvent: (event: PiRuntimeEvent) => void) => {
        onEvent(piEvent('agent_end', { status: 'completed' }))
        return () => {}
      }),
    }
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(client as never)
    if (opts.mockBuilder) {
      vi.spyOn(service, 'createDirectImagePayloadBuilder').mockReturnValue(
        (async () => ({
          images: [{ name: 'a.png', mimeType: 'image/png', data: 'QUJD' }],
          markers: ['[I1=a.png]'],
        })) as never,
      )
    }
    for await (const _e of service.streamConversation(
      's1',
      '描述这张图',
      'u1',
      undefined,
      undefined,
      undefined,
      model,
      undefined,
      [{ id: 'att1', mediaType: 'image', sourceKind: 'upload', label: 'a', url: '/uploads/u1/a.png' } as SidebarAttachment],
    )) {
      /* drain */
    }
    await vi.waitFor(() => expect(prompt).toHaveBeenCalled())
    const call = prompt.mock.calls[0] as unknown as
      | [string, string, string, Record<string, unknown> | undefined]
      | undefined
    return { text: call?.[1] as string, opts: call?.[3] as Record<string, unknown> | undefined }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('视觉模型 + 图片 → prompt opts.images 且 text 尾带 [I1=] 标记', async () => {
    const { text, opts } = await runPromptCapture('gemini-2.5-flash', { mockBuilder: true })
    expect(opts?.images).toEqual([{ name: 'a.png', mimeType: 'image/png', data: 'QUJD' }])
    expect(text).toContain('[I1=a.png]')
  })

  it('非视觉模型 → 无 images、text 无标记（识图兜底路径，缺省行为不变）', async () => {
    const { text, opts } = await runPromptCapture('deepseek-v4-pro')
    expect(opts?.images).toBeUndefined()
    expect(text).not.toContain('[I1=')
  })
})
