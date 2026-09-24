import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common'
import { applyCanvasActions, type AgentStreamEvent } from '@lnkpi/agent'
import type {
  AgentMessageMetadata,
  CanvasAction,
  CanvasData,
  JourneyTraceSnapshot,
  ExecutionTraceState,
  LinkedCanvasOutput,
  SidebarAttachment,
} from '@lnkpi/shared'
import {
  IMAGE_MODELS,
  TEXT_MODELS,
  VIDEO_MODELS,
  normalizeMentionedKeys,
  validateSidebarAttachments,
} from '@lnkpi/shared'
import { MaterialService } from '../canvas/material.service'
import { ShotService } from '../canvas/shot.service'
import { AgentCanvasToolsService } from './agent-canvas-tools.service'
import { PrismaService } from '../prisma/prisma.service'
import { isObjectStorageConfigured } from '../storage/object-storage-env'
import {
  buildTextProviderContext,
  type ProviderContext,
} from '../provider/provider-context'
import { ProviderResolverService } from '../provider/provider-resolver.service'
import { AgentRuntimeClient } from './agent-runtime.client'
import { mapUiSkillId } from './agent-skill-map'
import { sanitizeAgentMessageContent } from './agentMessageSanitize'
import { PiRuntimeClient, PiRuntimeError } from './pi-runtime/pi-runtime.client'
import { PiPromptAssembler } from './pi-runtime/pi-prompt-assembler.service'
import { extractCanvasCommands, mapPiEventToUiEvent, type PiRuntimeEvent } from './pi-runtime/pi-events'

/** #12：pi 每轮的画布上下文（进 toolContext + system prompt 组装输入）。 */
export interface PiCanvasContext {
  attachments?: SidebarAttachment[]
  mentionedKeys?: string[]
  refOrder?: string[]
  focusNodeId?: string
  priorMessages: Array<{
    role: 'user' | 'assistant' | 'tool'
    content: string
    toolNames?: string[]
  }>
}

const TRACE_PERSIST_EVENT_TYPES = new Set([
  'step',
  'text_replace',
  'phase_hint',
  'tool_call',
  'tool_result',
  'canvas_action',
  'node_status',
  'task_update',
  'thinking',
  'explore',
  'error',
])

export function buildTurnMetadata(input: {
  journeyTrace?: JourneyTraceSnapshot
  presentation?: Record<string, unknown>
  executionTrace?: ExecutionTraceState
  executionEvents?: Array<{ type: string; data: unknown }>
}): AgentMessageMetadata | undefined {
  const metadata: AgentMessageMetadata = {}
  if (input.journeyTrace) metadata.journeyTrace = input.journeyTrace
  if (input.executionTrace) metadata.executionTrace = input.executionTrace
  if (input.presentation) metadata.presentation = input.presentation
  if (input.executionEvents?.length) metadata.executionEvents = input.executionEvents
  return Object.keys(metadata).length ? metadata : undefined
}

export function deriveLinkedOutputs(actions: CanvasAction[]): LinkedCanvasOutput[] {
  return actions
    .filter((a) => a.type === 'add_node' && a.payload?.id)
    .map((a) => ({
      nodeId: a.payload.id!,
      title: String(a.payload.data?.title || a.payload.data?.prompt || '未命名').slice(0, 20),
      nodeType: String(a.payload.nodeType || 'image'),
      status: 'done' as const,
    }))
}

@Injectable()
export class AgentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ShotService) private readonly shotService: ShotService,
    @Inject(MaterialService) private readonly materialService: MaterialService,
    @Inject(ProviderResolverService) private readonly providerResolver: ProviderResolverService,
    // F4：去掉 @Optional——module 已提供 AgentCanvasToolsService，DI 缺失应 fail-fast
    @Inject(AgentCanvasToolsService)
    private readonly canvasTools?: AgentCanvasToolsService,
  ) {}

  getCapabilities() {
    return {
      text: TEXT_MODELS,
      image: IMAGE_MODELS,
      video: VIDEO_MODELS,
      stsDirectUpload: isObjectStorageConfigured(),
    }
  }

  async getMessages(sessionId: string, threadId: string, limit = 100) {
    if (!sessionId?.trim() || !threadId?.trim()) {
      throw new BadRequestException('sessionId and threadId are required')
    }
    const rows = await this.prisma.agentMessage.findMany({
      where: { sessionId, threadId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return rows.reverse()
  }

  async listThreads(sessionId: string) {
    if (!sessionId?.trim()) {
      throw new BadRequestException('sessionId is required')
    }
    return this.prisma.agentThread.findMany({
      where: { sessionId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    })
  }

  async upsertAgentThread(input: { id: string; sessionId: string; title?: string }) {
    const title = (input.title?.trim() || '新对话').slice(0, 40)
    return this.prisma.agentThread.upsert({
      where: { id: input.id },
      create: { id: input.id, sessionId: input.sessionId, title },
      update: { title, updatedAt: new Date() },
    })
  }

  async optimizePrompt(prompt: string, style?: string) {
    const optimized = style
      ? `${prompt}，${style} 风格，高清细节，专业构图，电影级光影`
      : `${prompt}，高清细节，专业构图，电影级光影，8K 画质`
    return { original: prompt, optimized }
  }

  async *streamConversation(
    sessionId: string,
    userMessage: string,
    userId?: string,
    threadId?: string,
    userDecision?: 'confirm' | 'revise' | 'replan' | 'confirm_gen' | 'topo_revise' | 'node_revise',
    idempotencyKey?: string,
    skillId?: string,
    model?: string,
    focusNodeId?: string,
    attachments?: SidebarAttachment[],
    refOrder?: string[],
    mentionedKeys?: string[],
    thinking?: boolean,
    thinkingEffort?: 'high' | 'max',
  ): AsyncGenerator<AgentStreamEvent> {
    // Register idempotency key (if provided) before starting
    if (idempotencyKey) {
      await this.registerIdempotencyKey(idempotencyKey, sessionId, threadId || sessionId)
    }

    const validatedAttachments =
      attachments?.length ? validateSidebarAttachments(attachments) : undefined
    const validatedMentionedKeys =
      mentionedKeys?.length ? normalizeMentionedKeys(mentionedKeys) : undefined

    const effectiveThreadId = threadId?.trim() || sessionId
    const threadExists = await this.prisma.agentThread.findUnique({
      where: { id: effectiveThreadId },
      select: { id: true },
    })
    if (!threadExists) {
      await this.upsertAgentThread({
        id: effectiveThreadId,
        sessionId,
        title: userMessage,
      })
    } else {
      await this.prisma.agentThread.update({
        where: { id: effectiveThreadId },
        data: { updatedAt: new Date() },
      })
    }

    const persistedUserContent = sanitizeAgentMessageContent('user', userMessage)
    // B4：pi-runtime 开关提前判定（F3：priorMessages 查询只在 pi 分支需要，老链路不再多付一次查询）
    const piMode = this.getPiRuntimeMode()
    const piUrl = this.getPiRuntimeUrl()
    const piEligible = piMode !== 'off' && piUrl && userId
    // #12：在本轮 user 消息落库前取历史（保证近期摘要不含本轮内容）
    const priorAgentMessages = piEligible
      ? await this.prisma.agentMessage.findMany({
          where: { threadId: effectiveThreadId },
          orderBy: { createdAt: 'desc' },
          take: 24,
          select: { role: true, content: true },
        })
      : []
    const priorMessages = priorAgentMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content ?? '' }))
      .reverse()
    if (persistedUserContent) {
      await this.prisma.agentMessage.create({
        data: {
          sessionId,
          threadId: effectiveThreadId,
          role: 'user',
          content: persistedUserContent,
          ...(validatedAttachments ? { attachments: JSON.stringify(validatedAttachments) } : {}),
        },
      })
    }

    let assistantText = ''

    // ---- B4：pi-runtime 开关（spec §6.2.0 B4 / §10.3 D-ζ'）----
    // active：主切 pi-runtime（healthz 失败则继续向下走 LangGraph 回落路径）
    // shadow：LangGraph 照常服务，pi-runtime 仅接收镜像流量（零用户感知）
    if (piEligible) {
      const piClient = this.createPiRuntimeClient(piUrl)
      const piContext: PiCanvasContext = {
        attachments: validatedAttachments,
        mentionedKeys: validatedMentionedKeys,
        refOrder,
        focusNodeId,
        priorMessages,
      }
      if (piMode === 'active' && (await piClient.healthz())) {
        for await (const event of this.streamFromPiRuntime(
          piClient,
          sessionId,
          userMessage,
          userId,
          threadId,
          piContext,
        )) {
          if (event.type === 'text_delta') {
            assistantText += (event.data as { text: string }).text
          }
          yield event
        }
        if (idempotencyKey) {
          await this.completeIdempotencyKey(idempotencyKey, assistantText)
        }
        return
      }
      if (piMode === 'shadow') {
        // 镜像会话与真实会话隔离（pi 侧独立 sessionId，删除即回收）
        this.mirrorToPiRuntime(piClient, `shadow-${sessionId}`, userMessage, userId, sessionId, piContext)
      }
    }

    const runtimeUrl = process.env.AGENT_RUNTIME_URL?.trim()
    if (runtimeUrl && userId) {
      const client = this.createRuntimeClient(runtimeUrl)
      if (await client.healthOk()) {
        for await (const event of this.streamFromRuntime(
          client,
          sessionId,
          userMessage,
          userId,
          threadId,
          userDecision,
          skillId,
          model,
          focusNodeId,
          validatedAttachments,
          refOrder,
          validatedMentionedKeys,
          thinking,
          thinkingEffort,
        )) {
          if (event.type === 'text_delta') {
            assistantText += (event.data as { text: string }).text
          }
          yield event
        }
        // Complete idempotency key after successful runtime stream
        if (idempotencyKey) {
          await this.completeIdempotencyKey(idempotencyKey, assistantText)
        }
        return
      }
    }

    for await (const event of this.streamRuntimeUnavailable()) {
      yield event
    }
    if (idempotencyKey) {
      await this.completeIdempotencyKey(idempotencyKey, '')
    }
  }

  private async *streamRuntimeUnavailable(): AsyncGenerator<AgentStreamEvent> {
    yield {
      type: 'error',
      data: {
        message: 'Agent 服务暂不可用，请稍后重试。',
        error_type: 'runtime_unavailable',
      },
    }
    yield { type: 'done', data: {} }
  }

  // ── Idempotency ──────────────────────────────────────────────

  /** Check if an idempotency key already exists (lazy-clean expired records first). */
  async checkIdempotencyKey(
    key: string,
  ): Promise<{ status: string; resultSummary?: string } | null> {
    // Lazy-clean expired records
    await this.prisma.idempotencyRecord.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    })
    const record = await this.prisma.idempotencyRecord.findUnique({
      where: { idempotencyKey: key },
    })
    if (!record) return null
    return { status: record.status, resultSummary: record.resultSummary ?? undefined }
  }

  /** Register a new idempotency key with 5-min TTL. */
  async registerIdempotencyKey(
    key: string,
    sessionId: string,
    threadId: string,
  ): Promise<void> {
    const now = new Date()
    await this.prisma.idempotencyRecord
      .create({
        data: {
          idempotencyKey: key,
          sessionId,
          threadId,
          status: 'processing',
          expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
        },
      })
      .catch(() => {
        // Unique constraint conflict = concurrent registration, ignore
      })
  }

  /** Mark idempotency key as completed with optional result summary. */
  async completeIdempotencyKey(key: string, resultSummary?: string): Promise<void> {
    await this.prisma.idempotencyRecord
      .updateMany({
        where: { idempotencyKey: key, status: 'processing' },
        data: { status: 'completed', resultSummary: resultSummary?.slice(0, 500) || null },
      })
      .catch(() => {})
  }

  // ── Runtime Health ───────────────────────────────────────────

  async cancelRun(input: {
    threadId: string
    sessionId: string
    reason?: 'user' | 'timeout'
  }) {
    const runtimeUrl = process.env.AGENT_RUNTIME_URL?.trim()
    if (!runtimeUrl) {
      throw new ServiceUnavailableException('Agent runtime is not configured')
    }
    return this.createRuntimeClient(runtimeUrl).cancelRun(input)
  }

  /** Proxy agent-runtime health check for frontend heartbeat detection. */
  async checkRuntimeHealth(): Promise<{ ok: boolean; latencyMs?: number }> {
    const runtimeUrl = process.env.AGENT_RUNTIME_URL?.trim()
    if (!runtimeUrl) return { ok: false }
    const client = this.createRuntimeClient(runtimeUrl)
    const start = Date.now()
    const ok = await client.healthOk(5000)
    return { ok, latencyMs: ok ? Date.now() - start : undefined }
  }

  /** W12: Read LangGraph checkpoint phase for reconnect UI. */
  async getThreadState(threadId: string): Promise<{
    threadId: string
    phase: string | null
    nextNodes: string[]
    interrupted: boolean
    finished: boolean
    runCancelled?: boolean | null
    hasAtomicCheckpoint?: boolean
    atomicNodeId?: string | null
    atomicTargetType?: string | null
    atomicTitle?: string | null
    flowMode?: string | null
  } | null> {
    const runtimeUrl = process.env.AGENT_RUNTIME_URL?.trim()
    if (!runtimeUrl || !threadId.trim()) return null
    const client = this.createRuntimeClient(runtimeUrl)
    return client.getThreadState(threadId.trim())
  }

  /** W27: Graph control-flow phase timeline (checkpoint history). */
  async getThreadTimeline(threadId: string): Promise<{
    threadId: string
    entries: Array<{
      step: number | null
      source: string | null
      phase: string | null
      nextNodes: string[]
      skillId: string | null
      promptVersion: string | null
      interrupted: boolean
    }>
    checkpointCount: number
  } | null> {
    const runtimeUrl = process.env.AGENT_RUNTIME_URL?.trim()
    if (!runtimeUrl || !threadId.trim()) return null
    const client = this.createRuntimeClient(runtimeUrl)
    return client.getThreadTimeline(threadId.trim())
  }

  /** Overridable in unit tests */
  createRuntimeClient(baseUrl: string): AgentRuntimeClient {
    return new AgentRuntimeClient(
      baseUrl,
      process.env.AGENT_RUNTIME_SERVICE_TOKEN?.trim(),
    )
  }

  // ---------------------------------------------------------------------------
  // B4：pi-runtime 接入（spec §6.2.0 B4 + §10.3 D-ζ' 双 runtime 开关）
  //
  // PI_RUNTIME_MODE 三态（默认 off，保证零行为变化）：
  //   off    — 全部走老 LangGraph agent-runtime（现状）
  //   shadow — 生产仍走 LangGraph；同一 prompt 镜像一份到 pi-runtime（P0 shadow
  //            验证 ≥7 天），pi 输出不返回给 Vue UI，仅记日志供 diff 收集
  //   active — chat 流主切 pi-runtime；healthz 不通过时自动回落 LangGraph
  // ---------------------------------------------------------------------------

  private readonly piLogger = new Logger('AgentService.pi')

  getPiRuntimeMode(): 'off' | 'shadow' | 'active' {
    const raw = process.env.PI_RUNTIME_MODE?.trim().toLowerCase()
    return raw === 'shadow' || raw === 'active' ? raw : 'off'
  }

  getPiRuntimeUrl(): string | undefined {
    return process.env.PI_RUNTIME_URL?.trim() || undefined
  }

  /** Overridable in unit tests */
  createPiRuntimeClient(baseUrl: string): PiRuntimeClient {
    return new PiRuntimeClient({ baseUrl })
  }

  /** Overridable in unit tests（#12：每轮 system prompt 组装器） */
  createPiPromptAssembler(): PiPromptAssembler {
    return new PiPromptAssembler(this.canvasTools as never)
  }

  /** 确保会话存在：409（已存在）视为可复用——正常每轮 delete 后重建，409 仅出现在同轮重试。 */
  private async ensurePiSession(
    client: PiRuntimeClient,
    sessionId: string,
    opts?: {
      systemPrompt?: string
      userId?: string
      attachments?: SidebarAttachment[]
      mentionedKeys?: string[]
      refOrder?: string[]
      focusNodeId?: string
    },
  ): Promise<void> {
    try {
      await client.createSession(sessionId, {
        systemPrompt: opts?.systemPrompt,
        userId: opts?.userId,
        attachments: opts?.attachments,
        mentionedKeys: opts?.mentionedKeys,
        refOrder: opts?.refOrder,
        focusNodeId: opts?.focusNodeId,
      })
    } catch (err) {
      if (err instanceof PiRuntimeError && err.status === 409) {
        this.piLogger.warn(`pi session ${sessionId} reused (409) — systemPrompt not updated`)
        return
      }
      throw err
    }
  }

  /** 把回调式 SSE 订阅桥接为 async generator（供 for-await 消费，结束自动退订）。 */
  private async *iteratePiEvents(
    client: PiRuntimeClient,
    sessionId: string,
  ): AsyncGenerator<PiRuntimeEvent> {
    const queue: PiRuntimeEvent[] = []
    let wake: (() => void) | null = null
    let closed = false
    const cancel = client.streamEvents(
      sessionId,
      (event) => {
        queue.push(event)
        wake?.()
        wake = null
      },
      () => {
        closed = true
        wake?.()
        wake = null
      },
    )
    try {
      while (true) {
        if (queue.length === 0) {
          if (closed) break
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          continue
        }
        yield queue.shift() as PiRuntimeEvent
      }
    } finally {
      cancel()
    }
  }

  private async *streamFromRuntime(
    client: AgentRuntimeClient,
    sessionId: string,
    userMessage: string,
    userId: string,
    threadId?: string,
    userDecision?: 'confirm' | 'revise' | 'replan' | 'confirm_gen' | 'topo_revise' | 'node_revise',
    skillId?: string,
    model?: string,
    focusNodeId?: string,
    attachments?: SidebarAttachment[],
    refOrder?: string[],
    mentionedKeys?: string[],
    thinking?: boolean,
    thinkingEffort?: 'high' | 'max',
  ): AsyncGenerator<AgentStreamEvent> {
    let assistantText = ''
    const canvasActions: CanvasAction[] = []
    let journeyTrace: JourneyTraceSnapshot | undefined
    const executionEvents: Array<{ type: string; data: unknown }> = []
    let turnPresentation: Record<string, unknown> | undefined

    const runtimeSkillId = mapUiSkillId(skillId)
    let ctx: ProviderContext | undefined
    if (userId) {
      const requested = model?.trim() || (await this.loadDefaultTextModel(userId))
      if (requested) {
        ctx = await buildTextProviderContext(this.providerResolver, userId, requested)
      }
    }

    const thinkingOn = thinking === true
    for await (const event of client.streamRun({
      sessionId,
      userId,
      message: userMessage,
      // 新建对话应换 thread，避免 MemorySaver 把旧 await_confirm 状态续上
      threadId: threadId?.trim() || sessionId,
      // W5 修复：把前端结构化决策（按钮点击）传给 agent-runtime
      // interrupt_before 恢复：注入 user_decision 后 astream(None)，不再重跑 intake
      userDecision,
      skillId: runtimeSkillId,
      llmProviderRef: ctx?.providerRef,
      llmModel: ctx?.model,
      llmApiKey: ctx?.apiKey,
      llmBaseUrl: ctx?.baseUrl,
      llmSource: ctx?.source,
      focusNodeId,
      attachments,
      refOrder,
      mentionedKeys,
      thinking: thinkingOn,
      thinkingEffort: thinkingOn ? (thinkingEffort === 'max' ? 'max' : 'high') : undefined,
    })) {
      if (TRACE_PERSIST_EVENT_TYPES.has(event.type)) {
        executionEvents.push({ type: event.type, data: event.data })
      }
      if (event.type === 'interrupt' || event.type === 'done') {
        const pres = (event.data as { presentation?: unknown })?.presentation
        if (pres && typeof pres === 'object' && !Array.isArray(pres)) {
          turnPresentation = pres as Record<string, unknown>
        }
      }
      if (event.type === 'text_delta') {
        assistantText += (event.data as { text: string }).text
      }
      if (event.type === 'text_replace') {
        assistantText = (event.data as { text: string }).text
      }
      if (event.type === 'canvas_action') {
        canvasActions.push(event.data as CanvasAction)
      }
      if (event.type === 'journey_update') {
        const snap = (event.data as { snapshot?: JourneyTraceSnapshot }).snapshot
        if (snap) {
          journeyTrace = snap
        }
      }
      yield event
    }

    const metadata = buildTurnMetadata({
      journeyTrace,
      presentation: turnPresentation,
      executionEvents,
    })

    const effectiveThreadId = threadId?.trim() || sessionId
    await this.finalizeTurn(sessionId, effectiveThreadId, userId, assistantText, canvasActions, {
      // Nest internal tools already wrote Session.canvasData; skip re-apply to avoid duplicate add_node
      rewriteCanvasData: false,
      linkedOutputs: deriveLinkedOutputs(canvasActions),
      metadata,
    })
  }

  /**
   * B4：pi-runtime 事件流 → 现有 AgentStreamEvent（active 模式主路径）。
   * 与 streamFromRuntime 同构：累积 assistantText / canvasActions，回合结束
   * 走同一个 finalizeTurn 持久化。canvas_action 提取待 pi 侧 custom tool
   * 事件形态定型后补（Round 5），当前工具结果经 tool_result 透传。
   */
  private async *streamFromPiRuntime(
    client: PiRuntimeClient,
    sessionId: string,
    userMessage: string,
    userId: string,
    threadId?: string,
    piContext?: PiCanvasContext,
  ): AsyncGenerator<AgentStreamEvent> {
    const systemPrompt = await this.createPiPromptAssembler().assemble({
      sessionId,
      attachments: piContext?.attachments,
      mentionedKeys: piContext?.mentionedKeys,
      priorMessages: piContext?.priorMessages,
      // B-2：写工具已在 pi registry 注册，规则 4/5 启用（第 10 条守卫随之退出）
      ruleGroups: ['core', 'writeTools'],
    })
    await this.ensurePiSession(client, sessionId, {
      systemPrompt,
      userId,
      attachments: piContext?.attachments,
      mentionedKeys: piContext?.mentionedKeys,
      refOrder: piContext?.refOrder,
      focusNodeId: piContext?.focusNodeId,
    })
    const events = this.iteratePiEvents(client, sessionId)
    // 先订阅再 prompt，避免首事件竞态（SSE 缓冲重放兜底）
    const iterator = events[Symbol.asyncIterator]()
    void client.prompt(sessionId, userMessage).catch(() => {
      // prompt 失败会以 error 事件形式出现在事件流中，此处静默
    })

    let assistantText = ''
    const canvasActions: CanvasAction[] = []
    let done = false
    try {
      while (!done) {
        const { value: event, done: streamClosed } = await iterator.next()
        if (streamClosed || !event) break
        if (event.type === 'agent_end' || event.type === 'error') {
          done = true
        }
        // UI_COMMAND 批次：canvas_command 是 UI 命令（focus/undo/redo/open_image_editor），
        // 直通前端 AgentSideRail canvas_command 分支；不得进 canvasActions（那是画布数据动作通道）
        if (event.type === 'tool_execution_end') {
          for (const cmd of extractCanvasCommands(event)) {
            yield { type: 'canvas_command', data: cmd }
          }
        }
        const ui = mapPiEventToUiEvent(event)
        if (!ui) continue
        if (ui.type === 'text_delta') {
          assistantText += (ui.data as { text: string }).text
        } else if (ui.type === 'canvas_action') {
          canvasActions.push(ui.data as CanvasAction)
        }
        yield ui as AgentStreamEvent
      }
    } finally {
      // 会话即时清理：历史已由 JsonlSessionRepo 落盘，内存句柄不留
      await client.deleteSession(sessionId).catch(() => {})
    }

    const effectiveThreadId = threadId?.trim() || sessionId
    await this.finalizeTurn(sessionId, effectiveThreadId, userId, assistantText, canvasActions, {
      rewriteCanvasData: false,
    })
  }

  /**
   * B4：P0 shadow 镜像（spec §4.4.1）。
   * 同一 prompt 复制到 pi-runtime，输出不返回 UI，仅记结构化日志供 diff 收集
   * （Prometheus/LangSmith 对接是后续任务，本方法先保证零用户感知 + 可观测）。
   */
  mirrorToPiRuntime(
    client: PiRuntimeClient,
    shadowSessionId: string,
    userMessage: string,
    userId?: string,
    realSessionId?: string,
    piContext?: PiCanvasContext,
  ): void {
    void (async () => {
      const startedAt = Date.now()
      let textLength = 0
      let toolCalls = 0
      let status: string = 'unknown'
      try {
        // 画布摘要按真实 sessionId 拉取（shadow-sid 在 Nest 无画布数据）
        const systemPrompt = await this.createPiPromptAssembler().assemble({
          sessionId: realSessionId ?? shadowSessionId,
          attachments: piContext?.attachments,
          mentionedKeys: piContext?.mentionedKeys,
          priorMessages: piContext?.priorMessages,
          ruleGroups: ['core', 'writeTools'],
        })
        await this.ensurePiSession(client, shadowSessionId, {
          systemPrompt,
          userId,
          attachments: piContext?.attachments,
          mentionedKeys: piContext?.mentionedKeys,
          refOrder: piContext?.refOrder,
          focusNodeId: piContext?.focusNodeId,
        })
        const iterator = this.iteratePiEvents(client, shadowSessionId)[Symbol.asyncIterator]()
        void client.prompt(shadowSessionId, userMessage).catch(() => {})
        const deadline = Date.now() + 90_000
        while (Date.now() < deadline) {
          const { value: event, done: streamClosed } = await iterator.next()
          if (streamClosed || !event) break
          if (event.type === 'agent_end') {
            status = (event.data as { status?: string }).status ?? 'completed'
            break
          }
          if (event.type === 'error') {
            status = 'error'
            break
          }
          const delta = mapPiEventToUiEvent(event)
          if (delta?.type === 'text_delta') {
            textLength += (delta.data as { text: string }).text.length
          } else if (delta?.type === 'tool_call') {
            toolCalls += 1
          }
        }
        this.piLogger.log(
          `shadow ${shadowSessionId}: status=${status} textLen=${textLength} toolCalls=${toolCalls} elapsed=${Date.now() - startedAt}ms`,
        )
      } catch (err) {
        this.piLogger.warn(
          `shadow ${shadowSessionId} failed after ${Date.now() - startedAt}ms: ${err instanceof Error ? err.message : String(err)}`,
        )
      } finally {
        await client.deleteSession(shadowSessionId).catch(() => {})
      }
    })()
  }

  private async finalizeTurn(
    sessionId: string,
    threadId: string,
    userId: string | undefined,
    assistantText: string,
    canvasActions: CanvasAction[],
    opts: { rewriteCanvasData: boolean; linkedOutputs?: LinkedCanvasOutput[]; metadata?: AgentMessageMetadata },
  ) {
    const shouldPersistAssistant = Boolean(
      assistantText || opts.metadata?.journeyTrace || opts.metadata?.presentation || opts.metadata?.executionEvents?.length,
    )
    if (shouldPersistAssistant) {
      await this.prisma.agentMessage.create({
        data: {
          sessionId,
          threadId,
          role: 'assistant',
          content: assistantText || ' ',
          toolCalls: canvasActions.length ? JSON.stringify(canvasActions) : null,
          linkedOutputs: opts.linkedOutputs?.length ? JSON.stringify(opts.linkedOutputs) : null,
          metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
        },
      })
      await this.prisma.agentThread.update({
        where: { id: threadId },
        data: { updatedAt: new Date() },
      })
    }

    if (canvasActions.length > 0 && userId) {
      await this.persistCanvasEntities(sessionId, canvasActions)

      if (opts.rewriteCanvasData) {
        const session = await this.prisma.session.findUnique({ where: { id: sessionId } })
        if (session) {
          const currentData: CanvasData = session.canvasData
            ? JSON.parse(session.canvasData)
            : { nodes: [], edges: [] }
          const updated = applyCanvasActions(currentData, canvasActions)
          await this.prisma.session.update({
            where: { id: sessionId },
            data: { canvasData: JSON.stringify(updated) },
          })
        }
      }
    }
  }

  private async persistCanvasEntities(sessionId: string, actions: CanvasAction[]) {
    for (const action of actions) {
      if (action.type !== 'add_node') continue
      const { payload } = action

      if (payload.nodeType === 'shot') {
        await this.shotService.create(sessionId, {
          id: payload.id,
          title: payload.data?.title as string | undefined,
          prompt: payload.data?.prompt as string | undefined,
          positionX: payload.position?.x,
          positionY: payload.position?.y,
          status: (payload.data?.status as string) ?? 'draft',
        })
      }

      if (payload.nodeType === 'image' && payload.parentShotId) {
        await this.materialService.createFromAgent({
          id: payload.id,
          shotId: payload.parentShotId,
          prompt: payload.data?.prompt as string | undefined,
          url: payload.data?.url as string | undefined,
          status: (payload.data?.status as string) ?? 'completed',
        })
      }
    }
  }

  private async loadDefaultTextModel(userId: string): Promise<string | undefined> {
    const row = await this.prisma.userAiPreferences.findUnique({
      where: { userId },
      select: { defaultTextModel: true },
    })
    const value = row?.defaultTextModel?.trim()
    return value || undefined
  }
}
