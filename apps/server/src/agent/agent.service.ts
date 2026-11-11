import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import type { AgentStreamEvent } from '@lnkpi/agent'
import { CANVAS_ACTION_APPLIER, defaultCanvasActionApplier } from './canvas-action-applier'
import { findUnfilledDraftTextNodes } from './turn-text-node-guard'
import {
  describeTurnInterruption,
  type AgentMessageMetadata,
  type CanvasAction,
  type CanvasActionApplier,
  type CanvasData,
  type ExecutionTraceState,
  type LinkedCanvasOutput,
  type PersistedExecutionEvent,
  type SidebarAttachment,
} from '@lnkpi/shared'
import {
  listModels,
  normalizeMentionedKeys,
  validateSidebarAttachments,
  type CreditTxEvent,
  type GenerationType,
  type StudioModality,
  buildSelectionDigest,
} from '@lnkpi/shared'
import { buildSidebarBlock, buildImageRecoveryHint, buildImageInjectedNotice } from './pi-runtime/sidebar-block'
import { decodeCursor, paginateVisibleRows } from './messages-cursor'
import { runWithMessageSeq } from './agent-message-seq'
import { normalizeIntent } from './intent-dedup'
import { MaterialService } from '../canvas/material.service'
import {
  SessionEventBus,
  type TurnSettledBusEvent,
} from '../points/session-event-bus.service'
import { ZodError } from 'zod'
import { AgentCanvasToolsService } from './agent-canvas-tools.service'
import { CanvasDigestService } from './canvas-digest.service'
import {
  isLedgerComplete,
  ledgerGapFrom,
  type LedgerCapture,
} from './turn-ledger'
import {
  classifyInterruption,
  collectToolAttempts,
  deriveSteps,
  shouldRecordTurnState,
} from './turn-state-store'
import { TurnStateService } from './turn-state.service'
import { TurnAutoResumeService } from './turn-auto-resume/turn-auto-resume.service'
import { shouldTriggerAutoResume } from './turn-auto-resume/auto-resume.decider'
import {
  reconcileAfterTurn,
  type ReconcileClient,
  type ReconcilePrisma,
  type ReconcileTurnState,
} from './history-reconciliation'
import { buildIncompleteNodeActions, collectIncompleteNodeIds } from './incomplete-node'
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
  PiRuntimeError,
  type CreateSessionResult,
  type PiPromptInfo,
  type PiRetentionState,
  type PiSessionLlmOverride,
  type QueueCancelOutcome,
  type RecoveredQueueItem,
  type PiQueueContext,
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
import { createUiEventProjector, createThinkingAccumulator, createTextSegmentPersister, createUsageAccumulator, extractCanvasActions, extractCanvasCommands, extractPlanProposedEvent, extractTaskEvents, extractTextDelta, extractTextEnd, mapPiEventToUiEvent, classifyPiRunError, type PiRuntimeEvent } from './pi-runtime/pi-events'
import { GenerationReaperService } from '../studio/generation-reaper.service'
import {
  DEFAULT_GATE_TTL_MS,
  PendingInterruptionService,
  type PendingInterruptionSummary,
} from './pending-interruption.service'
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
   * P1c 清债（写面分流）：本行 executionEvents 是最小兼容集而非全量，全量在
   * AgentEvent 账本（按 runId 投影）。读端（getMessages enrichment）据此判定
   * 合并投影；直读 DB 消费方据此判定不得把本行当全量重放（N4）。
   */
  eventsShrunk?: boolean
  /**
   * TURN-IDENTITY PR2：账本不完整（本流没捕获到 run 起点）。
   *
   * 键不出现纪律：完整时**不写** `partial` / `gapFrom` 两个键（老消息因此零变化），
   * 只有残缺才落 `partial:true`，`gapFrom` 仅在序号已知时附带。
   */
  partial?: boolean
  gapFrom?: number
  /**
   * D2（Task 2）：**尾部**截断（消费方断连 ⇒ 只拿到 run 前缀）。
   * 与 `partial`（头部缺口）方向相反，键不出现纪律相同：完整时**不写**该键。
   */
  truncated?: boolean
}): AgentMessageMetadata | undefined {
  const metadata: AgentMessageMetadata = {}
  if (input.executionTrace) metadata.executionTrace = input.executionTrace
  if (input.presentation) metadata.presentation = input.presentation
  if (input.executionEvents?.length) metadata.executionEvents = input.executionEvents
  // 键不出现纪律：未分流（旧行语义）不写该键 ⇒ 读端缺省视为全量
  if (input.eventsShrunk) metadata.eventsShrunk = true
  if (input.partial) {
    metadata.partial = true
    if (input.gapFrom !== undefined) metadata.gapFrom = input.gapFrom
  }
  if (input.truncated) metadata.truncated = true
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

// ── P1c 清债（账本投影，spec 2026-11-11-sse-p1c-ledger-projection-metadata-shrink §2.1）──

/** 账本行的最小投影形状（prisma AgentEvent 行的结构子集；测试桩同构）。 */
export interface AgentEventLedgerRow {
  runId: string | null
  gSeq: number
  sSeq: number
  type: string
  data: string
  ts: Date
  messageIndex: number
}

/** 账本行 → PersistedExecutionEvent（data JSON 还原、sSeq→seq、ts→epoch ms；坏 JSON 不炸读路径）。 */
export function ledgerRowToPersistedEvent(row: AgentEventLedgerRow): PersistedExecutionEvent {
  let data: unknown = null
  try {
    data = JSON.parse(row.data)
  } catch {
    data = null
  }
  return {
    type: row.type,
    data,
    seq: row.sSeq,
    gSeq: row.gSeq,
    ts: new Date(row.ts).getTime(),
    messageIndex: row.messageIndex,
  }
}

/**
 * metadata 保留集（waiting_user/turn_settled/合成）与账本投影行归并：
 * (gSeq, sSeq) 去重（waiting_user/turn_settled 两边都在——保留集与账本同写，先到者留），
 * 按 seq 升序复原发生序。seq=traceSeq 计数器为两存储共用（R1：账本 sSeq 即 traceSeq），
 * 同一行的所有事件来自同一流的漏斗 ⇒ seq 序即真实发生序。
 */
export function mergeShrunkEvents(
  leftovers: readonly PersistedExecutionEvent[],
  projected: readonly PersistedExecutionEvent[],
): PersistedExecutionEvent[] {
  const seen = new Set<string>()
  const merged: PersistedExecutionEvent[] = []
  for (const ev of [...leftovers, ...projected]) {
    const key =
      typeof ev.gSeq === 'number' && typeof ev.seq === 'number' ? `${ev.gSeq}:${ev.seq}` : `syn:${ev.seq ?? merged.length}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(ev)
  }
  return merged.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
}

/** 回合外 run 收束快照（P0-A 记账者产出，供 finalizeTurn 落库）。 */
export interface OutOfTurnRunSnapshot {
  runId: string
  assistantText: string
  canvasActions: CanvasAction[]
}

/**
 * 回合外 run 接收器（P0-A 纯逻辑，2026-11-02 天鹅事故）。
 *
 * 背景：生成 job 终态的「回合外简报轮」不属于任何用户 turn ⇒ Nest 主流不存在
 * ⇒ 无人落库（AgentMessage 是展示层 SSOT）⇒ 刷新即失。记账者（`projectOutOfTurnRuns`）
 * 在 reaper notify-generation 送达后挂短命订阅，用本接收器按 runId 分桶累积，
 * run 收束时产出快照走 `finalizeTurn`（唯一索引防重，与主流写者互不冲突）。
 *
 * 因果断据（对齐账本完整性 N5 的「因果围栏」纪律）：**只记账自己见到
 * `agent_start` 的 run**——半路接入的 run（buckets 里无起点）不产出快照，
 * 防止把前缀冒充全量（那比缺行更糟，N4）。
 *
 * 输入 = **裸 `PiRuntimeEvent`**（与主流同一输入层）：画布动作提取
 * （`extractCanvasActions`）与主流同源同形状；文本/收束语义经
 * `mapPiEventToUiEvent` 归一（text_delta / done / error），run 身份用 `runId`
 * （runtime 给所有 run 内事件兜底打戳，session-manager.ts:3219）。
 */
export function createOutOfTurnRunAcceptor() {
  const buckets = new Map<
    string,
    { text: string; canvasActions: CanvasAction[]; sawStart: boolean; done: boolean }
  >()
  return {
    /** 喂入一条裸 pi 事件；当且仅当某 run 刚收束且可落库时返回其快照。 */
    feed(event: PiRuntimeEvent): OutOfTurnRunSnapshot | null {
      const runId = event.runId
      if (!runId) return null
      if (event.type === 'agent_start') {
        buckets.set(runId, { text: '', canvasActions: [], sawStart: true, done: false })
        return null
      }
      const bucket = buckets.get(runId)
      if (!bucket || bucket.done) return null
      // 画布动作提取与主流逐事件同源（简报轮一般不产动作，但 drain 是完整 agent run）。
      for (const action of extractCanvasActions(event)) {
        bucket.canvasActions.push(action)
      }
      const ui = mapPiEventToUiEvent(event)
      if (!ui) return null
      if (ui.type === 'text_delta') {
        // 与主流一致应剥 plan 内联标记；简报轮不产 plan（无 turn 上下文），直取正文。
        bucket.text += (ui.data as { text?: string })?.text ?? ''
        return null
      }
      if (ui.type === 'done' || ui.type === 'error') {
        // done=agent_end（权威收束）；error 也是收束（失败轮，落什么算什么）。
        bucket.done = true
        buckets.delete(runId)
        if (!bucket.sawStart) return null
        return { runId, assistantText: bucket.text, canvasActions: bucket.canvasActions }
      }
      return null
    },
  }
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

/**
 * 多端一致性 P1（计划 2026-11-04 Task 4）：flag on 时 POST /chat/conversation 的响应体。
 * `sinceSeq` 缺省（undefined）= 游标未知 ⇒ 前端 from=now（见 headSeq 注释的不对称取舍）。
 */
export interface ConversationAck {
  accepted: boolean
  /** 订阅目标线程；fork 场景 = fork 后的新线程 id。 */
  threadId?: string
  /** 订阅游标锚点：触发时刻 lane head seq。 */
  sinceSeq?: number
  /** accepted=false 时的用户可读原因（fork 切点失效等）。 */
  errorMessage?: string
}

@Injectable()
export class AgentService implements OnModuleInit {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
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
    // 回合连续性（2026-10-21 修正）：「上一轮任务进行到哪」的权威副本存储。
    // @Optional 保持既有测试与未装配路径零破坏（缺省时回合连续性降级为「不记录」，
    // 对话照常——「记不住上一轮」是降级，不是事故）。
    @Optional()
    @Inject(TurnStateService)
    private readonly turnState?: TurnStateService,
    // 批次 3.2（对话轮次自动续跑）：⚠️ 必须经 ModuleRef 运行时惰性解析、**不能构造器注入**。
    // AgentService → TurnAutoResumeService → AUTO_RESUME_AGENT_PORT → AgentService
    // 会构成 Nest 实例化环 ⇒ DI 死锁、事件循环耗尽、进程静默 exit 0（#398/#399 部署事故教训）。
    // ModuleRef 同样 @Optional：单测手工构造不传也零破坏；运行时拿不到 = flag 第二道闸。
    @Optional()
    @Inject(ModuleRef)
    private readonly moduleRef?: ModuleRef,
    // 回合外投影记账者接线（2026-11-02 天鹅事故 P0-A）：@Optional 注入 reaper（经
    // StudioModule 导出；AgentModule imports StudioModule ⇒ 依赖方向安全零环），
    // onModuleInit 把投影回调注册上去。缺省（单测/未装配）= 只通报不投影，行为不变。
    @Optional()
    @Inject(GenerationReaperService)
    private readonly generationReaper?: GenerationReaperService,
    // Epic 1（2026-11-03-credit-consumption-display）：在飞流注入 credit_tx 的总线。
    // @Optional 保持既有测试/未装配零破坏；运行时缺省 = 退化（flag 第二道闸，
    // 与 PointsService 同模式）。
    @Optional()
    @Inject(SessionEventBus)
    private readonly eventBus?: SessionEventBus,
    // Canvas Digest（spec 2026-11-05-canvas-digest-design）：回合末「画布总览」管道。
    // @Optional 保持既有测试/未装配零破坏（缺省 = undefined ⇒ 挂载点短路，
    // 与 flag off 等价——S6「行为完全不存在」）。
    @Optional()
    @Inject(CanvasDigestService)
    private readonly canvasDigest?: CanvasDigestService,
    // P2 待确认门 durable（2026-11-11）：最后一个 @Optional 参数 ⇒ 既有按位置构造
    // 的单测零破坏；缺省（未装配）= 全链路短路，旧行为逐字节不变。
    @Optional()
    @Inject(PendingInterruptionService)
    private readonly pendingInterruptions?: PendingInterruptionService,
  ) {}

  /**
   * 回合外投影记账者的在飞守卫：同一 threadKey 只挂一条订阅。
   * reaper 5min 节拍可能对同会话多条记录接连 notify，简报轮是同一 drain 窗口，
   * 第二条 notify 无需（也不该）再开一条订阅。
   */
  private readonly outOfTurnProjecting = new Set<string>()

  /**
   * armed 状态（2026-11-03 Layer 3 订阅时序竞态）：订阅已挂、SSE 已 open，
   * 等 reaper 的 notify-generation 触发简报轮。
   *
   * 为什么需要两段式（arm → project）：runtime 在 notify-generation handler 内
   **同步** drain 开简报轮（followUp → void drainQueued → lane.prompt），agent_start
   * 在 notify 响应返回**之前**就已发出；后置订阅（旧 onDelivered 单段式）经 prisma
   * 归属查询再挂 SSE，实测晚 ~500ms+ ⇒ `from=now` 错过 agent_start ⇒ 因果围栏
   * 静默丢弃整轮（蓝老虎复测生产实证：pi transcript seq 435→653 简报完整存在、
   * Nest 零落库）。arm 把订阅挂载挪到 notify **之前**并等 SSE open（与主流
   * 「先订阅再 prompt」同一严格时序），project 只负责生命周期与落库。
   */
  private readonly outOfTurnArmed = new Map<
    string,
    {
      unsubscribe: () => void
      acceptor: ReturnType<typeof createOutOfTurnRunAcceptor>
      thread: { id: string; sessionId: string }
      userId: string | undefined
      clock: { lastActivityAt: number }
      armedAt: number
    }
  >()

  /** P0-A 看门狗参数：全部收束后安静多久退订 / 订阅总上限。 */
  private static readonly OUT_OF_TURN_QUIET_MS = 30_000
  private static readonly OUT_OF_TURN_CAP_MS = 5 * 60_000
  /** arm 等 SSE open 的上限：超时放弃预挂（notify 照发，退化回后置订阅旧行为）。 */
  private static readonly OUT_OF_TURN_OPEN_TIMEOUT_MS = 3_000
  /**
   * armed 自愈 TTL：notify 一直不来（被 tool-wait 抑制 / 通报失败）⇒ 到点退订，
   * 防订阅悬挂。> 一次 notify HTTP 往返（秒级）即可，10s 足够宽裕。
   */
  private static readonly OUT_OF_TURN_ARM_TTL_MS = 10_000

  onModuleInit(): void {
    // 钩子注册 fail-soft：reaper 缺席（单测/降级装配）= 只通报不投影（行为同今天）。
    if (!this.generationReaper) return
    this.generationReaper.outOfTurnArmHook = (threadId) => this.armOutOfTurnProjection(threadId)
    this.generationReaper.outOfTurnProjectionHook = (threadId) =>
      this.projectOutOfTurnRuns(threadId)
  }

  /**
   * 阶段一：预挂回合外投影订阅（P0-A Layer 3，2026-11-03 蓝老虎复测）。
   *
   * 由 reaper 在 notify-generation **之前** await（late-generation-notify 的
   * `onBeforeNotify`）。生产实证（thread cmvzixb8k0018pc01ktoxthpy）：runtime 在
   * notify handler 内**同步** drain 开简报轮，agent_start 在 notify 响应返回前
   * 就已发出；旧单段式（onDelivered 后置订阅）经 prisma 归属查询再挂 SSE 实测晚
   * ~500ms+ ⇒ `from=now` 错过 agent_start ⇒ 因果围栏静默丢弃整轮。
   *
   * 做什么：prisma 归属查询 → 挂事件订阅（`live:true` + `retryOnMissing`，均为
   * 上游 `streamEvents` 内建语义）→ 等 SSE open（≤3s）。open 意味着 runtime 已
   * 注册本订阅 ⇒ 此后到达的 notify 触发的简报轮 agent_start **必然**落在窗口内
   * （与主流「先订阅再 prompt」同一严格时序，见 streamConversation 同构注释）。
   *
   * armed 期间若简报轮意外抢先收束（竞态极小），acceptor 产出照常落库——
   * (threadId,runId) 唯一索引防重，与 activate 后的记账互不冲突。
   *
   * fail-soft：任何失败只 warn，通报照发（退化回后置订阅旧行为）。
   */
  async armOutOfTurnProjection(
    threadKey: string,
    opts?: { openTimeoutMs?: number; armTtlMs?: number },
  ): Promise<void> {
    const piUrl = this.getPiRuntimeUrl()
    if (!piUrl) return
    if (this.outOfTurnProjecting.has(threadKey)) return // 在飞投影已覆盖本线程
    if (this.outOfTurnArmed.has(threadKey)) return // 已武装（同轮多条记录接连 notify）
    try {
      const thread = await this.prisma?.agentThread?.findFirst?.({
        where: { id: threadKey },
        select: { id: true, sessionId: true },
      })
      if (!thread?.sessionId) {
        this.piLogger?.warn?.(`out_of_turn_projection arm skipped (thread not found, key=${threadKey})`)
        return
      }
      const session = await this.prisma?.session?.findUnique?.({
        where: { id: thread.sessionId },
        select: { userId: true },
      })
      const client = this.createPiRuntimeClient(piUrl)
      const acceptor = createOutOfTurnRunAcceptor()
      const clock = { lastActivityAt: Date.now() }
      let opened = false
      const unsubscribe = client.streamEvents(
        threadKey,
        (event: PiRuntimeEvent) => {
          clock.lastActivityAt = Date.now()
          const snapshot = acceptor.feed(event)
          if (!snapshot) return
          // fire-and-forget：落库失败只影响可见性，不拖垮订阅（(threadId,runId) 唯一索引防重）。
          void this.persistOutOfTurnTurn(thread.sessionId, threadKey, session?.userId, snapshot)
        },
        () => {},
        {
          live: true,
          retryOnMissing: true,
          onOpen: () => {
            clock.lastActivityAt = Date.now()
            opened = true
          },
        },
      )
      const openDeadline =
        Date.now() + (opts?.openTimeoutMs ?? AgentService.OUT_OF_TURN_OPEN_TIMEOUT_MS)
      while (!opened && Date.now() < openDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if (!opened) {
        unsubscribe()
        this.piLogger?.warn?.(`out_of_turn_projection arm timeout (key=${threadKey})`)
        return
      }
      const armedAt = Date.now()
      this.outOfTurnArmed.set(threadKey, {
        unsubscribe,
        acceptor,
        thread,
        userId: session?.userId,
        clock,
        armedAt,
      })
      // 武装自愈 TTL：notify 一直不来（tool-wait 抑制 / 通报失败）⇒ 到点退订防悬挂。
      const ttl = setTimeout(
        () => {
          const ctx = this.outOfTurnArmed.get(threadKey)
          if (ctx && ctx.armedAt === armedAt) {
            ctx.unsubscribe()
            this.outOfTurnArmed.delete(threadKey)
            this.piLogger?.log?.(`out_of_turn_projection arm expired (key=${threadKey})`)
          }
        },
        opts?.armTtlMs ?? AgentService.OUT_OF_TURN_ARM_TTL_MS,
      )
      ttl.unref?.()
    } catch (err) {
      this.piLogger?.warn?.(
        `out_of_turn_projection arm failed (key=${threadKey}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  /**
   * 阶段二：回合外投影记账者（P0-A，2026-11-02 天鹅事故）。
   *
   * 触发：reaper → notify-generation `delivered:true` 后。正常路径消费
   * {@link armOutOfTurnProjection} 预挂的订阅（agent_start 已在窗口内）；
   * 直接调用/测试/未武装时现场挂订阅兜底（旧行为）。
   *
   * 记账语义（与 arm 共用 acceptor）：按 runId 分桶累积
   * （`createOutOfTurnRunAcceptor`），run 收束即经 `finalizeTurn` 落库：
   * - `runId` 进 `(threadId, runId)` 唯一索引 ⇒ 与主流写者/重复重放天然防重；
   * - `metadata.outOfTurn: true` ⇒ 前端渲染独立气泡、历史恢复识别「回合外来信」；
   * - 只记账**自己见到 agent_start 的 run**（因果围栏，不冒充全量）——预挂保证
   *   围栏不再误伤正常简报轮（见 arm 注释）。
   *
   * 生命周期：全部收束后安静 30s 退订；总上限 5min（防订阅悬挂）。
   *
   * `opts.quietMs/capMs/tickMs` 仅测试注入（生产用静态默认值）。
   */
  async projectOutOfTurnRuns(
    threadKey: string,
    opts?: { quietMs?: number; capMs?: number; tickMs?: number },
  ): Promise<void> {
    if (this.outOfTurnProjecting.has(threadKey)) return
    const armed = this.outOfTurnArmed.get(threadKey)
    this.outOfTurnArmed.delete(threadKey)
    const piUrl = this.getPiRuntimeUrl()
    if (!piUrl && !armed) return
    this.outOfTurnProjecting.add(threadKey)
    try {
      // 优先消费 armed 上下文（预挂订阅 + 已累积的 acceptor + 归属信息）；
      // 未武装（直接调用/测试路径）现场挂订阅兜底——不等待 open，行为同旧单段式。
      let thread = armed?.thread
      let sessionUserId = armed?.userId
      let acceptor = armed?.acceptor
      let unsubscribe = armed?.unsubscribe
      const clock = armed?.clock ?? { lastActivityAt: Date.now() }
      if (!armed) {
        const found = await this.prisma?.agentThread?.findFirst?.({
          where: { id: threadKey },
          select: { id: true, sessionId: true },
        })
        if (!found?.sessionId) {
          this.piLogger?.warn?.(
            `out_of_turn_projection skipped (thread not found, key=${threadKey})`,
          )
          return
        }
        const session = await this.prisma?.session?.findUnique?.({
          where: { id: found.sessionId },
          select: { userId: true },
        })
        const client = this.createPiRuntimeClient(piUrl!)
        acceptor = createOutOfTurnRunAcceptor()
        thread = found
        sessionUserId = session?.userId
        unsubscribe = client.streamEvents(
          threadKey,
          (event: PiRuntimeEvent) => {
            clock.lastActivityAt = Date.now()
            const snapshot = acceptor!.feed(event)
            if (!snapshot) return
            void this.persistOutOfTurnTurn(found.sessionId, threadKey, sessionUserId, snapshot)
          },
          () => {},
          { live: true, retryOnMissing: true },
        )
      }
      const deadline = Date.now() + (opts?.capMs ?? AgentService.OUT_OF_TURN_CAP_MS)
      const tickMs = opts?.tickMs ?? 5_000
      const quietMs = opts?.quietMs ?? AgentService.OUT_OF_TURN_QUIET_MS
      try {
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, tickMs))
          // 30s 无任何事件（含 drain 未发生的情形）即收摊；个别 run 悬挂由 5min 上限兜底。
          if (Date.now() - clock.lastActivityAt >= quietMs) break
        }
      } finally {
        unsubscribe?.()
      }
    } catch (err) {
      this.piLogger?.warn?.(
        `out_of_turn_projection failed (key=${threadKey}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    } finally {
      this.outOfTurnProjecting.delete(threadKey)
    }
  }

  /** 回合外 run 落库（fail-soft：失败 warn，不影响通报/订阅主链路）。 */
  private async persistOutOfTurnTurn(
    sessionId: string,
    threadKey: string,
    userId: string | undefined,
    snapshot: OutOfTurnRunSnapshot,
  ): Promise<void> {
    try {
      await this.finalizeTurn(sessionId, threadKey, userId, snapshot.assistantText, snapshot.canvasActions, {
        // 简报轮可能产画布动作（drain 是完整 agent run）⇒ 照常持久化画布实体，
        // 但不重写 canvasData 主通道（Nest 内部工具已直写）。
        rewriteCanvasData: false,
        linkedOutputs: deriveLinkedOutputs(snapshot.canvasActions),
        metadata: { outOfTurn: true },
        runId: snapshot.runId,
        sawTerminalEvent: true,
        runStarted: true,
      })
      this.piLogger?.log?.(
        `out_of_turn_turn_persisted key=${threadKey} runId=${snapshot.runId} len=${snapshot.assistantText.length}`,
      )
      // Canvas Digest 主链已在 finalizeTurn 内部（唯一收束点）触发；drain 无流可 yield
      // ⇒ actions 只落库，实时同步随下一轮/刷新（规格 v1.2 定稿）。
      // §9.1 P3（v1.6）：简报轮的 snapshot.canvasActions 通常为空 ⇒ 主链 D1 双闸门
      // 跳过 digest，而生成完成的 url 回填正发生在这一条收束链上。落库后走一次
      // **独立旁路**，仅在 stale 非空时补渲染总览（零写入则完全不动画布）。
      // fail-soft：旁路自带 catch，此处再包一层，void 链不得产生 unhandled rejection。
      if (this.canvasDigest) {
        await this.canvasDigest.maybeRepairOutOfTurn({ sessionId, userId }).catch((err: unknown) => {
          this.piLogger?.warn?.(
            `canvas_digest out_of_turn_repair failed (session=${sessionId}): ${err instanceof Error ? err.message : String(err)}`,
          )
        })
      }
    } catch (err) {
      this.piLogger?.warn?.(
        `out_of_turn_turn persist failed (key=${threadKey}, runId=${snapshot.runId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  /**
   * 批次 3.2：运行时惰性解析自动续跑服务（构造环见构造器注）。
   * 解析失败 = 未装配 = 不派发（fail-open）。
   */
  private get turnAutoResume(): TurnAutoResumeService | undefined {
    try {
      return this.moduleRef?.get(TurnAutoResumeService, { strict: false })
    } catch {
      return undefined
    }
  }

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

  async getMessages(sessionId: string, threadId: string, before?: string, limit?: number) {
    if (!sessionId?.trim() || !threadId?.trim()) {
      throw new BadRequestException('sessionId and threadId are required')
    }
    const take = Math.min(Math.max(limit ?? 100, 1), 200)
    const cursor = before ? decodeCursor(before) : null
    const rows = await this.prisma.agentMessage.findMany({
      where: {
        sessionId,
        threadId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // overfetch 给 superseded 过滤留余量（D13：过滤不得发生在 take 之后）；
      // supersededBy 真列化（规格 §12，随 Task 7 seq 收口）后退役。
      take: take * 2,
    })
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
    // P3 G3（D5 收口）：queued 的消费判定**曾经**只走读时派生——steer 在 turn 边界消费、
    // followUp 在收尾边界消费，而 owner 流在 agent_end 即收尾（早于 followUp 消费）
    // ⇒ 写时翻转要么过早要么依赖 runtime queue_update 事件（刻意不进 SSE，
    // session-manager.ts:1740）。desc 分页下 reply 恒新于 user 行 ⇒ 必在同窗或更早页，
    // 窗口内判定即全局判定（P3 计划 Review Focus 4）。
    //
    // 2026-11-11（插话气泡实时化 + 消费终态）升级为**权威终态优先**：
    // `consumedAt`（服务端观察到 pi_message_end{role=user, entryId} 命中本行时写入）
    // 与 `reconciled`（对账判定滞留终态）任一非空 ⇒ 派生值**让位**——生产实证 13/66
    // 条「入队但从未被消费」的行恰恰有更晚 assistant 行，派生会把它们误判成已发送。
    // 派生保留为 `consumedAt==NULL && !reconciled` 时的 legacy fallback：存量行无权威
    // 信号，直接删派生会让全部历史插话回显「排队中」（回归）。
    const latestAssistantAt = visible.reduce<number>((acc, r) => {
      if (r.role === 'assistant') {
        const ts = new Date(r.createdAt).getTime()
        return ts > acc ? ts : acc
      }
      return acc
    }, 0)
    const derived = visible.map((r) => {
      if (r.role !== 'user' || !r.queued) return r
      if (r.consumedAt || r.reconciled) return r // 权威终态：queued 保持 DB 原值（consumed 时已翻 false）
      if (latestAssistantAt > new Date(r.createdAt).getTime()) return { ...r, queued: false }
      return r
    })
    // rawCount = DB 原始行数（过滤前）：overfetch 窗口 (take*2) 被打满时保守判定有下一页，
    // 避免 superseded 重负载线程误判 hasMore=false 截断历史（审查 P1）。
    // P1c 清债（读时 enrichment）：对分流行注入账本投影（只动 eventsShrunk 标记行的响应副本）
    const enriched = await this.enrichAssistantPage(
      threadId,
      paginateVisibleRows(derived, take, rows.length),
    )
    // P2：终态门的历史重放不得复活活卡片（母计划 P1c-6）
    return this.suppressTerminalGateCards(enriched)
  }

  /**
   * P2 一致性（母计划 §3.2 第 5 条 / 判据 P1c-6）：门 answered/expired/aborted 后，
   * 历史重放里同 callId 的 `canvas_command{ask_user}` 会被前端 `turnTimeline.ts:829`
   * 无条件翻回 pending_answer ⇒ 死卡片复活。这里在**响应副本**上剔除终态门卡片。
   *
   * 阴性保证：无 P2 门记录（老会话）⇒ 零改动；无卡片 ⇒ 零查询；表读失败 ⇒ 保守放行。
   */
  private async suppressTerminalGateCards<
    T extends { role: string; runId: string | null; metadata: string | null },
  >(
    result: { page: T[]; hasMore: boolean; nextCursor: string | null },
  ): Promise<{ page: T[]; hasMore: boolean; nextCursor: string | null }> {
    if (!this.pendingInterruptions) return result
    const callIds: string[] = []
    for (const r of result.page) {
      if (r.role !== 'assistant' || !r.metadata) continue
      try {
        const meta = JSON.parse(r.metadata) as { executionEvents?: unknown }
        if (!Array.isArray(meta.executionEvents)) continue
        for (const ev of meta.executionEvents as Array<{ type?: string; data?: unknown }>) {
          if (ev?.type !== 'canvas_command') continue
          const d = ev.data as { type?: string; callId?: string } | undefined
          if (d?.type === 'ask_user' && typeof d.callId === 'string') callIds.push(d.callId)
        }
      } catch {
        // 坏行不动
      }
    }
    if (!callIds.length) return result
    const terminal = await this.pendingInterruptions.getTerminalCallIds(callIds)
    if (!terminal.size) return result
    let touched = false
    const page = result.page.map((r) => {
      if (r.role !== 'assistant' || !r.metadata) return r
      let meta: Record<string, unknown>
      try {
        meta = JSON.parse(r.metadata) as Record<string, unknown>
      } catch {
        return r
      }
      const list = meta.executionEvents
      if (!Array.isArray(list)) return r
      const kept = list.filter((ev) => {
        const e = ev as { type?: string; data?: { type?: string; callId?: string } } | null
        return !(
          e?.type === 'canvas_command' &&
          e.data?.type === 'ask_user' &&
          typeof e.data.callId === 'string' &&
          terminal.has(e.data.callId)
        )
      })
      if (kept.length === list.length) return r
      touched = true
      return { ...r, metadata: JSON.stringify({ ...meta, executionEvents: kept }) } as T
    })
    return touched ? { ...result, page } : result
  }

  /**
   * P1c 清债（读时 enrichment，spec §2.1）：写面分流后，新回合 assistant 行的
   * metadata.executionEvents 只含最小兼容集——本方法对带 `eventsShrunk` 标记且 runId
   * 非空的行，按 runId 从 AgentEvent 账本投影派生全量 executionEvents，与保留集归并后
   * 注入**响应副本**（不落库）。前端历史重放（meta.executionEvents 全消费面）零改动。
   *
   * 兼容直通（响应与 DB 原样一致，键不出现纪律）：
   * - 非 assistant / 无 runId / 无 eventsShrunk 标记（账本时代旧行、回合外投影行）；
   * - 账本读失败（fail-open，与写面 appendAgentEvent 对称）；
   * - 账本无该 runId 行（不注入空数组）；
   * - metadata 解析失败（坏行不动）。
   */
  private async enrichAssistantPage<T extends { role: string; runId: string | null; metadata: string | null }>(
    threadId: string,
    result: { page: T[]; hasMore: boolean; nextCursor: string | null },
  ): Promise<{ page: T[]; hasMore: boolean; nextCursor: string | null }> {
    const runIdCandidates = result.page
      .filter((r) => r.role === 'assistant' && typeof r.runId === 'string' && r.runId.length > 0)
      .map((r) => r.runId as string)
    if (!runIdCandidates.length) return result
    let ledgerRows: AgentEventLedgerRow[]
    try {
      ledgerRows = (await this.prisma.agentEvent.findMany({
        where: { threadId, runId: { in: [...new Set(runIdCandidates)] } },
        orderBy: [{ gSeq: 'asc' }, { sSeq: 'asc' }],
      })) as AgentEventLedgerRow[]
    } catch {
      return result
    }
    if (!ledgerRows.length) return result
    const byRun = new Map<string, PersistedExecutionEvent[]>()
    for (const row of ledgerRows) {
      if (typeof row.runId !== 'string') continue
      const ev = ledgerRowToPersistedEvent(row)
      const list = byRun.get(row.runId)
      if (list) list.push(ev)
      else byRun.set(row.runId, [ev])
    }
    let touched = false
    const page = result.page.map((r) => {
      if (r.role !== 'assistant' || typeof r.runId !== 'string') return r
      const projected = byRun.get(r.runId)
      if (!projected?.length) return r
      let meta: Record<string, unknown>
      try {
        meta = r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : {}
      } catch {
        return r
      }
      // 只对分流行（eventsShrunk 标记）合并投影；旧行直通——N4：不冒充全量、不改老数据
      if (meta.eventsShrunk !== true) return r
      const leftovers = Array.isArray(meta.executionEvents)
        ? (meta.executionEvents as PersistedExecutionEvent[])
        : []
      touched = true
      return { ...r, metadata: JSON.stringify({ ...meta, executionEvents: mergeShrunkEvents(leftovers, projected) }) } as T
    })
    return touched ? { ...result, page } : result
  }

  async listThreads(sessionId: string) {
    if (!sessionId?.trim()) {
      throw new BadRequestException('sessionId is required')
    }
    // H1-b（规格 §5.2）：messageCount 随 threads 一次带回，bootstrap 不再为计数全量下载消息（D3）
    const [threads, counts] = await Promise.all([
      this.prisma.agentThread.findMany({
        where: { sessionId }, // 不得过滤 archivedAt（Task 4 守卫：归档行透出供 H0-c 禁用态）
        orderBy: { updatedAt: 'desc' },
        take: 50,
      }),
      this.prisma.agentMessage.groupBy({
        by: ['threadId'],
        where: { sessionId },
        _count: { _all: true },
      }),
    ])
    const countByThread = new Map(counts.map((c) => [c.threadId, c._count._all]))
    return threads.map((t) => ({ ...t, messageCount: countByThread.get(t.id) ?? 0 }))
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
  /**
   * 2026-11-04 实时补桥（flag `STREAM_MAIN_FROM_PIRUNTIME=on`）：drain 模式下
   * generator 的 yield 帧被后台 drain 丢弃（仅保留落库副作用）⇒ turn_settled 经
   * /runs/events 收不到，前端实时摘要缺结算段（刷新重放才见）。置 true 时结算块
   * 的权威值同步 emit 到 SessionEventBus，由 `runEventStream` 订阅注入（与
   * credit_tx Epic 1 Task 5 同款接线）。flag-off 主流直收 yield，**不置**（防双发）。
   * P3 G1（2026-11-05）：语义扩为 **drain 补桥总开关**——turn_settled 之外，
   * turn_ack / turn_not_submitted 两个裁定帧也经本 gate 补投（不改名：
   * startConversationRun 调用点零改动）。⚠️ 追加在参数表**末尾**：本方法有
   * ~40 处按位置调用的测试。
   */
  streamOpts?: { bridgeSettledToBus?: boolean },
  ): AsyncGenerator<AgentStreamEvent> {
    // P4 意图级去重（根治规格 §8.3）：预计算归一化意图指纹，供 registerIdempotencyKey 落库 +
    // 控制器入口 findDuplicateIntent 近窗去重。与 HTTP 随机幂等键解耦。
    const normalizedIntent = normalizeIntent(userMessage)

    // Register idempotency key (if provided) before starting
    if (idempotencyKey) {
      await this.registerIdempotencyKey(
        idempotencyKey,
        sessionId,
        threadId || sessionId,
        normalizedIntent,
      )
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
      // P4-T1（投影面收口）：seq 全部写点统一取号（@@unique([threadId, seq]) 上线前置）。
      await runWithMessageSeq(this.prisma, effectiveThreadId, (seq) =>
        this.prisma.agentMessage.create({
          data: {
            sessionId,
            threadId: effectiveThreadId,
            role: 'user',
            content: persistedUserContent,
            seq,
            ...(validatedAttachments ? { attachments: JSON.stringify(validatedAttachments) } : {}),
          },
        }),
      )
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
        // 2026-11-04 实时补桥：drain 模式下 turn_settled 经 SessionEventBus 注入
        // runEventStream（见 streamOpts.bridgeSettledToBus 注释；结算块在本方法内）
        streamOpts,
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
    normalizedIntent?: string,
  ): Promise<void> {
    const now = new Date()
    await this.prisma.idempotencyRecord
      .create({
        data: {
          idempotencyKey: key,
          sessionId,
          threadId,
          normalizedIntent: normalizedIntent ?? null,
          status: 'processing',
          expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
        },
      })
      .catch(() => {
        // Unique constraint conflict = concurrent registration, ignore
      })
  }

  /**
   * P4 意图级去重查询（根治规格 §8.3 / §9-P4）。
   *
   * 在「同 threadId + 同归一化意图 + 未过期 + 近窗内创建」且状态为
   * processing/completed 的范围内，查是否存在既有记录。命中即说明同一意图的生成
   * 已在进行 / 刚完成，本次请求应去重（不新开 operation），由调用方走 reconcile 复用既有节点。
   *
   * 注意：仅按 threadId 维度（不跨 thread），且空意图直接返回 false（不参与去重）。
   */
  async findDuplicateIntent(
    threadId: string,
    normalizedIntent: string,
    windowMs = 60_000,
  ): Promise<boolean> {
    if (!normalizedIntent) return false
    const now = Date.now()
    const hit = await this.prisma.idempotencyRecord.findFirst({
      where: {
        threadId,
        normalizedIntent,
        status: { in: ['processing', 'completed'] },
        expiresAt: { gt: new Date(now) },
        createdAt: { gte: new Date(now - windowMs) },
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    })
    return hit !== null
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
  }): Promise<{ ok: boolean; skipped: boolean; recovered: RecoveredQueueItem[] }> {
    const piUrl = this.getPiRuntimeUrl()
    // 维护态：没有 runtime 可中断 ⇒ 没有队列会被销毁 ⇒ 无需回灌任何内容
    if (!piUrl) return { ok: false, skipped: true, recovered: [] }
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
   *
   * multi-device Task 4：`opts.lastEventId`（**追加在末尾**，参数位置纪律）——
   * 旁听端断线重连时把浏览器 Last-Event-ID 传进来，pi-runtime 据此增量续传；
   * 未传维持既有 `live:true`（from=now）语义。服务端闸门（/^\d+$/）在 controller。
   *
   * ⭐⭐ 2026-10-24：`opts.signal` —— **客户端断开必须能终止本生成器**。
   *
   * 背景：`retryOnMissing` 让 404 走「无限期等 lane 出现」⇒ pi-runtime 客户端
   * 永不回调 onError ⇒ 本生成器的 `finished` 永远为 false ⇒ 生成器永远挂在
   * `await new Promise(resolve => { notify = resolve })` 上。
   * ⇒ 浏览器一断开，Nest 侧就会**永久留下**一条每 ≤5s 轮询 pi-runtime 的订阅
   * （每个 observer 一条）⇒ 资源泄漏 + 无谓上游压力。
   *
   * ⇒ controller 必须把「客户端断开」映射成 `signal.abort()`，
   *   本方法据此退订（`unsubscribe()`）并结束生成器。
   */
  // ─── 多端一致性 P1（规格 2026-10-21 §10 / 计划 2026-11-04 Task 4）────────────
  /**
   * POST /chat/conversation 的 ack 化入口（flag `STREAM_MAIN_FROM_PIRUNTIME=on`）：
   * 触发 run 后立即返回订阅锚点，事件改由 `GET /runs/events` 权威通道按游标投递
   * ——发起端与旁观端从此同源（Claude/Codex 的「稳定 run + 独立可游标重连订阅」模型）。
   *
   * ⭐ 复用既有 `streamConversation`：以**末尾追加参数**方式传参（本方法有 ~40 处
   *   按位置调用的测试，中段插参会静默错值——spec §11）；billingSource 缺省 'user'。
   *   后台把 generator **消费到底** ⇒ 落库 / finalizeTurn / 积分 / 简报等副作用全保留
   *   （Review Focus 5：ack 提前返回 ≠ run 半途而废）。
   *
   * fork 场景（branchFromEntryId）：`thread_forked` 与 fork 失败的 `error` 都是
   * Nest 侧**合成事件，不进 lane buffer** ⇒ 前端经 /runs/events 收不到，必须在
   * ack 里给出结论：成功 ⇒ threadId=fork 后新线程；失败 ⇒ accepted:false
   * （否则前端订阅旧线程永远等不到帧，永久转圈）。因此 fork 时须等首个事件
   * （一次内部 HTTP，forkAckTimeoutMs 兜底超时后保守按原线程 ack）。
   */
  async startConversationRun(args: {
    sessionId: string
    message: string
    userId?: string
    threadId?: string
    idempotencyKey?: string
    skillId?: string
    model?: string
    focusNodeId?: string
    attachments?: SidebarAttachment[]
    refOrder?: string[]
    mentionedKeys?: string[]
    thinking?: boolean
    thinkingEffort?: 'high' | 'max'
    branchFromEntryId?: string
    selectedNodeIds?: string[]
    /** 测试注入口：fork 首事件等待上限（默认 5000ms）。 */
    forkAckTimeoutMs?: number
  }): Promise<ConversationAck> {
    const baseThreadId = args.threadId?.trim() || args.sessionId
    // ⭐ 位置参数逐一对应 streamConversation 签名（sessionId…selectedNodeIds 共 15 个）；
    //    上游签名末尾追加参数时，此处必须同步补位（禁止中段插参）。
    const gen = this.streamConversation(
      args.sessionId,
      args.message,
      args.userId,
      args.threadId,
      args.idempotencyKey,
      args.skillId,
      args.model,
      args.focusNodeId,
      args.attachments,
      args.refOrder,
      args.mentionedKeys,
      args.thinking,
      args.thinkingEffort,
      args.branchFromEntryId,
      args.selectedNodeIds,
      // billingSource：ack 化入口固定用户 run（位置参数纪律：末位追加，禁中段插参）
      undefined,
      // flag-on 实时补桥：drain 丢弃 yield 帧 ⇒ turn_settled 经 SessionEventBus
      // 注入 runEventStream（2026-11-04，截图会话取证「刷新才有结算段」根因）。
      { bridgeSettledToBus: true },
    )
    const drain = (): void => {
      void (async () => {
        try {
          for await (const _ev of gen) {
            // 事件本体经 GET /runs/events 投递给前端；这里消费 generator 只为让
            // 体内副作用（落库 / finalizeTurn / 积分 / 简报）完整执行。
          }
        } catch (err) {
          this.piLogger?.error?.(
            `background drain failed (thread=${baseThreadId}): ${String(err)}`,
          )
        }
      })()
    }

    if (args.branchFromEntryId?.trim()) {
      const first = await Promise.race([
        gen.next(),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), args.forkAckTimeoutMs ?? 5000),
        ),
      ])
      if (first && !first.done) {
        const ev = first.value as AgentStreamEvent
        if (ev.type === 'thread_forked') {
          const forkedId = (ev.data as { threadId?: string } | null)?.threadId
          if (forkedId) {
            // generator 正停在 thread_forked yield 上（run 尚未启动）⇒ 此刻
            // snapshot 新线程拿到的就是「fork 后、run 前」的干净 head。
            const sinceSeq = await this.headSeq(forkedId)
            drain()
            return { accepted: true, threadId: forkedId, sinceSeq: sinceSeq ?? 0 }
          }
        }
        if (ev.type === 'error') {
          const message = (ev.data as { message?: string } | null)?.message
          drain()
          return { accepted: false, errorMessage: message }
        }
      }
      // 超时 / 立即结束 / 首事件非 fork 语义 ⇒ 保守按原线程 ack（fork 结果经日志可查）
    }

    // ⭐ 游标锚点必须取在 drain **之前**：run 一旦开始，head 就会前进，
    //    后取的锚点会把 run 的前几帧跳掉（漏窗 = M3 主诉）。
    const sinceSeq = await this.headSeq(baseThreadId)
    drain()
    return {
      accepted: true,
      threadId: baseThreadId,
      ...(sinceSeq !== null ? { sinceSeq } : {}),
    }
  }

  /**
   * 订阅游标锚点：线程 lane 的 head seq（`transcriptTail` 最大 seq）。
   * - 无 lane（PiRuntimeError 404，新线程还没建）⇒ 0：lane 为空，`lastEventId=0`
   *   的「全量重放」重放不到任何东西，且不漏 run 帧；
   * - pi 不可达 / 其它错误 ⇒ null：ack 省略 sinceSeq ⇒ 前端 from=now。
   *   ⭐ 宁可冒「漏掉 run 启动后 ~100ms 早帧」的险（verify-before-fail + reconcile
   *   可自愈），也不回到 sinceSeq=0 把 500 帧历史重放进当前气泡（文本双倍污染，
   *   不可自愈）——两者不对称，取轻。
   */
  private async headSeq(threadKey: string): Promise<number | null> {
    const piUrl = this.getPiRuntimeUrl()
    if (!piUrl) return null
    try {
      const snap = await this.createPiRuntimeClient(piUrl).snapshot(threadKey)
      return snap.transcriptTail.reduce((m, e) => Math.max(m, e?.seq ?? 0), 0)
    } catch (err) {
      if (err instanceof PiRuntimeError && err.status === 404) return 0
      return null
    }
  }

  async *runEventStream(
    sessionKey: string,
    opts?: { lastEventId?: string; signal?: AbortSignal },
  ): AsyncGenerator<AgentStreamEvent> {
    const piUrl = this.getPiRuntimeUrl()
    // 维护态（PI_RUNTIME_MODE=off / 未配 URL）：旁听无处可挂，直接空流。
    // 刻意不抛错 —— 消费端是「人走开之后切回来才看」的旁路，不该让它在挂载时就炸。
    if (!piUrl) return
    const client = this.createPiRuntimeClient(piUrl)
    const queue: AgentStreamEvent[] = []
    let notify: (() => void) | null = null
    let finished = false
    // ── 统一事件通道 P0（spec 2026-11-04-unified-channel-event-projection-design）──
    // 单一派生源判据（spec §4.4-1）：回调从「usageAccumulator + mapPiEventToUiEvent
    // 零散拼装」收敛为投影编排工厂——与主链路共享同一批 pi-events 提取实现
    // （#714 补桥的 usage/turn_usage 语义在此收敛继承：不传 estimateTurnCredits，
    // 旁观不复制回合计费上下文，estimatedCredits 由重放的落库权威值补齐）。
    // 分工边界：projector 只承诺「pi 事件 → UI 事件」；turn_settled/credit_tx 是
    // 计费领域事件，走 SessionEventBus 扇出（上方两条总线订阅），不入派生源。
    const projector = createUiEventProjector({ role: 'observer' })
    // ── Epic 1 Task 5：旁听路径同样注入 credit_tx（多端一致，见 streamFromPiRuntime）──
    // 直接推入本方法既有 queue（主循环已会 yield），退订在 finally。
    let creditUnsub: (() => void) | undefined
    if (process.env.CREDIT_TX === 'on' && this.eventBus) {
      creditUnsub = this.eventBus.subscribeSession(sessionKey, (ev: CreditTxEvent['data']) => {
        queue.push({ type: 'credit_tx', data: ev } as unknown as AgentStreamEvent)
        notify?.()
      })
    }
    // turn_settled 补桥：streamConversation 结算块在 drain 模式下 emit（见
    // streamOpts.bridgeSettledToBus），本通道订阅注入。剥掉路由用 sessionId 再下发
    // （键不出现纪律：与重放通道的 executionEvents data 契约一致）。
    let settledUnsub: (() => void) | undefined
    if (this.eventBus) {
      settledUnsub = this.eventBus.subscribeSessionTurnSettled(sessionKey, (ev) => {
        const { sessionId: _routeKey, ...data } = ev
        queue.push({ type: 'turn_settled', data } as unknown as AgentStreamEvent)
        notify?.()
      })
    }
    // P3 G1：turn_ack / turn_not_submitted 补桥订阅（streamConversation drain 模式 emit）。
    // 剥掉路由用 sessionId 再下发（与 settled 补桥同口径）。两订阅共用一个退订聚合。
    // ⚠️ 路由键主路径一致性（Review Focus 5）：本方法订阅键 = sessionKey（controller
    // 传 threadId||sessionId），emit 键 = streamConversation 的 sessionId 首参；主路径
    // threadId===sessionId ⇒ 一致。fork 线程的不对称属既有 turn_settled 桥问题，只记录不修。
    let turnAckUnsub: (() => void) | undefined
    if (this.eventBus) {
      const unsubs: Array<() => void> = [
        this.eventBus.subscribeSessionTurnAck(sessionKey, (ev) => {
          const { sessionId: _routeKey, ...data } = ev
          queue.push({ type: 'turn_ack', data } as unknown as AgentStreamEvent)
          notify?.()
        }),
        this.eventBus.subscribeSessionTurnNotSubmitted(sessionKey, (ev) => {
          const { sessionId: _routeKey, ...data } = ev
          queue.push({ type: 'turn_not_submitted', data } as unknown as AgentStreamEvent)
          notify?.()
        }),
      ]
      turnAckUnsub = () => {
        for (const u of unsubs) u()
      }
    }
    // 2026-11-11 用户发言领域事件补桥（跨端实时气泡 + 消费终态）：steer/followup
    // 是独立 HTTP 请求，无法注入既有 SSE 连接 ⇒ 经 SessionEventBus 扇出到本通道
    // 的全部订阅者（发起端与旁听端同源）。合成帧无 pi seq ⇒ controller 不写 id 行
    // （Last-Event-ID 不指向它们）；晚加入者靠历史 GET 的 DB 权威值兜底。
    // ⭐ 防御性可选调用：测试手搓的 mock bus（只带旧三通道）与滚动升级窗口内的
    // 旧实例都缺本方法 ⇒ 缺省即退化（不接桥），不得让旁听流生成器崩溃。
    let utteranceUnsub: (() => void) | undefined
    if (typeof this.eventBus?.subscribeSessionUserUtterance === 'function') {
      utteranceUnsub = this.eventBus.subscribeSessionUserUtterance(sessionKey, (ev) => {
        const { sessionId: _routeKey, ...data } = ev
        const type =
          ev.kind === 'queued'
            ? 'user_utterance_queued'
            : ev.kind === 'consumed'
              ? 'user_utterance_consumed'
              : 'user_utterance_stuck'
        queue.push({ type, data } as unknown as AgentStreamEvent)
        notify?.()
      })
    }
    const unsubscribe = client.streamEvents(
      sessionKey,
      (event) => {
        // 2026-11-11 消费终态挂钩（旁听侧）：主流在 agent_end 收尾、早于 followUp 的
        // 收尾边界消费 ⇒ drain 派生新一代的 user message_end 只有本通道看得到。
        // 零订阅者窗口内的消费写不进 DB（已知缺口，--reconcile 脚本兜底）。
        const consumedEntry = this.extractConsumableUtteranceEnd(event)
        if (consumedEntry) void this.noteUtteranceConsumed(sessionKey, consumedEntry)
        // 统一事件通道 P0：全量投影派生（canvas_command / canvas_action / task /
        // thinking / usage / 结构化 error / map 归一）——askuser 卡等此前被 pi_
        // 前缀静默丢弃的事件在此恢复。顺序 = 主链路既有顺序（projector 内编排列）。
        // 与主 `streamConversation`（:912）一样：归一产物是 `UiEvent`，末端收口成
        // `AgentStreamEvent` 时统一 cast，保证两端契约一致。
        for (const ui of projector.feed(event)) {
          queue.push(ui as AgentStreamEvent)
        }
        notify?.()
      },
      () => {
        finished = true
        notify?.()
      },
      // multi-device Task 4：lastEventId 透传（undefined 时 client 走既有 from=now 分支）。
      //
      // ⭐⭐ 2026-10-24：retryOnMissing —— pi-runtime 的 lane 是**内存态、per-thread、
      // 带 TTL**（session-manager `this.sessions` + `sessionTtlMs` 默认 30 分钟）：
      // 「另一端还没在这个 thread 上发过消息」或「跑完超过 TTL」都会让
      // `GET /sessions/:key/events` 返回 **404**。旧语义把 404 当「会话已删除」
      // ⇒ 旁听流 47ms 断流（生产实测），常驻订阅名存实亡。
      // ⇒ 旁听流用 retryOnMissing：404 归入退避重试，等 lane 真的被建起来。
      { live: true, lastEventId: opts?.lastEventId, retryOnMissing: true },
    )
    // ⭐ 客户端断开 ⇒ 唤醒等待并退订（否则上面说的「每 observer 一条永久轮询」泄漏）。
    // 只注册**一个** abort 监听（不在循环里反复 add，否则长连接会撞 EventEmitter
    // 的 MaxListeners 告警）。
    const onAbort = () => notify?.()
    if (opts?.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift() as AgentStreamEvent
        }
        if (finished) return
        if (opts?.signal?.aborted) return
        await new Promise<void>((resolve) => {
          notify = resolve
        })
      }
    } finally {
      if (opts?.signal) opts.signal.removeEventListener('abort', onAbort)
      unsubscribe()
      creditUnsub?.()
      settledUnsub?.()
      turnAckUnsub?.()
      utteranceUnsub?.()
    }
  }

  // ─── 多端一致性 P0（规格 2026-10-21 §10 / 计划 2026-11-04 Task 2）────────────
  /**
   * 断流后对账：回答「这个会话此刻有没有活跃/已完结的回合」。verify-before-fail 的
   * 服务端真相源——断流 ≠ 失败，先查真再判失败（红车根因 2026-11-01 P0）。
   *
   * ⭐ 真相源刻意**不用** `getThreadResumeState`/`getThreadTimeline`——两者已随 LangGraph
   * 退役（恒返回 null）。改用双源裁决：
   *   ① IdempotencyRecord 近窗（threadId + 30min）：processing ⇒ active、completed ⇒ settled
   *   ② runEventStream 流探测（5s 超时）：立即续到增量 ⇒ active（终止事件 ⇒ settled）
   * GenerationRecord 无 threadId 列（仅 sessionId/nodeId）⇒ 不参与裁决。
   * 双源全空 ⇒ missing（此时前端才允许判真失败）。
   */
  async reconcileLatestAssistant(
    threadId: string,
    sinceSeq: number,
  ): Promise<{
    outcome: 'active' | 'settled' | 'missing'
    lastSeq: number
    evidence?: { idempotencyStatus?: string }
  }> {
    const recent = await this.prisma.idempotencyRecord
      .findMany({
        where: { threadId, createdAt: { gte: new Date(Date.now() - 30 * 60_000) } },
        orderBy: { createdAt: 'desc' },
        take: 5,
      })
      .catch(() => [] as Array<{ status: string }>)
    const processing = recent.find((r) => r.status === 'processing')
    if (processing) {
      // 短路：无需探测，幂等记录在案 ⇒ 活跃
      return { outcome: 'active', lastSeq: sinceSeq, evidence: { idempotencyStatus: 'processing' } }
    }
    const probe = await this.probeRunEventStream(threadId, sinceSeq, 5_000)
    if (probe.outcome !== 'none') {
      return { outcome: probe.outcome, lastSeq: probe.lastSeq }
    }
    const completed = recent.find((r) => r.status === 'completed')
    if (completed) {
      return { outcome: 'settled', lastSeq: sinceSeq, evidence: { idempotencyStatus: 'completed' } }
    }
    return { outcome: 'missing', lastSeq: sinceSeq }
  }

  /** runEventStream 真实 UiEvent 产物里的回合终态（见 probeRunEventStream 内注释）。 */
  private static readonly PROBE_TERMINAL_TYPES = new Set([
    'done',
    'turn_ack',
    'error',
    'turn_not_submitted',
    'pi_turn_end',
    'turn_settled',
    'turn_end',
    'agent_end',
  ])

  /**
   * 流探测：按游标续至多 timeoutMs。语义（Task 7 集成测试实证修订）：
   *  - 消费重放**直到终态帧** ⇒ settled（完结回合的重放首帧是 turn_start 等非终态
   *    ——首帧即返回会把 settled 误判成 active，D2「跑完未落库」场景就治不了）；
   *  - 有增量但超时仍无终态 ⇒ active（run 在跑，live tail 静默属正常）；
   *  - 零增量（超时/404 退避中）⇒ none（交 IdempotencyRecord 兜底裁决）。
   */
  private async probeRunEventStream(
    threadId: string,
    sinceSeq: number,
    timeoutMs: number,
  ): Promise<{ outcome: 'active' | 'settled' | 'none'; lastSeq: number }> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let lastSeq = sinceSeq
    let sawAny = false
    try {
      for await (const ev of this.runEventStream(threadId, {
        lastEventId: String(sinceSeq),
        signal: ac.signal,
      })) {
        sawAny = true
        const seq =
          typeof (ev as unknown as { seq?: number }).seq === 'number'
            ? (ev as unknown as { seq: number }).seq
            : lastSeq
        if (seq > lastSeq) lastSeq = seq
        const type = (ev as unknown as { type?: string }).type
        if (type !== undefined && AgentService.PROBE_TERMINAL_TYPES.has(type)) {
          return { outcome: 'settled', lastSeq }
        }
      }
      return { outcome: sawAny ? 'active' : 'none', lastSeq }
    } catch {
      return { outcome: sawAny ? 'active' : 'none', lastSeq }
    } finally {
      clearTimeout(timer)
    }
  }

  // ── P1a PR-B（事件一等化，spec 2026-11-11-sse-event-firstclass-p1a §2.3）：双只读 API ──

  /**
   * 线程属主校验（PR-B 双 API 共用）：thread 不存在或非本人会话一律 403
   * （不区分 404/403，避免线程存在性探测）。
   */
  private async assertThreadOwner(threadId: string, userId: string): Promise<void> {
    const thread = await this.prisma.agentThread.findUnique({
      where: { id: threadId },
      select: { session: { select: { userId: true } } },
    })
    if (!thread || thread.session.userId !== userId) throw new ForbiddenException()
  }

  /**
   * `GET /api/agent/threads/:threadId/state`：线程状态摘要（前端 reconcile 自愈入口）。
   * ⚠️ 方法名刻意避开 `getThreadState`——那是 H1-c 退役的死端点，D20 契约测试
   * （agent.service.pi-runtime.test.ts）钉死其必须保持不存在，撞名即假红。
   * - status：复用 reconcileLatestAssistant 双源裁决（IdempotencyRecord 近窗 + 流探测），
   *   active ⇒ in_progress，settled / missing ⇒ complete（missing = 无进行中证据，历史态）。
   * - lastGSeq：AgentEvent 账本本线程最大 gSeq（账本空 ⇒ null，前端回落 DB 快照）。
   * - pendingInterruption：P2 待确认门 durable 摘要（PendingInterruption 表）；
   *   无仍可点的门 / 未装配 P2 service ⇒ null（旧形状兼容）。
   */
  async getThreadResumeState(
    threadId: string,
    userId: string,
  ): Promise<{
    status: 'in_progress' | 'complete'
    lastGSeq: number | null
    pendingInterruption: PendingInterruptionSummary | null
  }> {
    await this.assertThreadOwner(threadId, userId)
    const reconciled = await this.reconcileLatestAssistant(threadId, 0)
    const lastGSeq = await this.prisma.agentEvent
      .aggregate({ where: { threadId }, _max: { gSeq: true } })
      .then((r) => r._max.gSeq ?? null)
      .catch(() => null)
    return {
      status: reconciled.outcome === 'active' ? 'in_progress' : 'complete',
      lastGSeq,
      // P2 durable 核心：从表读 ⇒ 进程重启后仍返回 pending（P1c-5）
      pendingInterruption: (await this.pendingInterruptions?.getPending(threadId)) ?? null,
    }
  }

  /**
   * `GET /api/agent/threads/:threadId/events?since=<gSeq>&limit=<n>`：
   * 事件账本游标读取（升序、nextCursor、超尾空数组非 404）。
   * - 游标语义 = gSeq 严格大于 since（与 SSE Last-Event-ID 同语义）；
   * - 同 gSeq 多事件（一个 pi 事件派生多个 UiEvent）按 sSeq 稳定排序，
   *   since 过滤按整组进退（不会出现同组半截）；
   * - nextCursor = 返回末条 gSeq（空数组时原样回传 since，前端无需推进）。
   */
  async getThreadEvents(
    threadId: string,
    userId: string,
    since: number,
    limit: number,
  ): Promise<{
    events: Array<{ gSeq: number; sSeq: number; runId: string | null; type: string; ts: string; data: unknown }>
    nextCursor: number
  }> {
    await this.assertThreadOwner(threadId, userId)
    const safeLimit = Math.min(Math.max(limit, 1), 500)
    const rows = await this.prisma.agentEvent
      .findMany({
        where: { threadId, gSeq: { gt: since } },
        orderBy: [{ gSeq: 'asc' }, { sSeq: 'asc' }],
        take: safeLimit,
      })
      .catch(() => [])
    return {
      events: rows.map((r) => ({
        gSeq: r.gSeq,
        sSeq: r.sSeq,
        runId: r.runId,
        type: r.type,
        ts: r.ts.toISOString(),
        data: JSON.parse(r.data) as unknown,
      })),
      nextCursor: rows.length ? rows[rows.length - 1]!.gSeq : since,
    }
  }

  /**
   * 用户插话（steering 队列）：run 进行中发言的正道。
   *
   * ⭐ **2026-10-20 P1-1：插话也要带参考素材与画布选中态。**
   * 此前插话**只发 text** ⇒ 「指着一张图插话」时 agent 收不到图、收不到「这个」指谁。
   * 正常发送（`streamConversation`）走的是完整装配（侧栏块 + 选中摘要 + 焦点派生），
   * 插话此前完全绕过了它。
   *
   * ⚠️ **不复用 `turnContext` 通道**：那条通道是**每轮整体覆盖**语义（`normalizeTurnContext`
   * 缺省即清空），而插话发生在**别人那一轮正在跑**的时候 —— 用它会把在跑那轮的
   * 动态上下文冲掉（pi-runtime 的 `setTurnContext` 是覆盖写）。
   * ⇒ 插话走**独立的** `queueContext`：只带「本条消息自己的」参考素材与选中态，
   * 由 pi-runtime 拼进**这条队列消息的文本**里，不碰会话级 turn 状态。
   *
   * ⭐ **2026-10-21：入队成功即落库**（此前从不建 AgentMessage 行 ⇒ 刷新后历史里
   * 这条插话凭空消失）。幂等键是 pi 在**入队那一刻**就回传的 `entryId`
   * （`pi-runtime/src/session-manager.ts:2517`，vendor `QueueResult` 自带）。
   * ⇒ 服务端原子落库、**不依赖客户端在线**，也不必等「消费时补写」。
   */
  async steerPiRun(input: {
    sessionId: string
    threadId?: string
    text: string
    attachments?: SidebarAttachment[]
    refOrder?: string[]
    mentionedKeys?: string[]
    selectedNodeIds?: string[]
    /** P1-2：vision 门控用（与正常发送的 dto.model 同源，前端 composer 冻结）。 */
    userId?: string
    model?: string
  }): Promise<{ queued: boolean; entryId?: string }> {
    const piUrl = this.getPiRuntimeUrl()
    if (!piUrl) return { queued: false }
    const sessionKey = input.threadId?.trim() || input.sessionId
    const queueContext = await this.buildQueueContext(input)
    const directImages = await this.buildQueueDirectImages(input)
    const text = directImages ? `${input.text}\n${directImages.markers.join(' ')}` : input.text
    const res = await this.createPiRuntimeClient(piUrl).steer(sessionKey, text, 'main', {
      queueContext,
      images: directImages?.images,
    })
    // ⭐ 2026-10-21：入队成功即落库，键=pi 回传的 entryId（见方法注释）。
    // 落库用**用户原话**（input.text），不是发给 pi 的 text —— 后者拼了 QUEUE_MARK 与
    // `[In=…]` 标记，直接存会让刷新后的历史「长出」机器标记（显示层 ≠ 上下文层）。
    if (res.queued) {
      await this.persistQueuedUserMessage({
        sessionId: input.sessionId,
        threadId: input.threadId,
        text: input.text,
        entryId: res.entryId,
      })
    }
    return res
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
   *
   * ⭐ 2026-10-21：与 `steerPiRun` 同款**入队即落库**（刷新后历史仍可见这条尾随指令）。
   */
  async followUpPiRun(input: {
    sessionId: string
    threadId?: string
    text: string
    attachments?: SidebarAttachment[]
    refOrder?: string[]
    mentionedKeys?: string[]
    selectedNodeIds?: string[]
    /** P1-2：同 steer。 */
    userId?: string
    model?: string
  }): Promise<{ queued: boolean; entryId?: string }> {
    const piUrl = this.getPiRuntimeUrl()
    if (!piUrl) return { queued: false }
    const sessionKey = input.threadId?.trim() || input.sessionId
    const queueContext = await this.buildQueueContext(input)
    const directImages = await this.buildQueueDirectImages(input)
    const text = directImages ? `${input.text}\n${directImages.markers.join(' ')}` : input.text
    const res = await this.createPiRuntimeClient(piUrl).followUp(sessionKey, text, 'main', {
      queueContext,
      images: directImages?.images,
    })
    // ⭐ 2026-10-21：与 steerPiRun 同款入队落库（同款理由、同款 fail-soft）。
    if (res.queued) {
      await this.persistQueuedUserMessage({
        sessionId: input.sessionId,
        threadId: input.threadId,
        text: input.text,
        entryId: res.entryId,
      })
    }
    return res
  }

  /**
   * 插话 / 尾随**入队即落库**（2026-10-21）：让刷新后的历史仍能看到这条发言。
   *
   * ## 为什么在服务端、且在「入队那一刻」
   * - **在服务端**：若交给客户端在「消费时」补写，则关页面 / 切走 / 断网就丢 ——
   *   而那条消息可能已被 pi 接住甚至已被回答，丢的恰恰是最该留存的一次发言。
   * - **在入队那一刻**：pi 的响应已带 `entryId`（vendor `QueueResult`）⇒ 幂等键天然存在，
   *   落库与「入队成功」在同一次请求里完成 ⇒ 零竞态，也不必引入第二把键（clientMsgId）。
   *
   * ## 幂等：唯一索引 + upsert 先到先得
   * `AgentMessage.entryId` 上有唯一索引（迁移 `20261021153000_*`）。
   * upsert 的 `update` 是**空操作** ⇒ 重复调用（重试、双写、事件重放）命中即 no-op，
   * 且**绝不覆盖既有行的 content** —— 「先到先得」，后来的拼装文本进不来。
   *
   * ## fail-soft：落库失败绝不阻断插话
   * 插话本身已经成功入队（pi 已 durable 落盘），此时抛错会让前端以为「没发出去」而重试，
   * 反而制造重复消息。⇒ 记 warn 后正常返回，丢的那一行由唯一键保证不会变成「重复的行」。
   */
  private async persistQueuedUserMessage(input: {
    sessionId: string
    threadId?: string
    text: string
    entryId?: string
  }): Promise<void> {
    const { sessionId, threadId, text, entryId } = input
    const threadKey = threadId?.trim()
    if (!threadKey) return // 没有 thread 归属就无法归入历史（与 streamConversation 同口径）
    const entry = entryId?.trim()
    if (!entry) return // 无幂等键不落库：宁可少一行，也不造一行可能被重放的重复行
    const content = sanitizeAgentMessageContent('user', text)
    if (!content) return // 纯机器载荷（sanitize 判定）不产生用户可见气泡
    try {
      // P4-T1：create 分支统一取号（update 分支命中既有行不动 seq）。
      await runWithMessageSeq(this.prisma, threadKey, (seq) =>
        this.prisma.agentMessage.upsert({
          where: { entryId: entry },
          create: {
            sessionId,
            threadId: threadKey,
            role: 'user',
            content,
            entryId: entry,
            seq,
            // D5：入队落库即「排队中」。终态由消费信号转 false（`queue_update`），
            // 不转的话用户会永远看到「排队中」（plan Task 8 · Review Focus #3）。
            queued: true,
          },
          // ⭐ 空操作 = 先到先得：重放/重试/双写都不得覆盖既有行。
          update: {},
        }),
      )
      // 2026-11-11（插话气泡实时化）：落库成功即广播 `user_utterance_queued`
      // 用户发言领域事件（经 SessionEventBus 扇出到 runEventStream 全部订阅者，
      // 含旁听端）——跨端实时用户气泡的数据源。content 是**用户原话**（本方法的
      // input.text 已是原文；发给 pi 的拼装文本不在此处）。重放命中 update 分支
      // 也会再 emit 一次：前端按 entryId 幂等（decideQueueBubbleSync），双发无害。
      // emit 失败不阻断（事件总线的 emit 只操作内存 Map，且订阅缺失时为 no-op）。
      this.eventBus?.emitUserUtterance({
        sessionId: threadKey,
        threadId: threadKey,
        entryId: entry,
        kind: 'queued',
        content,
        ts: new Date().toISOString(),
      })
    } catch (err) {
      this.piLogger?.warn?.(
        `queued user message persist skipped (fail-soft, thread=${threadKey}, entryId=${entry}): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * 从 pi 原始事件里抽取「可判消费的 user 消息收束」：仅 `message_end` 且
   * `message.role==='user'` 且带非空 `entryId`（assistant 收束/无身份事件不触发）。
   * 命中返回 entryId，否则 null。纯函数（可单测）。
   */
  private extractConsumableUtteranceEnd(event: unknown): string | null {
    if (!event || typeof event !== 'object') return null
    const ev = event as { type?: unknown; data?: unknown }
    if (ev.type !== 'message_end') return null
    const data = ev.data as { message?: { role?: unknown }; entryId?: unknown } | undefined
    const entryId = typeof data?.entryId === 'string' ? data.entryId.trim() : ''
    if (!entryId || data?.message?.role !== 'user') return null
    return entryId
  }

  /**
   * 「已接住」权威消费信号（2026-11-11，插话气泡实时化 + 消费终态）。
   *
   * 触发口径：任一 SSE 通道（主流 `streamConversation` / 旁听 `runEventStream`）
   * 观察到 pi 原始事件 `message_end{role:'user', entryId}`，且 DB 命中 `queued=true`
   * 行 ⇒ 该 entry 已物化为 transcript `kind:entry`（vendor `boundary.ts:115-142`
   * 物化 + `checkpoint.ts:114-122` 续生成 ⇒ 必被下一轮 `readBoundedContext` 读入），
   * **事件已写 ⇔ 内容已进上下文被模型接住**——这是规格 §4.5 的 SSOT。
   *
   * 副作用：`queued=false + consumedAt=now`（幂等：`WHERE queued=true` 只命中一次）
   * + 经 SessionEventBus 广播 `user_utterance_consumed`（前端据此实时翻转徽标）。
   *
   * 为什么旁听通道也要挂钩：主流在 `agent_end` 收尾，**早于** followUp 的收尾边界
   * 消费（P3 G3 注释为证）；drain 派生的新一代事件只有旁听通道看得到。
   *
   * fail-soft：消费已发生，写不进去/发不出去都不影响对话（与 persist 同款理由）。
   */
  private async noteUtteranceConsumed(threadKey: string, entryId: string): Promise<void> {
    if (!threadKey?.trim() || !entryId?.trim()) return
    const entry = entryId.trim()
    try {
      const res = await this.prisma.agentMessage.updateMany({
        where: { entryId: entry, queued: true },
        data: { queued: false, consumedAt: new Date() },
      })
      if (res.count > 0) {
        this.eventBus?.emitUserUtterance({
          sessionId: threadKey.trim(),
          threadId: threadKey.trim(),
          entryId: entry,
          kind: 'consumed',
          ts: new Date().toISOString(),
        })
      }
    } catch (err) {
      this.piLogger?.warn?.(
        `utterance consumed persist skipped (fail-soft, thread=${threadKey}, entryId=${entry}): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * 回填 user 消息的 pi `entryId`（2026-10-21，统一 user 消息身份）。
   *
   * ## 为什么正常发送需要这一步
   * `streamConversation` 在**调用 pi 之前**就落了 user 行（此时 pi 还没回任何身份），
   * 而 `pi.prompt()` 只返回 `{ accepted }`（`pi-runtime/src/session-manager.ts:2370`）
   * ⇒ 正常发送的 entryId **只能从 `pi_message_end` 事件拿**（事件带 `{ message, entryId }`）。
   * 不回填 ⇒ 刷新后的历史消息没有 fork 切点，「③ 重跑」只能降级兜底。
   *
   * ## 为什么插话不用走这里
   * 插话入队即回传 entryId（`persistQueuedUserMessage` 已在落库时写好）⇒ 无需事后回填。
   *
   * ## 定位口径：thread 内**最后一条还没有 entryId 的 user 行**
   * 与前端 `AgentSideRail.vue` 的 attach 分支**同一口径**（都取「最后一条尚未被认领的
   * user 消息」）。⛔ 绝不覆盖已有 entryId —— 那是上一条发言的 fork 切点，
   * 覆盖它会让「重新生成」从错的地方分叉（PR #534 修的正是这个）。
   *
   * 幂等：entryId 上有唯一索引；命中已有行 ⇒ no-op。fail-soft：写不进去也不影响对话。
   */
  async attachUserMessageEntryId(input: {
    sessionId: string
    threadId: string
    entryId: string
  }): Promise<{ attached: boolean }> {
    const { sessionId, threadId, entryId } = input
    const threadKey = threadId?.trim()
    const entry = entryId?.trim()
    if (!threadKey || !entry) return { attached: false }
    try {
      const existing = await this.prisma.agentMessage.findFirst({
        where: { sessionId, threadId: threadKey, entryId: entry },
        select: { id: true },
      })
      if (existing) return { attached: true } // 幂等：已回填过（重放 / 双端各报一次）
      const target = await this.prisma.agentMessage.findFirst({
        where: { sessionId, threadId: threadKey, role: 'user', entryId: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
      if (!target) return { attached: false }
      await this.prisma.agentMessage.update({
        where: { id: target.id },
        data: { entryId: entry },
      })
      return { attached: true }
    } catch (err) {
      this.piLogger?.warn?.(
        `user message entryId attach skipped (fail-soft, thread=${threadKey}, entryId=${entry}): ${err instanceof Error ? err.message : String(err)}`,
      )
      return { attached: false }
    }
  }

  /**
   * 隐式插话（409→steer/followUp 兜底）的落库补齐（P3 G2，D5）。
   *
   * 与显式端点（`persistQueuedUserMessage`）的差异：本路径的 user 行**早已存在**
   * （streamConversation 在 prompt 前落库）⇒ 这里是 **update 既有行**而非 create
   * ——再 create 就是同一句话两行（P3 计划 Review Focus 3）。定位口径与
   * `attachUserMessageEntryId` 同源：thread 内最新 `entryId:null` 的 user 行
   * （⛔ 绝不覆盖已有 entryId —— 那是上一条发言的 fork 切点，先到先得）。
   * 幂等：entryId 唯一索引 ⇒ 重复调用天然 no-op。
   * fail-soft：无行 / 写失败都只 warn，绝不阻断对话主链路。
   */
  async markQueuedUserMessage(input: {
    sessionId: string
    threadId: string
    entryId: string
  }): Promise<{ messageId?: string }> {
    const threadKey = input.threadId?.trim()
    const entry = input.entryId?.trim()
    if (!threadKey || !entry) return {}
    try {
      const row = await this.prisma.agentMessage.findFirst({
        where: {
          sessionId: input.sessionId,
          threadId: threadKey,
          role: 'user',
          entryId: null,
          queued: false,
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
      if (!row) return {}
      await this.prisma.agentMessage.update({
        where: { id: row.id },
        data: { entryId: entry, queued: true },
      })
      return { messageId: row.id }
    } catch (err) {
      this.piLogger?.warn?.(
        `queued user message update skipped (fail-soft, thread=${threadKey}, entryId=${entry}): ${err instanceof Error ? err.message : String(err)}`,
      )
      return {}
    }
  }

  /**
   * 插话/尾随的**多模态直通载荷**（2026-10-20 P1-2）：与正常发送（`streamConversation` 的
   * T1 直通）同一构造器 `buildDirectImagePayload`，同一 fail-soft 语义 —— 非视觉模型 /
   * 无图片附件 / 构造失败 ⇒ undefined（退化为纯文本插话，绝不阻断插话本身）。
   *
   * `[In=文件名]` 标记并入**消息文本尾部**（与正常发送的 `promptTextWithMarkers` 同口径），
   * 图片本体经 runtime 队列透传到 `lane.steer` 第二参。
   *
   * model 解析：优先用前端 composer 冻结的 `input.model`；缺省回落
   * `loadDefaultTextModel(userId)`（与正常发送同款兜底）。
   */
  private async buildQueueDirectImages(input: {
    attachments?: SidebarAttachment[]
    userId?: string
    model?: string
  }): Promise<DirectImageBuild | undefined> {
    if (!input.attachments?.length) return undefined
    try {
      const model =
        input.model?.trim() ||
        (input.userId
          ? await this.loadDefaultTextModel(input.userId).catch(() => undefined)
          : undefined)
      return await this.createDirectImagePayloadBuilder()({
        attachments: input.attachments,
        model,
      })
    } catch (err) {
      this.piLogger?.warn?.(
        `queue direct image payload build skipped (fail-soft): ${err instanceof Error ? err.message : String(err)}`,
      )
      return undefined
    }
  }

  /**
   * 插话/尾随的**独立上下文**（2026-10-20 P1-1）：只带这条消息自己的参考素材与选中态。
   *
   * ⚠️ **刻意不碰会话级 `turnContext`**：那是「每轮整体覆盖」语义，插话发生在别人那轮
   * 正在跑的时候，用它会冲掉在跑那轮的动态上下文（`setTurnContext` 是覆盖写）。
   * 本方法产出的内容只随**这一条队列消息**下发，由 pi-runtime 拼进该消息文本。
   *
   * 内容与正常发送同源（复用同一批 builder，避免两套口径）：
   * - 侧栏参考素材块（`buildSidebarBlock`：I1/T1 编号 + 标签）
   * - 画布选中摘要（`buildSelectionDigest`：id · type · 标题 + 自解释尾注）
   *
   * ⚠️ 选中摘要受 `SEL_REF_ENABLED` 开关约束（与正常发送同口径）：开关关时不拼，
   * 免得插话路径成为绕过 kill switch 的旁路。
   */
  private async buildQueueContext(input: {
    sessionId: string
    attachments?: SidebarAttachment[]
    selectedNodeIds?: string[]
  }): Promise<PiQueueContext | undefined> {
    const blocks: string[] = []
    if (input.attachments?.length) {
      const block = buildSidebarBlock(input.attachments)
      if (block) blocks.push(block)
    }
    const selectedNodeIds = input.selectedNodeIds ?? []
    if (selectedNodeIds.length && this.selectionRefEnabled()) {
      const selRefLookup = await this.buildSelectionLookup(input.sessionId)
      // 与正常发送同口径（见 streamConversation 的 selRefLookup → selectedNodeLookup 包装）：
      // buildSelectionDigest 收的是函数，不是 Map。
      const digest = buildSelectionDigest({
        nodeIds: selectedNodeIds,
        lookup: (id) => selRefLookup.get(id),
      })
      if (digest) blocks.push(digest)
    }
    if (!blocks.length) return undefined
    return { blocks }
  }

  /**
   * 撤回单条已入队的插话（2026-10-20）：让前端气泡的「放弃 / 取回内容」真正生效。
   *
   * 此前这两个按钮只清前端 `queued.value`，服务端那条仍在 vendor inbox 里照常被消费
   * —— 用户以为撤回了，实际它还会插进 agent 上下文（对齐 vendor `AgentLane.cancelQueued`）。
   *
   * ⚠️ 维护态（`piUrl` 为空）返回 `not_found` 而不是抛错：语义是「这条已经不在队列里了」，
   * 与前端「放弃」按钮的期望一致（把气泡收掉）。
   */
  async cancelQueuedPiRun(input: {
    sessionId: string
    threadId?: string
    entryId: string
  }): Promise<{ outcome: QueueCancelOutcome }> {
    const piUrl = this.getPiRuntimeUrl()
    if (!piUrl) return { outcome: 'not_found' }
    const sessionKey = input.threadId?.trim() || input.sessionId
    return this.createPiRuntimeClient(piUrl).cancelQueued(sessionKey, input.entryId)
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
    /** P1-A：late 裁决的归属校验与 llm 装配（controller 透传 req.user.sub）。 */
    userId?: string
  }): Promise<{ ok: boolean; deduped: boolean; prior?: string; late?: boolean; expired?: boolean }> {
    const piUrl = this.getPiRuntimeUrl()
    if (!piUrl) return { ok: false, deduped: false }
    const sessionKey = input.threadId?.trim() || input.sessionId
    const client = this.createPiRuntimeClient(piUrl)
    const data = await client.answer(sessionKey, {
      callId: input.callId,
      answers: input.answers,
      ...(input.decision ? { decision: input.decision } : {}),
    })
    // P2：durable 终态的唯一写者——CAS 只翻 pending 行，重复作答/并发第二发幂等。
    // 未装配 PendingInterruptionService（既有单测）⇒ 整段短路，响应形态逐字节不变。
    const settle = (status: 'answered' | 'expired' | 'aborted') =>
      this.pendingInterruptions?.settleGate({
        threadId: sessionKey,
        callId: input.callId,
        status,
        answerJson: input.answers,
      })
    // 正常 settle（registry hit）：响应形态与 P1-A 前完全一致（规格 A3 零回归）。
    if (!data.deduped) {
      await settle(input.decision === 'decline' ? 'aborted' : 'answered')
      return data
    }
    // deduped:true + prior：runtime 本进程刚 settle（墓碑命中）——并发第二发的幂等回执，不裁决。
    if (data.prior) {
      await settle(input.decision === 'decline' ? 'aborted' : 'answered')
      return { ok: true, deduped: true, prior: data.prior }
    }
    // deduped:true 无 prior：真丢失（runtime 重启 / 脏 callId）→ durable part 裁决（规格 §4.2）。
    const late = await this.adjudicateLateAnswer({
      sessionId: input.sessionId,
      sessionKey,
      callId: input.callId,
      decision: input.decision,
      answers: input.answers,
      userId: input.userId,
      client,
    })
    // 表状态跟随最终裁决（expired 优先于 answered），CAS 保证终态门不被复活。
    await settle(
      late.expired ? 'expired' : input.decision === 'decline' ? 'aborted' : 'answered',
    )
    return late
  }

  /**
   * P1（历史会话加载对账）：查询该会话在 pi-runtime 是否仍有**活跃**的阻塞等待
   * （propose_generation / ask_user）。用于前端打开旧会话时判断持久化的 pending_confirm
   * 是「活闸门」还是「死等待」（callId 已不在 runtime registry，或会话早已结束）。
   * 失败安全：探活调用异常时返回 true（假定仍活跃，保留闸门而非误隐）。
   */
  async getPendingLiveness(sessionId: string, threadId?: string | null): Promise<boolean> {
    const piUrl = this.getPiRuntimeUrl()
    if (!piUrl) return false
    const sessionKey = threadId?.trim() || sessionId
    try {
      const pending = await this.createPiRuntimeClient(piUrl).getPending(sessionKey)
      return pending != null
    } catch {
      return true
    }
  }

  /**
   * P1-A（规格 2026-11-01 §4.2）：/answers 在 runtime 侧真丢失时的 durable part 裁决。
   *
   * 真源 = AgentMessage.metadata.executionEvents 里的 waiting_user 事件（#648 起落库）。
   * 分支：找不到 waiting part → 脏 callId 幂等回执（A6）；已过 deadline（ts+timeoutMs）
   * → part 翻 expired（reason=timeout，#654 映射 expired）；未过期 → 先 CAS 翻 part 终态
   * （双闸防双裁决，规格 §8-2）再 late-answer 注入 runtime（注入失败回滚 CAS 并 503 可重试）。
   */
  private async adjudicateLateAnswer(input: {
    sessionId: string
    sessionKey: string
    callId: string
    decision?: 'answer' | 'decline'
    answers: Record<string, string[]>
    userId?: string
    client: PiRuntimeClient
  }): Promise<{ ok: boolean; deduped: boolean; prior?: string; late?: boolean; expired?: boolean }> {
    // P2（判据 P1c-4）：表是权威——门已 answered/expired/aborted 或已过 expiresAt 时，
    // late answer 只回终态回执，绝不注入 runtime、绝不把门翻回 pending（不复活门）。
    // 未装配 P2 service / 老会话无门记录 ⇒ 短路，P1-A 既有裁决链逐字节不变。
    const gate = await this.pendingInterruptions?.getGate(input.callId)
    if (gate && (gate.status !== 'pending' || gate.expiresAt <= Date.now())) {
      return {
        ok: true,
        deduped: false,
        expired: gate.status === 'expired' || gate.expiresAt <= Date.now(),
        late: true,
      }
    }
    const row = await this.findWaitingPartRow(input.sessionId, input.sessionKey, input.callId)
    // A6 脏 callId：无 waiting part（或已终态）→ 幂等回执，不泄漏探测面。
    if (!row) return { ok: true, deduped: true }
    const { messageId, event } = row
    const wd = (event.data ?? {}) as {
      timeoutMs?: number
      toolName?: string
      nodeId?: string
    }
    const timeoutMs = typeof wd.timeoutMs === 'number' ? wd.timeoutMs : null
    const startedAt = typeof event.ts === 'number' ? event.ts : null
    const expired =
      timeoutMs !== null && startedAt !== null && Date.now() > startedAt + timeoutMs
    // 翻 part 终态（CAS）：先落库再注入——CAS 输掉 = 并发裁决方已收口，本请求按幂等回执返回。
    const reason: 'answered' | 'aborted' | 'timeout' = expired
      ? 'timeout'
      : input.decision === 'decline'
        ? 'aborted'
        : 'answered'
    const casOk = await this.appendWaitingResolution(messageId, input.callId, event, reason)
    if (!casOk) {
      return { ok: true, deduped: true, prior: reason }
    }
    if (expired) return { ok: true, deduped: false, expired: true }
    // 未过期 → 迟到语境注入 runtime（answer/decline 都注入，取消走取消语境）。
    try {
      const llm = await this.resolvePiSessionLlm(input.userId)
      await input.client.lateAnswer(input.sessionKey, {
        userId: input.userId ?? '',
        callId: input.callId,
        toolName: wd.toolName,
        kind: input.decision === 'decline' ? 'decline' : 'answer',
        ...(input.decision === 'decline' ? {} : { answers: input.answers }),
        ...(llm ? { llm } : {}),
        canvasSessionId: input.sessionId,
      })
    } catch (err) {
      // 注入失败 → 回滚 CAS（part 保持 waiting 可重试）；回滚也失败则留痕（终态 receipt 已 durable，
      // 模型缺迟到语境是已登记风险，warn 不抛）。
      const rolledBack = await this.removeWaitingResolution(messageId, input.callId)
      if (!rolledBack) {
        this.piLogger.warn(
          `late-answer CAS rollback failed (callId=${input.callId}, message=${messageId}) — part 已终态但注入未达`,
        )
      }
      throw new HttpException(
        `late-answer injection failed: ${err instanceof Error ? err.message : String(err)}`,
        503,
      )
    }
    return { ok: true, deduped: false, late: true }
  }

  /**
   * 在该 thread 最近消息的 metadata.executionEvents 里找指定 callId 的**未决** waiting_user 事件。
   * 返回 messageId（供 CAS 翻终态）与事件本体；waiting 不存在（或同 callId 已有 resolved
   * ——先前裁决/正常 settle 已落库）→ null（幂等回执路径）。
   */
  private async findWaitingPartRow(
    sessionId: string,
    threadId: string,
    callId: string,
  ): Promise<{ messageId: string; event: PersistedExecutionEvent } | null> {
    const rows = await this.prisma.agentMessage.findMany({
      where: { sessionId, threadId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, metadata: true },
    })
    for (const row of rows) {
      if (!row.metadata) continue
      let meta: { executionEvents?: PersistedExecutionEvent[] }
      try {
        meta = JSON.parse(row.metadata) as { executionEvents?: PersistedExecutionEvent[] }
      } catch {
        continue
      }
      const events = Array.isArray(meta.executionEvents) ? meta.executionEvents : []
      let waiting: PersistedExecutionEvent | undefined
      for (const ev of events) {
        if (ev?.type !== 'waiting_user') continue
        const d = ev.data as { callId?: string; status?: string } | undefined
        if (d?.callId !== callId) continue
        if (d.status === 'resolved') {
          waiting = undefined // 已终态（正常 settle / 先前裁决落库）→ 幂等回执
          break
        }
        waiting = ev
      }
      if (waiting) return { messageId: row.id, event: waiting }
    }
    return null
  }

  /**
   * part 翻终态：向 executionEvents **追加**同型 waiting_user resolved 事件（#648 消费形态，
   * reason 沿用 #654 映射表 → 前端重放零新增映射）。CAS = 以旧 metadata 整串作 where 条件
   * （updateMany 计数判胜负），输掉即返回 false 由调用方按幂等收口。
   */
  private async appendWaitingResolution(
    messageId: string,
    callId: string,
    waiting: PersistedExecutionEvent,
    reason: 'answered' | 'aborted' | 'timeout',
  ): Promise<boolean> {
    const raw = (await this.prisma.agentMessage.findUnique({
      where: { id: messageId },
      select: { metadata: true },
    }))?.metadata
    let meta: Record<string, unknown> = {}
    try {
      meta = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch {
      return false
    }
    const events = Array.isArray(meta.executionEvents)
      ? [...(meta.executionEvents as PersistedExecutionEvent[])]
      : []
    if (
      events.some(
        (ev) =>
          ev?.type === 'waiting_user' &&
          (ev.data as { callId?: string; status?: string } | undefined)?.callId === callId &&
          (ev.data as { status?: string } | undefined)?.status === 'resolved',
      )
    ) {
      return false // 已终态（并发先到）——CAS 语义的一部分
    }
    const wd = waiting.data as { callId?: string; toolName?: string; nodeId?: string } | undefined
    const lastSeq = events.length ? (events[events.length - 1]?.seq ?? 0) : 0
    events.push({
      type: 'waiting_user',
      data: {
        status: 'resolved',
        toolName: wd?.toolName,
        callId: wd?.callId ?? callId,
        nodeId: wd?.nodeId,
        reason,
      },
      seq: lastSeq + 1,
      gSeq: waiting.gSeq,
      ts: Date.now(),
      messageIndex: waiting.messageIndex,
    })
    const next = JSON.stringify({ ...meta, executionEvents: events })
    const res = await this.prisma.agentMessage.updateMany({
      where: { id: messageId, metadata: raw ?? null },
      data: { metadata: next },
    })
    return res.count > 0
  }

  /** 回滚 appendWaitingResolution（注入失败路径）：以追加后的整串作 CAS 条件还原旧串。 */
  private async removeWaitingResolution(messageId: string, callId: string): Promise<boolean> {
    const row = await this.prisma.agentMessage.findUnique({
      where: { id: messageId },
      select: { metadata: true },
    })
    if (!row?.metadata) return false
    let meta: { executionEvents?: PersistedExecutionEvent[] }
    try {
      meta = JSON.parse(row.metadata) as { executionEvents?: PersistedExecutionEvent[] }
    } catch {
      return false
    }
    const events = meta.executionEvents ?? []
    const idx = [...events]
      .reverse()
      .findIndex(
        (ev) =>
          ev?.type === 'waiting_user' &&
          (ev.data as { callId?: string; status?: string } | undefined)?.callId === callId &&
          (ev.data as { status?: string } | undefined)?.status === 'resolved',
      )
    if (idx < 0) return true // 已无 resolved 条目（视为已还原）
    const realIdx = events.length - 1 - idx
    const next = JSON.stringify({
      ...meta,
      executionEvents: [...events.slice(0, realIdx), ...events.slice(realIdx + 1)],
    })
    const res = await this.prisma.agentMessage.updateMany({
      where: { id: messageId, metadata: row.metadata },
      data: { metadata: next },
    })
    return res.count > 0
  }

  /**
   * H1-c（规格 2026-10-28 §5.2）：checkpoint 相位读取方法已随 thread-state
   * 死端点一并退役删除（恒返 null，无存活消费方）。
   */
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

  /**
   * 批次 2：双写对账（发现分叉 + 自愈）—— 薄封装。
   *
   * ⭐ 判据与编排都在 `history-reconciliation.ts`（纯函数 + 可注入的编排层）
   * ⇒ 本方法只负责「把 Nest 的依赖接上去」⇒ 测试不需要构造整个 AgentService。
   *
   * ⛔ 不 await（fire-and-forget）：不拖慢 run 收尾；自愈的状态下一轮被注入。
   */
  private reconcileHistoryAfterTurn(
    client: PiRuntimeClient,
    sessionKey: string,
    threadId: string | undefined,
  ): void {
    void reconcileAfterTurn({
      prisma: this.prisma as unknown as ReconcilePrisma,
      client: client as unknown as ReconcileClient,
      turnState: this.turnState as unknown as ReconcileTurnState | undefined,
      threadId,
      sessionKey,
      logger: { warn: (msg: string) => this.piLogger.warn(msg) },
    })
  }

  /**
   * 批次 3.2：失败后**不等用户**说「继续」，自动新开一轮让模型接着做。
   *
   * ## 为什么这样就够（不需要自己造注入内容）
   *
   * 批次 1 已把「用户要什么 / 做到哪 / 卡在哪」记进 `turnState`，
   * 且**下一轮装配时会作为动态块注入**（含「不道歉、不复盘」指导语）。
   * ⇒ 自动续跑只需**新开一轮**，那一轮自然吃到状态块 ⇒ 模型直接接着做。
   *
   * ⛔ **不做**关键词识别「继续」（要猜用户意图，「接着改那个组件」即失效）。
   * ⛔ **不做** `lane.resume()`（`cmv3zzid` 已证阻塞 612 s）⇒ 只走「新开一轮」。
   *
   * ## 门控全在决策器里（`decideAutoResume`）
   *
   * - 用户在场 ⇒ 不自动（他会自己说「继续」，别抢）；
   * - 用户取消 ⇒ 不算故障（由调用方保证 `failed` 口径）；
   * - 幂等（同一轮只派一次）/ 每会话每小时上限 / 同因连败降级。
   *
   * ⛔ fail-soft：任何异常只 warn —— 自动续跑是旁路观察者，
   * 绝不影响本轮收尾（用户此时可能在等响应）。
   */
  private async maybeAutoResumeTurn(input: {
    sessionId: string
    userId: string
    threadId?: string
    /** pi 侧会话键（threadId 缺省时回落 sessionId）。 */
    sessionKey: string
    /** 本轮的用户原话（幂等键的一部分）。 */
    userMessage: string
    failed: boolean
  }): Promise<void> {
    try {
      const svc = this.turnAutoResume
      if (!svc) return
      // 幂等键 = 会话键 + 本轮用户原话 + 时刻：
      // ⭐ 同一轮的多次收尾路径（owner/shadow）只会派一次；
      // 时刻参与是为了「同一句原话在两个不同轮次里」也不互相吞。
      const turnKey = `${input.sessionKey}:${input.userMessage.slice(0, 80)}:${Date.now()}`
      const decision = await svc.handleTurnFailed({
        sessionId: input.sessionId,
        userId: input.userId,
        threadId: input.threadId,
        turnKey,
        failed: input.failed,
        interruption: classifyInterruption({ failed: input.failed, promptAccepted: true }),
      })
      this.piLogger.warn(
        `turn_auto_resume key=${input.sessionKey} path=${decision.path} ` +
          `reason=${decision.reason} degraded=${decision.degraded}`,
      )
    } catch (err) {
      this.piLogger.warn(
        `turn_auto_resume failed (fail-soft, key=${input.sessionKey}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  /**
   * 回合连续性：本轮中断时，把「用户要什么 / 做到哪 / 卡在哪」记进 **Nest DB**
   * （`AgentThread.turnState`，权威副本）。
   *
   * ⭐ 为什么权威在 Nest 而不是 pi transcript（2026-10-21 自我审查修正了初版）：
   * - **压缩必丢**：上游 `buildContextEntries`（`vendor/…/harness/session/context.ts:10-23`）
   *   在有 compaction 时返回 `[compaction, ...compaction之后的entries]`
   *   ⇒ compaction **之前**的 custom entry 被丢弃；且 `CompactionEntry.retainedTail`
   *   是 `AgentMessage[]`（`types.ts:36`）⇒ **只含 message**。
   *   ⇒ 初版「落在 transcript 里天然跨压缩存活」是**错的**。
   * - **第三条真相线**：Nest 已决定「不再查 AgentMessage 历史喂 prompt」
   *   ⇒ 再加一份 pi 侧状态 = 多一处分叉面。
   * - **绕过既有通道**：跨压缩保留早就有（`compaction-retention.ts` 的 `RetentionState`）。
   *
   * ⭐ 改走 Nest 后的收益：**pi 侧零改动**（不需 pi-runtime 重新发布），
   * 且动态块每轮重新求值 ⇒ 跨压缩存活（与 `todo` 块同机制）。
   *
   * ⛔ fail-soft：任何异常只 warn，绝不影响本轮收尾。
   */
  private async recordTurnStateOnInterruption(input: {
    sessionKey: string;
    userMessage: string;
    userMessageId?: string;
    assistantText: string;
    executionEvents: readonly { type: string; data?: unknown }[];
    failed: boolean;
    userAborted: boolean;
    /** prompt 是否被 pi 接受。false ⇒ pi 侧整轮不存在（双写分叉形态）。 */
    promptAccepted?: boolean;
  }): Promise<void> {
    try {
      const attempts = collectToolAttempts(input.executionEvents);
      if (
        !shouldRecordTurnState({
          failed: input.failed,
          userAborted: input.userAborted,
          hasAssistantText: Boolean(input.assistantText.trim()),
          toolCallCount: attempts.length,
        })
      ) {
        return;
      }
      const { completedSteps, pendingSteps } = deriveSteps(attempts);
      const recorded = await this.turnState?.record({
        threadId: input.sessionKey,
        userText: input.userMessage,
        ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
        assistantPartial: input.assistantText,
        completedSteps,
        pendingSteps,
        failed: input.failed,
        promptAccepted: input.promptAccepted !== false,
        userAborted: input.userAborted,
        hasAssistantText: Boolean(input.assistantText.trim()),
        toolCallCount: attempts.length,
      });
      this.piLogger.warn(
        `turn_state_recorded key=${input.sessionKey} recorded=${recorded === true} ` +
          `completed=${completedSteps.length} pending=${pendingSteps.length} ` +
          `promptAccepted=${input.promptAccepted !== false}`,
      );
    } catch (err) {
      this.piLogger.warn(
        `turn_state_record failed (fail-soft, key=${input.sessionKey}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async collectRetentionState(
    sessionId: string,
    threadId?: string,
  ): Promise<PiRetentionState> {
    try {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { canvasData: true },
      })
      const retention: PiRetentionState = {}
      if (session?.canvasData) {
        const parsed = JSON.parse(session.canvasData) as {
          nodes?: Array<{ id?: unknown; data?: { status?: unknown } }>
        }
        const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : []
        const pendingConfirmNodeIds = nodes
          .filter((n) => String(n?.data?.status ?? '') === 'pending_confirm')
          .map((n) => String(n?.id ?? ''))
          .filter((id) => id.length > 0)
        if (pendingConfirmNodeIds.length > 0) retention.pendingConfirmNodeIds = pendingConfirmNodeIds
      }
      // 回合连续性（2026-10-21 修正）：把「上一轮被中断」的状态也带进压缩保留段。
      //
      // ⭐ 为什么必须走这里（而不是只靠动态块）：上游压缩时
      // `buildContextEntries` 只保留 `[compaction, ...compaction之后的entries]`
      // （`vendor/…/harness/session/context.ts:10-23`）⇒ **压缩前的动态块不在上下文里**。
      // 动态块保证「下一轮可见」，保留段保证「压缩摘要里也带着」⇒ 两个通道互补。
      //
      // ⚠️ 走既有 `RetentionState` 通道（`compaction-retention.ts`）而非另开通道：
      // 那是上游为「宿主领域状态跨压缩」设计的唯一合法入口
      // （`lane.compact({ customInstructions })` ⇒ 拼进摘要 prompt，`compaction.ts:567`）。
      const turnStateLine = threadId
        ? await this.turnState?.renderRetentionLine(threadId)
        : undefined
      if (turnStateLine) {
        retention.keyToolConclusions = [...(retention.keyToolConclusions ?? []), turnStateLine]
      }
      return retention
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
    // 2026-11-04 实时补桥（见 streamConversation.streamOpts 注释）：结算块 emit
    // turn_settled 到 SessionEventBus，由 runEventStream 订阅注入 /runs/events。
    streamOpts?: { bridgeSettledToBus?: boolean },
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
    // ── P1a PR-B（事件一等化，spec 2026-11-11-sse-event-firstclass-p1a §2.2）：AgentEvent
    // append-only 双写 ──。单一写者：streamConversation 是 flag on（drain 丢 yield）/ off
    // （SSE 直收）双通道共用的唯一 owner，本漏斗是其派生副作用唯一出口；text_delta 经
    // textPersister 段折叠、flush() 边界以完整 text 事件进漏斗 ⇒「不半条」天然成立（S3）。
    // - 只落带 pi gSeq 的事件（与 /runs/events 的 SSE `id:` 同源同值，游标可寻址）；
    //   合成事件（无 gSeq）不落本表——展示权威仍是 executionEvents 落库快照（P1b 才换读）。
    // - 幂等：@@unique([threadId, gSeq, sSeq]) 冲突即覆盖（SSE 重放/重投同帧安全）。
    // - 失败不阻断主链路（fail-open，warn 打稳定 tag 供 grep）：事件表是兜底真解，
    //   写失败只损失「溢出后可恢复性」，绝不影响实时对话。
    const appendAgentEvent = (ev: PersistedExecutionEvent): void => {
      const gSeq = ev.gSeq
      // ev.seq（run 内 traceSeq）由 pushTraceEvent 恒写数字；类型可选守卫一并收口
      if (typeof gSeq !== 'number' || typeof ev.seq !== 'number') return
      const threadKey = threadId ?? sessionId
      const runId = currentPiEvent?.runId
      const payload = {
        threadId: threadKey,
        gSeq,
        sSeq: ev.seq,
        runId: runId ?? null,
        type: ev.type,
        ts: new Date(ev.ts ?? Date.now()),
        data: JSON.stringify(ev.data ?? null),
        // P1c 清债（账本投影）：回合内 assistant 消息段归属随行落账（message_end 不是
        // trace 事件不进账本 ⇒ 块归属读侧无法重建，只能写侧带出）。
        messageIndex: ev.messageIndex ?? 0,
      }
      try {
        void this.prisma.agentEvent
          .upsert({
            where: { threadId_gSeq_sSeq: { threadId: threadKey, gSeq, sSeq: ev.seq } },
            create: payload,
            update: { type: payload.type, ts: payload.ts, data: payload.data, runId: payload.runId },
          })
          .catch((err: unknown) => {
            this.piLogger?.warn?.(
              `agent_event_append_failed thread=${threadKey} gSeq=${gSeq} sSeq=${ev.seq} type=${ev.type}: ${String(err)}`,
            )
          })
      } catch (err) {
        // 同步异常（测试桩缺 agentEvent delegate / client 未含新模型）同样 fail-open
        this.piLogger?.warn?.(
          `agent_event_append_failed thread=${threadKey} gSeq=${gSeq} sSeq=${ev.seq} type=${ev.type}: ${String(err)}`,
        )
      }
    }
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
      // P1c 清债（写面分流，spec 2026-11-11-sse-p1c-ledger-projection-metadata-shrink §2.2）：
      // metadata.executionEvents 只保留**最小兼容集**，其余只进账本（appendAgentEvent）——
      // - waiting_user：状态机读者（pending 查找/resolved 追加/清除）只在 metadata，
      //   P2 PendingInterruption 表接管前不动（R7）；
      // - turn_settled：经 awaited finalizeTurn 落 metadata 的权威终态，前端已结算探测
      //   （L959/L1115 形态）健壮性不回退——账本是 fire-and-forget fail-open（R7）；
      // - 无 gSeq 合成事件：账本不收（appendAgentEvent 直接跳过），metadata 是唯一落点（R6）。
      // 其余（text/tool_call/tool_result/thinking/canvas/task_list/turn_usage/plan_proposed…）
      // 带全量 gSeq 且账本全量在 ⇒ metadata 不再双写（债主体，生产实测 max 530KB/行）。
      // 返回值不变：调用点 pushTraceEvent(...).data / const settledData = … 依赖。
      if (
        typeof ev.gSeq !== 'number' ||
        ev.type === 'waiting_user' ||
        ev.type === 'turn_settled'
      ) {
        executionEvents.push(ev)
      }
      // P1a PR-B：事件账本即时 append（fire-and-forget，不阻塞流）
      appendAgentEvent(ev)
      return ev    }
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
    // 2026-11-05 生产事故（composer 图不进上下文）补的可观测闸门：buildDirectImagePayload
    // 内部单图失败是静默 skip，全部失败返回 undefined 时外面毫无声息——模型只能拿到
    // 识图文本摘要，用户侧表现为「模型说看不见图」。有图片附件却没直通成功必须留痕。
    if (!directImages) {
      const imageCount = (piContext?.attachments ?? []).filter(
        (a) => (a?.mediaType ?? '').trim().toLowerCase() === 'image',
      ).length
      if (imageCount > 0) {
        this.piLogger?.warn?.(
          `direct image payload not built: ${imageCount} image attachment(s) will NOT reach model context as pixels (model=${directImageModel ?? 'unknown'}, session=${sessionId}) — falling back to sidebar vision text block`,
        )
      }
    }
    // ③ 侧栏识图前置：结果作为文本上下文并入 systemPrompt（失败返回 ''，不阻断）
    const visionBase = directImages
      ? ''
      : await this.buildSidebarVisionBlock({
      sessionId,
      userId,
      userMessage,
      attachments: piContext?.attachments,
      model,
    })
    // VISP S-7/M-9（2026-11-05）：直注失败且有图片附件 → 动态块追加恢复提示
    // （模型需要知道 read_media 存在；不吃 L6 静态预算，R-V10）。
    // VISP 2026-11-06 生产事故：直注**成功**也要明示「图已在 context，直接描述」
    // ——实证模型会无视已注入的像素、按侧栏块的 url 线索去调 view_canvas_media，
    // 撞 pod hairpin 死路后报告「图片加载失败」。
    const visionBlock = directImages
      ? buildImageInjectedNotice(piContext?.attachments)
      : visionBase + buildImageRecoveryHint(piContext?.attachments)
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
    // 回合连续性（2026-10-21 修正）：把「上一轮被中断」的状态作为动态块喂给模型。
    //
    // ⭐ 为什么走动态块（systemPrompt 尾部动态段）而不是 pi 侧 transcript 条目：
    // - 动态块**每轮重新求值** ⇒ 跨压缩存活（与 `todo` 块同机制，
    //   `session-manager.ts:2358-2369` 注释：压缩后每次 LLM 请求重新求值 systemPrompt，
    //   块恒在）⇒ 修掉了初版「custom entry 在 compaction 时被丢弃」的缺陷；
    // - 权威在 Nest DB ⇒ 只有一条真相线（不加剧双写分叉面）；
    // - pi 侧**零改动** ⇒ 不需要 pi-runtime 重新发布。
    //
    // ⚠️ 块首行必须与 `renderTurnStateBlock` 一致（`【上一轮被中断…】`）——
    // `classifyBlock` 靠前缀分类预算档位，改前缀要同步改那边。
    const turnStateBlock = await this.turnState?.renderBlock(sessionKey)
    if (turnStateBlock) {
      dynamicBlocks.push(turnStateBlock)
      // ⭐ 可观测性：生产上「这一轮到底有没有注入状态块」是本特性唯一的验证入口
      // （模型看到什么无法直接观测，只能靠「块是否进了 systemPrompt」+ 用户侧体感）。
      // 不打这条日志 ⇒ 线上出问题时分不清是「没记录」「没读到」还是「注入了但被截断」。
      this.piLogger.warn(
        `turn_state_injected key=${sessionKey} chars=${turnStateBlock.length} ` +
          `interruption=${/中断类型：([^。]+)/.exec(turnStateBlock)?.[1] ?? 'unknown'}`,
      )
    }
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
    // ── Epic 1 Task 5：在飞流注入 credit_tx ──
    // 本次会话的积分变动（文本回合结算 / 生成扣费）经 SessionEventBus 推入 creditQueue，
    // 主消费循环顶部与结算块收口处依次 yield，确保实时进 SSE 流。CREDIT_TX=off 时
    // 完全不订阅（退化，与既有展示行为一致）。
    const creditQueue: AgentStreamEvent[] = []
    let creditUnsub: (() => void) | undefined
    if (process.env.CREDIT_TX === 'on' && this.eventBus) {
      creditUnsub = this.eventBus.subscribeSession(sessionId, (ev: CreditTxEvent['data']) => {
        creditQueue.push({ type: 'credit_tx', data: ev } as unknown as AgentStreamEvent)
      })
    }
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
      retention: await this.collectRetentionState(sessionId, sessionKey),
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
    /**
     * D4（multi-device Task 6，spec §5.2）：服务端裁定的回合归属，流末尾经 `turn_ack`
     * 回传前端（不再让客户端从 409 猜「我的消息到底去哪了」）。
     * - 'run'      —— 空闲 ⇒ 本流发起新 run（owner）
     * - 'steer'    —— 409 后并入在跑 run 的 steer 队列（本轮 turn 边界接住）
     * - 'followup' —— steer 也塞不进去 ⇒ followUp 兜底（收尾边界接住，消息不蒸发）
     * - undefined  —— 没有可裁定的归属：prompt 非 409 失败（error 事件已告知）/
     *   steer+followUp 双失败（turn_not_submitted{not_steerable} 已告知）。
     *   这两种场景再发 ack 就是把「没受理」包装成「受理了」。
     *
     * ⚠️ 不变式：turnMode !== 'run' ⇒ turnRefusalReason === 'not_idle'
     * （not_steerable 只在双失败路径置，而那一条 leave undefined）。
     */
    let turnMode: 'run' | 'steer' | 'followup' | undefined
    /**
     * P3 G4：turn_ack 的 messageId（隐式插话落库补齐后的 AgentMessage 行 id）。
     * 键不出现纪律：落库失败（fail-soft）⇒ 不出现该键（不发 null/空串）。
     */
    let turnMessageId: string | undefined
    /** prompt 是否被 pi 接受（202）。false ⇒ pi 侧**整轮不存在**（双写分叉）。 */
    let promptAccepted = true
    // ── D2（multi-device Task 2）：落库与请求生命周期解耦 ──
    //
    // ⛔⛔ 2026-10-21 生产取证推翻了原计划的机制假设（详见 .superpowers/sdd ledger）：
    // 「nginx 300s 掐断 ⇒ 消费方在 yield 处抛错 ⇒ generator 提前终止」**不成立**——
    // Node 上 `res.write` 对已销毁的 socket 只返回 false、**不抛错**（实测），
    // 生产 nginx 日志里该 POST 是 **201 正常完成**（不是 499/504）。
    //
    // ⇒ 真正可证的缺陷是：**落库判据依赖「本流是否见到了 agent_end」**。
    // Nest 侧流提前结束时，权威的 agent_end（+ turn_usage）还没到 ⇒
    // 「等 agent_end 才落库、没等到就什么都不写」⇒ 整轮在 Nest 侧**零记录**，
    // 而 pi 侧那轮照跑照完（transcript 里 completed）⇒ 「有执行、无记录」。
    //
    // `sawTerminalEvent`：本流是否见到了**权威收束事件**（agent_end 或 error）。
    // - true  ⇒ 这轮在 pi 侧**已经结束**（成功或失败）⇒ 本流看到的是全部 ⇒ 不标 truncated；
    // - false ⇒ 这轮在 pi 侧**还在跑**（本流只是提前收尾）⇒ 落库内容是**前缀**，
    //   尾部未捕获 ⇒ 必须标 truncated（否则读端会把前缀当完整过程重放）。
    //
    // ⚠️ `error` 也算收束：run 失败**也是**结束了，不是「尾部缺失」。
    //   失败轮的账本完整性由 `runFailed` 分支（计费全退）承担，不靠 truncated 表达。
    let sawTerminalEvent = false
    // `loopCompletedNaturally` = while 循环自然退出（agent_end / error / 流耗尽）。
    // 消费方断连触发 `generator.return()` 时，generator 在 `yield` 处被回收、**不会**
    // 执行循环后的收尾（计费 / 回合状态 / finalizeTurn 落库）→ 整轮助手消息丢失。
    // 该标志为 false 时由 finally 的 detached settle 接管落库。
    // `turnSettled` 保证整轮只落库一次（断连与正常路径互斥）。
    let loopCompletedNaturally = false
    let turnSettled = false
    try {
      await client.prompt(sessionKey, promptTextWithMarkers, "main", {
        forceSkills,
        turnContext,
        images: directImages?.images,
      })
      // D4（Task 6）：prompt 被接受 ⇒ 本流是新 run 的 owner（唯一落库者）。
      turnMode = 'run'
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const status = (err as { status?: number } | undefined)?.status
      if (status !== 409) {
        // 上游错误：照旧交给 SSE 的 error 事件，此处不另起一轮。
        // ⚠️ 刻意**不**置 shadow：网络超时等场景下 run 可能其实已被接受，
        // 若把唯一写者误判成旁听 ⇒ 整轮消息彻底不落库（那比重复更糟）。
        this.piLogger.warn(`pi prompt failed (key=${sessionKey}): ${message}`)
        // ⭐ 回合连续性（2026-10-21）：prompt 未被接受 ⇒ **pi 侧整轮不存在**。
        // 而 Nest 侧 user 消息已落库（`streamConversation` 早于本方法落库）⇒ 双写分叉：
        // 用户在界面上看得见自己说了什么，模型却从未见过 ⇒ 下一轮说「继续」时
        // 模型只能靠感知画布猜意图（2026-10-21 生产事故形态）。
        // 这里立刻把「用户要什么」记进 Nest（权威副本），下一轮动态块会喂给模型。
        promptAccepted = false
        await this.recordTurnStateOnInterruption({
          sessionKey,
          userMessage,
          assistantText: '',
          executionEvents: [],
          failed: true,
          userAborted: false,
          promptAccepted: false,
        })
      } else {
        // 409 = 上一轮还在跑。用户这次发言不该蒸发 → 改走 steer 队列（durable 落盘），
        // 由当前 run 的下一个 turn 边界接住。此前这条分支是 `catch(() => {})`，静默丢消息。
        turnRole = 'shadow'
        turnRefusalReason = 'not_idle'
        this.piLogger.warn(
          `turn_not_submitted{reason=not_idle} key=${sessionKey} — 本流转旁听（同 run 由 owner 流记账）`,
        )
        try {
          const steerRes = (await client.steer(sessionKey, promptText, "main", {
            turnContext,
          })) as { queued?: boolean; entryId?: string } | undefined
          // D4（Task 6）：服务端裁定 = 并入在跑 run 的 steer 队列（本轮 turn 边界接住）。
          turnMode = 'steer'
          // P3 G2：隐式插话与显式端点同权——entryId 不再丢弃，既有 user 行补 queued+entryId。
          const steerMark = await this.markQueuedUserMessage({
            sessionId,
            threadId: sessionKey,
            entryId: steerRes?.entryId ?? '',
          })
          turnMessageId = steerMark.messageId
        } catch (steerErr: unknown) {
          // steer 也塞不进去（队列满 / 会话已被回收 / runtime 侧异常）。
          // D4（Task 6）追加 followUp 兜底：「忙碌且 steer 不可用」时用户发言改走
          // **收尾边界**（当前 run 跑完后由 vendor 同一次 run 续一代接住）——
          // plan 模式表「忙碌+队列满 ⇒ followup」。没有这条兜底，队列满时用户消息
          // 既不入队也不报错，是查不掉的黑洞。
          this.piLogger.warn(
            `pi steer fallback failed (key=${sessionKey}): ${
              steerErr instanceof Error ? steerErr.message : String(steerErr)
            } — 转 followUp 兜底（收尾边界接住）`,
          )
          try {
            const followUpRes = (await client.followUp(sessionKey, promptText, "main", {
              turnContext,
            })) as { queued?: boolean; entryId?: string } | undefined
            turnMode = 'followup'
            // P3 G2：同 steer——followUp 返回的 entryId 回填既有 user 行。
            // entryId 缺席（老 runtime）⇒ markQueuedUserMessage no-op。
            const followMark = await this.markQueuedUserMessage({
              sessionId,
              threadId: sessionKey,
              entryId: followUpRes?.entryId ?? '',
            })
            turnMessageId = followMark.messageId
          } catch (followUpErr: unknown) {
            // 两条队列都进不去：必须留痕，否则「消息既不回答也不报错」会成为查不掉的黑洞。
            turnRefusalReason = 'not_steerable'
            this.piLogger.warn(
              `pi followUp fallback failed (key=${sessionKey}): ${
                followUpErr instanceof Error ? followUpErr.message : String(followUpErr)
              }`,
            )
          }
        }
        // 结构化拒绝：409 是传输层信号，语义太薄，UI 拿不到 reason 就分不出
        //「已并入 / 当前不可插话」两种文案。前端收到它才显示「已并入进行中的任务」。
        // ⚠️ followup 兜底成功时 reason 仍是 not_idle：消息**已受理**（排进收尾边界），
        // 只是没有新开一轮；steer/followup 的细化由流末尾 turn_ack 承担（D4）。
        // P3 G1：drain 模式下本帧被丢弃 ⇒ 经 bus 补投（gate 与 turn_settled 补桥同源）。
        if (streamOpts?.bridgeSettledToBus === true) {
          this.eventBus?.emitTurnNotSubmitted({ sessionId, reason: turnRefusalReason })
        }
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
    // v2 单一真相源修复（2026-11-03）：流式预估与回合结算**同引擎**。此前预估走
    // estimateCreditsFromUsdCost（USD 成本折算），结算走 quoteTextTokens（token 反比率）
    // ——两套公式 ⇒ 用户看到「≈1 积分（预估）」而账单实扣 14/7。现在回合开始时预读
    // 一次价目表 token 比率（prepareTextTokenQuote），流式中途用与结算同一纯公式同步
    // 估算（computeTextTokenCredits）——「≈N 积分（预估）」与「对话回合结算」同源同式，
    // 改价目表两端同时生效。非 token 模型 / 价目表降级时 plan=null，回落 USD 成本预估
    // （那正是结算的 degraded 兜底公式，口径仍一致）。
    const textQuotePlan =
      this.pricing && typeof this.pricing.prepareTextTokenQuote === 'function'
        ? await this.pricing.prepareTextTokenQuote(userId, billingModelKey)
        : null
    const estimateTurnCredits = (totals: {
      inputTokens?: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
      outputTokens?: number
      cost?: number
    }): number | null => {
      if (textQuotePlan) {
        const credits = textQuotePlan.compute({
          inputTokens: totals.inputTokens ?? 0,
          cacheReadTokens: totals.cacheReadTokens ?? 0,
          cacheWriteTokens: totals.cacheWriteTokens ?? 0,
          outputTokens: totals.outputTokens ?? 0,
        })
        // compute 恒 ≥1（max(1,…)）且四列有值才可信；全零 usage 不出预估（杜绝 0 假象）
        const hasTokens =
          (totals.inputTokens ?? 0) +
            (totals.cacheReadTokens ?? 0) +
            (totals.cacheWriteTokens ?? 0) +
            (totals.outputTokens ?? 0) >
          0
        return hasTokens ? credits : null
      }
      return totals.cost && totals.cost > 0
        ? estimateCreditsFromUsdCost(totals.cost, marginBp, fxUsdCny)
        : null
    }
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
    // turn_suspended（2026-10-31 皮皮虾回合生产实证）：主流在**阻塞等待边界**被
    // pi lane 的挂起收尾（iterator done、无 agent_end）——此前客户端只能靠「流断了」
    // 猜测语义：正常挂起与真断链在传输层不可区分，P0-5 的安抚文案只能挂在
    // fetch 异常分支上（真挂起走 [DONE] 反而什么都不说、状态行随 isStreaming 熄灭）。
    // 显式记录「本流见到过 waiting{waiting} 且未见权威收束」⇒ 流自然耗尽时下发
    // turn_suspended（见循环出口处）。
    let sawWaitingUser = false
    try {
      while (!done) {
        // Epic 1 Task 5：先把在飞期间到达的 credit_tx 尽数下发（生成扣费实时进对话）。
        while (creditQueue.length > 0) {
          yield creditQueue.shift() as AgentStreamEvent
        }
        const { value: event, done: streamClosed } = await iterator.next()
        if (streamClosed || !event) break
        // ── P0-B 回合围栏（2026-11-02 天鹅事故）────────────────────────────
        //
        // 本流是**新 run 的 owner**（prompt 被接受、turnMode='run'）时，以 prompt 后
        // **首个 agent_start** 的 runId 锁定回合身份；此后一切归属其他 run 的事件
        // （回合外 drain 简报轮等，runtime 给所有 run 内事件兜底打 runId 戳，
        // session-manager.ts:3219）**整条跳过**——不进文本、不进 executionEvents、
        // 不 yield 给前端、更不能让它的 agent_end 提前终止本流。
        //
        // 旧行为两个病灶（生产实证：黑天鹅简报整段黏进蓝天鹅的 AgentMessage 行）：
        // ① `turnRunId` 取「最后出现的非空值」⇒ 中途插入的回合外 run 会顶掉本流
        //    身份，其 text_delta 被并进本流正文落库（跨 run 黏连）；
        // ② 任意 `agent_end` 都置 done ⇒ 回合外简报轮先收束时主流被提前掐断。
        //
        // ⚠️ 只对 owner-of-new-run 生效：shadow/steer/followup 是**半路接入在跑
        // run** 的流（没有自己的 agent_start 可认），保持旧语义（首个带身份事件
        // 即归属 run；其 agent_end 终止本流也是既有契约）——它们的重复落库由
        // `(threadId, runId)` 唯一索引兜底（D2/PR2 既有裁决）。
        //
        // ⚠️ 残余竞态（接受）：本流订阅（from=now）与 prompt 202 之间若有回合外
        // run 恰好 agent_start，身份会误锁到它（毫秒级窗口；reaper 5min 节拍下
        // 概率可忽略）。识别手段（payload 返回 operationId）上游暂未提供，见
        // pi-runtime.client.prompt() 返回 void——未来上游补身份回传时应优先采用。
        if (turnMode === 'run') {
          if (event.type === 'agent_start') {
            // sawRunStart 是账本完整性的因果围栏（N5）——保持旧语义：**任意**
            // agent_start 都置位（上游 runId 在 data 里、envelope 上可能没有，
            // 不能把两者捆绑，否则「看到了 run 起点」被误判成头部缺口）。
            sawRunStart = true
            if (event.runId && turnRunId === undefined) turnRunId = event.runId
          }
          if (turnRunId !== undefined && event.runId !== undefined && event.runId !== turnRunId) {
            continue
          }
        } else {
          if (event.runId) turnRunId = event.runId
          if (event.type === 'agent_start') sawRunStart = true
        }
        // P0-1：本轮落库事件共享这个事件的全局 seq（见 pushTraceEvent 的 gSeq）。
        currentPiEvent = event
        if (firstSeq === undefined && typeof event.seq === 'number') firstSeq = event.seq
        if (event.type === 'agent_end' || event.type === 'error') {
          done = true
          runFailed = event.type === 'error'
          // D2（Task 2）：权威收束事件到了 ⇒ 这轮在 pi 侧已结束 ⇒ 本流看到的是全部。
          // ⚠️ `error` 也算收束（run 失败**也是**结束，不是「尾部缺失」）。
          sawTerminalEvent = true
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
          // P2（判据 P1c-6）：终态门不再下发活卡片。propose-plan.ts 的 timeout/aborted
          // 分支仍会经 tool_execution_end 携带 canvasCommands（卡片 payload 与结算态无关），
          // 前端重放会把已 answered/expired 的 question part 翻回 pending_answer。
          // 表无该 callId 记录（老会话）⇒ isGateLive 保守放行 ⇒ 旧行为零回归。
          if (cmd.type === 'ask_user' && cmd.callId && this.pendingInterruptions) {
            const live = await this.pendingInterruptions.isGateLive(cmd.callId)
            if (!live) continue
            await this.pendingInterruptions.openGate({
              threadId: sessionKey,
              callId: cmd.callId,
              runId: currentPiEvent?.runId ?? null,
              questions: (cmd as unknown as { questions?: unknown }).questions,
            })
          }
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
        // P1-2（spec 2026-11-11-propose-plan-visibility-design.md §5.3/D4）：propose_plan 的
        // details.plan → plan_proposed 一等方案事件。落库（pushTraceEvent）⇒ 刷新/重连后方案
        // 独立于确认卡仍可见；确认卡内联 plan（P0-2）与本事件并存：卡是决策面，本事件是对话流
        // 的方案存档 + 二期方案面板数据底座。
        const planEv = extractPlanProposedEvent(event)
        if (planEv) {
          pushTraceEvent(planEv.type, planEv.data)
          yield planEv as AgentStreamEvent
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
        // mapPiEventToUiEvent 不产出该类型。
        // node_status（2026-10-18 回合挂住等终态）：生产实证漏入库——实时 SSE 走
        // 全量 ui yield 没问题，但这里只通用收集 tool_call/tool_result ⇒ 刷新后
        // 历史回合重放拿不到生成终态（TRACE_PERSIST 白名单早有它，是提取分支漏接）。
        // waiting_user（2026-10-31 孤儿 pending_confirm 根治）：同款「漏入库」——阻塞
        // 确认工具（ask_user/propose_generation）的等待生命周期事件只走实时 SSE，
        // 落库后前端 replayTimelineEvents 才能在刷新/历史重放时重建 proposal part
        // （含 callId），等待结束（resolved，含 timeout/aborted）也落库 ⇒ 重放把
        // proposal part 翻终态，不再残留「点了没反应」的死确认卡。
        // 生产实证 cmvvaw8ar000moe01fdolrugb：propose 阻塞等待 7.5min 超时收场，
        // 账本里 tool_call/tool_result 齐全却无 waiting_user ⇒ 前端无法从历史判定
        // 等待态，确认/取消按钮静默 no-op。
        if (
          ui.type === 'tool_call' ||
          ui.type === 'tool_result' ||
          ui.type === 'node_status' ||
          ui.type === 'waiting_user'
        ) {
          pushTraceEvent(ui.type, ui.data)
        }
        // P2-3：message_end 是「一条 assistant 消息的权威收束」⇒ 其后的执行事件归属下一段，
        // 供时间线还原多段叙述各自的块归属（messageIndex 从 0 起）。
        if (event.type === 'message_end') {
          textPersister.flush() // 收束前把正文段归入当前 messageIndex
          traceMessageIndex += 1
        }
        // 2026-11-11 消费终态挂钩（主流侧）：user 消息 entry 物化进 transcript ⇒
        // queued=true 行翻终态 + 广播 user_utterance_consumed（见 noteUtteranceConsumed）。
        // fire-and-forget：写库失败 fail-soft，不阻塞事件流。
        const consumedEntry = this.extractConsumableUtteranceEnd(event)
        if (consumedEntry) void this.noteUtteranceConsumed(sessionKey, consumedEntry)
        // turn_suspended 判据：waiting{waiting} 置位；同流内见到 resolved（等待在
        // 本流生命周期内被 answered/取消）则复位——挂起事件只在「流耗尽时仍挂着」发。
        if (ui.type === 'waiting_user') {
          const wd = ui.data as {
            status?: string
            callId?: string
            timeoutMs?: number
            toolName?: string
            reason?: string
          }
          sawWaitingUser = wd.status === 'waiting'
          // P2：durable 开闸/收闸。runtime 的 setTimeout 仍负责让阻塞工具返回 timeout，
          // 表只作权威状态；resolved 帧（reason=answered/timeout/aborted）把 state 对齐。
          // 表写失败由 service fail-open 吞掉 ⇒ 不阻塞 SSE。
          if (this.pendingInterruptions && typeof wd.callId === 'string' && wd.callId) {
            if (wd.status === 'waiting') {
              await this.pendingInterruptions.openGate({
                threadId: sessionKey,
                callId: wd.callId,
                runId: currentPiEvent?.runId ?? null,
                kind: wd.toolName,
                expiresAt:
                  Date.now() +
                  (typeof wd.timeoutMs === 'number' && wd.timeoutMs > 0
                    ? wd.timeoutMs
                    : DEFAULT_GATE_TTL_MS),
              })
            } else if (wd.status === 'resolved') {
              await this.pendingInterruptions.settleGate({
                threadId: sessionKey,
                callId: wd.callId,
                status:
                  wd.reason === 'timeout'
                    ? 'expired'
                    : wd.reason === 'aborted'
                      ? 'aborted'
                      : 'answered',
              })
            }
          }
        }
        yield ui as AgentStreamEvent
      }
      // turn_suspended（2026-10-31 生产实证 cmvvaw8ar000moe01fdolrugb）：流在阻塞等待
      // 边界自然耗尽（pi lane 挂起收尾 ⇒ iterator done、无 agent_end）。此前客户端对
      // 「正常挂起」无任何显式信号——等待条随 isStreaming 熄灭、真断链与挂起不可区分。
      // 显式下发 turn_suspended（其后 controller 照常补 [DONE]）：前端据此保持等待态
      // 呈现、不弹断链文案；等待解除后续跑事件经旁听流（followUp tail）续传。
      if (sawWaitingUser && !sawTerminalEvent) {
        // 双段 cast（本仓既有模式）：本地 @lnkpi/agent dist 落后于源码联合类型时
        // 单段 cast 报 TS2352；CI 一致 checkout 下等价。
        yield { type: 'turn_suspended', data: {} } as unknown as AgentStreamEvent
      }
      // D2（Task 2）：只有 while 循环**自然**退出才置 true。消费方断连触发
      // `generator.return()` 时，generator 在 `yield` 处被回收，本语句不可达 ⇒
      // loopCompletedNaturally 保持 false，由下方 finally 接管落库。
      loopCompletedNaturally = true
    } finally {
      textPersister.flush() // 回合收尾：残留正文段（尾段后无边界事件时）落库
      // D2（Task 2）：落库不得依赖「本流是否见到了 agent_end」。
      //
      // ⛔⛔ 生产取证（2026-10-21，见 .superpowers/sdd ledger）推翻了原计划的机制假设：
      // 「nginx 300s 掐断 ⇒ 消费方在 yield 处抛错 ⇒ generator 提前终止」**不成立**
      // （Node 上 res.write 对死 socket 只返回 false 不抛错；生产 nginx 日志该 POST 是
      // **201 正常完成**；同 session 一个 438.1s 的 run 照样落了库）。
      // ⇒ 真正可证的缺陷是：**Nest 侧 SSE 提前收尾时（~118s），权威的 agent_end 还没到**
      // （pi 侧那轮继续跑到 618.6s 并 completed）⇒ 旧判据「等到 agent_end 才落库、
      // 没等到就什么都不写」⇒ 整轮在 Nest 侧零记录 ⇒「有执行、无记录」。
      //
      // 因此本分支的语义从「断连兜底」升级为「**本流结束时必落库**」：
      // 不论是消费方断连（generator.return）、循环内异常、还是流提前耗尽，
      // 都用**手上已有的一切**落库，并按缺口方向显式标注（truncated = 尾部截断）。
      //
      // ⚠️ inline `threadId?.trim() || sessionId` 而非引用下方的 effectiveThreadId，
      // 否则触发 TDZ（该 const 声明在 try 之后，finally 作用域内尚不可见）。
      if (!loopCompletedNaturally && turnRole === 'owner' && !turnSettled) {
        turnSettled = true
        // 落库内容是**本流结束瞬间的快照**：pi 侧 run 在 Nest 侧收尾后**仍会跑完**
        // （证据：618.6s 的 run 在 pi transcript 里 completed，而 Nest 表 0 行）。
        // ⇒ Nest 手上的 executionEvents 只是**前缀**，不冒充全量 ⇒ 必须标「尾部截断」。
        // 账本围栏（partial/gapFrom）照常算：收尾点可能也在 run 起点之前（那就没有 partial，
        // 因为 isLedgerComplete 判的是「有事件却没看到 agent_start」）。
        const capture: LedgerCapture = {
          sawRunStart,
          firstSeq,
          eventCount: traceSeq, // P1c R8：分流后 executionEvents 只存保留集，完整性判据用总推送计数
        }
        const partial = !isLedgerComplete(capture)
        if (partial) {
          this.piLogger.warn(
            `persist_ordinal_gap key=${sessionKey} runId=${turnRunId ?? 'unknown'} gapFrom=${firstSeq ?? 'unknown'} — 本流从半路接入，账本标 partial（不冒充全量）`,
          )
        }
        void this.finalizeTurn(
          sessionId,
          threadId?.trim() || sessionId,
          userId,
          assistantText,
          canvasActions,
          {
            rewriteCanvasData: false,
            linkedOutputs: deriveLinkedOutputs(canvasActions),
            metadata: buildTurnMetadata({
              executionEvents,
              partial,
              gapFrom: ledgerGapFrom(capture),
              // P1c 写面分流标记：traceSeq > 数组长 ⇒ 本行 executionEvents 是最小兼容集
              eventsShrunk: traceSeq > executionEvents.length,
              // ⚠️ 只有**真的没见到 agent_end** 才是尾部截断。
              // 消费方在 agent_end 之后才断连（很常见：最后一帧已到、前端刚好刷新）
              // ⇒ 本流其实看全了 ⇒ 不能标 truncated（否则谎报缺口）。
              ...(sawTerminalEvent ? {} : { truncated: true }),
            }),
            runId: turnRunId,
            sawTerminalEvent,
            runStarted: promptAccepted,
          },
        ).catch((err) =>
          this.piLogger.warn(
            `detached finalizeTurn failed (key=${sessionKey}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        )
      }
      // P0-①：会话跨轮保留（历史即上下文），回收由 pi-runtime 的 TTL / 磁盘 LRU 负责。
      // 这里只退订本轮订阅（触发 iteratePiEvents 的 doCancel → client.cancel）。
      // 注意：iteratePiEvents 现在返回 AsyncIterableIterator，其 `return` 在类型上是可选的，
      // 故用可选调用（运行期恒存在，见 iteratePiEvents 内部实现）。
      await iterator.return?.(undefined)?.catch(() => {})
      // Epic 1 Task 5：流收口退订 credit_tx 订阅，避免 emitter 泄漏（R1）。
      creditUnsub?.()
    }

    // ── D4（multi-device Task 6）：流末尾回传服务端裁定的回合归属 ──
    //
    // plan Task 6 Step 3：本期不改「流随请求」形态，只在现有响应里额外回传 mode
    // （SSE 流末尾的一个 turn_ack 事件，与 turn_not_submitted 并存），
    // 让前端能对用户说清「已并入进行中的任务」。分两期：先让语义可见，再改传输形态。
    //
    // ⚠️ 只在**有归属**时发：prompt 非 409 失败（error 事件已告知）与
    // steer+followUp 双失败（turn_not_submitted{not_steerable} 已告知）都不发——
    // 没有裁定结论却回一个 ack，就是把「没受理」包装成「受理了」。
    // ⚠️ 位置即「自然完成路径」保证：消费方断连触发 generator.return() 时，
    // generator 在 yield 处被回收，**try/finally 之后的代码一律不可达**
    // （与 loopCompletedNaturally 的语义同源，见其声明处注释）⇒ 能走到这里
    // 就说明本轮是看着 agent_end/error/流耗尽收尾的，ack 是给看完整轮的前端的。
    if (turnMode) {
      // P3 G1：drain 模式下本帧被丢弃 ⇒ 经 bus 补投。data 与流内 yield 同源，杜绝口径漂移。
      if (streamOpts?.bridgeSettledToBus === true) {
        this.eventBus?.emitTurnAck({
          sessionId,
          mode: turnMode,
          ...(turnMode !== 'run' ? { reason: turnRefusalReason } : {}),
          ...(turnRunId ? { runId: turnRunId } : {}),
          ...(turnMessageId ? { messageId: turnMessageId } : {}),
        })
      }
      yield {
        type: 'turn_ack',
        data: {
          // runId = 观测值（事件流里最后出现的非空 runId，见循环内 `if (event.runId)`）。
          // runtime 未透传时**不出现该键**（键不出现纪律）：滚动升级窗口里老 runtime
          // 没有 runId，编一个假 id 比没有更糟（Task 7 的投影按它查 snapshot，缺了就是缺了）。
          ...(turnRunId ? { runId: turnRunId } : {}),
          mode: turnMode,
          // reason 仅 mode!=='run' 时出现（spec §5.2）：说明为什么不是新开一轮。
          // 不变式：此处 turnRefusalReason 恒为 'not_idle'（not_steerable 只伴随
          // turnMode === undefined，那条路径根本不会到这里）。
          ...(turnMode !== 'run' ? { reason: turnRefusalReason } : {}),
          // P3 G4（原「留待 Task 8」）：隐式插话落库补齐（markQueuedUserMessage）成功
          // 时回填 AgentMessage 行 id；失败（fail-soft）不出现该键（不发 null/空串）。
          ...(turnMessageId ? { messageId: turnMessageId } : {}),
        },
      } as AgentStreamEvent
    }

    const effectiveThreadId = threadId?.trim() || sessionId
    // ── P2 T6（token 精确计费）：收尾结算（finalizeTurn 前，turn_settled 须随
    // executionEvents 落进 assistant metadata）。全链路 try/catch 包裹——计费故障
    // 绝不打断对话：结算失败 → release 全退 + warn，hold 泄漏双保险之二。
    // TURN-IDENTITY P0-2：shadow 流（409 并入在跑的 run）**不参与结算** —— 它没有
    // 发起 run，没有可归因的 usage；扣它等于对同一次生成重复收费。
    // hold 由下面的 finally 兜底全退（holdOpen 仍为 true ⇒ release 恰一次）。
    if (turnRole === 'owner' && billingEnabled && billingHold && this.points && this.pricing) {
      // 2026-11-04 实时补桥：drain 模式（flag-on）下 yield 帧被丢弃 ⇒ turn_settled
      // 需经 SessionEventBus 注入 runEventStream（见 streamOpts.bridgeSettledToBus 注释）。
      // emit 的 data 与流内 yield 共用同一对象（落库=下发=补桥三口同源，杜绝口径漂移）。
      const bridgeSettledToBus = streamOpts?.bridgeSettledToBus === true
      const emitSettled = (data: TurnSettledBusEvent): void => {
        if (bridgeSettledToBus) this.eventBus?.emitTurnSettled({ ...data, sessionId })
      }
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
        // 2026-11-03 复测修复：turn_settled 此前只 pushTraceEvent（落库），从不 yield 进
        // SSE 流 ⇒ live 摘要永远停在「≈N 积分（预估）」，刷新后重放才见权威值。生成器
        // 尾部结算块可直接 yield（同 turn_ack），落库+下发共用同一 data 对象。
        const settledData = pushTraceEvent('turn_settled', {
          holdId: billingHold.id,
          released: true,
        }).data
        emitSettled(settledData as TurnSettledBusEvent)
        yield { type: 'turn_settled', data: settledData } as AgentStreamEvent
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
                // Epic 1 Task 5：会话归属透传——settle 后 emit 的 credit_tx 经此 sessionId
                // 精准路由到本会话在飞流（C3：仅订阅匹配的流收到，不串会话）。
                sessionId,
                model: billingModelKey,
                ruleVersion: quote.ruleVersion,
                ...(quote.grayReleaseId ? { grayReleaseId: quote.grayReleaseId } : {}),
              } satisfies PointTxMeta,
            )
            holdOpen = false
            const settledData = pushTraceEvent('turn_settled', {
              holdId: billingHold.id,
              credits: settled.settled,
              ruleVersion: quote.ruleVersion,
              // 2026-11-03 结算摘要：模型名随结算下发（turn 摘要静态行「共消耗 N 积分 · 模型名」
              // 数据源）；同回合内 billingModelKey 恒定（回合开始冻结），落库重放还原一致。
              // 键不出现纪律：空值（异常形态）不带键，前端按「无模型名」缺省渲染。
              ...(billingModelKey ? { model: billingModelKey } : {}),
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
            }).data
            emitSettled(settledData as TurnSettledBusEvent)
            yield { type: 'turn_settled', data: settledData } as AgentStreamEvent
            // Epic 1 Task 5：回合结算 credit_tx 已随 settleFromHold 经总线入队，
            // 此处收口下发，确保落在本流结束（done）之前、turn_settled 之后。
            while (creditQueue.length > 0) {
              yield creditQueue.shift() as AgentStreamEvent
            }
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
            const settledData = pushTraceEvent('turn_settled', {
              holdId: billingHold.id,
              released: true,
            }).data
            emitSettled(settledData as TurnSettledBusEvent)
            yield { type: 'turn_settled', data: settledData } as AgentStreamEvent
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
          yield {
            type: 'turn_settled',
            data: pushTraceEvent('turn_settled', { holdId: billingHold.id, released: true }).data,
          } as AgentStreamEvent
        }
      }
    }
    // ── 回合连续性（2026-10-21）：中断轮留下「任务状态」，下一轮模型能看到 ──
    //
    // ⭐ 事故形态（2026-10-21 生产取证）：用户「让他们抱在一起」那轮因故障中断，
    // Nest 侧 AgentMessage 有这条 user 消息，pi 侧 transcript **整轮不存在**；
    // 20 分钟后用户说「继续」，模型上下文里零线索 ⇒ 只能退化成「感知画布猜意图」。
    //
    // 这里在**中断发生的当下**把状态记进 Nest（`AgentThread.turnState`，权威副本），
    // 下一轮装配 prompt 时作为动态块喂给模型 ⇒ **不依赖对话历史是否完好**。
    //
    // ⛔ 不做「继续」关键词识别：那要猜用户意图，在「接着改那个组件」这类表达上立刻失效。
    // ⛔ fail-soft：写不进去只 warn ——「记不住上一轮」是降级，「把用户请求打回去」是事故。
    //
    // ⚠️ `promptAccepted === false` 时**上面那条 catch 分支已经记过一次** ⇒ 此处跳过，
    // 否则同一条 user 消息会记两遍（模型会看到重复的两段说明）。
    if (promptAccepted) {
      await this.recordTurnStateOnInterruption({
        sessionKey,
        userMessage,
        assistantText,
        executionEvents,
        failed: runFailed,
        userAborted: false,
      })
      // ── 批次 3.2：自动续跑（失败不等用户说「继续」）────────────────────
      //
      // ⭐ 放在**记录状态之后**：自动续跑新开的那一轮，装配时会读到本轮
      // 刚记下的 `turnState` ⇒ 那一轮自然吃到「用户要什么 / 做到哪 / 卡在哪」
      // +「不道歉、不复盘」指导语 ⇒ **本处不需要自己造注入内容**。
      //
      // ⛔ 不 await（fire-and-forget）：自动续跑是旁路观察者，
      // 不能拖慢本轮收尾（用户此时可能在等响应）。
      //
      // ⭐ 判据抽成纯函数 `shouldTriggerAutoResume`（含 `turnRole`）——
      // 埋在调用点里会踩坑：`promptAccepted` 在 409（shadow 流）时**仍为 true**
      // ⇒ 只看 promptAccepted 会让 shadow 与 owner **都**触发 ⇒ 双派发。
      if (
        shouldTriggerAutoResume({
          turnRole,
          promptAccepted,
          runFailed,
          userId,
        })
      ) {
        void this.maybeAutoResumeTurn({
          sessionId,
          userId: userId!,
          threadId: effectiveThreadId,
          sessionKey,
          userMessage,
          failed: true,
        })
      }
      // ── 批次 3.1：把「未完成」标到画布节点上（用户直接看得见）────────────
      //
      // ⭐ 走**既有** `update_node` 画布动作 + `finalizeTurn` 的 `canvasActions`
      // 落库通道 ⇒ **零新增落库路径**（节点 status 的写入散落在 80+ 处，
      // 但「标记未完成」只需要这一个写入点）。
      //
      // ⛔ 只在**真失败**时标：用户主动取消 ≠ agent 故障（那是用户的意图，
      // 标成「未完成」会误导）。
      // ⛔ 标不到节点就不标：本轮可能没碰画布（纯聊天）⇒ 宁可不标也不乱标。
      if (runFailed) {
        const incompleteNodeIds = collectIncompleteNodeIds(executionEvents)
        if (incompleteNodeIds.length > 0) {
          for (const action of buildIncompleteNodeActions({
            nodeIds: incompleteNodeIds,
            reason: describeTurnInterruption(
              classifyInterruption({ failed: true, promptAccepted: true }),
            ),
            at: Date.now(),
          })) {
            canvasActions.push(action as unknown as CanvasAction)
          }
          this.piLogger.warn(
            `incomplete_nodes_marked key=${sessionKey} nodes=${incompleteNodeIds.length} ` +
              `ids=${incompleteNodeIds.slice(0, 3).join(',')}`,
          )
        }
      }
    } else {
      // 状态已被消费过（prompt 未被接受 ⇒ 那条消息用户已经看见、也知道失败了）
      // ⇒ 这里不再重复记录。
    }

    // ── 回合连续性：状态消费后清除 ──
    //
    // ⭐ 清除时机 = **本轮成功收尾之后**（不是「注入后立刻清」）：
    // 立刻清的话，若这一轮又失败，状态就没了 ⇒ 用户再说「继续」时又失忆。
    // ⇒ 判据是「问题是否已解决」，不是「是否已展示过」。
    //
    // ⚠️ 只在**成功**时清（`!runFailed`）：失败轮刚写进去的状态必须留着。
    if (promptAccepted && !runFailed) {
      await this.turnState?.clear(sessionKey)
    }

    // ── TURN-IDENTITY P0-2：只有 owner 落库 ──
    // shadow 流（409 并入在跑的 run）到此为止：事件已全程转发给前端（进度可见），
    // 但**不写助手消息**。唯一性最终由 PR2 的 `(threadId, runId)` 唯一索引兜底；
    // 这里先掐掉「同一 run 被 N 条流各记一本账」的源头。
    // D2（Task 2）：断连路径已在上方 finally 里 fire-and-forget 落库并置 turnSettled，
    // 此处互斥跳过，避免整轮落两次。
    if (turnRole === 'owner' && !turnSettled) {
      turnSettled = true
      // 账本完整性：判据是**因果围栏**（是否看到 run 起点），不是内容指纹——
      // 同一句话 5 分钟后重发是合法新回合，用指纹判会把合法回合误标残缺（N5）。
      const capture: LedgerCapture = {
        sawRunStart,
        firstSeq,
        eventCount: traceSeq, // P1c R8：分流后 executionEvents 只存保留集，完整性判据用总推送计数
      }
      const partial = !isLedgerComplete(capture)
      if (partial) {
        this.piLogger.warn(
          `persist_ordinal_gap key=${sessionKey} runId=${turnRunId ?? 'unknown'} gapFrom=${firstSeq ?? 'unknown'} — 本流从半路接入，账本标 partial（不冒充全量）`,
        )
      }
      const digestActions = await this.finalizeTurn(sessionId, effectiveThreadId, userId, assistantText, canvasActions, {
        // Nest internal tools already wrote Session.canvasData; skip re-apply to avoid duplicate add_node
        rewriteCanvasData: false,
        // 退役对齐：老 LangGraph 路径（streamFromRuntime）同样传 deriveLinkedOutputs，
        // pi 路径此前漏了这一项 → 助手消息的「产出」挂件为空。老路径已删，此处补回对等语义。
        linkedOutputs: deriveLinkedOutputs(canvasActions),
        metadata: buildTurnMetadata({
          executionEvents,
          // P1c 写面分流标记：traceSeq > 数组长 ⇒ 本行 executionEvents 是最小兼容集
          eventsShrunk: traceSeq > executionEvents.length,
          ...(partial ? { partial: true, gapFrom: ledgerGapFrom(capture) } : {}),
          // D2（Task 2）：本流结束时**没见到 agent_end** ⇒ 这轮在 Nest 侧是个前缀
          // （pi 侧那轮仍在跑、仍会跑完）⇒ 必须标 truncated，不能冒充全量。
          ...(sawTerminalEvent ? {} : { truncated: true }),
        }),
        runId: turnRunId,
        sawTerminalEvent,
        runStarted: promptAccepted,
      })
      // ── 批次 2：双写对账（发现分叉 + 自愈）────────────────────────────
      //
      // ⭐ 时机 = **本轮收尾后**（不是下一轮开始前）：此刻本轮的 user 消息已落 pi 侧
      // ⇒ 可以比对本轮；且**不阻塞**下一轮的 prompt 发出。
      //
      // ⭐ 比对对象 = **Nest 侧最近一条 user 消息**（本轮的那条）：
      // 本轮收尾时它就是最新的一条 ⇒ 与 pi 侧 tail 的最后一条 user 消息对齐。
      //
      // ⛔ 不 await（fire-and-forget）：对账是**观测 + 自愈**，不是主链路
      // ⇒ 不能拖慢 run 收尾。自愈的状态下一轮被动态块注入（晚一轮，可接受）。
      void this.reconcileHistoryAfterTurn(client, sessionKey, effectiveThreadId)

      // ── Canvas Digest 实时上屏（规格 v1.2 定稿）──
      // 触发已统一下沉到 finalizeTurn（三条收束路径共用的唯一收束点），这里只做
      // 「把落库产生的 actions 转成 SSE 帧」这一件事：只 yield 不 pushTraceEvent，
      // executionEvents 零噪音（刷新重放不重复）；detached 断连与 out-of-turn drain
      // 无流可 yield，落库的 canvasData 由前端刷新恢复。
      for (const action of digestActions) {
        yield { type: 'canvas_action', data: action } as AgentStreamEvent
      }
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
      /**
       * D2（Task 2）：本轮**是否见到权威收束事件**（agent_end）。
       *
       * 为什么要单独传：旧的落库判据是「有内容才落库」（`shouldPersistAssistant`），
       * 而内容只有在 pi 侧 agent_end 前后才齐 ⇒ Nest 侧流提前收尾时
       * 「本流没见到 agent_end」⇒ 内容为空 ⇒ **整轮零记录**（生产实证：618.6s 的 run
       * 在 pi transcript 里 completed、Nest 表里 0 行 ⇒「有执行、无记录」）。
       *
       * ⇒ false 时**仍须落库**：落一条「本轮已执行但 Nest 未见到收束」的行，
       * 让这轮在历史里**可查**（spec D2：「执行完成即应有记录」），
       * 并用 metadata.truncated 显式标注「尾部未捕获」。
       *
       * ⚠️ 键不出现纪律：true（见到 agent_end 或 error）时**不写** truncated。
       */
      sawTerminalEvent?: boolean
      /**
       * D2（Task 2）：本轮**是否真的跑起来了**（prompt 已被 pi 接受）。
       *
       * 判据分工（两者缺一不可）：
       * - `sawTerminalEvent=false` ⇒ Nest 没看到收束（**尾部未捕获**）；
       * - `runStarted=true`        ⇒ pi 侧确实在跑这轮（**不是「从没发生过」**）。
       *
       * 两者皆真 ⇒ 本轮在 pi 侧**确实执行了**，Nest 只是没看全 ⇒ 必须留痕。
       * 只有 `sawTerminalEvent=false` 而 `runStarted=false`（prompt 被拒/未提交）⇒
       * pi 侧整轮不存在 ⇒ 不该造一条假记录。
       */
      runStarted?: boolean
    },
  ): Promise<CanvasAction[]> {
    // ── TURN-IDENTITY PR2：先到先得的唯一性 ──
    // 上游 409 判定（PR1）已挡掉绝大多数重复写者，但**挡不住全部**：断线重连补发、
    // generation-recovery 的 drain、以及任何未来的第三个写者都可能带着同一个
    // runId 走到这里。唯一索引是**最后一道**不变式——不是靠各端默契，而是靠数据库。
    if (opts.runId && (await this.findTurnByRunId(threadId, opts.runId))) {
      this.piLogger.warn(
        `duplicate_turn_persist blocked (thread=${threadId}, runId=${opts.runId}) — 已有 owner 记账，本条 no-op`,
      )
      return []
    }
    // D2（Task 2）：落库判据**不得依赖「本流是否见到了 agent_end」**。
    //
    // 旧判据 = `Boolean(assistantText || presentation || executionEvents.length)`
    // （「有内容才落库」）⇒ 内容只有在 agent_end 前后才齐 ⇒ Nest 侧流提前收尾时
    // 本轮内容为空 ⇒ **整轮零记录**（生产实证：618.6s 的 run 在 pi transcript 里
    // completed，而 Nest 表里 0 行 ⇒「有执行、无记录」，用户永远看不到这轮）。
    //
    // 新判据（三者取或）：
    // 1. 有内容（正文/展示块/执行事件）⇒ 照旧落库；
    // 2. 本流没见到收束（sawTerminalEvent=false）**且**这轮确实跑起来了（runStarted=true）
    //    ⇒ 落一条「本轮已执行但 Nest 未见到收束」的行，让这轮在历史里**可查**
    //    （spec D2：「执行完成即应有记录」），并由 metadata.truncated 标注「尾部未捕获」；
    // 3. 其余（既没内容、又没跑起来）⇒ 不落库（不造假记录）。
    //
    // ⚠️ ②的落库内容是**前缀快照**（本流手上的一切），不是全量 ⇒ 必须可判读，
    // 否则读端会把前缀当完整过程重放（比缺行更糟）。
    const sawTerminalEvent = opts.sawTerminalEvent !== false
    const runStarted = opts.runStarted === true
    const hasContent = Boolean(
      assistantText || opts.metadata?.presentation || opts.metadata?.executionEvents?.length ||
        // P1c 清债：写面分流后 metadata.executionEvents 只剩保留集——「本流见到过事件」
        // 的真值在 eventsShrunk 标记（traceSeq > 保留集长度 ⇒ 分流发生过）。漏判会让
        // 「只见到保留集外事件（tool_call 等）的半路接入回合」整轮不落库（有执行、无记录回归）。
        opts.metadata?.eventsShrunk,
    )
    // 未见到收束但**这轮确实在跑** ⇒ 必须留痕（哪怕本流一个字都没收到：
    // 「Nest 没看到」≠「这轮没发生」，前者是观测缺失，后者是事实缺失）。
    const shouldPersistAssistant = hasContent || (!sawTerminalEvent && runStarted)
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
        // P4-T1：统一取号。⚠️ 重试耗尽后抛出的 P2002 落回下方 catch——那里既有
        // 「runId 已被 owner 记账 = 预期 no-op」语义，seq 持续冲突（单实例下近不可能）
        // 也被同一条路径安静降级，不新增静默成功面。
        await runWithMessageSeq(this.prisma, threadId, (seq) =>
          this.prisma.agentMessage.create({
            data: {
              sessionId,
              threadId,
              role: 'assistant',
              content,
              seq,
              toolCalls: canvasActions.length ? JSON.stringify(canvasActions) : null,
              linkedOutputs: opts.linkedOutputs?.length ? JSON.stringify(opts.linkedOutputs) : null,
              metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
              // 回合身份：落库即成为唯一键的一半（NULL 时唯一索引不生效，等价旧行为）。
              runId: opts.runId ?? null,
            },
          }),
        )
      } catch (err) {
        // 竞态兜底：上面的查存在与这里的 create 之间仍可能被另一条流抢先。
        // 唯一索引是唯一的裁决者——命中即说明 owner 已记账，本条安静 no-op。
        if (isUniqueViolation(err)) {
          this.piLogger.warn(
            `duplicate_turn_persist blocked by unique index (thread=${threadId}, runId=${opts.runId}) — 本条 no-op`,
          )
          return []
        }
        throw err
      }
      await this.prisma.agentThread.update({
        where: { id: threadId },
        data: { updatedAt: new Date() },
      })
    }

    // 返回值 = 本回合系统管道产生的画布动作，供 owner 流转成 SSE 帧实时上屏。
    let digestActions: CanvasAction[] = []
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

      // ── 终态一致性守卫（2026-11-07 事故「产物没落地却回复已完成」）──
      // 只产出 warn 观测：不改用户可见文案、不阻断落库、不依赖模型自律。
      // 真实修复在 pi-runtime 的跨轮 id 绑定；这里保证复发时日志立刻可见。
      // 必须在画布态写完之后读 ⇒ 看到的是本回合最终态。
      await this.warnUnfilledDraftTextNodes(sessionId, canvasActions)

      // ── Canvas Digest：唯一触发源（spec 2026-11-05-canvas-digest-design §5.1 图 1）──
      // finalizeTurn 是既有回合收束的唯一点，三条调用路径在此共用同一管道：
      //   owner 同步 (:3874) / detached 断连 (:3538, void fire-and-forget) /
      //   out-of-turn drain (:595)。⇒ 不再在调用点各处挂 maybeRender，避免
      //   「整文件 stale 覆盖冲掉挂载」与「某条路径漏挂」两类复发。
      // 位置约束：必须在画布实体/画布态写完之后 ⇒ maybeRender 读到最新态；
      // 且只有「无 early return、无抛错」的成功收束才会走到这里（规格图 1）。
      // S7 fail-soft：digest 异常只 warn 并返回空数组，不影响回合收束；
      // detached 的 void 链因此不会 unhandled rejection。
      const digest = this.canvasDigest
      if (digest?.isEnabled()) {
        const digestResult = await digest
          .maybeRender({ sessionId, userId, canvasActions })
          .catch((err: unknown) => {
            this.piLogger?.warn?.(
              `canvas_digest failed (session=${sessionId}): ${err instanceof Error ? err.message : String(err)}`,
            )
            return null
          })
        digestActions = digestResult?.actions ?? []
      }
    }
    return digestActions
  }

  /**
   * 终态一致性守卫（纯判据在 turn-text-node-guard.ts）：
   * 本轮新建的文本节点若收束后仍为 draft + 空正文 ⇒ warn。
   * fail-soft：读库/解析异常一律吞掉，绝不影响回合收束（单测可无 prisma）。
   */
  private async warnUnfilledDraftTextNodes(
    sessionId: string,
    canvasActions: CanvasAction[],
  ): Promise<void> {
    try {
      // 可选链：单测可无 prisma（守卫纯观测，缺依赖时静默跳过，不制造 warn 噪声）。
      const session = await this.prisma?.session?.findUnique?.({
        where: { id: sessionId },
        select: { canvasData: true },
      })
      if (!session?.canvasData) return
      const unfilled = findUnfilledDraftTextNodes(
        JSON.parse(session.canvasData) as CanvasData,
        canvasActions,
      )
      if (unfilled.length > 0) {
        this.piLogger?.warn?.(
          `turn_text_nodes_unfilled session=${sessionId} nodes=${unfilled.join(',')} — 本轮新建文本节点仍为 draft 且无正文，assistant 不应声称已完成`,
        )
      }
    } catch (err) {
      this.piLogger?.warn?.(
        `turn_text_nodes_guard_failed session=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private async persistCanvasEntities(sessionId: string, actions: CanvasAction[]) {
    for (const action of actions) {
      if (action.type !== 'add_node') continue
      const { payload } = action

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
