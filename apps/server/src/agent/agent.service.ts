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
  PersistedExecutionEvent,
  SidebarAttachment,
} from '@lnkpi/shared'
import {
  listModels,
  normalizeMentionedKeys,
  validateSidebarAttachments,
  type GenerationType,
  type StudioModality,
} from '@lnkpi/shared'
import { MaterialService } from '../canvas/material.service'
import { ShotService } from '../canvas/shot.service'
import { ZodError } from 'zod'
import { AgentCanvasToolsService } from './agent-canvas-tools.service'
import {
  isLedgerComplete,
  ledgerGapFrom,
  type LedgerCapture,
} from './turn-ledger'
import { AgentMemoryService } from './agent-memory.service'
import { isSuppressed } from './memory-suppression'
import { resolveRuleGroups } from './pi-runtime/rule-groups'
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
  type PiPromptInfo,
  type PiRetentionState,
  type PiSessionLlmOverride,
} from './pi-runtime/pi-runtime.client'
import { resolveModelCapability, resolveVisionInputSupport } from '../provider/model-capability'
import { resolveChannelModelCost } from '../provider/model-cost'
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
import { createThinkingAccumulator, createTextSegmentPersister, createUsageAccumulator, extractCanvasActions, extractCanvasCommands, extractTaskEvents, extractTextEnd, mapPiEventToUiEvent, classifyPiRunError, type PiRuntimeEvent } from './pi-runtime/pi-events'
import { estimateCreditsFromUsdCost, resolveFxUsdCny } from '../pricing/pricing.core'
import { InsufficientPointsError, PointsService } from '../points/points.service'
import { PricingService } from '../pricing/pricing.service'
import type { PointTxMeta } from '../points/point-tx.types'

/** #12：pi 每轮的画布上下文（P0-① 起全部经 prompt 的 turnContext 逐轮透传，不再随会话创建注入）。 */
export interface PiCanvasContext {
  attachments?: SidebarAttachment[]
  mentionedKeys?: string[]
  refOrder?: string[]
  /**
   * SEL-REF：指代信号（本轮画布选中的节点 id 集合）—— **唯一真源**。
   * `focusNodeId` 由本字段派生（§5.3）；正常客户端不发它。
   */
  selectedNodeIds?: string[]
  /**
   * @deprecated 仅供**迁移期回落**：版本错配期的旧客户端只发 `focusNodeId`。
   * 只有当 `selectedNodeIds` **完全缺省**时才会被读（见 streamFromPiRuntime）；
   * 命中即写 warn。有消费方，不是死字段，但**新客户端不得下发**。
   */
  legacyFocusNodeId?: string
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
  executionEvents?: PersistedExecutionEvent[]
  /**
   * TURN-IDENTITY PR2：账本不完整（本流没捕获到 run 起点）。
   *
   * 键不出现纪律：完整时**不写** `partial` / `gapFrom` 两个键（老消息因此零变化），
   * 只有残缺才落 `partial:true`，`gapFrom` 仅在序号已知时附带。
   */
  partial?: boolean
  gapFrom?: number
}): AgentMessageMetadata | undefined {
  const metadata: AgentMessageMetadata = {}
  if (input.executionTrace) metadata.executionTrace = input.executionTrace
  if (input.presentation) metadata.presentation = input.presentation
  if (input.executionEvents?.length) metadata.executionEvents = input.executionEvents
  if (input.partial) {
    metadata.partial = true
    if (input.gapFrom !== undefined) metadata.gapFrom = input.gapFrom
  }
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

/**
 * Prisma 唯一约束冲突（P2002）——`(threadId, runId)` 唯一索引的裁决信号。
 *
 * 为什么要按 code 判而不是 catch-all：这里的语义是「已有人在跑的这个 run 上记过账」，
 * 与「数据库整体不可用 / 字段写错」是两件事。混在一起 catch 会让真正的落库故障
 * 被静默降级成「反正有 owner 记了」——那正是本次事故的家族形态（失败被降级成成功）。
 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002'
}

/** P2 T6：回合预扣单的结构子集（freeze 返回的 PointHold 只消费这几个字段）。 */
interface TurnPointHold {
  id: string
  amount: number
  status: string
  createdAt: Date
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
    // P2 T6（token 精确计费）：回合预扣/结算依赖。@Optional 保持既有测试与
    // 未装配 Points/Pricing 模块的调用路径零破坏（flag off 时完全不可达）。
    @Optional()
    @Inject(PointsService)
    private readonly points?: PointsService,
    @Optional()
    @Inject(PricingService)
    private readonly pricing?: PricingService,
  ) {}

  /** 画布动作落地实现：注入优先，缺省回退默认（@lnkpi/agent 的 applyCanvasActions）。 */
  private get applier(): CanvasActionApplier {
    return this.canvasActionApplier ?? defaultCanvasActionApplier
  }

  /**
   * 能力清单 = `STUDIO_MODEL_CATALOG` 的派生投影（**唯一真相**）。
   *
   * ⛔ 2026-10-08：此前直接返回 `TEXT_MODELS` / `IMAGE_MODELS` / `VIDEO_MODELS`
   * 那份手写清单，与 catalog **零重叠**（gpt-4o / dall-e-3 / sora… 全部不在目录里）。
   * `packages/shared/src/index.ts` 里那三个常量已删除，此处改为从 catalog 派生，
   * 于是「接口暴露的模型」与「后端能解析的模型」不再可能分叉。
   *
   *顺带补上 `audio`：catalog 有 4 个 modality，而 `GenerationType` 只有 3个，
   * 旧接口缺audio ⇒ 音频面板拿不到列表。前端 `useCapabilities` 按需取用。
   *
   * 注：返回的是 `modelKey`（规范 id），不是 `gatewayModelId`。
   * 调用方需要的是「可被 `resolveModelKey` 解析的 id」，
   * 发给上游的 gatewayModelId 由 `generation-adapter` / `studio.service` 负责转换。
   */
  getCapabilities() {
    const asOption = (modality: StudioModality) =>
      listModels(modality).map((entry) => ({
        id: entry.modelKey,
        name: entry.displayName,
        provider: entry.providerBinding,
        type: (entry.modality === 'audio' ? 'text' : entry.modality) as GenerationType,
      }))

    return {
      text: asOption('text'),
      image: asOption('image'),
      video: asOption('video'),
      audio: asOption('audio'),
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
    // Task 14（repair-duplicate-turns.ts）历史重复回合软标记：被取代的 assistant
    // 行（metadata.supersededBy 非空）不再返回，由 owner 行承载展示，避免重复气泡。
    const visible = rows.filter((r) => {
      if (r.role !== 'assistant') return true
      let supersededBy: unknown
      try {
        const parsed = r.metadata ? JSON.parse(r.metadata) : null
        supersededBy =
          parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).supersededBy : null
      } catch {
        supersededBy = null
      }
      return !supersededBy
    })
    return visible.reverse()
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
    /**
     * @deprecated SEL-REF 起不再使用（前端停止下发；焦点由 `selectedNodeIds` 派生）。
     * 保留仅为位置参数兼容——**删除它会移位后续 7 个参数**，而 `attachments` 等
     * 同型参数错位不会报错。勿读此字段。
     */
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
    /**
     * SEL-REF：指代信号（本轮画布选中的节点 id 集合）。
     * ⛔ 追加在参数表**末尾**：本方法有 ~40 处按位置调用的测试，中间插入会移位，
     * 且 `refOrder` / `mentionedKeys` 同为 `string[]` ⇒ 错位不会报错、只会静默错值。
   * `focusNodeId` 由它派生（见调用方），不再由前端单独给。
   */
  selectedNodeIds?: string[],
  /**
   * P2 T6（token 精确计费）：run 发起方标识。`'automation'` = automation 触发的
   * run（无用户交互）——预扣失败降级为不预扣照常执行 + warn，绝不阻塞自动化
   * （Review Focus 4）；缺省 `'user'` = 用户 run，预扣被拒（余额不足）→ 402 语义拒绝。
   * ⚠️ 追加在参数表**末尾**：本方法有 ~40 处按位置调用的测试，中间插入会移位。
   */
  billingSource?: 'user' | 'automation',
): AsyncGenerator<AgentStreamEvent> {
    // Register idempotency key (if provided) before starting
    if (idempotencyKey) {
      await this.registerIdempotencyKey(idempotencyKey, sessionId, threadId || sessionId)
    }

    let validatedAttachments: SidebarAttachment[] | undefined
    try {
      validatedAttachments = attachments?.length ? validateSidebarAttachments(attachments) : undefined
    } catch (e) {
      // RB-D3 延伸（PR-A 终审）：用户消息附件路径同样不再 500，字段细节 + 正确用法直达。
      const detail = e instanceof ZodError
        ? e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
        : (e as Error).message
      throw new BadRequestException(`参考素材校验失败（${detail}）。请检查上传的参考素材后重试。`)
    }
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
        // SEL-REF：指代信号（选区本身，开关**不**闸这里）——焦点要由它派生，
        // 闸掉就等于把 P0-① 的焦点过滤一起关掉。开关只作用于 digest 块（见调用方 digestIds）。
        selectedNodeIds: selectedNodeIds?.length ? [...selectedNodeIds] : undefined,
        // SEL-REF 迁移期回落输入：新字段**完全缺省**且旧字段有值 ⇒ 旧客户端。
        // 只往 piContext 带、不外泄到 turnContext 的其它位置。
        legacyFocusNodeId: !selectedNodeIds?.length && focusNodeId?.trim() ? focusNodeId.trim() : undefined,
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
        // P2 T6：run 发起方标识透传（预扣失败的用户 run 拒绝 / automation run 降级）
        billingSource,
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
    /** 2026-10-06：`decline` = 用户显式拒绝（propose 卡取消），runtime 以 aborted 交还。 */
    decision?: 'answer' | 'decline'
  }): Promise<{ ok: boolean; deduped: boolean }> {
    const piUrl = this.getPiRuntimeUrl()
    if (!piUrl) return { ok: false, deduped: false }
    const sessionKey = input.threadId?.trim() || input.sessionId
    return this.createPiRuntimeClient(piUrl).answer(sessionKey, {
      callId: input.callId,
      answers: input.answers,
      ...(input.decision ? { decision: input.decision } : {}),
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
   * P2 平台透传开关：**默认 off**（决策 A 原状），只认 `on`（大小写不敏感）。
   * on 时平台 ctx 也注入 pi 会话 llm override —— 平台用户侧栏选的模型对对话线生效。
   * 前置运维语义：开启即宣告「Nest 平台通道与 pi env 不同源」问题已被接受，
   * 平台用户将按 UpstreamRoute 路由走平台通道（availability 校验/探活灰显照常生效）。
   */
  piLlmPlatformPassthroughEnabled(): boolean {
    return (process.env.PI_LLM_PLATFORM_PASSTHROUGH?.trim().toLowerCase() || 'off') === 'on'
  }

  /**
   * SEL-REF 开关（R-S9）：**默认 off**，只认 `on`（大小写不敏感），其余值一律当 off。
   *
   * ⛔ 不用前端 `useFeatureFlag`——那是前端进程内 Map，够不到 Nest 注入点，
   * 且其远程 kill switch 至今未落地（V2 前靠发版）。本开关由 **api 容器**读，
   * 因此**不进 helm chart**、也**不需要** runtime-deploy；参照 `PI_RUNTIME_TOOL_TIERING` 形态。
   */
  selectionRefEnabled(): boolean {
    return (process.env.SEL_REF_ENABLED?.trim().toLowerCase() || 'off') === 'on'
  }

  /**
   * SEL-REF：指代节点的 type/title/绝对坐标。
   *
   * ⚠️ 必须用 `getCanvasLayout` 而不是 `getCanvasSummary`——后者的返回只有
   * `{id, type, title, status}`，**没有坐标**，而 digest 要按位置稳定排序（R-S6/S-8）。
   * 两者都走 `loadSession(sessionId)` ⇒ 同样只返回本会话画布的节点，归属校验白拿。
   */
  private async buildSelectionLookup(
    sessionId: string,
  ): Promise<Map<string, { type: string; title: string; x: number; y: number }>> {
    const empty = new Map<string, { type: string; title: string; x: number; y: number }>()
    if (!this.canvasTools) return empty
    try {
      const layout = await this.canvasTools.getCanvasLayout({ sessionId })
      return new Map(
        layout.nodes.map((n) => [
          n.id,
          // 用 absolutePosition 而非 position：后者相对父 group，节点被打组后同一节点
          // 在两套坐标系里值不同，跨 group 比较会错。
          { type: n.type, title: n.title, x: n.absolutePosition.x, y: n.absolutePosition.y },
        ]),
      )
    } catch (err) {
      // fail-open（R-S7）：查不到布局就不拼 digest，绝不注入半截列表。
      this.piLogger?.warn?.(
        `SEL-REF lookup unavailable for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return empty
    }
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
   * 决策 A（P2 修订）：默认只透传 BYOK（source=user），平台用户保持 env 装配——
   * 生产上 Nest 平台通道（apihub + 老 key + agnes-2.0-flash）与 pi-runtime env
   * （api.agnes-ai.cn + 新 key + agnes-2.5-flash）不同源，无条件透传会让平台用户
   * 换网关换模型，属回归。
   *
   * P2 平台透传：`PI_LLM_PLATFORM_PASSTHROUGH=on` 时平台 ctx（provider-resolver
   * platform 分支：UpstreamRoute 路由 + availability 校验 + 平台 key）也注入 override，
   * 让侧栏选择的平台模型对 pi 对话线真实生效。缺省 off = 行为与决策 A 原状完全一致。
   * 层级：主开关 `PI_LLM_PASSTHROUGH=off` 仍然杀掉整条链路（含平台透传）。
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
    if (ctx.source !== 'user' && !this.piLlmPlatformPassthroughEnabled()) return undefined
    const cap = resolveModelCapability(ctx.providerRef)
    // P1 cost 接线：渠道 models[].pricing → override.cost（vendor calculateCost
    // 据此算 usage.cost）。未配置 pricing → undefined → 字段不出现，行为不变。
    const cost = resolveChannelModelCost(ctx.channelModelsJson, ctx.model)
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
      ...(cost ? { cost } : {}),
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
  /**
   * 从装配器取 prompt 版本指纹（P0-3 / L-2）。
   *
   * 刻意**每次现取**而不是缓存：`lastManifestDetail` 会被下一次装配覆盖，
   * 缓存会把「某个会话用的哪版」与「进程当前装配出的哪版」混起来 ——
   * 而前者才是回溯时真正要回答的问题（同一 manifest 对象在每轮都被覆写）。
   */
  private promptInfoFrom(assembler: PiPromptAssembler): PiPromptInfo {
    const m = assembler.lastManifestDetail
    if (!m) return {}
    return {
      // ⭐ promptVersion 由 registryVersion + registryHash 派生，不另设人工版本号。
      // 理由：人工版本号会**忘记 bump**（改了 .md 忘了改常量 ⇒ 指标显示「同一版」，
      // 而实际内容已变，这正是审计要根治的问题）。派生式永远与内容一致。
      // 形如 `1.0.0@9e8e28f11bc7`：前者是人读的前端版本，后者是机器比对的内容哈希。
      promptVersion: `${m.registryVersion || "n/a"}@${m.registryHash || "n/a"}`,
      promptHash: m.promptHash,
      registryVersion: m.registryVersion,
      registryHash: m.registryHash,
    }
  }

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
    // P2 T6：run 发起方标识（'automation' 预扣失败降级照常执行；缺省用户 run）
    billingSource: 'user' | 'automation' = 'user',
  ): AsyncGenerator<AgentStreamEvent> {
    // ── P2 T6（token 精确计费）：回合发起预扣 ──
    // flag 门禁：TEXT_TOKEN_BILLING 仅 'on' 启用；off 时零预扣零结算（Q2 展示预估照旧，
    // 回归判据——既有测试零改动的根基）。归属 = run（Q2 拍板）：本方法即一个 run，
    // steer 并入当前 run 不新扣；drain/followUp/automation 派生 run 各自预扣结算。
    const billingEnabled = process.env.TEXT_TOKEN_BILLING === 'on' && Boolean(userId)
    let billingHold: TurnPointHold | undefined
    let billingModelKey = ''
    // F2（P2 T6 修复轮）：hold 未终结标志。settle/release 成功后置 false；finally
    // 据此判「hold 仍在手」兜底全退，保证终结路径恰一次（error 分支与 finally 二选一）。
    let holdOpen = false
    if (billingEnabled) {
      // modelKey 从回合参数取（dock/BYOK 选择），空则回落用户默认文本模型（与
      // directImageModel 同一解析），入口处 toLowerCase 规范化。quote 永不 throw。
      billingModelKey = (
        model?.trim() ||
        (await this.loadDefaultTextModel(userId as string).catch(() => undefined)) ||
        ''
      ).toLowerCase()
      const frozen = await this.freezeTurnHold(userId as string, billingModelKey, billingSource)
      billingHold = frozen.hold
      holdOpen = Boolean(billingHold)
      if (!billingHold && frozen.rejected) {
        // 用户 run 预扣被拒（余额不足）→ 402 语义拒绝，回合不发起（与 studio
        // 「先扣后退」一致）。automation run 已在 freezeTurnHold 内降级，不会走到这。
        yield {
          type: 'error',
          data: {
            message: '积分不足，请充值后重试。',
            error_type: 'insufficient_credits',
          },
        } as AgentStreamEvent
        yield { type: 'done', data: {} }
        return
      }
    }
    // ── F2（P2 T6 修复轮）：trace 基础设施声明上移 ──
    // 原声明位置在首个流外 yield（selection_binding）之后；消费方在该 yield 处
    // abort 时 finally 会引用它们 → TDZ ReferenceError。上移后 finally 全程可用。
    const executionEvents: PersistedExecutionEvent[] = []
    // P2-3：落库事件显式带 seq/ts/messageIndex（数组下标即序，seq 冗余但抗裁剪；
    // messageIndex 以 message_end 分段，供时间线还原「多段叙述各自成块」的块归属）。
    let traceSeq = 0
    let traceMessageIndex = 0
    // TURN-IDENTITY P0-1：当前正在处理的 pi 事件（供 pushTraceEvent 取**会话级全局 seq**）。
    // 为什么不逐个给 pushTraceEvent 加参数：它有 11 个调用点，逐个透传会把改动面扩散到
    // 每段事件提取逻辑里，而这些逻辑本身并不关心 seq。改成由事件循环在每轮开头赋值、
    // pushTraceEvent 只读 —— 单线程生成器内无并发写，语义是明确的「当前事件」。
    let currentPiEvent: PiRuntimeEvent | undefined
    const pushTraceEvent = (type: string, data: unknown): PersistedExecutionEvent => {
      if (type !== 'text') textPersister.flush()
      traceSeq += 1
      const ev: PersistedExecutionEvent = {
        type,
        data,
        seq: traceSeq,
        // P0-1：全局 seq 与 pi-runtime 的 afterSeq / lastEventId 同编号空间；
        // 缺省（旧 runtime / 非流式合成事件）时消费端回退局部 seq。
        gSeq: currentPiEvent?.seq,
        ts: Date.now(),
        messageIndex: traceMessageIndex,
      }
      executionEvents.push(ev)
      return ev
    }
    // 正文分段落库（2026-10-14）：任何非文本 trace 事件落库前先 flush，text 事件 seq
    // 恒小于边界事件 ⇒ 前端重放时正文按真实时序归位（修「正文整体跑到工具行上面」）。
    const textPersister = createTextSegmentPersister((type, data) => pushTraceEvent(type, data))
    // ── F2：hold 生命周期 try/finally 收口 ──
    // 消费方 abort（SSE 断开 → .return()）或迭代异常时，生成器尾部结算块不可达
    // → hold 滞留至 reaper 30min。freeze 之后整个 run 体包进 try/finally：
    // 正常收束时结算块已置 holdOpen=false → finally no-op；中断 → 即时全退。
    try {
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
    // B-5：run_* 生成工具已注册，genTools 规则组启用（规则 3' + 11/12/13）。
    // AGENT_RULE_GROUPS 仅供 A/B 评测切组（fail-closed，见 rule-groups.ts）；
    // 生产部署不得设置——覆盖态下 unlessGroup 守卫规则不注入，而工具注册不受 groups 约束。
    const ruleGroups = resolveRuleGroups(process.env.AGENT_RULE_GROUPS)
    if (process.env.AGENT_RULE_GROUPS?.trim()) {
      this.piLogger.warn(
        `AGENT_RULE_GROUPS 覆盖生效: [${ruleGroups.join(',')}] —— 仅限 A/B 评测，生产发版不得携带该变量`,
      )
    }
    const staticPrompt = await assembler.assembleStatic({
      ruleGroups: ruleGroups.filter(
        // C1 kill switch（spec 2026-10-09-task-tool-design.md §3.1）：PI_RUNTIME_TODO_TOOL=off
        // 时 task_tool 规则不注入。⚠️ 双部署单元（Nest 容器 / pi-runtime k3s）各自读同一 env 名，
        // 上线检查单必须核对一致；off 但工具仍注册的错配由 pi-runtime 侧 isError 兜底。
        (g) => g !== 'todoTools' || process.env.PI_RUNTIME_TODO_TOOL !== 'off',
      ),
    })
    // C1：⟦plan⟧/⟦task-done⟧ 教学段已删除——模型改教 todo_write 工具（prompt-registry task_tool 规则）。
    // planMarkers.ts 保留为只读重放兼容层（老会话 resume 渲染旧卡片），TTL 自然退场。
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
        // M6a 反哺剔除（spec 2026-10-04-prompt-engineering §13.3 第3 条）：
        // 这条通道**不经模型调用**、每轮自动注入 5 条，是污染记忆进prompt 的主路
        // （同段注释里的终审 C-1 已论证过「有记忆可捞」主要走这里，而不是模型主动 recall_memory）。
        // 所以抑制必须在这里也生效，否则「剔除」只堵住了次要通道。
        //
        // ⚠️ kept 必须同时喂给 lines 与 crossNote：若 lines 用过滤后、crossNote 用过滤前，
        // 会出现「注入内容里没有跨画布条目，但尾部仍挂着一句『注：带前缀的条目来自别的画布』」的
        // 无主注释——模型被告知去核对一个它看不到的前缀，是纯粹的噪音与误导。
        // 两处同源于kept，才保证「注入什么」与「声明什么」始终一致。
        const kept = mem.items.filter((m) => !isSuppressed(m.id))
        const lines = kept.map((m) => `- ${m.crossCanvas ? '[其他画布] ' : ''}${m.content}`)
        if (lines.length) {
          const header = '## 长期记忆（用户历史偏好，供参考）'
          // 跨画布条目必须自带归属说明——不能只靠提示词规则，事故证明模型会违反它们。
          const crossNote = kept.some((m) => m.crossCanvas)
            ? '\n注：带前缀的条目来自别的画布/项目，仅作背景参考，不能当作当前画布、当前截图或当前图片的观察结果。'
            : ''
          memoryBlock = `${header}\n${lines.join('\n')}${crossNote}`
        }
      } catch (err) {
        this.piLogger?.warn?.(`memory injection skipped (fail-soft): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // SEL-REF 指代信号。**开关只闸新能力，不闸既有行为**：
    //   · selRefIds  —— 焦点派生的输入，**始终**用它 ⇒ `SEL_REF_ENABLED=off` 时
    //     焦点过滤仍与上线前一致（回归测试「active：…画布上下文改由 turnContext 携带」就靠这条）；
    //   · digestIds  —— 只喂 digest 块，开关关时为空 ⇒ 既不拼块也不回执（R-S9）。
    // 若把开关套在 selRefIds 上，一关就把 P0-① 的焦点过滤一起关掉 —— 那是回归，不是关停。
    const selRefIds = piContext?.selectedNodeIds ?? []
    const digestIds = this.selectionRefEnabled() ? selRefIds : []
    // 派生（R-S1/S2）：恰好 1 个选中时才派生焦点；0 个或多个都留 undefined ⇒
    // 命中 getCanvasSummary 的「无焦点 → 全量返回」fail-open 第一闸。
    //
    // ⚠️ 迁移期回落（评审 C2）：版本错配期（CDN 旧 web / 灰度 / 旧标签页）的客户端
    // **只发 `focusNodeId`、不发 `selectedNodeIds`**。若直接丢弃，焦点会退化成
    // 「无焦点」⇒ 命中上面那道 fail-open 第一闸 ⇒ 大画布注入成本上升 + 换话题污染，
    // 且无任何日志。判据是**新字段是否完全缺省**，不是「新字段是否为空」：
    //   · `selectedNodeIds === undefined` → 旧客户端 → 回落旧字段（并 warn 留痕）；
    //   · `selectedNodeIds` 有值（含空数组）→ 新客户端 → **绝不回落**。
    // 这样仍不存在「双字段各自独立写」：两者不可能同时生效，回落路径唯一且有日志。
    const legacyFocusNodeId = piContext?.legacyFocusNodeId
    const legacyFocusOnly = selRefIds.length === 0 && !piContext?.selectedNodeIds && !!legacyFocusNodeId
    let derivedFocusNodeId = selRefIds.length === 1 ? selRefIds[0] : undefined
    if (legacyFocusOnly && legacyFocusNodeId) {
      derivedFocusNodeId = legacyFocusNodeId
      this.piLogger.warn(
        `SEL-REF legacy fallback (session=${sessionId}): client sent focusNodeId only, selectedNodeIds absent`,
      )
    }
    const selRefLookup = digestIds.length ? await this.buildSelectionLookup(sessionId) : undefined
    const dynamicBlocks = await assembler.assembleDynamic({
      sessionId,
      attachments: piContext?.attachments,
      // 审计 P0-①：焦点过滤（>30 节点画布只注入焦点 + 1 跳邻居），换话题污染收口。
      focusNodeId: derivedFocusNodeId,
      selectedNodeIds: digestIds,
      selectedNodeLookup: selRefLookup ? (id) => selRefLookup.get(id) : undefined,
      memoryBlock,
    })
    if (visionBlock) dynamicBlocks.push(visionBlock)
    // SEL-REF R-S8 + 评审 C1：回执**必须由服务端确认驱动**。
    // 前端读不到 Nest 的 `SEL_REF_ENABLED`，若它只按「本地冻结的 id 非空」渲染 chip，
    // 则 V1 默认态（off）下用户照样看到「已绑定 N 个选中节点」，而提示词里 0 字节注入
    // —— 比没有回执更糟：回执是信任担保，担保说谎会引导用户去问无关问题。
    // 故只在**确实有有效节点注入**时下发本事件；前端只在收到它时才显示 chip。
    // 剔除规则必须与 digest 一致（lookup 查不到 = 已删/跨会话 ⇒ 不上报），
    // 否则会出现「提示词里没有、但回执说有」的第二种不一致。
    if (digestIds.length && selRefLookup) {
      const bound = digestIds
        .map((id) => ({ id, node: selRefLookup.get(id) }))
        .filter((x): x is { id: string; node: NonNullable<typeof x.node> } => !!x.node)
      if (bound.length > 0) {
        yield {
          type: 'selection_binding',
          data: {
            nodes: bound.map(({ id, node }) => ({ id, type: node.type, title: node.title })),
          },
        } as AgentStreamEvent
      }
    }
    const created = await this.ensurePiSession(client, sessionKey, {
      systemPrompt: staticPrompt,
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
      // P0-3 / L-2：把 prompt 版本指纹交给 runtime（落 meta.json，磁盘 resume 时比对）。
      // ⚠️ 取的是 assembleStatic 刚写下的 lastManifestDetail —— 它此前标着「供 metrics 消费」
      // 却没有任何消费方，manifest 只进了 logger，导致事故无法回溯「那批请求用的哪版」。
      promptInfo: this.promptInfoFrom(assembler),
    })
    if (created.status === 'rebuilt') {
      // 会话身份变更（如 BYOK 渠道切换）→ pi-runtime 重建了会话，历史已重置。
      // 用户侧不变天，但这轮上下文确实变薄了，必须可观测。
      this.piLogger.warn(
        `pi session rebuilt for key=${sessionKey} (会话身份变更，历史已重置)`,
      )
    }
    const events = this.iteratePiEvents(client, sessionKey)
    // 先订阅再 prompt：iteratePiEvents 是 **eager** 的（streamEvents 在返回前就调用），
    // 订阅先于下面的 await client.prompt 建立 ⇒ agent_start 落在订阅窗口内、from=now 也收得到
    // （首事件不丢；⚠️ 若把 iteratePiEvents 改回惰性 async generator，此保证立即失效——
    // 见其内部注释与 turn-identity 测试 H 用例）。
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
      // SEL-REF：与 assembleDynamic 用同一个派生值，避免两处各算一遍而分叉。
      focusNodeId: derivedFocusNodeId,
      // W2①压缩保留段：把「待用户确认的节点」交给 pi-runtime，让它活过上下文压缩。
      // 压缩后模型看不到自己已经propose 过，最典型的后果是重复建节点 + 谎称已生成。
      retention: await this.collectRetentionState(sessionId),
      // P0-3 / L-2：每轮带指纹（manifest 的 hash 是本轮拼装结果，跨轮才反映真实在用哪版）。
      promptInfo: this.promptInfoFrom(assembler),
    }
    // T1：直通生效时把 [In=文件名] 标记并入发送文本尾部（pi-runtime T4 摘要占位从该标记恢复编号）
    const promptTextWithMarkers = directImages
      ? `${promptText}\n${directImages.markers.join(' ')}`
      : promptText
    // ── TURN-IDENTITY P0-2（回合身份 / 单一写者）：写者身份由 prompt 结果判定 ──
    //
    // 原实现是 `void client.prompt(...).catch(...)` —— **发射后不管**：409 被 catch
    // 吞掉后，这条流并不终止，继续旁听在跑的 run，跑到 agent_end 时**自己也
    // finalizeTurn 落库**。于是同一次 run 被 N 条流各记一本账（生产实证：同秒落
    // 4 条助手消息、正文完全相同；后 3 条的事件集是完整回合的**子序列**——起点
    // 滞后、终点同刻 ⇒ 订阅切片。切片首事件是孤儿 tool_result，前端 `parts.push`
    // 把它变成 parts[0] ⇒「提议生成」卡片顶到思考和工具消息之前）。
    //
    // 对齐 Codex `NotSubmittedReason`：被拒绝的提交 **不得** 退化成一个新回合。
    // 409 = 上游 LaneBusy（NotIdle）= 现成的 writer_lock ⇒ 本流转 **shadow**：
    // 事件照常转发（用户照样看到在跑的进度），但不结算、不落库。
    //
    // ⚠️ 为什么这里可以安全地 await：`client.prompt` 是「接受即返回」（pi-runtime
    // 内 `void lane.prompt(...)` 后立刻回 202），**不会**等到 run 结束；且订阅在
    // 上面已先建立（`live:true` from=now），等待期间到达的事件由 iteratePiEvents
    // 的内存队列承接 ⇒ 既拿到了确定的身份，又不丢首事件。
    /** owner = 本流发起了 run（唯一落库者）；shadow = 并入在跑的 run（只转发）。 */
    let turnRole: 'owner' | 'shadow' = 'owner'
    let turnRefusalReason: 'not_idle' | 'not_steerable' = 'not_idle'
    try {
      await client.prompt(sessionKey, promptTextWithMarkers, "main", {
        forceSkills,
        turnContext,
        images: directImages?.images,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const status = (err as { status?: number } | undefined)?.status
      if (status !== 409) {
        // 上游错误：照旧交给 SSE 的 error 事件，此处不另起一轮。
        // ⚠️ 刻意**不**置 shadow：网络超时等场景下 run 可能其实已被接受，
        // 若把唯一写者误判成旁听 ⇒ 整轮消息彻底不落库（那比重复更糟）。
        this.piLogger.warn(`pi prompt failed (key=${sessionKey}): ${message}`)
      } else {
        // 409 = 上一轮还在跑。用户这次发言不该蒸发 → 改走 steer 队列（durable 落盘），
        // 由当前 run 的下一个 turn 边界接住。此前这条分支是 `catch(() => {})`，静默丢消息。
        turnRole = 'shadow'
        turnRefusalReason = 'not_idle'
        this.piLogger.warn(
          `turn_not_submitted{reason=not_idle} key=${sessionKey} — 本流转旁听（同 run 由 owner 流记账）`,
        )
        try {
          await client.steer(sessionKey, promptText, "main", { turnContext })
        } catch (steerErr: unknown) {
          // 队列也塞不进去（会话已被回收 / runtime 侧异常）：必须留痕，
          // 否则「消息既不回答也不报错」会成为查不掉的黑洞。
          turnRefusalReason = 'not_steerable'
          this.piLogger.warn(
            `pi steer fallback failed (key=${sessionKey}): ${
              steerErr instanceof Error ? steerErr.message : String(steerErr)
            }`,
          )
        }
        // 结构化拒绝：409 是传输层信号，语义太薄，UI 拿不到 reason 就分不出
        //「已并入 / 当前不可插话」两种文案。前端收到它才显示「已并入进行中的任务」。
        yield {
          type: 'turn_not_submitted',
          data: { reason: turnRefusalReason },
        } as AgentStreamEvent
      }
    }

    let assistantText = ''
    const canvasActions: CanvasAction[] = []
    const thinkingAccumulator = createThinkingAccumulator()
    // Q2（2026-10-14 积分预估展示，spec §6.7 数据链路第 1 步·展示先行）：按 MarginPolicy
    // 当前生效系数（只读，缺省 11000bp=1.10×）+ FX 把 usage.cost（USD）折算为**预估积分**。
    // 纯展示，不落账不扣分——P2 token 价目条目 + turn_settled 落地后由权威结算覆盖。
    // 防御性读取：prisma 替身缺 marginPolicy（单测 mock 是手写局部对象）/ 表读失败都不阻断
    // 回合——降级默认系数；折算不可用（usage.cost=0）时回调返回 null，事件不带预估字段
    // （绝不显示 0）。⚠️ 不能写 `this.prisma.marginPolicy.findFirst().catch()`——mock 缺
    // marginPolicy 时是同步 TypeError，.catch 挂不上（#415 CI 78 例失败实证）。
    const readMarginBp = async (): Promise<number> => {
      try {
        const row = await this.prisma?.marginPolicy?.findFirst?.({ orderBy: { createdAt: 'desc' } })
        return typeof row?.marginBp === 'number' && row.marginBp > 0 ? row.marginBp : 11000
      } catch {
        return 11000
      }
    }
    const [marginBp, fxUsdCny] = await Promise.all([
      readMarginBp(),
      Promise.resolve(resolveFxUsdCny(process.env as NodeJS.ProcessEnv)),
    ])
    const estimateTurnCredits = (totals: { cost?: number }): number | null =>
      totals.cost && totals.cost > 0 ? estimateCreditsFromUsdCost(totals.cost, marginBp, fxUsdCny) : null
    const usageAccumulator = createUsageAccumulator(estimateTurnCredits)
    // （F2：executionEvents / traceSeq / traceMessageIndex / pushTraceEvent /
    // textPersister 已上移到本生成器 try 之前，见 freeze 块后的收口注释。）
    let done = false
    // ── TURN-IDENTITY PR2：回合身份 + 账本捕获状态 ──
    // `turnRunId` 是落库唯一键的一半（另一半是 threadId）：runtime 已透传（Task 7）
    // 时每条事件都带它，取**最后出现的非空值**（run 内恒定，跨 run 才变）。
    // `sawRunStart` / `firstSeq` 是账本完整性的因果围栏：没看到 `agent_start`
    // 却有后续事件 = 本流从半路接入（订阅切片 / 断线重连），产出的是残缺账本。
    let turnRunId: string | undefined
    let sawRunStart = false
    let firstSeq: number | undefined
    // P2 T6：本轮以 error 事件收束 → 收尾走 release 全退（hold 泄漏双保险之一，
    // Review Focus 1）；agent_end 正常收束 → settleFromHold 按实际 usage 结算。
    let runFailed = false
    try {
      while (!done) {
        const { value: event, done: streamClosed } = await iterator.next()
        if (streamClosed || !event) break
        // P0-1：本轮落库事件共享这个事件的全局 seq（见 pushTraceEvent 的 gSeq）。
        currentPiEvent = event
        if (event.runId) turnRunId = event.runId
        if (event.type === 'agent_start') sawRunStart = true
        if (firstSeq === undefined && typeof event.seq === 'number') firstSeq = event.seq
        if (event.type === 'agent_end' || event.type === 'error') {
          done = true
          runFailed = event.type === 'error'
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
            pushTraceEvent('canvas_command', cmd)
          }
          yield { type: 'canvas_command', data: cmd }
        }
        // B-5：gen/lifecycle 工具 details.actions → canvas_action（画布数据动作通道；
        // 对齐老链路 NestEventProxy 转发语义），节点状态经此实时到前端
        for (const action of extractCanvasActions(event)) {
          canvasActions.push(action)
          pushTraceEvent('canvas_action', action)
          yield { type: 'canvas_action', data: action }
        }
        // C1：todo_write diff → task_list/task_update（todo 面板数据源；与 ⟦plan⟧ 派生路径并存，
        // 老标记只读兼容，见 planMarkers.ts deprecation 注释）
        for (const task of extractTaskEvents(event)) {
          pushTraceEvent(task.type, task.data)
          yield task as AgentStreamEvent
        }
        // 可观测性专项 ③：pi thinking 子事件折叠为老 UI 契约的 thinking 事件。
        // Q1（2026-10-14）：delta 阶段的节流流式快照带 transient:true——只 yield 走 SSE
        // 供前端实时长出思考文本，不 pushTraceEvent（executionEvents 只留 start/done，
        // 防落库膨胀；重放走 done 全文即可）。
        const thinkingUi = thinkingAccumulator.feed(event)
        if (thinkingUi) {
          if ((thinkingUi.data as { transient?: boolean }).transient !== true) {
            pushTraceEvent('thinking', thinkingUi.data)
          }
          yield thinkingUi as AgentStreamEvent
        }
        // P1 状态行：usage 累积，agent_end 前恰发一次 turn_usage（seenUsage 门，见 pi-events.ts）。
        // Q2：usage_delta 是实时预估快照（transient）——只走 SSE 供状态行「预估 -N积分」，
        // 不落库（turn_usage 落库时带 estimatedCredits 权威预估，重放走它）。
        const usageUi = usageAccumulator.feed(event)
        if (usageUi) {
          if ((usageUi.data as { transient?: boolean }).transient !== true) {
            pushTraceEvent(usageUi.type, usageUi.data)
          }
          yield usageUi as AgentStreamEvent
        }
        // 上游帧契约对齐（2026-10-14）：vendor AssistantMessageFrame 的 text_end 帧携带
        // contentIndex + 整块 content，是「一段正文块」的权威边界（非启发式）。以此为主触发
        // flush——正文 text 事件的 seq 精确落在上游块边界，而非「下一个非文本事件」的推测位置。
        // 「pushTraceEvent 非 text 先 flush」的启发式保留作兜底（个别 provider 路径缺 text_end 时仍归位）。
        // 注意：必须在 `if (!ui) continue` 之前——text_end 映射为 null UI 事件，放后面永远走不到。
        if (extractTextEnd(event) !== null) textPersister.flush()
        const ui = mapPiEventToUiEvent(event)
        if (!ui) continue
        if (ui.type === 'text_delta') {
          // P1#5：plan 内联标记剥离 + 派生既有 task_list/task_update 事件（todo 面板数据源）
          const rawText = (ui.data as { text: string }).text
          const stripped = stripPlanMarkers(rawText)
          assistantText += stripped.text
          textPersister.add(stripped.text)
          ;(ui.data as { text: string }).text = stripped.text
          if (stripped.plan?.length) {
            // C1 验收观测：⟦plan⟧ 已停教（prompt 只教 todo_write），部署后本日志应恒 0
            this.piLogger?.log?.(`[legacy-plan-marker] session=${sessionKey} items=${stripped.plan.length}`)
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
            pushTraceEvent(planEv.type, planEv.data)
            yield planEv as AgentStreamEvent
          }
          if (stripped.doneN != null) {
            const doneEv = { type: 'task_update', data: { id: `plan-${stripped.doneN}`, status: 'done' } }
            pushTraceEvent(doneEv.type, doneEv.data)
            yield doneEv as AgentStreamEvent
          }
        }
        // 执行事件持久化收集（刷新后前端可恢复执行过程）；canvas_action 已在
        // extractCanvasActions 循环内同步入 canvasActions/executionEvents，
        // mapPiEventToUiEvent 不产出该类型
        if (ui.type === 'tool_call' || ui.type === 'tool_result') {
          pushTraceEvent(ui.type, ui.data)
        }
        // P2-3：message_end 是「一条 assistant 消息的权威收束」⇒ 其后的执行事件归属下一段，
        // 供时间线还原多段叙述各自的块归属（messageIndex 从 0 起）。
        if (event.type === 'message_end') {
          textPersister.flush() // 收束前把正文段归入当前 messageIndex
          traceMessageIndex += 1
        }
        yield ui as AgentStreamEvent
      }
    } finally {
      textPersister.flush() // 回合收尾：残留正文段（尾段后无边界事件时）落库
      // P0-①：会话跨轮保留（历史即上下文），回收由 pi-runtime 的 TTL / 磁盘 LRU 负责。
      // 这里只退订本轮订阅（触发 iteratePiEvents 的 doCancel → client.cancel）。
      // 注意：iteratePiEvents 现在返回 AsyncIterableIterator，其 `return` 在类型上是可选的，
      // 故用可选调用（运行期恒存在，见 iteratePiEvents 内部实现）。
      await iterator.return?.(undefined)?.catch(() => {})
    }

    const effectiveThreadId = threadId?.trim() || sessionId
    // ── P2 T6（token 精确计费）：收尾结算（finalizeTurn 前，turn_settled 须随
    // executionEvents 落进 assistant metadata）。全链路 try/catch 包裹——计费故障
    // 绝不打断对话：结算失败 → release 全退 + warn，hold 泄漏双保险之二。
    // TURN-IDENTITY P0-2：shadow 流（409 并入在跑的 run）**不参与结算** —— 它没有
    // 发起 run，没有可归因的 usage；扣它等于对同一次生成重复收费。
    // hold 由下面的 finally 兜底全退（holdOpen 仍为 true ⇒ release 恰一次）。
    if (turnRole === 'owner' && billingEnabled && billingHold && this.points && this.pricing) {
      const usageEv = [...executionEvents].reverse().find((e) => e.type === 'turn_usage')
      const usage = (usageEv?.data ?? {}) as {
        inputTokens?: number
        cacheReadTokens?: number
        cacheWriteTokens?: number
        outputTokens?: number
        cost?: number
      }
      if (runFailed) {
        // error 路径：release 全退 + turn_settled {released: true}（键不出现纪律）
        try {
          await this.points.release(billingHold.id, '对话回合异常全退')
          holdOpen = false
        } catch (err) {
          this.piLogger.warn(
            `turn hold release failed (hold=${billingHold.id}): ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        pushTraceEvent('turn_settled', { holdId: billingHold.id, released: true })
      } else {
        try {
          // credits 来自实际 usage（turn_usage 折叠值直取，cacheWrite 并入 in 项
          // 计费——终审 C-2；costUsd 传 cost——缺行 USD 兜底时尽量真实，缺 costUsd
          // 兜底只结 1 分）。
          const quote = await this.pricing.quoteTextTokens(userId, billingModelKey, {
            inputTokens: usage.inputTokens ?? 0,
            cacheReadTokens: usage.cacheReadTokens ?? 0,
            cacheWriteTokens: usage.cacheWriteTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            ...(usage.cost !== undefined ? { costUsd: usage.cost } : {}),
          })
          const credits = Math.max(1, Math.ceil(quote.credits))
          try {
            const settled = await this.points.settleFromHold(
              billingHold.id,
              credits,
              '对话回合结算',
              {
                kind: 'consume',
                category: 'text',
                model: billingModelKey,
                ruleVersion: quote.ruleVersion,
                ...(quote.grayReleaseId ? { grayReleaseId: quote.grayReleaseId } : {}),
              } satisfies PointTxMeta,
            )
            holdOpen = false
            pushTraceEvent('turn_settled', {
              holdId: billingHold.id,
              credits: settled.settled,
              ruleVersion: quote.ruleVersion,
              // 终审 I-1：tokens = 原始 token 数（展示口径，千级；与计费口径
              // cacheWrite 并入 in 可不同——此为 turn_usage 四列直取）。
              // breakdown（积分成分，个位）留事件供未来展开，前端不再按它渲染。
              tokens: {
                in: usage.inputTokens ?? 0,
                cache: usage.cacheReadTokens ?? 0,
                out: usage.outputTokens ?? 0,
              },
              // 键不出现：breakdown 仅价目口径携带；degraded 仅 USD 兜底场景携带
              ...(quote.breakdown ? { breakdown: quote.breakdown } : { degraded: true }),
            })
          } catch (err) {
            // settle 抛 409 等 → release 全退 + warn（幂等由 points 层 exactly-once 守卫）
            this.piLogger.warn(
              `turn settle failed (hold=${billingHold.id}): ${err instanceof Error ? err.message : String(err)} — release 全退`,
            )
            try {
              await this.points.release(billingHold.id, '对话回合结算失败全退')
              holdOpen = false
            } catch (releaseErr) {
              this.piLogger.warn(
                `turn hold release failed (hold=${billingHold.id}): ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`,
              )
            }
            pushTraceEvent('turn_settled', { holdId: billingHold.id, released: true })
          }
        } catch (err) {
          // quote 异常（quoteTextTokens 承诺永不 throw，此处为纵深防御）→ release 全退
          this.piLogger.warn(
            `turn quote failed (hold=${billingHold.id}): ${err instanceof Error ? err.message : String(err)} — release 全退`,
          )
          try {
            await this.points.release(billingHold.id, '对话回合计价失败全退')
            holdOpen = false
          } catch (releaseErr) {
            this.piLogger.warn(
              `turn hold release failed (hold=${billingHold.id}): ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`,
            )
          }
          pushTraceEvent('turn_settled', { holdId: billingHold.id, released: true })
        }
      }
    }
    // ── TURN-IDENTITY P0-2：只有 owner 落库 ──
    // shadow 流（409 并入在跑的 run）到此为止：事件已全程转发给前端（进度可见），
    // 但**不写助手消息**。唯一性最终由 PR2 的 `(threadId, runId)` 唯一索引兜底；
    // 这里先掐掉「同一 run 被 N 条流各记一本账」的源头。
    if (turnRole === 'owner') {
      // 账本完整性：判据是**因果围栏**（是否看到 run 起点），不是内容指纹——
      // 同一句话 5 分钟后重发是合法新回合，用指纹判会把合法回合误标残缺（N5）。
      const capture: LedgerCapture = {
        sawRunStart,
        firstSeq,
        eventCount: executionEvents.length,
      }
      const partial = !isLedgerComplete(capture)
      if (partial) {
        this.piLogger.warn(
          `persist_ordinal_gap key=${sessionKey} runId=${turnRunId ?? 'unknown'} gapFrom=${firstSeq ?? 'unknown'} — 本流从半路接入，账本标 partial（不冒充全量）`,
        )
      }
      await this.finalizeTurn(sessionId, effectiveThreadId, userId, assistantText, canvasActions, {
        // Nest internal tools already wrote Session.canvasData; skip re-apply to avoid duplicate add_node
        rewriteCanvasData: false,
        // 退役对齐：老 LangGraph 路径（streamFromRuntime）同样传 deriveLinkedOutputs，
        // pi 路径此前漏了这一项 → 助手消息的「产出」挂件为空。老路径已删，此处补回对等语义。
        linkedOutputs: deriveLinkedOutputs(canvasActions),
        metadata: buildTurnMetadata({
          executionEvents,
          ...(partial ? { partial: true, gapFrom: ledgerGapFrom(capture) } : {}),
        }),
        runId: turnRunId,
      })
    } else {
      // shadow：事件已全程转发给前端（进度可见），到此为止——同一次 run 只记一本账。
      this.piLogger.warn(
        `turn persist skipped (role=shadow, reason=${turnRefusalReason}, key=${sessionKey}) — 已并入在跑的 run，由 owner 流记账`,
      )
    }
    } finally {
      // ── F2：hold 生命周期兜底（恰一次）──
      // holdOpen=true = 本 run 持有 hold 且 settle/release 均未成功——正常收束时
      // 结算块已置 false → no-op；消费方 abort（.return()）/迭代异常 → 此处即时
      // release 全退，不再等 reaper 30min。turn_settled 只进内存 executionEvents
      // （中断路径 finalizeTurn 不可达，不落库），可观测信号即 release 本身。
      if (holdOpen && billingHold && this.points) {
        try {
          await this.points.release(billingHold.id, '回合中断，预扣全退')
        } catch (err) {
          this.piLogger.warn(
            `turn hold release failed (hold=${billingHold.id}): ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        pushTraceEvent('turn_settled', { holdId: billingHold.id, released: true })
      }
    }
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
      /** P0-3 / L-2：prompt 版本指纹，落 meta.json 供磁盘 resume 比对 */
      promptInfo?: PiPromptInfo
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

  /**
   * 把回调式 SSE 订阅桥接为 async iterator（供 for-await / 手写 .next() 消费，结束自动退订）。
   *
   * ⭐ **必须 eager 订阅**：本方法是**普通函数**，`streamEvents` 在返回 iterator 之前就调用。
   * 曾经它是 `async *`（惰性生成器）—— 函数体要等**首个 `.next()`** 才执行，而调用处
   * （streamConversation）首个 `.next()` 在消费循环里、**晚于** `await client.prompt(...)`：
   * run 起点 `agent_start` 在订阅建立前就已发出，`{ live:true }`（from=now）又不重放历史缓冲
   * ⇒ `agent_start` 永久丢失、每轮账本被标 `partial`（残尾首事件常是孤儿 tool_result ⇒ 前端
   * 「提议生成」卡片顶到思考/工具消息之前 —— 生产画布 cmvbqb9km001jmr0160w3ffnk 实证）。
   * 「先订阅再 prompt」的意图正是被惰性求值击穿的，故改为 eager（回归锁见
   * agent.service.turn-identity.test.ts 的「H 订阅必须早于 prompt」用例）。
   */
  private iteratePiEvents(
    client: PiRuntimeClient,
    sessionId: string,
  ): AsyncIterableIterator<PiRuntimeEvent> {
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
    // cancel 恰一次：自然收口（closed）/ 提前 return() 两条路都走这里，重复调用无害化。
    let cancelled = false
    const doCancel = () => {
      if (!cancelled) {
        cancelled = true
        cancel()
      }
    }
    return {
      next: async (): Promise<IteratorResult<PiRuntimeEvent>> => {
        while (queue.length === 0) {
          if (closed) {
            doCancel()
            return { value: undefined as never, done: true }
          }
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
        return { value: queue.shift() as PiRuntimeEvent, done: false }
      },
      return: async (): Promise<IteratorResult<PiRuntimeEvent>> => {
        doCancel()
        return { value: undefined as never, done: true }
      },
      [Symbol.asyncIterator](): AsyncIterableIterator<PiRuntimeEvent> {
        return this
      },
    }
  }

  /**
   * P2 T6：回合预扣。hold = ceil(quoteTextTokens(典型回合 8K in + 0.5K out).credits × 1.2)
   * （spec §6.5 典型回合口径）。全部 try/catch 包裹——计费故障绝不打断对话：
   *  - freeze 抛「可用积分不足」（业务拒绝）→ user run 返回 {rejected: true} 由调用方
   *    402 语义拒绝 / automation run 降级 warn；
   *  - 其余异常（DB 等）→ 降级不预扣照常执行 + warn（billing bug 不杀对话）。
   * hold 为 undefined = 本 run 无预扣（被拒或降级），以 rejected 区分。
   */
  private async freezeTurnHold(
    userId: string,
    modelKey: string,
    billingSource: 'user' | 'automation',
  ): Promise<{ hold?: TurnPointHold; rejected?: boolean }> {
    if (!this.points || !this.pricing) {
      this.piLogger.warn('text billing enabled but points/pricing service missing — skip freeze')
      return {}
    }
    try {
      // 典型回合口径（终审 C-2 修订）：8K in + 0.8K cacheWrite + 0.5K out ——
      // 真实回合普遍含缓存写入（system prompt 折叠），预扣口径与结算计费口径同构
      // （cacheWrite 并入 in 项）。costUsd 不传：回合发起时 vendor cost 尚不可得
      // （cost 只在 message_end 后产出），传猜测值反而失真——degraded 时接受 min1 兜底。
      const quote = await this.pricing.quoteTextTokens(userId, modelKey, {
        inputTokens: 8000,
        cacheReadTokens: 0,
        cacheWriteTokens: 800,
        outputTokens: 500,
      })
      const holdAmount = Math.max(1, Math.ceil(quote.credits * 1.2))
      return { hold: await this.points.freeze(userId, holdAmount, '对话回合预扣') }
    } catch (err) {
      // F1（P2 T6 修复轮）：余额不足分类走专用异常 instanceof，去掉 message 字符串
      // 耦合——points 层改文案不再造成静默失配（失配方向 = 用户 run fail-open 免费执行）
      const isInsufficient = err instanceof InsufficientPointsError
      if (billingSource === 'automation') {
        // automation run 预扣失败（含余额不足）→ 降级不预扣照常执行 + warn（不阻塞自动化）
        this.piLogger.warn(
          `[automation run] 预扣失败，降级照常执行: ${err instanceof Error ? err.message : String(err)}`,
        )
        return {}
      }
      if (isInsufficient) return { rejected: true }
      this.piLogger.warn(
        `turn freeze failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
      )
      return {}
    }
  }

  /**
   * 同 `(threadId, runId)` 是否**已经**有记账行（PR2 唯一性的读侧判据）。
   *
   * ⚠️ fail-open：查询异常一律**放行**（返回 false，让落库照旧）。理由与 PR1 的
   * 409 判定一致——查不到就让整轮消息不落库，比重复一条更糟。
   * 真正的裁决者是唯一索引（`create` 的 P2002 兜底），本方法只负责**提前说清
   * 发生了什么**（日志语义比「唯一约束冲突」好排查）。
   *
   * `findFirst` 而非复合键 `findUnique`：单测的 prisma 替身是手写局部对象，
   * 未必实现复合唯一键的入参形态（历史教训：mock 缺键时 `.catch()` 挂不上，
   * 直接 TypeError 打挂整个回合）。
   */
  private async findTurnByRunId(threadId: string, runId: string): Promise<boolean> {
    try {
      const row = await this.prisma?.agentMessage?.findFirst?.({
        where: { threadId, runId },
        select: { id: true },
      })
      return Boolean(row)
    } catch (err) {
      this.piLogger.warn(
        `turn runId lookup failed (fail-open, thread=${threadId}, runId=${runId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return false
    }
  }

  private async finalizeTurn(
    sessionId: string,
    threadId: string,
    userId: string | undefined,
    assistantText: string,
    canvasActions: CanvasAction[],
    opts: {
      rewriteCanvasData: boolean
      linkedOutputs?: LinkedCanvasOutput[]
      metadata?: AgentMessageMetadata
      /**
       * 回合身份（pi-runtime operationId）。PR2 起它是**落库唯一键的一半**：
       * 同 `(threadId, runId)` 已存在 ⇒ 已有 owner 记过账，本条 no-op。
       * 未透传（老 runtime 滚动窗口）时为 undefined ⇒ 退回「无条件写」的旧行为。
       */
      runId?: string
    },
  ) {
    // ── TURN-IDENTITY PR2：先到先得的唯一性 ──
    // 上游 409 判定（PR1）已挡掉绝大多数重复写者，但**挡不住全部**：断线重连补发、
    // generation-recovery 的 drain、以及任何未来的第三个写者都可能带着同一个
    // runId 走到这里。唯一索引是**最后一道**不变式——不是靠各端默契，而是靠数据库。
    if (opts.runId && (await this.findTurnByRunId(threadId, opts.runId))) {
      this.piLogger.warn(
        `duplicate_turn_persist blocked (thread=${threadId}, runId=${opts.runId}) — 已有 owner 记账，本条 no-op`,
      )
      return
    }
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
      try {
        await this.prisma.agentMessage.create({
          data: {
            sessionId,
            threadId,
            role: 'assistant',
            content,
            toolCalls: canvasActions.length ? JSON.stringify(canvasActions) : null,
            linkedOutputs: opts.linkedOutputs?.length ? JSON.stringify(opts.linkedOutputs) : null,
            metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
            // 回合身份：落库即成为唯一键的一半（NULL 时唯一索引不生效，等价旧行为）。
            runId: opts.runId ?? null,
          },
        })
      } catch (err) {
        // 竞态兜底：上面的查存在与这里的 create 之间仍可能被另一条流抢先。
        // 唯一索引是唯一的裁决者——命中即说明 owner 已记账，本条安静 no-op。
        if (isUniqueViolation(err)) {
          this.piLogger.warn(
            `duplicate_turn_persist blocked by unique index (thread=${threadId}, runId=${opts.runId}) — 本条 no-op`,
          )
          return
        }
        throw err
      }
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
