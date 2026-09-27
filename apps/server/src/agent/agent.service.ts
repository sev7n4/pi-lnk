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
import { PiRuntimeClient, type PiSessionLlmOverride } from './pi-runtime/pi-runtime.client'
import { resolveModelCapability } from '../provider/model-capability'
import {
  formatParseContextBlock,
  getCachedParseBlock,
  imageUrlsForParse,
  setCachedParseBlock,
  SIDEBAR_VISION_FAIL_HINT,
  supportsVisionModel,
} from './sidebar-vision'
import { SIDEBAR_MEDIA_PARSE_PROMPT } from './sidebar-media-parse-prompt'
import { mapThinkingLevel } from './pi-runtime/thinking-level'
import { parseSkillCommand } from './pi-runtime/skill-command'
import { resolveForceSkills } from './pi-runtime/resolve-force-skills'
import { PiPromptAssembler } from './pi-runtime/pi-prompt-assembler.service'
import { createThinkingAccumulator, createUsageAccumulator, extractCanvasActions, extractCanvasCommands, mapPiEventToUiEvent, type PiRuntimeEvent } from './pi-runtime/pi-events'

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
  'turn_usage',
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
        // pi 会话按 sessionId 串行化：上一轮的 DELETE 与本轮的 create/prompt 不得交错
        // （2026-09-24 生产实测：迟到的 DELETE 会删掉本轮刚建的会话 → 本轮空响应）
        const releasePiLock = await this.acquirePiSessionLock(sessionId)
        try {
          for await (const event of this.streamFromPiRuntime(
            piClient,
            sessionId,
            userMessage,
            userId,
            threadId,
            piContext,
            { thinking, thinkingEffort },
    // P1：dock 技能选择器 skillId 转接 pi-runtime forceSkills
    skillId,
    // K-1：dock 模型选择（BYOK 渠道）经 resolvePiSessionLlm 注入 pi 会话
    model,
  )) {
            if (event.type === 'text_delta') {
              assistantText += (event.data as { text: string }).text
            }
            yield event
          }
        } finally {
          // streamFromPiRuntime 的 finally（DELETE 会话）已在其生成器结束时完成
          releasePiLock()
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

  /** Proxy agent-runtime health check for frontend heartbeat detection.
   *
   * pi active 时对话真正依赖的是 pi-runtime，心跳必须探 pi：否则老 runtime 退役后
   * 前端每 15s 拿到 ok:false → 误报「生成服务暂时不可达」并拦掉重连（下线前置 ①b）。
   * pi 不可达时 chat 会按 D-ζ' 回落 LangGraph，此时继续探回落链路——只要回落链路
   * 还活着，心跳就不该报不可达。 */
  async checkRuntimeHealth(): Promise<{ ok: boolean; latencyMs?: number }> {
    const runtimeUrl = process.env.AGENT_RUNTIME_URL?.trim()
    if (this.getPiRuntimeMode() === 'active') {
      const piUrl = this.getPiRuntimeUrl()
      if (piUrl) {
        const start = Date.now()
        const piOk = (await this.createPiRuntimeClient(piUrl).healthz()) !== null
        if (piOk) return { ok: true, latencyMs: Date.now() - start }
      }
    }
    if (!runtimeUrl) return { ok: false }
    const client = this.createRuntimeClient(runtimeUrl)
    const start = Date.now()
    const ok = await client.healthOk(5000)
    return { ok, latencyMs: ok ? Date.now() - start : undefined }
  }

  /** W12: Read LangGraph checkpoint phase for reconnect UI.
   * pi active 时对话状态在 pi-runtime，老 LangGraph 根本没有该 thread 的 checkpoint
   * （生产实测：24h 内 47 次查询全部空转）→ 直接返回 null，与「查不到」等价，
   * 同时不再打到即将退役的老 runtime（下线前置 ①）。 */
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
    // 下线前置 ①：pi active 下对话状态不在 LangGraph，查也无意义
    if (this.getPiRuntimeMode() === 'active') return null
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
    // 同 getThreadState：pi active 下 checkpoint 历史不在 LangGraph
    if (this.getPiRuntimeMode() === 'active') return null
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

  /** K-1 回滚开关：置 off → 停发 llm 字段，全量回落 pi-runtime env 装配（秒级止血，不改代码）。 */
  piLlmPassthroughEnabled(): boolean {
    return (process.env.PI_LLM_PASSTHROUGH?.trim().toLowerCase() || 'on') !== 'off'
  }

  /**
   * K-1：解析本轮 pi 会话的 BYOK 覆盖（per-session 注入，多用户并发互相隔离）。
   *
   * 失败语义：任何一步拿不到 → undefined（pi 走 env 装配）。对齐老路径 ctx 缺省语义，
   * 不引入 fallback_pending（spec §4）。
   *
   * 决策 A：只透传 BYOK（source=user），平台用户保持 env 装配——生产上 Nest 平台通道
   * （apihub + 老 key + agnes-2.0-flash）与 pi-runtime env（api.agnes-ai.cn + 新 key +
   * agnes-2.5-flash）**不同源**，透传会让平台用户换网关换模型，属回归。
   */
  /**
   * ③ 侧栏识图：pi 路径下 `parse_sidebar_media`（老 LangGraph 图节点）的等价物。
   *
   * 老链路是「侧栏贴图 → runtime 调 Nest vision QA → 结构化字段 → 作为文本上下文给模型」，
   * 不是让对话模型直接看图；pi 路径此前**完全没有这一步**（侧栏块只有文件名），
   * 表现为「它说只看到文件名」。这里在 Nest 侧做前置，把解析结果文本注入 pi systemPrompt。
   *
   * 失败语义（对齐老链路，不是简单返回空）：
   *   - 无贴图 / 开关 off / 拿不到渠道 → ''（压根没尝试解析，与老链路 `parse=None` 一致）
   *   - 尝试了但没成功（模型不支持视觉 / 上游失败 / vision_used=false）→ 仍出块
   *     （摘要=未知）+「未能识别」兜底话术，避免模型拿着文件名编一版空品类方案。
   */
  private async buildSidebarVisionBlock(input: {
    sessionId: string
    userId: string | undefined
    userMessage: string
    attachments: SidebarAttachment[] | undefined
    model?: string
  }): Promise<string> {
    const { sessionId, userId, userMessage, attachments, model } = input
    if (!userId || !this.canvasTools) return ''
    // 回滚开关：置 off → 停掉侧栏识图（与 PI_LLM_PASSTHROUGH 同款运维习惯）
    if ((process.env.PI_SIDEBAR_VISION?.trim().toLowerCase() || 'on') === 'off') return ''
    const imageUrls = imageUrlsForParse(attachments)
    if (!imageUrls.length) return ''
    // 有贴图就必须给模型一个交代：成功给解析块，失败给「未能识别」兜底块——
    // 否则模型手里只有文件名（正是老链路要防的「照着文件名编方案」）。

    const requested =
      model?.trim() || (await this.loadDefaultTextModel(userId).catch(() => undefined))
    let ctx: ProviderContext | undefined
    if (requested) {
      try {
        ctx = await buildTextProviderContext(this.providerResolver, userId, requested)
      } catch {
        // 渠道停用/无 key/解密失败 → 兜底块（老链路 VISION_PROVIDER_CONTEXT_INVALID）
        ctx = undefined
      }
    }
    if (!ctx) return this.failedParseBlock(userMessage)
    // 跨轮复用：同 provider + 同图片集合直接取缓存块（只缓存成功，失败下一轮可自愈）
    const cached = getCachedParseBlock(imageUrls, ctx.providerRef)
    if (cached) return cached

    // 模型不支持视觉 → 不调 vision，但**仍出块**（摘要=未知）+ 失败兜底话术，
    // 对齐老链路 VISION_UNSUPPORTED：不让它拿着文件名去编一版方案。
    if (!supportsVisionModel(ctx.model)) {
      return this.failedParseBlock(userMessage)
    }

    try {
      const parsed = await this.canvasTools.runVisionQa({
        sessionId,
        userId,
        imageUrls,
        userText: userMessage,
        systemPrompt: SIDEBAR_MEDIA_PARSE_PROMPT,
        userContent: `请解析这 ${imageUrls.length} 张侧栏参考图。${
          userMessage.trim() ? `\n\n【用户说明】\n${userMessage.trim()}` : ''
        }`,
        providerRef: ctx.providerRef,
        model: ctx.model,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        source: ctx.source,
      })
      if (!parsed?.visionUsed) {
        return this.failedParseBlock(userMessage)
      }
      const block = formatParseContextBlock(
        {
          visionUsed: true,
          userFacingSummary: parsed.userFacingSummary ?? parsed.productSummary,
          fields: {
            category: parsed.category,
            appearance: parsed.appearance,
            materialHint: parsed.materialHint,
            textInImage: parsed.textInImage,
          },
          unknown: parsed.unknown,
        },
        { userText: userMessage },
      )
      setCachedParseBlock(imageUrls, ctx.providerRef, block)
      return block
    } catch {
      return this.failedParseBlock(userMessage)
    }
  }

  /**
   * 识图未成功时的文本块：仍给【侧栏参考图解析】骨架（摘要=未知），再追加兜底话术。
   * 不缓存——失败是可能自愈的（上游抖动/超时），下一轮应重试。
   */
  private failedParseBlock(userMessage: string): string {
    return `${formatParseContextBlock(
      { visionUsed: false, userFacingSummary: '', fields: {}, unknown: [] },
      { userText: userMessage },
    )}\n${SIDEBAR_VISION_FAIL_HINT}`
  }

  private async resolvePiSessionLlm(
    userId: string | undefined,
    model?: string,
  ): Promise<PiSessionLlmOverride | undefined> {
    if (!userId) return undefined
    if (!this.piLlmPassthroughEnabled()) return undefined
    let requested = model?.trim()
    if (!requested) {
      requested = await this.loadDefaultTextModel(userId).catch(() => undefined)
    }
    if (!requested) return undefined
    let ctx: ProviderContext
    try {
      ctx = await buildTextProviderContext(this.providerResolver, userId, requested)
    } catch {
      // 渠道停用/无 key/解密失败 → 不发 llm → env 兜底（UI 侧已有「模型已停用」拦截）
      return undefined
    }
    if (ctx.source !== 'user') return undefined
    const cap = resolveModelCapability(ctx.providerRef)
    return {
      model: ctx.model,
      apiKey: ctx.apiKey,
      baseUrl: ctx.baseUrl,
      providerRef: ctx.providerRef,
      source: ctx.source,
      reasoning: cap.reasoning,
      contextWindow: cap.contextWindow,
      maxTokens: cap.maxTokens,
    }
  }

  /** Overridable in unit tests */
  createPiRuntimeClient(baseUrl: string): PiRuntimeClient {
    return new PiRuntimeClient({ baseUrl })
  }

  /** Overridable in unit tests（#12：每轮 system prompt 组装器） */
  createPiPromptAssembler(): PiPromptAssembler {
    return new PiPromptAssembler(this.canvasTools as never)
  }

  /** 确保会话存在：409 → 删陈旧重建（不复用，见 createSessionReplacingStale 注释）。 */
  /** 每 sessionId 一条串行链（同会话的两轮不得交错；Nest 单实例，进程内锁足够）。 */
  private readonly piSessionChains = new Map<string, Promise<void>>()

  /**
   * pi 会话串行化锁：保证「本轮 create/prompt/删除」整段互斥。
   * 场景：用户连发两轮时，上一轮结束的 DELETE 与下一轮 create/prompt 竞态——
   *  · 若 DELETE 先到：下一轮 create 撞 409（已由 createSessionReplacingStale 兜底）；
   *  · 若 DELETE 后到：会删掉下一轮刚建的会话 → 本轮空响应（本锁解决这一侧）。
   */
  private async acquirePiSessionLock(sessionId: string): Promise<() => void> {
    const prev = this.piSessionChains.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = prev.then(() => gate)
    this.piSessionChains.set(sessionId, tail)
    await prev.catch(() => {})
    return () => {
      release()
      // 仅当自己仍是队尾时清理，避免删掉后来者的链
      if (this.piSessionChains.get(sessionId) === tail) this.piSessionChains.delete(sessionId)
    }
  }

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
      thinkingLevel?: 'off' | 'medium' | 'high'
      /** K-1：BYOK 会话级模型覆盖（仅 source=user 的渠道；平台用户不传） */
      llm?: PiSessionLlmOverride
    },
  ): Promise<void> {
    // 409 竞态（上一轮 DELETE 未完成就来了本轮 create）：删除陈旧会话后重建，
    // 不复用——旧会话 systemPrompt 陈旧且其事件缓冲会把上一轮事件回放给本轮 SSE
    await client.createSessionReplacingStale(sessionId, {
      systemPrompt: opts?.systemPrompt,
      userId: opts?.userId,
      attachments: opts?.attachments,
      mentionedKeys: opts?.mentionedKeys,
      refOrder: opts?.refOrder,
      focusNodeId: opts?.focusNodeId,
      thinkingLevel: opts?.thinkingLevel,
      // K-1：BYOK 覆盖随会话创建注入（畸形由 pi-runtime 侧 400，此处不二次校验）
      llm: opts?.llm,
    })
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
    thinkingOpts?: { thinking?: boolean; thinkingEffort?: 'high' | 'max' },
    // P1：与 Task 1 的 thinkingOpts 并列独立第 8 参（按计划裁定不并入 opts，保持既有调用点兼容）
    skillId?: string,
    // K-1：dock 模型选择（BYOK 渠道）→ resolvePiSessionLlm → create body 的 llm 字段
    model?: string,
  ): AsyncGenerator<AgentStreamEvent> {
    // K-1：BYOK 覆盖必须在 create 之前解析（会话创建即装配模型，中途不可换）
    const llm = await this.resolvePiSessionLlm(userId, model)
    // ③ 侧栏识图前置：结果作为文本上下文并入 systemPrompt（失败返回 ''，不阻断）
    const visionBlock = await this.buildSidebarVisionBlock({
      sessionId,
      userId,
      userMessage,
      attachments: piContext?.attachments,
      model,
    })
    const systemPrompt = await this.createPiPromptAssembler().assemble({
      sessionId,
      attachments: piContext?.attachments,
      mentionedKeys: piContext?.mentionedKeys,
      priorMessages: piContext?.priorMessages,
      // B-5：run_* 生成工具已注册，genTools 规则组启用（规则 3' + 11/12/13）
      ruleGroups: ['core', 'writeTools', 'genTools'],
    })
    await this.ensurePiSession(client, sessionId, {
      systemPrompt: visionBlock ? `${systemPrompt}\n\n${visionBlock}` : systemPrompt,
      userId,
      attachments: piContext?.attachments,
      mentionedKeys: piContext?.mentionedKeys,
      refOrder: piContext?.refOrder,
      focusNodeId: piContext?.focusNodeId,
      // D-T1：老 UI effort 两档映射为 pi 档位，逐请求透传
      thinkingLevel: mapThinkingLevel(thinkingOpts?.thinking, thinkingOpts?.thinkingEffort),
      // K-1：BYOK 渠道覆盖（undefined → pi-runtime env 装配）
      llm,
    })
    const events = this.iteratePiEvents(client, sessionId)
    // 先订阅再 prompt，避免首事件竞态（SSE 缓冲重放兜底）
    const iterator = events[Symbol.asyncIterator]()
    // 可观测性专项 ④ + P1 skillId 转接：文本 /skill 命令优先，dock skillId 兜底；未知名 fail-soft 原文发送。
    // listSkills 仅在可能需要校验时调用（有命令或有 skillId），失败降级 null（fail-soft）
    // P1 标尺④修复：dock 传的是 UI 短 id（canvas/product-visual），须先经 mapUiSkillId 映射为
    // runtime skill 名再进 resolveForceSkills 白名单校验（与老 LangGraph 路径 :597 对齐；
    // 未接入占位 id 映射为 undefined → fail-soft，与 T2-3 语义一致）
    const skillCmd = parseSkillCommand(userMessage)
    const known =
      skillCmd || skillId?.trim()
        ? await client.listSkills().catch(() => null)
        : null
    const { forceSkills, promptText } = resolveForceSkills(
      mapUiSkillId(skillId),
      userMessage,
      known?.skills ?? null,
    )
    void client.prompt(sessionId, promptText, "main", { forceSkills }).catch(() => {
      // prompt 失败会以 error 事件形式出现在事件流中，此处静默
    })

    let assistantText = ''
    const canvasActions: CanvasAction[] = []
    const thinkingAccumulator = createThinkingAccumulator()
    const usageAccumulator = createUsageAccumulator()
    const executionEvents: Array<{ type: string; data: unknown }> = []
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
          // B-5：gen/lifecycle 工具 details.actions → canvas_action（画布数据动作通道；
          // 对齐老链路 NestEventProxy 转发语义），节点状态经此实时到前端
          for (const action of extractCanvasActions(event)) {
            canvasActions.push(action)
            executionEvents.push({ type: 'canvas_action', data: action })
            yield { type: 'canvas_action', data: action }
          }
        }
        // 可观测性专项 ③：pi thinking 子事件折叠为老 UI 契约的 thinking 事件（delta 只累积）
        const thinkingUi = thinkingAccumulator.feed(event)
        if (thinkingUi) {
          executionEvents.push({ type: 'thinking', data: thinkingUi.data })
          yield thinkingUi as AgentStreamEvent
        }
        // P1 状态行：usage 累积，agent_end 前恰发一次 turn_usage（seenUsage 门，见 pi-events.ts）
        const usageUi = usageAccumulator.feed(event)
        if (usageUi) {
          executionEvents.push({ type: 'turn_usage', data: usageUi.data })
          yield usageUi as AgentStreamEvent
        }
        const ui = mapPiEventToUiEvent(event)
        if (!ui) continue
        if (ui.type === 'text_delta') {
          assistantText += (ui.data as { text: string }).text
        }
        // 执行事件持久化收集（刷新后前端可恢复执行过程）；canvas_action 已在
        // extractCanvasActions 循环内同步入 canvasActions/executionEvents，
        // mapPiEventToUiEvent 不产出该类型
        if (ui.type === 'tool_call' || ui.type === 'tool_result') {
          executionEvents.push({ type: ui.type, data: ui.data })
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
      metadata: buildTurnMetadata({ executionEvents }),
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
          ruleGroups: ['core', 'writeTools', 'genTools'],
        })
        await this.ensurePiSession(client, shadowSessionId, {
          systemPrompt,
          userId,
          attachments: piContext?.attachments,
          mentionedKeys: piContext?.mentionedKeys,
          refOrder: piContext?.refOrder,
          focusNodeId: piContext?.focusNodeId,
          // K-1：影子镜像**故意不传 llm** —— 镜像流量若走 BYOK 会重复消耗用户渠道配额，
          // 且 shadow 只用于 diff 收集，用平台 env 装配即可。
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
