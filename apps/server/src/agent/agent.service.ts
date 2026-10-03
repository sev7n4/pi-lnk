import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common'
import type { AgentStreamEvent } from '@lnkpi/agent'
import { CANVAS_ACTION_APPLIER, defaultCanvasActionApplier } from './canvas-action-applier'
import type {
  AgentMessageMetadata,
  CanvasAction,
  CanvasActionApplier,
  CanvasData,
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
import { AgentMemoryService } from './agent-memory.service'
import { PrismaService } from '../prisma/prisma.service'
import { isObjectStorageConfigured } from '../storage/object-storage-env'
import {
  buildTextProviderContext,
  type ProviderContext,
} from '../provider/provider-context'
import { ProviderResolverService } from '../provider/provider-resolver.service'
import { mapUiSkillId } from './agent-skill-map'
import { sanitizeAgentMessageContent } from './agentMessageSanitize'
import {
  PiRuntimeClient,
  type CreateSessionResult,
  type PiRetentionState,
  type PiSessionLlmOverride,
} from './pi-runtime/pi-runtime.client'
import { resolveModelCapability, resolveVisionInputSupport } from '../provider/model-capability'
import {
  formatParseContextBlock,
  getCachedParseBlock,
  imageUrlsForParse,
  setCachedParseBlock,
  SIDEBAR_VISION_FAIL_HINT,
  supportsVisionModel,
} from './sidebar-vision'
import { SIDEBAR_MEDIA_PARSE_PROMPT } from './sidebar-media-parse-prompt'
import { buildDirectImagePayload, type DirectImageBuild } from './direct-image-payload'
import { mapThinkingLevel } from './pi-runtime/thinking-level'
import { parseSkillCommand } from './pi-runtime/skill-command'
import { resolveForceSkills } from './pi-runtime/resolve-force-skills'
import { stripPlanMarkers } from './planMarkers'
import { normalizeAssistantText } from './text-normalize'
import { PiPromptAssembler } from './pi-runtime/pi-prompt-assembler.service'
import { createThinkingAccumulator, createUsageAccumulator, extractCanvasActions, extractCanvasCommands, mapPiEventToUiEvent, classifyPiRunError, type PiRuntimeEvent } from './pi-runtime/pi-events'

/** #12：pi 每轮的画布上下文（P0-① 起全部经 prompt 的 turnContext 逐轮透传，不再随会话创建注入）。 */
export interface PiCanvasContext {
  attachments?: SidebarAttachment[]
  mentionedKeys?: string[]
  refOrder?: string[]
  focusNodeId?: string
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
  presentation?: Record<string, unknown>
  executionTrace?: ExecutionTraceState
  executionEvents?: Array<{ type: string; data: unknown }>
}): AgentMessageMetadata | undefined {
  const metadata: AgentMessageMetadata = {}
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
    // 两产品线拆分 path A 的 seam：画布动作落地实现可替换（归属待定）。
    // 可选 —— 未提供时回退默认实现，保证现有调用/测试行为不变。
    @Optional()
    @Inject(CANVAS_ACTION_APPLIER)
    private readonly canvasActionApplier?: CanvasActionApplier,
    // 审计 #7：长期记忆动态注入。@Optional 保证既有测试/装配路径零破坏。
    @Optional()
    @Inject(AgentMemoryService)
    private readonly agentMemory?: AgentMemoryService,
  ) {}

  /** 画布动作落地实现：注入优先，缺省回退默认（@lnkpi/agent 的 applyCanvasActions）。 */
  private get applier(): CanvasActionApplier {
    return this.canvasActionApplier ?? defaultCanvasActionApplier
  }

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
    idempotencyKey?: string,
    skillId?: string,
    model?: string,
    focusNodeId?: string,
    attachments?: SidebarAttachment[],
    refOrder?: string[],
    mentionedKeys?: string[],
    thinking?: boolean,
    thinkingEffort?: 'high' | 'max',
    /**
     * ③ 重跑：pi 会话内目标消息的 entryId（前端从 `pi_message_end` 捕获）。
     * 提供时 → 先 fork 出「截断到该消息之前」的新分支会话，本轮在新线程上跑。
     */
    branchFromEntryId?: string,
  ): AsyncGenerator<AgentStreamEvent> {
    // Register idempotency key (if provided) before starting
    if (idempotencyKey) {
      await this.registerIdempotencyKey(idempotencyKey, sessionId, threadId || sessionId)
    }

    const validatedAttachments =
      attachments?.length ? validateSidebarAttachments(attachments) : undefined
    const validatedMentionedKeys =
      mentionedKeys?.length ? normalizeMentionedKeys(mentionedKeys) : undefined

    // B4：pi-runtime 开关提前判定（fork 需先于落库确定最终 threadId，故上移）
    const piMode = this.getPiRuntimeMode()
    const piUrl = this.getPiRuntimeUrl()
    const piEligible = piMode !== 'off' && piUrl && userId

    // ---- ③ 重跑：后端线程截断（与 WorkBuddy「编辑并重发」一致）----
    // fork 必须在落库之前：本轮的用户消息要落在**新**线程上，否则前端切到新 threadId 后
    // 刷新会查不到这条消息（旧线程的历史保留不动，分支只往前走）。
    let effectiveThreadId = threadId?.trim() || sessionId
    let piClient: PiRuntimeClient | undefined
    const branchId = branchFromEntryId?.trim()
    if (piEligible && branchId) {
      const forkClient = this.createPiRuntimeClient(piUrl)
      if (await forkClient.healthz()) {
        try {
          const forked = await forkClient.forkSession(effectiveThreadId, branchId, {
            // 分支仍属同一画布：工具回查 Nest 需要画布会话 id（2026-09-29 hotfix 语义）
            canvasSessionId: sessionId,
            thinkingLevel: mapThinkingLevel(thinking, thinkingEffort),
          })
          effectiveThreadId = forked.newKey
          piClient = forkClient
          // 通知前端切换 agentThreadId：后续发送/订阅都要用新线程
          yield {
            type: 'thread_forked',
            data: { threadId: forked.newKey, newSessionId: forked.newSessionId },
          }
        } catch (err) {
          // fork 失败（切点 entry 不存在 / 来源会话已回收）：如实报错，不污染旧链
          this.piLogger.warn(
            `fork failed (key=${effectiveThreadId}, entry=${branchId}): ${String(err)}`,
          )
          yield {
            type: 'error',
            data: {
              message: '重跑失败：目标消息已不存在，请直接发送新消息。',
              error_type: 'fork_failed',
            },
          }
          yield { type: 'done', data: {} }
          if (idempotencyKey) await this.completeIdempotencyKey(idempotencyKey, '')
          return
        }
      } else {
        // pi 不可达：不 fork，保持原线程（后续主块会再次 healthz 并走「不可用」路径）
        this.piLogger.warn(`pi-runtime healthz failed, skip fork (session=${sessionId})`)
      }
    }

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
    // P0-①：不再查 AgentMessage 历史喂 prompt —— 会话跨轮常驻，历史已在 pi 侧原生 context 里。
    // DB 仍按 sessionId + threadId 归属落库（前端消息列表与清空语义不受影响）。
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

    // ---- pi-runtime：唯一对话链路（老 LangGraph runtime 已退役）----
    // 老 runtime 退役后没有第二条链路：pi 不可用就如实报错，不再有任何回落。
    // `PI_RUNTIME_MODE=off` 是**维护态开关**（停用 agent 服务），不是切到另一条链路。
    if (piEligible) {
      // 走 fork 分支时复用同一个 client（已探活 + 已 fork）；否则新建并探活。
      const client = piClient ?? this.createPiRuntimeClient(piUrl)
      const piContext: PiCanvasContext = {
        attachments: validatedAttachments,
        mentionedKeys: validatedMentionedKeys,
        refOrder,
        focusNodeId,
      }
      if (!piClient && !(await client.healthz())) {
        // 用户侧文案与「无可用链路」一致；排障靠这条 warn 区分（pi 挂 vs 维护态）。
        this.piLogger.warn(`pi-runtime healthz failed (session=${sessionId})`)
        for await (const event of this.streamRuntimeUnavailable()) {
          yield event
        }
        if (idempotencyKey) {
          await this.completeIdempotencyKey(idempotencyKey, '')
        }
        return
      }
      // P0-①：会话跨轮常驻，为「每轮重建 / 防迟到删除」而生的进程内串行锁一并退役
      // （pi-runtime 侧已有 busy 409 守卫同键并发轮次）。
      for await (const event of this.streamFromPiRuntime(
        client,
        sessionId,
        userMessage,
        userId,
        // ③ 重跑：fork 后这就是新分支 threadId（未 fork 时 = 原 threadId || sessionId）
        effectiveThreadId,
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
      if (idempotencyKey) {
        await this.completeIdempotencyKey(idempotencyKey, assistantText)
      }
      return
    }

    for await (const event of this.streamRuntimeUnavailable()) {
      yield event
    }
    if (idempotencyKey) {
      await this.completeIdempotencyKey(idempotencyKey, '')
    }
  }

  /** off / 非 pi 场景，或 active 下 pi-runtime 不可达：无可用链路。 */
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

  /** 前端心跳（每 15s）探的「生成服务是否可达」。
   *
   * 老 runtime 退役后 pi-runtime 是唯一链路，心跳 = 探 pi，不再有第二条可探。
   * 维护态（PI_RUNTIME_MODE=off）下 chat 会直接报不可用，心跳也必须报不可用，
   * 否则会出现「心跳绿、发消息立刻失败」的自相矛盾。 */
  async checkRuntimeHealth(): Promise<{ ok: boolean; latencyMs?: number }> {
    if (this.getPiRuntimeMode() !== 'active') return { ok: false }
    const piUrl = this.getPiRuntimeUrl()
    if (!piUrl) return { ok: false }
    const start = Date.now()
    const ok = (await this.createPiRuntimeClient(piUrl).healthz()) !== null
    return { ok, latencyMs: ok ? Date.now() - start : undefined }
  }

  /**
   * 中断会话当前正在跑的 run（前端「停止」按钮）。
   *
   * 老 runtime 退役时 `/agent/runs/cancel` 整条链被删，但前端仍在校准它 → 404，
   * 结果「停止」只断开 SSE，pi-runtime 那一轮照跑完（继续烧 token、占会话）。
   * 这里补回语义：转发到 pi-runtime 的 `/sessions/:id/abort`。
   *
   * ⚠️ 会话**保留不删除**——用户停止后可以接着发新消息。
   * pi-runtime 侧没有活跃 run 时返回 skipped=true（前端提示「已断开回复」）。
   *
   * P0-①：中断目标 = **对话键**（threadId，回落 sessionId），与 chat 的会话键推导完全一致；
   * 传画布 sessionId 会 abort 不到常驻会话（键不同）。
   */
  async cancelRun(input: {
    sessionId: string
    threadId?: string
  }): Promise<{ ok: boolean; skipped: boolean }> {
    const piUrl = this.getPiRuntimeUrl()
    if (!piUrl) return { ok: false, skipped: true }
    const sessionKey = input.threadId?.trim() || input.sessionId
    return this.createPiRuntimeClient(piUrl).abortRun(sessionKey)
  }

  /**
   * 用户插话（steering 队列，2026-10-02）：把消息交给 vendor steer 队列，由当前 run 的
   * 下一个 turn 边界（`runtime/drive/boundary.ts:85-89`）接住并续跑同一次 run。
   *
   * 会话键推导与 cancelRun / answerPiPending 完全一致（threadId?.trim() || sessionId）。
   *
   * 这个「轻端点」存在的理由：流式进行中发言走完整 prompt 流必然撞 409（上一轮还在跑），
   * 而此前 `iteratePiEvents` 里的 409 是 `void ... .catch(() => {})` **静默吞掉**的 ——
   * 前端只剩浏览器内一个「最多 1 条」的单槽队列，刷新即丢、断网即丢。插话不该是前端内存的事。
   */
  /**
   * 纯旁听众管（**不发 prompt、不开启新 run**）：转发当前会话 pi-runtime 之后的事件。
   *
   * 存在的唯一理由：followUp 队列在**收尾边界**被接住后，pi-runtime 的 `drainAfterRun`
   * 会派生出新的一代 run（`vendor` 自己没有 terminal drain，是本项目补的排空）。那条 SSE
   * 既不是用户发起的、也不经过 `chat/conversation` —— 主流此时已 close、Nest 已退订，
   * 前端收不到任何东西，「点了等跑完就走开」的人切回来只会看到空白。
   *
   * 与 `iteratePiEvents` 的区别：本方法**不驱动 run**，只旁听；消费端（Nest SSE / 前端）自己
   * 定什么时候断，服务端不因收到 `agent_end` 就收尾（否则续跑那一代恰好被切掉）。
   *
   * ⚠️ 首连必须走 `live: true`（pi-runtime `/events?from=now`）。pi-runtime 的订阅有三档参数：
   * 不传 = **全量重放 buffer**、`?lastEventId=n` = 增量续传、`from=now` = 只收未来。这里过去那个
   * 缺口（主流 buffer 里本轮的事件）恰恰必须跳过 —— 主流已经把这些事件推给前端过了，再重放一遍
   * 就是文本重复。漏一两个字符不如重复一段话。
   *
   * 漏窗是真实存在但极窄的：drain 派生出的新一代要再走一轮网络 + 模型首字才出第一个事件，
   * 而前端在主流 `finally` 里就已发起旁听请求（毫秒级），赶在它前面的概率可忽略。
   */
  async *runEventStream(sessionKey: string): AsyncGenerator<AgentStreamEvent> {
    const piUrl = this.getPiRuntimeUrl()
    // 维护态（PI_RUNTIME_MODE=off / 未配 URL）：旁听无处可挂，直接空流。
    // 刻意不抛错 —— 消费端是「人走开之后切回来才看」的旁路，不该让它在挂载时就炸。
    if (!piUrl) return
    const client = this.createPiRuntimeClient(piUrl)
    const queue: AgentStreamEvent[] = []
    let notify: (() => void) | null = null
    let finished = false
    const unsubscribe = client.streamEvents(
      sessionKey,
      (event) => {
        // 与主 `streamConversation` 走同一个归一函数，保证两端事件契约一致
        // （前端 handleEvent 只需认 AgentStreamEvent，不必懂 pi 原始名）。
        const ui = mapPiEventToUiEvent(event)
        if (!ui) return
        // 与主 `streamConversation`（:912）一样：归一产物是 `UiEvent`，末端收口成
        // `AgentStreamEvent` 时统一 cast，保证两端契约一致。
        queue.push(ui as AgentStreamEvent)
        notify?.()
      },
      () => {
        finished = true
        notify?.()
      },
      { live: true },
    )
    try {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift() as AgentStreamEvent
        }
        if (finished) return
        await new Promise<void>((resolve) => {
          notify = resolve
        })
      }
    } finally {
      unsubscribe()
    }
  }

  async steerPiRun(input: {
    sessionId: string
    threadId?: string
    text: string
  }): Promise<{ queued: boolean }> {
    const piUrl = this.getPiRuntimeUrl()
    if (!piUrl) return { queued: false }
    const sessionKey = input.threadId?.trim() || input.sessionId
    return this.createPiRuntimeClient(piUrl).steer(sessionKey, input.text)
  }

  /**
   * 尾随指令（followUp 队列）：「这条我先不发，等本轮跑完再说」。
   *
   * 与 steer 的区别**不在消息形态**（`lane.ts:1456-1460` 两者在 `enqueue` 里构造的是同一个
   * `{role:"user",content:[{type:"text",text}]}`），而在**消费时机**：
   * - steer → run 内任意 checkpoint / finish 边界（`drive/boundary.ts:85-89`）
   * - followUp → 只在本轮收尾、且该边界上没有任何「会 project 的条目」时才拉
   *   （`boundary.ts:106` `followUpWhenNoTrigger && !pending.some(projects)`）
   *
   * ⚠️ 由此产生一条必须让调用方知道的规则：**同一次边界里已有 steer 时 followUp 会被跳过**，
   * 消息留在 inbox 等下一次 accept（pi-runtime 的 `drainAfterRun` 会兜，不丢但延后）。
   * 所以 UI 上 steer 与 followUp 是「二选一」而非「可叠加」，别做成可同时勾选。
   *
   * 入队成功即返回：真正接住发生在当前 run 的收尾边界，本方法不等待、不开新流
   * （开新流会撞 409，且用户此刻要的是「人走开」而不是「盯着看」）。
   */
  async followUpPiRun(input: {
    sessionId: string
    threadId?: string
    text: string
  }): Promise<{ queued: boolean }> {
    const piUrl = this.getPiRuntimeUrl()
    if (!piUrl) return { queued: false }
    const sessionKey = input.threadId?.trim() || input.sessionId
    return this.createPiRuntimeClient(piUrl).followUp(sessionKey, input.text)
  }

  /**
   * B-2：透传用户回答到 pi-runtime pending registry（ask_user/propose_generation 阻塞恢复）。
   * sessionKey 推导与 cancelRun（:392）完全一致：threadId?.trim() || sessionId。
   * 幂等：pi-runtime 侧未知/已清理 callId 返回 deduped=true，不抛错。
   */
  async answerPiPending(input: {
    sessionId: string
    threadId?: string | null
    callId: string
    answers: Record<string, string[]>
  }): Promise<{ ok: boolean; deduped: boolean }> {
    const piUrl = this.getPiRuntimeUrl()
    if (!piUrl) return { ok: false, deduped: false }
    const sessionKey = input.threadId?.trim() || input.sessionId
    return this.createPiRuntimeClient(piUrl).answer(sessionKey, {
      callId: input.callId,
      answers: input.answers,
    })
  }

  /**
   * W12: 重连时的 checkpoint 相位。
   *
   * 老 LangGraph runtime 已退役，checkpoint 概念随它一起消失（pi-runtime 无此状态），
   * 所以恒为 null——与「查不到」等价，前端按无状态处理。
   * 端点保留：前端 `AgentSideRail.vue` 重连时仍会调 `/api/agent/thread-state`，
   * 删端点会让它 404。将来若 pi 侧补恢复态，从这里接回即可。
   */
  async getThreadState(_threadId: string): Promise<null> {
    return null
  }

  /** 同 getThreadState：checkpoint 历史随老 LangGraph runtime 一起退役，恒 null。 */
  async getThreadTimeline(_threadId: string): Promise<null> {
    return null
  }

  // ---------------------------------------------------------------------------
  // pi-runtime：唯一对话链路（老 LangGraph runtime 已于 2026-09-27 退役）
  //
  // PI_RUNTIME_MODE 二态（默认 active）：
  //   active — 正常服务。pi healthz 不通过 → 直接报不可用（没有第二条链路可回落）
  //   off    — **维护态开关**：停用 agent 服务，chat 与心跳都报不可用。
  //            不再是「切回老 runtime」——那条链路已删。
  // ---------------------------------------------------------------------------

  private readonly piLogger = new Logger('AgentService.pi')

  getPiRuntimeMode(): 'off' | 'active' {
    return process.env.PI_RUNTIME_MODE?.trim().toLowerCase() === 'off' ? 'off' : 'active'
  }

  getPiRuntimeUrl(): string | undefined {
    return process.env.PI_RUNTIME_URL?.trim() || undefined
  }

  /** K-1 回滚开关：置 off → 停发 llm 字段，全量回落 pi-runtime env 装配（秒级止血，不改代码）。 */
  piLlmPassthroughEnabled(): boolean {
    return (process.env.PI_LLM_PASSTHROUGH?.trim().toLowerCase() || 'on') !== 'off'
  }

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
      // 视觉输入能力必须**显式**传下去，且永远是 boolean（见下方注释）。
      supportsVision: this.resolveOverrideSupportsVision(ctx),
    }
  }

  /**
   * BYOK override 的视觉输入能力（接线 #123/#124）。
   *
   * **为什么必须显式传**：Nest 是唯一知道「用户那个模型能不能看图」的地方——
   * 它持有渠道元数据、也能跑探针；pi-runtime 只拿到一个 providerRef，无从得知。
   * 若这里不传，pi-runtime 的 `overrideProvider()` 会回落到硬编码
   * `input:["text"]`，于是 vendor `downgradeUnsupportedImages` 把每张图换成
   * `(image omitted: model does not support images)`。
   * 那是一次**完全成功**的请求：上游200、assistant 正常落库、无 error 事件、
   * 无 5xx、无日志——UI 上只能表现为「模型说看不见图」（生产事故根因）。
   *
   * **当前没有可用的显式声明，所以走启发式兜底**：
   * `resolveVisionInputSupport` 需要「渠道显式声明该模型接收图片输入」或「实测探针」
   * 才有结论。但 `ProviderChannel.models[]` 里**只有 `capability`（输出模态）**，
   * 没有输入能力字段；探针也还没实现。所以现在必然落到 `unknown` 分支。
   *
   *⚠️ 刻意**不**把 `capability` 当输入声明：生产实测 `agnes-2.5-flash` 声明
   * `capability:"text"` 却能识图（`image_tokens:1024`），拿输出去推输入会把
   * 能看图的模型判成不能——与本次事故同形、方向相反。TS 也拦得住这个写法：
   * `ModelCapability` 与 `'vision'` 无交集，`declared === 'vision'` 是死代码。
   *
   * 这样写的收益是：一旦有人给渠道加`inputModalities` 字段或实现探针，
   * 这里立刻自动生效，无需再改接线。
   *
   * **为什么折叠成 boolean 而不是省略字段**：省略字段等于让 pi-runtime 回落
   * 硬编码，正是上面那个故障形状。显式 false 的后果是「识图走兜底块并给用户
   * 失败提示」，可查得多。
   */
  private resolveOverrideSupportsVision(ctx: ProviderContext): boolean {
    const support = resolveVisionInputSupport(ctx.providerRef, {
      // 无输入能力声明 ⇒ 留空 ⇒ unknown（传 undefined 会与「显式声明不支持」混淆）
      declared: undefined,
    })
    if (support === 'supported') return true
    if (support === 'unsupported') return false
    // unknown：回落现役启发式（agent.service:670 / direct-image-payload:86 同一判据），
    // 保证本 PR 不改变「哪些模型走直通」的既有行为，只把它显式化。
    return supportsVisionModel(ctx.model)
  }

  /** Overridable in unit tests */
  createPiRuntimeClient(baseUrl: string): PiRuntimeClient {
    return new PiRuntimeClient({ baseUrl })
  }

  /** Overridable in unit tests（#12：每轮 system prompt 组装器） */
  createPiPromptAssembler(): PiPromptAssembler {
    return new PiPromptAssembler(this.canvasTools as never)
  }

  /** Overridable in unit tests（T1：多模态直通图片组装器） */
  createDirectImagePayloadBuilder(): typeof buildDirectImagePayload {
    return buildDirectImagePayload
  }

  /**
   * 收集「跨压缩必须保留」的领域状态（Round 2 W2①）。
   *
   * ## 为什么 Nest 侧填而 pi-runtime 不猜
   *
   * 「哪些节点正等用户确认」的 SSOT 是画布节点上的 `data.status === 'pending_confirm'`
   * —— `proposeGeneration()` 在返回propose 卡片**之前**就已把它 persist 进
   * `Session.canvasData`（agent-canvas-tools.service.ts:1080-1087），
   * 且pi-runtime 的 generation-gate 跨轮/跨会话重建后**仍然回查这个字段**
   * （gate/generation-gate.ts:147-155），它是唯一真相。
   * pi-runtime 若自己推断，会产生第二套与画布不一致的真相。
   *
   * ## 为什么不用 getCanvasSummary
   *
   * `getCanvasSummary({ focusNodeId })` 在 >30 节点画布上会做焦点过滤
   * （CANVAS_SUMMARY_FULL_LIMIT=30），**待确认节点可能被过滤掉 ⇒ 保留段漏报**。
   * 保留段是「宁可多报不可漏报」的场景（漏报 = 压缩后重复建节点 + 谎称已生成）。
   *
   * ## fail-soft
   *
   * DB 读失败返回 `{}`：保留段退化为通用兜底要求，压缩照常发生。
   * 反向选择（抛错阻断 prompt）会把一个纯增强功能变成主链路故障点。
   */
  private async collectRetentionState(sessionId: string): Promise<PiRetentionState> {
    try {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { canvasData: true },
      })
      if (!session?.canvasData) return {}
      const parsed = JSON.parse(session.canvasData) as {
        nodes?: Array<{ id?: unknown; data?: { status?: unknown } }>
      }
      const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : []
      const pendingConfirmNodeIds = nodes
        .filter((n) => String(n?.data?.status ?? '') === 'pending_confirm')
        .map((n) => String(n?.id ?? ''))
        .filter((id) => id.length > 0)
      return pendingConfirmNodeIds.length > 0 ? { pendingConfirmNodeIds } : {}
    } catch (err) {
      this.piLogger?.warn(
        `collectRetentionState failed (fail-soft, 保留段退化为通用兜底): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return {}
    }
  }

  /**
   * pi-runtime 事件流 → 现有 AgentStreamEvent（退役后唯一主路径）。
   * 累积 assistantText / canvasActions，回合结束走 finalizeTurn 持久化。
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
    // T1 多模态直通（spec §3.1）：视觉模型 + 图片附件 → base64 images + [In=] 标记。
    // 直通成功则跳过识图前置（省一次 vision QA）；失败/非视觉 → undefined 走识图兜底。
    const directImageModel = model?.trim() || (await this.loadDefaultTextModel(userId).catch(() => undefined))
    let directImages: DirectImageBuild | undefined
    try {
      directImages = await this.createDirectImagePayloadBuilder()({
        attachments: piContext?.attachments,
        model: directImageModel,
      })
    } catch (err) {
      this.piLogger?.warn?.(
        `direct image payload build skipped (fail-soft): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    // ③ 侧栏识图前置：结果作为文本上下文并入 systemPrompt（失败返回 ''，不阻断）
    const visionBlock = directImages
      ? ''
      : await this.buildSidebarVisionBlock({
      sessionId,
      userId,
      userMessage,
      attachments: piContext?.attachments,
      model,
    })
    // P0-① Task 10：装配器拆静态/动态两段。此处暂按旧语义把两段拼成一个 systemPrompt
    // （会话仍每轮重建，动态块不会被冻结）；Task 11 改为把动态段交给 pi-runtime 每轮求值。
    const assembler = this.createPiPromptAssembler()
    const staticPrompt = await assembler.assembleStatic({
      // B-5：run_* 生成工具已注册，genTools 规则组启用（规则 3' + 11/12/13）
      ruleGroups: ['core', 'writeTools', 'genTools'],
    })
    // P1#5：尾部追加任务计划汇报约定（⟦plan⟧/⟦task-done⟧ 内联标记，Nest 剥离后派生 task 事件）。
    // 静态指令进 staticPrompt（visionBlock 等动态段由 assembleDynamic 每轮追加，不冻结进历史）。
    const systemPromptWithPlanConvention = `${staticPrompt}

## 任务计划汇报（多步任务时启用）
多步出图/改造任务开工前，先单独一行输出计划标记（会被界面渲染为任务清单，用户可见）：
⟦plan⟧[{"n":1,"title":"起稿"},{"n":2,"title":"配图"}]
每完成一项，单独一行输出：⟦task-done⟧<n>
标记行之外不要解释标记本身；单步简单任务不要输出标记。`
    // P0-①：会话键 = 对话（threadId），不是画布会话（sessionId）——新对话即新键、新上下文。
    // 与持久化键 / cancelRun 共用同一推导，三处必须一致。
    const sessionKey = threadId?.trim() || sessionId
    // 动态段（画布快照 + 侧栏素材 + 侧栏识图结果）：交给 pi-runtime 每轮追加到
    // systemPrompt 尾部求值，不写入对话历史（spec §4 动态上下文判据）。
    // 审计 #7：长期记忆动态注入——每轮最近 5 条拼块（fail-soft，memory 挂了会话照常）。
    // 安全红线：只拼 content 摘要行，绝不带 id/userId（与 tools/memory.ts 同一红线）。
    //
    // 终审 C-1：这条注入通道**必须**带画布归属并限定作用域。
    // 事故链里「有记忆可捞」主要走的就是这条每轮注入，而不是模型主动调的 recall_memory；
    // 原实现不传 sessionId/scope ⇒ where退化成 {userId}，把别的画布的项目知识
    // 以「用户历史偏好」的名义塞进 system prompt，完整绕过作用域隔离。
    let memoryBlock: string | undefined
    if (this.agentMemory && userId) {
      try {
        const mem = await this.agentMemory.searchMemory({ userId, sessionId, limit: 5, scope: 'any' })
        const lines = mem.items.map((m) => `- ${m.crossCanvas ? '[其他画布] ' : ''}${m.content}`)
        if (lines.length) {
          const header = '## 长期记忆（用户历史偏好，供参考）'
          // 跨画布条目必须自带归属说明——不能只靠提示词规则，事故证明模型会违反它们。
          const crossNote = mem.items.some((m) => m.crossCanvas)
            ? '\n注：带前缀的条目来自别的画布/项目，仅作背景参考，不能当作当前画布、当前截图或当前图片的观察结果。'
            : ''
          memoryBlock = `${header}\n${lines.join('\n')}${crossNote}`
        }
      } catch (err) {
        this.piLogger?.warn?.(`memory injection skipped (fail-soft): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const dynamicBlocks = await assembler.assembleDynamic({
      sessionId,
      attachments: piContext?.attachments,
      // 审计 P0-①：焦点过滤（>30 节点画布只注入焦点 + 1 跳邻居），换话题污染收口。
      focusNodeId: piContext?.focusNodeId,
      memoryBlock,
    })
    if (visionBlock) dynamicBlocks.push(visionBlock)
    const created = await this.ensurePiSession(client, sessionKey, {
      systemPrompt: systemPromptWithPlanConvention,
      userId,
      // D-T1：老 UI effort 两档映射为 pi 档位，逐请求透传
      thinkingLevel: mapThinkingLevel(thinkingOpts?.thinking, thinkingOpts?.thinkingEffort),
      // K-1：BYOK 渠道覆盖（undefined → pi-runtime env 装配）
      llm,
      // ⚠️ 必须显式传画布会话 id：sessionKey 可能是 `${画布id}:${后缀}` 的复合键，
      // pi-runtime 会把它哈希成 toSessionKey() 作为持久化键，而工具要拿**画布** id
      // 回查 Nest `/agent/internal/*`（prisma.session.findUnique({id})）。
      // 不传 → agent 全部画布工具 404（2026-09-29 hotfix）。
      canvasSessionId: sessionId,
    })
    if (created.status === 'rebuilt') {
      // 会话身份变更（如 BYOK 渠道切换）→ pi-runtime 重建了会话，历史已重置。
      // 用户侧不变天，但这轮上下文确实变薄了，必须可观测。
      this.piLogger.warn(
        `pi session rebuilt for key=${sessionKey} (会话身份变更，历史已重置)`,
      )
    }
    const events = this.iteratePiEvents(client, sessionKey)
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
    // P0-①：每轮世界状态（画布/侧栏）随本轮 prompt 求值，不进对话历史
    const turnContext = {
      dynamicBlocks,
      attachments: piContext?.attachments,
      mentionedKeys: piContext?.mentionedKeys,
      refOrder: piContext?.refOrder,
      focusNodeId: piContext?.focusNodeId,
      // W2①压缩保留段：把「待用户确认的节点」交给 pi-runtime，让它活过上下文压缩。
      // 压缩后模型看不到自己已经propose 过，最典型的后果是重复建节点 + 谎称已生成。
      retention: await this.collectRetentionState(sessionId),
    }
    // T1：直通生效时把 [In=文件名] 标记并入发送文本尾部（pi-runtime T4 摘要占位从该标记恢复编号）
    const promptTextWithMarkers = directImages
      ? `${promptText}\n${directImages.markers.join(' ')}`
      : promptText
    void client
      .prompt(sessionKey, promptTextWithMarkers, "main", {
        forceSkills,
        turnContext,
        images: directImages?.images,
      })
      .catch(async (err: unknown) => {
        // 原本这里是一个空 catch（注释写「prompt 失败会以 error 事件形式出现」）——
        // 那只对 503/上游错误成立：pi-runtime 会把 error 写进 SSE，前端看得见。
        // 但对 **409 不成立**：prompt 根本没进去，会话在跑，SSE 里不会有任何东西，
        // 于是「用户发了、世界没反应」是彻底静默的，而它恰恰是这条链路最常见的失败。
        const message = err instanceof Error ? err.message : String(err)
        const status = (err as { status?: number } | undefined)?.status
        if (status !== 409) {
          // 上游错误：照旧交给 SSE 的 error 事件，此处不另起一轮
          this.piLogger.warn(`pi prompt failed (key=${sessionKey}): ${message}`)
          return
        }
        // 409 = 上一轮还在跑。用户这次发言不该蒸发 → 改走 steer 队列（durable 落盘），
        // 由当前 run 的下一个 turn 边界接住。此前这条分支是 `catch(() => {})`，静默丢消息。
        try {
          await client.steer(sessionKey, promptText, "main", { turnContext })
        } catch (steerErr: unknown) {
          // 队列也塞不进去（会话已被回收 / runtime 侧异常）：必须留痕，
          // 否则「消息既不回答也不报错」会成为查不掉的黑洞。
          this.piLogger.warn(
            `pi steer fallback failed (key=${sessionKey}): ${
              steerErr instanceof Error ? steerErr.message : String(steerErr)
            }`,
          )
        }
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
        // 失败透传（item 2）+ 可观测性（item 3）：本轮以错误结束 → 分类后下发结构化 error 事件，
        // 前端接住后既在对话内追加 ⚠️，又在 dock 上沿弹「充值提醒」类窄卡片。
        const turnErr = classifyPiRunError(event)
        if (turnErr) {
          const providerRef = (llm as { providerRef?: string } | undefined)?.providerRef
          const modelName = (llm as { model?: string } | undefined)?.model
          this.piLogger.warn(
            `pi run failed (kind=${turnErr.kind}, provider=${providerRef ?? 'unknown'}, model=${modelName ?? 'unknown'}, key=${sessionKey}): ${turnErr.message}`,
          )
          yield {
            type: 'error',
            data: {
              message: turnErr.message,
              error_type: turnErr.kind,
              retry_hint: turnErr.retry_hint,
              provider: providerRef ?? null,
              model: modelName ?? null,
            },
          } as AgentStreamEvent
        }
        // UI_COMMAND 批次：canvas_command 是 UI 命令（focus/undo/redo/open_image_editor），
        // 直通前端 AgentSideRail canvas_command 分支；不得进 canvasActions（那是画布数据动作通道）。
        // B-6：tool_execution_update 也参与提取——阻塞 ask_user 卡片只在 update 快照
        // （onUpdate → partialResult.details.canvasCommands）里，end 事件只有答案文本
        for (const cmd of extractCanvasCommands(event)) {
          // P1#7：ask_user 进 executionEvents → metadata 落库，刷新/重连后可恢复待答卡。
          // svg_card 与 ask_user 同走这条落库通道（spec §4.6 第 3 跳）：卡片只经 SSE
          // 实时上屏，刷新即失；落库后前端从 metadata.executionEvents 重放恢复。
          // update 快照可能多次下发：同 callId 以最新为准（先移除旧条目再入列，防落库重复）；
          // blocking off 旧路径卡片无 callId，不去重直接追加。
          //
          // ⚠️ 去重按 callId 精确匹配（`e.data.callId === cmd.callId`）且外层有
          // `if (cmd.callId)` 门 —— svg_card 无 callId，既不会被这里的 splice 删掉，
          // 也不会让别的条目被误删。回归锁：本文件测试的「Review Focus #2 / #2b」。
          // 其余 canvas_command（focus_node / undo / arrange_nodes…）刻意不落库：
          // 它们是瞬时 UI 副作用或画布数据动作，落库只会在重放时变成无源指令。
          if (cmd.type === 'ask_user' || cmd.type === 'svg_card') {
            if (cmd.callId) {
              const idx = executionEvents.findIndex(
                (e) => e.type === 'canvas_command' && (e.data as { callId?: string }).callId === cmd.callId,
              )
              if (idx >= 0) executionEvents.splice(idx, 1)
            }
            executionEvents.push({ type: 'canvas_command', data: cmd })
          }
          yield { type: 'canvas_command', data: cmd }
        }
        // B-5：gen/lifecycle 工具 details.actions → canvas_action（画布数据动作通道；
        // 对齐老链路 NestEventProxy 转发语义），节点状态经此实时到前端
        for (const action of extractCanvasActions(event)) {
          canvasActions.push(action)
          executionEvents.push({ type: 'canvas_action', data: action })
          yield { type: 'canvas_action', data: action }
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
          // P1#5：plan 内联标记剥离 + 派生既有 task_list/task_update 事件（todo 面板数据源）
          const rawText = (ui.data as { text: string }).text
          const stripped = stripPlanMarkers(rawText)
          assistantText += stripped.text
          ;(ui.data as { text: string }).text = stripped.text
          if (stripped.plan?.length) {
            const planEv = {
              type: 'task_list',
              data: {
                items: stripped.plan.map((it) => ({
                  id: `plan-${it.n}`,
                  title: it.title,
                  status: 'running',
                })),
              },
            }
            executionEvents.push(planEv)
            yield planEv as AgentStreamEvent
          }
          if (stripped.doneN != null) {
            const doneEv = { type: 'task_update', data: { id: `plan-${stripped.doneN}`, status: 'done' } }
            executionEvents.push(doneEv)
            yield doneEv as AgentStreamEvent
          }
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
      // P0-①：会话跨轮保留（历史即上下文），回收由 pi-runtime 的 TTL / 磁盘 LRU 负责。
      // 这里只退订本轮订阅（触发 iteratePiEvents 的 finally → client.cancel）。
      await iterator.return(undefined).catch(() => {})
    }

    const effectiveThreadId = threadId?.trim() || sessionId
    await this.finalizeTurn(sessionId, effectiveThreadId, userId, assistantText, canvasActions, {
      // Nest internal tools already wrote Session.canvasData; skip re-apply to avoid duplicate add_node
      rewriteCanvasData: false,
      // 退役对齐：老 LangGraph 路径（streamFromRuntime）同样传 deriveLinkedOutputs，
      // pi 路径此前漏了这一项 → 助手消息的「产出」挂件为空。老路径已删，此处补回对等语义。
      linkedOutputs: deriveLinkedOutputs(canvasActions),
      metadata: buildTurnMetadata({ executionEvents }),
    })
  }
  /**
   * 确保 pi 会话存在。P0-① 起 create 是幂等的（同会话键复用），重建由 pi-runtime
   * 内部按 LLM 身份判定 —— Nest 侧不再有「删了重建」路径（`createSessionReplacingStale` 已退役）。
   * 返回 status 供调用方区分 created / resumed / rebuilt。
   */
  private async ensurePiSession(
    client: PiRuntimeClient,
    sessionKey: string,
    opts?: {
      systemPrompt?: string
      userId?: string
      thinkingLevel?: 'off' | 'medium' | 'high'
      /** K-1：BYOK 会话级模型覆盖（仅 source=user 的渠道；平台用户不传） */
      llm?: PiSessionLlmOverride
      /** 画布会话 id（≠ sessionKey，见 createSession 处注释）；工具回查 Nest 用 */
      canvasSessionId?: string
    },
  ): Promise<CreateSessionResult> {
    return client.createSession(sessionKey, {
      systemPrompt: opts?.systemPrompt,
      userId: opts?.userId,
      thinkingLevel: opts?.thinkingLevel,
      // K-1：BYOK 覆盖随会话创建注入（畸形由 pi-runtime 侧 400，此处不二次校验）
      llm: opts?.llm,
      // 画布会话 id 随会话创建注入 → pi-runtime 存进 entry，toolContext 取它而非哈希键
      canvasSessionId: opts?.canvasSessionId,
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
      // P0-A（2026-09-29）：每轮新订阅必须 `from=now`（只收未来事件）。
      // 持久会话的缓冲跨轮累积，若全量重放会先收到上一轮事件（含其 agent_end）
      // → 本轮在 ~100ms 内被上一轮回答顶替（生产六步 CRUD 实证）。
      { live: true },
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

  private async finalizeTurn(
    sessionId: string,
    threadId: string,
    userId: string | undefined,
    assistantText: string,
    canvasActions: CanvasAction[],
    opts: { rewriteCanvasData: boolean; linkedOutputs?: LinkedCanvasOutput[]; metadata?: AgentMessageMetadata },
  ) {
    const shouldPersistAssistant = Boolean(
      assistantText || opts.metadata?.presentation || opts.metadata?.executionEvents?.length,
    )
    if (shouldPersistAssistant) {
      // 首尾空行归一化：上游 harness / agnes 网关常在下水前补一串 \n（生产 1.4% 消息命中），
      // 只在落库这一跳清理——逐帧 normalize delta 会把跨 delta 的段落换行吃掉。
      //
      // 归一化后允许为空串：模型只吐 thinking / toolCalls 而没吐正文时（生产实测占
      // 纯空白行的 100%，全部带 executionEvents）content 本就该是空的。此前这里写的是
      // `|| ' '`兜底，会把「无正文」伪装成「有一个空格」——生产库确实留下了
      // len=1 / codepoint=32 的行，前端还可能因此渲染出一个空气泡。
      // 空 content 不影响 `shouldPersistAssistant` 的判定：那条走的是原始 assistantText
      // 与 metadata，presentation / executionEvents 才是这些行必须落库的原因。
      const content = normalizeAssistantText(assistantText)
      await this.prisma.agentMessage.create({
        data: {
          sessionId,
          threadId,
          role: 'assistant',
          content,
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
          const updated = this.applier.apply(currentData, canvasActions)
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
