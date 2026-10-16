<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useAgentMobileLayout } from '@/composables/useAgentMobileLayout'
import { useRouter } from 'vue-router'
import { useAgentStore } from '@/stores/agent'
import { useDockNoticeStore } from '@/stores/dockNotice'
import { useAuthStore } from '@/stores/auth'
import type { SidebarAttachment } from '@lnkpi/shared'
import { normalizeMentionedKeys, SIDEBAR_ATTACHMENT_MAX } from '@lnkpi/shared'
import { apiUrl } from '@/services/api-base'
import { sessionsApi } from '@/services/sessions-api'
import NeoAgentLogo from '@/components/agent/NeoAgentLogo.vue'
import AgentRefStrip from '@/components/agent/AgentRefStrip.vue'
import AgentSelectionBindingChip from '@/components/agent/AgentSelectionBindingChip.vue'
import AgentAssetPicker from '@/components/agent/AgentAssetPicker.vue'
import AgentTaskProgressCard from '@/components/agent/AgentTaskProgressCard.vue'
import AgentCanvasOutputs from '@/components/agent/AgentCanvasOutputs.vue'
import AgentExecutionTrace from '@/components/agent/AgentExecutionTrace.vue'
import AgentTurnTimeline from '@/components/agent/AgentTurnTimeline.vue'
import { isFeatureOn } from '@/composables/useFeatureFlag'
import { resolveMessageOutputs, locatableNodeIds } from '@/components/agent/agentCanvasOutputs'
import { buildTurnReceipt } from './composer/turnReceipt'
import { acceptedHint, parseQueueDelivery } from '@/components/agent/queueDelivery'
import type { AgentStreamMessage } from '@/stores/agent'
import {
  cancelAgentRun,
  cancelledCalloutTextFromProgress,
} from '@/components/agent/cancelAgentRun'
import {
  applyTaskEvent,
  applyPollRecordToTask,
  emptyTaskProgress,
  seedTaskProgressFromEvents,
  type AgentTaskProgressState,
} from '@/components/agent/agentTaskProgress'
import { useGenerationPolling, type GenerationPollTask } from '@/composables/useGenerationPolling'
import { useAgentStream } from '@/composables/useAgentStream'
import {
  reconcileTaskProgress,
  shouldFinishTaskCard,
  synthesizeSummary,
  type CanvasNodeLike,
} from '@/components/agent/taskProgressReconcile'
import {
  pickAssistantForLatestUserTurn,
  shouldApplyReconciledAssistant,
} from '@/components/agent/assistantReconcile'
import AskUserCard from '@/components/agent/AskUserCard.vue'
import AgentPresentationHost from '@/components/agent/presentation/AgentPresentationHost.vue'
import AgentSvgCard from '@/components/agent/presentation/AgentSvgCard.vue'
import AgentNodeGraph from '@/components/agent/presentation/AgentNodeGraph.vue'
import AgentProseBlock from '@/components/agent/presentation/AgentProseBlock.vue'
import { hasSchemeDraftSections, splitAssistantDraftMessage } from '@/components/agent/presentation/schemeDraftProse'
import type { AgentPresentationEnvelope, NodeGraphBodyPayload } from '@/components/agent/presentation/types'
import {
  resolveProposeCancelCallId,
  resolveProposeCancelNodeId,
  resolveProposeConfirmCallId,
} from '@/components/agent/proposeWaitActions'
import {
  isRunCancelledState,
  filterAssistantVisibleText,
  filterUserVisibleText,
} from '@/components/agent/agentInterruptGate'
import { isSystemEventText } from '@/components/agent/systemEventRender'
import {
  buildIdempotencyKey,
  createAgentThreadId,
  persistActiveThreadId,
  resolveBootstrapThreadId,
  checkRuntimeHealthViaNest,
  fetchThreadStateSafe,
  RUNTIME_UNREACHABLE_SNIPPET,
  RECONCILE_MAX_POLLS,
  shouldKeepReconciling,
  shouldInjectUnreachableSnippet,
} from '@/components/agent/streamRecovery'
// 注：shouldPollRuntimeHealth（streamRecovery.ts）已无 SideRail 调用方——P1#11 重连改造后
// 旧 reconcile 唯一消费点被 thread-state 终态判定替代。函数 + 测试保留以备未来手动重连或
// 别处复用；本期只删 SideRail 死 import（I-3 fix）。
import ForceChoiceDialog, { type ForceChoiceKind } from '@/components/agent/ForceChoiceDialog.vue'
import DockGenerateButton from '@/components/canvas/dock-studio/shared/DockGenerateButton.vue'
import DockMicButton from '@/components/canvas/dock-studio/shared/DockMicButton.vue'
import { useSpeechRecognition } from '@/composables/useSpeechRecognition'
import { useSidebarAttachments, assignRefKeysFor, type FocusNodeLike, type CanvasRefAddResult } from '@/composables/useSidebarAttachments'
import { parseRefMentions } from '@/composables/useRefMentions'
import MentionInput, { type MentionOption } from '@/components/canvas/MentionInput.vue'
import { copyTextToClipboard } from '@/utils/copyToClipboard'
import { useClickOutside } from '@/composables/useClickOutside'
import { useProviderBootstrap } from '@/composables/useProviderBootstrap'
import { catalogModelKeyFromValue, supportsThinkingLevel } from '@/constants/studioModels'
import {
  AGENT_SKILLS,
  agentInputPlaceholder,
  getAgentSkill,
} from '@/constants/agentSkillMap'
import { PRODUCT_VISUAL_GUIDANCE } from '@/constants/productVisualCopy'
import {
  buildDraftFromUtterance,
  selectExampleUtterances,
  type CanvasPhase,
  type UtterancePool,
} from './composer/exampleUtterances'
import { levelLabel, THINKING_LEVELS, type ThinkingLevel } from './composer/thinkingLevels'
import { shouldShowModelChip } from './composer/modelSkillDedup'
import { barShape, classifyGesture, COMPOSER_HOLD_MS } from './composer/mobileBarLayout'
import UniversalModelSelector from '@/components/canvas/UniversalModelSelector.vue'
import CanvasRefTargetIcon from '@/components/shared/CanvasRefTargetIcon.vue'
import { useCanvasRefPickMode } from '@/composables/useCanvasRefPickMode'
import { formatDuration as formatTraceDuration } from '@/components/agent/executionStepLabels'
import { hasFailedTraceStep, turnSettledText, turnSummaryLine } from '@/components/agent/executionTraceReducer'
import { formatSessionTime, lastThreadStorageKey } from '@/utils/formatSessionTime'
import { randomId } from '@/utils/randomId'
import { submitAnswers } from '@/components/agent/agentAnswers'
import { failureReason, resolveWaiting, turnStatusLine } from '@/components/agent/turnStatusBar'
import { hasBubbleContent, hasBubbleText } from '@/components/agent/bubbleVisibility'
import {
  describeActivity,
  describeRuntimeActivity,
} from '@/components/agent/activityLine'
import { buildStatusLine } from '@/components/agent/composer/statusLine'
import { ElMessage } from 'element-plus'

interface AgentThreadRow {
  id: string
  title: string
  updatedAt: string
  createdAt: string
}

const props = defineProps<{
  sessionId: string
  /** 当前登录用户非画布所有者时为 true，禁止 Agent 写入画布 */
  readOnly?: boolean
  /** W30: 画布选中节点 id，配合「快速生成」走单节点路径 */
  selectedNodeId?: string | null
  /**
   * SEL-REF：指代信号——本轮画布选中的节点 id 集合（单选与框选统一走这里）。
   * 框选优先（CanvasPage 侧表达式已处理优先级）；空/缺省 ⇒ 本轮无指代信号。
   */
  selectedNodeIds?: string[]
  /** M2: 选中节点数据，发送时升格为 canvasNode attachment */
  selectedNode?: { id: string; type?: string; data?: Record<string, unknown> } | null
  /** Phase 2c.1: canvas nodes for pending_confirm SSOT chip recover */
  canvasNodes?: CanvasNodeLike[] | null
  canOpen?: () => boolean
}>()

const emit = defineEmits<{
  canvasActions: [actions: unknown[]]
  /** Agent 一轮结束后由画布从服务端回拉 SoT，避免本地旧图覆盖 Nest 拆图结果 */
  turnComplete: []
  focusNode: [nodeId: string]
  focusAll: [nodeIds: string[]]
  exportPack: [nodeIds: string[], exportMode?: 'full_package' | 'lightweight']
  undo: []
  redo: []
  openImageEditor: [nodeId: string]
  expandedChange: [expanded: boolean]
  /** 切换画布引用 Pick 模式（由 CanvasPage 处理选中 seed） */
  canvasRefPickToggle: []
  /** Phase 2b: confirm propose_generation → dock generateForNode(nodeId) */
  generateNode: [nodeId: string]
  /** Phase 2b: cancel propose → clear pending_confirm on canvas node */
  clearProposeGeneration: [nodeId: string]
  /**
   * L2（2026-10-06）：propose 等待开始，把本地画布节点同步成 pending_confirm。
   *
   * 等待期 `update_node{pending_confirm}` 还没随 tool result 下发，本地是 stale draft；
   * 任何 saveCanvas 都会用它整份覆盖 SSOT 的待确认 ⇒ runtime 误判「用户取消」。
   */
  proposeWaitStart: [nodeId: string]
  /** P0-C（2026-10-13）：propose 等待结束——CanvasPage 解除 PUT 载荷强制声明 */
  proposeWaitEnd: []
  /** arrange_nodes 工具：agent 触发自动排列（grid / along_edges），CanvasPage 应用布局 */
  arrangeNodes: [payload: { nodeIds: string[]; mode: 'grid' | 'along_edges'; gap: number; edges?: { source: string; target: string }[] }]
  /** 「导入到画布」：建成结构化节点组（由 CanvasPage 写 SSOT）。 */
  importNodeGraph: [payload: import('@/components/agent/presentation/AgentNodeGraph.vue').GraphPayload]
}>()

const pickMode = useCanvasRefPickMode()
const pickModeActive = pickMode.active
const { isMobileLayout } = useAgentMobileLayout()

const panelTeleported = computed(() => floating.value || isMobileLayout.value)
const asidePanelWidth = computed(() => {
  if (!open.value || floating.value || isMobileLayout.value) return '0px'
  return `${panelWidth.value}px`
})

const agent = useAgentStore()
const auth = useAuthStore()
const router = useRouter()
const input = ref('')
/**
 * 流式中的插话槽位（2026-10-02 重写：从「单槽字符串 + 流结束补发」改成**三态意图槽**）。
 *
 * 老实现的两个动作名不符实：「⚡ 打断并发送」实际是 `abort`+新开一轮，「等流结束再发」实际是
 * 延迟新开一轮 —— 都不是 pi-agent 的 steering / followUp。现在两者分别是 vendor 队列里
 * **同一条消息的两个送达时机**（`lane.ts:1456-1460` 两者构造的消息完全一致）：
 *   - `steer`    → run 内下一个 turn 边界接住（`drive/boundary.ts:85-89`）：不中断、事件流不断
 *   - `followup` → 本轮收尾边界接住（`boundary.ts:106`）：不打扰，人可以先走开
 * ⚠️ 二者**互斥**——同一次边界里已有 steer 时 followUp 会被跳过（消息留 inbox 等下一次
 * accept），所以 UI 上是二选一、不是可叠加的两勾。
 *
 * 槽位默认**挂着等用户点**（不做自动派发）：steer 与 followUp 是两种截然不同的送达时机，
 * 替用户默认选一次就可能把「想走开」的消息插进正在跑的那轮。
 */
type QueueIntent = 'steer' | 'followup'
/**
 * pending = 等你点（不自动派发）；accepted = 已入队、agent 还没开口；
 * applied = agent **已经开口/动手**了（确定性事件触发，见 QUEUE_APPLIED_EVENTS）；
 * failed = 入队失败，文字保留在槽位里。
 *
 * ⚠️ accepted / applied 都不再自动收起（原「accepted 2.6s 后自动收」是错的）：
 * agent 从入队到第一次吐字常是 20~40s（中间还在跑工具），这期间 UI 若是空的，
 * 用户会以为消息丢了。「agent 正在解读我的补充」这句话本来就不需要模型复述 ——
 * 一个事件就够，比赌模型自觉可靠得多。收起交给用户（气泡上有「知道了」）。
 */
type QueueState = 'pending' | 'accepted' | 'applied' | 'failed'
interface QueuedSlot {
  text: string
  intent: QueueIntent | null // pending 态尚未决定走哪条通道
  state: QueueState
  /** 成功/失败原因，直接显示在气泡上，不做 toast（流式中弹窗会打断阅读） */
  hint: string
}
const queued = ref<QueuedSlot | null>(null)
/**
 * 「agent 已经接住」的确定性事件（2026-10-02）。
 *
 * 作用是替掉原先那段 system prompt 约定（"你必须先复述…再动工具"）——那段每轮常驻、是概率行为、
 * 而且模型照样可能一声不吭直接跳工具。这里只要这四种事件任一到达，就说明 agent 已经在这条消息上
 * 产出内容了，气泡从「已入队」推进到「已接住」。收到第一个 text_delta 之前那段空白期（20~40s，
 * 中间还在跑工具）正是用户最需要「它没丢」的时候。
 */
const QUEUE_APPLIED_EVENTS = new Set(['thinking', 'text_delta', 'tool_call', 'activity'])
function markQueueApplied() {
  if (!queued.value || queued.value.state !== 'accepted') return
  queued.value.state = 'applied'
  queued.value.hint = '已接住 · agent 正在处理你的补充'
}
/** 已发送用户消息的就地二次编辑：正在编辑的消息 id */
const editingMessageId = ref<string | null>(null)
const editingDraft = ref('')
const composerRef = ref<InstanceType<typeof MentionInput> | null>(null)

// PR1「让 Agent 诊断」：诊断抽屉按钮写入预填文案后，这里消费并落到 composer（不自动发送，
// 等用户显式点发送表达意图）。与既有 mention/插话槽位同款预填模式（见下方 insertText）。
watch(
  () => agent.pendingDiagnosticText,
  (text) => {
    if (!text) return
    input.value = text
    agent.consumePendingDiagnosticText()
    nextTick(() => composerRef.value?.focus())
  },
)
const fileInputRef = ref<HTMLInputElement | null>(null)
const chatContainer = ref<HTMLElement>()
const sidebar = useSidebarAttachments()
const isUploading = ref(false)
const isDragOver = ref(false)
const assetPickerOpen = ref(false)
const attachMenuOpen = ref(false)
const attachMenuRef = ref<HTMLElement | null>(null)
useClickOutside(attachMenuRef, () => {
  attachMenuOpen.value = false
})

/**
 * SEL-REF：给回执 chip 用的节点摘要。
 * 标题取法沿用仓内既有约定（`executionStepLabels.ts:43` / `agentCanvasOutputs.ts:167`）：
 * `data.title ?? data.prompt`，都没有则空串（chip 会显示「未知」类型 + 空标题）。
 */
const canvasNodesForBinding = computed(() =>
  (props.canvasNodes ?? []).map((n) => ({
    id: n.id,
    type: String((n as { type?: string }).type ?? '未知'),
    title: String(n.data?.title ?? n.data?.prompt ?? ''),
  })),
)

function makeAttachmentItems(
  attachments: SidebarAttachment[] | undefined,
  refKeys: string[] | undefined,
) {
  const list = attachments ?? []
  const keys = refKeys?.length === list.length ? refKeys : assignRefKeysFor(list)
  return list.map((attachment, index) => ({
    attachment,
    refKey: keys[index] ?? attachment.id,
  }))
}

function clearComposer() {
  input.value = ''
  sidebar.clear()
}

function reattachFromHistory(attachment: SidebarAttachment) {
  if (sidebar.pendingAttachments.value.length >= SIDEBAR_ATTACHMENT_MAX) {
    ElMessage.warning(`最多 ${SIDEBAR_ATTACHMENT_MAX} 个引用`)
    return
  }
  dismissHistoryReattachCoachmark()
  sidebar.addFromPayload({ ...attachment, id: randomId() })
  const keys = sidebar.assignRefKeys()
  const idx = sidebar.pendingAttachments.value.length - 1
  if (keys[idx]) insertRefMention(keys[idx])
  nextTick(() => composerRef.value?.focus())
}

const HISTORY_REATTACH_HINT_KEY = 'agent-history-reattach-hint'
const historyReattachHintSeen = ref(false)

onMounted(() => {
  try {
    historyReattachHintSeen.value = localStorage.getItem(HISTORY_REATTACH_HINT_KEY) === '1'
  } catch {
    historyReattachHintSeen.value = false
  }
})

function dismissHistoryReattachCoachmark() {
  historyReattachHintSeen.value = true
  try {
    localStorage.setItem(HISTORY_REATTACH_HINT_KEY, '1')
  } catch {
    /* ignore quota / private mode */
  }
}

function visibleAssistantContent(msg: AgentStreamMessage): string {
  if (msg.role !== 'assistant') return msg.content ?? ''
  return filterAssistantVisibleText(msg.content ?? '')
}

function visibleUserContent(msg: AgentStreamMessage): string {
  if (msg.role !== 'user') return msg.content ?? ''
  return filterUserVisibleText(msg.content ?? '')
}

/** 宿主回注的系统事件消息（spec §6.4，PR3）：前缀判据唯一实现在 systemEventRender.ts。 */
function isUserSystemEvent(msg: AgentStreamMessage): boolean {
  return msg.role === 'user' && isSystemEventText(msg.content ?? '')
}

/** 带着可渲染 svg_card 的消息：`body.svg` 收窄为 `string`（非 `string | undefined`）。 */
type SvgCardMessage = AgentStreamMessage & {
  presentation: AgentPresentationEnvelope & { body: { svg: string } }
}

/**
 * 该轮是否带着一张可渲染的 svg_card（spec §4.6）。
 *
 * **门禁与挂载点共用的唯一判据**：气泡放行（`shouldShowMessageBubbleText`）与模板
 * `v-if` 都调它，两处因此不可能漂移。改条件只改这一处。
 *
 * 写成类型谓词（`msg is SvgCardMessage`）而非 `boolean`：挂载点的 `:svg` 绑定需要
 * `body.svg` 已收窄为 `string`，判据一旦抽成函数，模板内的自动收窄就不会再生效。
 *
 * ⚠️ 判据用 `!== undefined` 而非真值，与 switch 分支同因：服务端超 SVG_MAX_CHARS 时
 * 下发 `svg: ""`（字段在、值为空），那张卡有专属的「已丢弃」可见文案，必须照样上屏。
 */
function hasRenderableSvgCard(msg: AgentStreamMessage): msg is SvgCardMessage {
  return msg.role === 'assistant'
    && msg.presentation?.kind === 'svg_card'
    && msg.presentation.body?.svg !== undefined
}

/** 带着可渲染 `node_graph` 的消息（结构化载荷，Vue Flow 渲染）。 */
type NodeGraphMessage = AgentStreamMessage & {
  presentation: AgentPresentationEnvelope & { kind: 'node_graph' }
}

/**
 * 有 node_graph 的助手轮次（2026-07）。
 *
 * ⚠️ **A 方案：node_graph 优先、svg_card 降级**（重放侧见 `stores/agent.ts` 的 `??` 左偏）。
 * 这里只判"有没有"，两条都在时由模板 `v-if` / `v-else-if` 的顺序决定优先级。
 */
function hasRenderableNodeGraph(msg: AgentStreamMessage): msg is NodeGraphMessage {
  return msg.role === 'assistant'
    && msg.presentation?.kind === 'node_graph'
    && Array.isArray((msg.presentation.body as { graph_nodes?: unknown } | undefined)?.graph_nodes)
}

type NodeGraphPayload = import('@/components/agent/presentation/AgentNodeGraph.vue').GraphPayload

/**
 * 把消息里的 node_graph 载荷取出来，供 expand / import 两个 emit 用。
 *
 * ⚠️ `graph_nodes` 在共享 body 类型里是 `NodeGraphBodyPayload['nodes']`
 *   （不是 `unknown[]`）—— 这里只需把可能为 `undefined` 的字段兜成空数组。
 */
function nodeGraphPayload(msg: AgentStreamMessage): NodeGraphPayload {
  const body = msg.presentation?.body
  return {
    nodes: body?.graph_nodes ?? [],
    edges: body?.graph_edges ?? [],
    title: body?.nodeGraphTitle ?? msg.presentation?.title,
  }
}

/**
 * P0 决策 2：零内容不渲染气泡（判定在 bubbleVisibility.ts，纯函数可单测）。
 * 阻塞等待期不产生 token，旧实现「流式恒 true」会留下一个空白气泡 + 闪烁光标 = 白块。
 *
 * ⚠️ 例外仅一处：带着可渲染 svg_card 的助手轮次。卡片区（含 AgentSvgCard）整体位于本
 * 门禁的 `v-if` 内，而 svg_card 可能是那一轮的**全部**产出（agent 只调 render_canvas_view
 * 而不说话）——不放行就等于卡片静默不可见（PR #65 同类失效）。
 * 例外只认「有卡片」，无卡片仍走 hasBubbleContent ⇒ P0 白块修复不受影响。
 */
function shouldShowMessageBubbleText(msg: AgentStreamMessage): boolean {
  // ⚠️ node_graph 与 svg_card 同为「卡片即全部产出」的情形（agent 只调 render_canvas_view 不说话）
  //   ⇒ 两者都要放行，否则卡片静默不可见（PR #65 同类失效）。
  return hasBubbleContent(msg) || hasRenderableSvgCard(msg) || hasRenderableNodeGraph(msg)
}

/**
 * 方案草稿散文（有结构化小节时改用 AgentProseBlock 排版）。
 * 2026-10-06：原「产品视觉 V2 开关 + 草稿小节」双条件随门控一起下线，
 * 现在只按结构化小节判定 —— 与方案卡片无关，是纯排版选择。
 */
function shouldRenderSchemeDraftProse(msg: AgentStreamMessage): boolean {
  if (msg.role !== 'assistant' || msg.streaming) return false
  const { prose } = splitAssistantDraftMessage(msg.content ?? '')
  return hasSchemeDraftSections(prose)
}

function canReuseTurn(msg: AgentStreamMessage): boolean {
  if (msg.role !== 'user') return false
  return Boolean(msg.content?.trim()) || (msg.attachments?.length ?? 0) > 0
}

async function reattachTurnFromHistory(msg: AgentStreamMessage) {
  if (props.readOnly || !canReuseTurn(msg)) return

  dismissHistoryReattachCoachmark()
  sidebar.clear()

  const items = makeAttachmentItems(msg.attachments, msg.attachmentRefKeys)
  for (const { attachment } of items) {
    if (sidebar.pendingAttachments.value.length >= SIDEBAR_ATTACHMENT_MAX) {
      ElMessage.warning(`最多 ${SIDEBAR_ATTACHMENT_MAX} 个引用，已跳过其余项`)
      break
    }
    sidebar.addFromPayload({ ...attachment, id: randomId() })
  }

  sidebar.assignRefKeys()

  const original = (msg.content ?? '').trim()
  if (original) {
    // 保留原始 @ 提及与提示词顺序；避免 insertText 与 v-model 竞态导致只剩引用
    input.value = original
  } else {
    const keys = sidebar.assignRefKeys()
    input.value = keys.map((key) => `@${key}`).join(' ')
  }

  await nextTick()
  composerRef.value?.focus()
  ElMessage.success('已复用本轮提示词与引用')
}

const messageFeedback = ref<Record<string, 'up' | 'down'>>({})
const copiedMessageId = ref<string | null>(null)
let copiedMessageTimer: number | null = null

function canShowMessageActions(msg: AgentStreamMessage): boolean {
  if (msg.role !== 'assistant' || msg.streaming) return false
  if (isLiveTurnMessage(msg) && (agent.isStreaming || showTaskCard.value)) return false
  return Boolean(
    visibleAssistantContent(msg).trim()
    || (assistantOutputsById.value.get(msg.id)?.length ?? 0) > 0
    || msg.executionTrace
    || msg.presentation,
  )
}

function toggleMessageFeedback(msgId: string, vote: 'up' | 'down') {
  if (messageFeedback.value[msgId] === vote) {
    const next = { ...messageFeedback.value }
    delete next[msgId]
    messageFeedback.value = next
    return
  }
  messageFeedback.value = { ...messageFeedback.value, [msgId]: vote }
}

async function copyAssistantMessage(msg: AgentStreamMessage) {
  const text = visibleAssistantContent(msg).trim()
  if (!text) return
  try {
    await copyTextToClipboard(text)
    copiedMessageId.value = msg.id
    if (copiedMessageTimer !== null) window.clearTimeout(copiedMessageTimer)
    copiedMessageTimer = window.setTimeout(() => {
      if (copiedMessageId.value === msg.id) copiedMessageId.value = null
      copiedMessageTimer = null
    }, 1600)
  } catch {
    ElMessage.error('复制失败')
  }
}

/** 已发送用户消息是否展示操作（编辑/复制）。与 assistant 的反馈操作互斥。 */
function canShowUserMessageActions(msg: AgentStreamMessage): boolean {
  return msg.role === 'user' && !msg.streaming && !props.readOnly
}

async function copyUserMessage(msg: AgentStreamMessage) {
  const text = visibleUserContent(msg).trim()
  if (!text) return
  try {
    await copyTextToClipboard(text)
    copiedMessageId.value = msg.id
    if (copiedMessageTimer !== null) window.clearTimeout(copiedMessageTimer)
    copiedMessageTimer = window.setTimeout(() => {
      if (copiedMessageId.value === msg.id) copiedMessageId.value = null
      copiedMessageTimer = null
    }, 1600)
  } catch {
    ElMessage.error('复制失败')
  }
}

function editUserMessage(msg: AgentStreamMessage) {
  editingMessageId.value = msg.id
  editingDraft.value = visibleUserContent(msg)
}

function cancelEditUserMessage() {
  editingMessageId.value = null
  editingDraft.value = ''
}

/**
 * 该条用户消息是否正处于**就地二次编辑**态。
 *
 * 为什么需要它（2026-10-12 用户口径）：编辑卡原先只是气泡里的一个 `v-else-if` 分支，
 * 而气泡中该消息的**静态展示**是并列的兄弟节点，编辑时照旧渲染 —— 于是同一段话
 * 出现两遍（一次在 textarea，一次是下方的历史正文），下面还挂着 编辑/复制/复用本轮
 * 三个对编辑态无意义的图标按钮，把二次编辑卡本身淹没掉。
 *
 * 当前退场范围：**历史正文** + **操作行**（正是用户点名的两块）。
 * 引用条（`AgentRefStrip`）与指代回执（`AgentSelectionBindingChip`）本次刻意保留 ——
 * 它们承载「这条消息当时带了哪些素材 / 指代了哪些节点」的既成事实，不是编辑内容的重复。
 *
 * 2026-10-12 二次口径（同一张卡片）：它同时是气泡壳的宽度开关 ——
 * 见 `.agent-bubble-user--editing`。展示态靠 max-width + 内容撑满，编辑态内容更窄会被
 * shrink-to-fit 收窄，两态外形对不上；故编辑态显式取满同宽（88%）。
 *
 * 取消编辑即原样恢复（本函数只做渲染门禁，不改 `editingDraft` / 消息数据）。
 */
function isMessageUnderEdit(msg: AgentStreamMessage): boolean {
  return msg.role === 'user' && editingMessageId.value === msg.id
}

/**
 * 已发送用户消息二次编辑 → 从此处重新开始对话（抄 WorkBuddy）。
 * 本地丢弃该消息之后的所有消息，并把该消息内容更新为编辑稿后重新发送；已有产物保留。
 *
 * ③ 重跑：同时把该消息的 pi `entryId` 作为 `branchFromEntryId` 下发 —— 后端据此 fork
 * 出「截断到该消息之前」的新分支线程（真实截断，旧尾不再进模型上下文），前端收到
 * `thread_forked` 后切换到新 threadId，做到前后端一致。
 *
 * 兜底：若该消息还没拿到 entryId（例如刷新后恢复的历史消息，事件早已流走），
 * 则退化为普通发送（不带 branchFromEntryId）—— 不静默伪造切点，后端照常 append。
 */
async function sendEditedUserMessage(msg: AgentStreamMessage) {
  const draft = editingDraft.value.trim()
  if (!draft) return
  const idx = agent.messages.findIndex((m) => m.id === msg.id)
  if (idx >= 0) {
    const target = agent.messages[idx]
    if (target && 'content' in target) target.content = draft
    agent.messages.splice(idx + 1)
  }
  editingMessageId.value = null
  editingDraft.value = ''
  // 目标消息已被本地丢弃，但它的 entryId 要作为 fork 切点保留下来
  const targetEntryId = msg.entryId
  await sendMessage(draft, targetEntryId)
}

const threadHasReattachableHistory = computed(() =>
  agent.messages.some((msg) => canReuseTurn(msg)),
)

const showHistoryReattachCoachmark = computed(
  () => !props.readOnly && !historyReattachHintSeen.value && threadHasReattachableHistory.value,
)

const showComposerReattachHint = computed(
  () =>
    !props.readOnly
    && pendingAttachmentItems.value.length === 0
    && !input.value.trim()
    && threadHasReattachableHistory.value,
)

const pendingAttachmentItems = computed(() =>
  makeAttachmentItems(sidebar.pendingAttachments.value, sidebar.assignRefKeys()),
)

/** 输入框左上角 🎯 圆心重合时的文字起始内边距（半径 + 小间距） */
const COMPOSER_PICK_INSET = 18

/** ◎ 空闲态（P1-2.3）：无草稿文本且未在流式生成 —— composer 的第一屏/空态 */
const isIdle = computed(() => input.value.trim() === '' && !agent.isStreaming)
/** ◎ mention 菜单开态（P1-2.3）：取 MentionInput expose 的真实 showMenu（defineExpose 的 ref 保持响应式） */
const mentionMenuOpen = computed(() => composerRef.value?.showMenu === true)
/** ◎ 可见性门控（P1-2.3）：空态隐藏；输入/生成态可见；空态键入 @ 打开 mention 菜单时立即显示 */
const canvasRefEntryVisible = computed(() => !props.readOnly && (!isIdle.value || mentionMenuOpen.value))

const mentionOptions = computed((): MentionOption[] =>
  pendingAttachmentItems.value.map(({ refKey, attachment }) => ({
    id: attachment.id,
    label: refKey,
    type: attachment.mediaType,
  })),
)

function insertRefMention(refKey: string) {
  const token = `@${refKey} `
  composerRef.value?.insertText(input.value ? ` ${token}` : token)
  nextTick(() => composerRef.value?.focus())
}

/** Runtime LangGraph thread；与画布 sessionId 解耦，新建对话时重置 */
const agentThreadId = ref(createAgentThreadId(props.sessionId))
const taskProgress = ref<AgentTaskProgressState>(emptyTaskProgress())
const showTaskCard = computed(() => taskProgress.value.items.length > 0)

/**
 * composer 上沿同一时刻只允许挂一层：有待发气泡时任务卡让位，排队发出后自动回来。
 * ⚠️ 这里只管「卡片是否渲染」；`showTaskCard`（本轮是否有任务）仍被 isLiveTurnMessage /
 * canShowMessageActions 用来判定「本轮是否活跃」，不能被排队状态带偏，否则会在排队期间
 * 把本轮消息的操作按钮提前放出来。
 */
const showTaskCardAtComposer = computed(() => showTaskCard.value && !queued.value)

const lastAssistantMessageId = computed(() =>
  [...agent.messages].reverse().find((m) => m.role === 'assistant')?.id,
)

function isLiveTurnMessage(msg: AgentStreamMessage): boolean {
  if (msg.role !== 'assistant') return false
  if (msg.id !== lastAssistantMessageId.value) return false
  return Boolean(msg.streaming) || Boolean(msg.executionTrace) || showTaskCard.value
}

/**
 * P0 决策 1：活体过程的归属 —— 本轮活跃时钉在 composer 上方（R2），
 * 回合收束（无流式 + 无任务卡）后沉降回气泡末尾（R1 折叠区）。
 * ⚠️ 同一个判定必须同时用在「钉底渲染」和「气泡内渲染」两处：
 * 否则收束那一瞬间过程卡会在两处各渲染一份。
 */
const liveTrace = computed(() => {
  const last = [...agent.messages].reverse().find((m) => m.role === 'assistant')
  if (!last?.executionTrace) return null
  const active = agent.isStreaming || showTaskCard.value || Boolean(last.streaming)
  return active ? last.executionTrace : null
})

function canvasOutputsForMessage(msg: AgentStreamMessage) {
  return resolveMessageOutputs({
    linkedOutputs: msg.linkedOutputs,
    canvasActions: msg.canvasActions,
    traceSteps: msg.executionTrace?.steps,
    taskItems: isLiveTurnMessage(msg) ? taskProgress.value.items : undefined,
    isLiveTurn: isLiveTurnMessage(msg),
  })
}

/**
 * P0（agent-turn-timeline-design §5 P0-4）：回合摘要行（节点/张数/耗时/tokens）。
 * 仅在本回合**已结束**（非 streaming）且确有 trace 时给出，供模板在产物之后渲染。
 * 旧实现把该行写死在 AgentExecutionTrace 组件内（ul 之后），而 trace 又排在正文/产物之前，
 * 导致「回合末才算出的统计行」永远压在产物之上；现独立渲染、落在时间线最末（产物之后）。
 */
function bubbleSummaryLine(msg: AgentStreamMessage): string | null {
  if (msg.role !== 'assistant' || msg.streaming || !msg.executionTrace) return null
  return turnSummaryLine(msg.executionTrace)
}

/**
 * P1（agent-turn-timeline-design §5-P1）：TurnTimeline 灰度开关。默认 off（useFeatureFlag）。
 * off 时气泡仍走旧 trace + 独立正文 + 独立产物，零行为变化；on 时由 AgentTurnTimeline
 * 一个组件承接 thinking/text/tool/canvas/artifact/notice，取代上述三处拼装。
 */
const turnTimelineOn = computed(() => isFeatureOn('turn_timeline'))
/** 该条 assistant 消息是否用时间线渲染（flag on 且确有 timeline）。 */
function useTimeline(msg: AgentStreamMessage): boolean {
  return turnTimelineOn.value && msg.role === 'assistant' && Boolean(msg.timeline)
}

/**
 * P2-2：活体时间线。与 `liveTrace`（旧 trace 钉底）**同判定**——本轮活跃时钉在 composer 上方，
 * 回合收束后由气泡内的 AgentTurnTimeline 接管。flag on 时用同一组件 + dense 变体渲染，
 * 消除「live dense trace vs history 气泡」两套渲染造成的布局跳变（设计 §3 现象 5）。
 * 判定必须与 liveTrace 完全一致，否则收束瞬间会在两处各渲染一份。
 */
const liveTimeline = computed(() => {
  if (!turnTimelineOn.value) return null
  const last = [...agent.messages].reverse().find((m) => m.role === 'assistant')
  if (!last?.timeline) return null
  const active = agent.isStreaming || showTaskCard.value || Boolean(last.streaming)
  return active ? last.timeline : null
})

/**
 * P2-2 修复（2026-10-14 生产实证）：钉底期间气泡内 `useTimeline(msg)` 仍对**同一条**
 * live 消息成立 ⇒ 同一回合渲染两份（截图复盘：气泡内一份 + pinned 一份）。
 * 设计注释（上）早有警告「同一判定必须用在两处」，旧 trace 气泡实例有 `!liveTrace`
 * 防线，新时间线的气泡实例漏配。此处给出钉底消息 id，供气泡内渲染按消息级互斥
 * （只抑制钉住那一条，历史消息的内联时间线不受影响）；收束后 liveTimeline 归 null，
 * 气泡内接管 —— 与设计「收束后由气泡内组件接管」闭环。
 */
const liveTimelineMessageId = computed<string | null>(() => {
  if (!liveTimeline.value) return null
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const m = agent.messages[i]
    if (m && m.role === 'assistant') return m.id
  }
  return null
})

/** P2-2：活体时间线的定位/重试接线（复用既有画布能力与节点生成 emit）。 */
function onLiveTimelineRetry(nodeId: string) {
  if (nodeId) emit('generateNode', nodeId)
}

const assistantOutputsById = computed(() => {
  const map = new Map<string, ReturnType<typeof canvasOutputsForMessage>>()
  for (const msg of agent.messages) {
    if (msg.role === 'assistant') {
      map.set(msg.id, canvasOutputsForMessage(msg))
    }
  }
  return map
})
const forceChoiceOpen = ref(false)
const forceChoiceKind = ref<ForceChoiceKind | null>(null)

/**
 * P1-4.1：回合产出收据行（消息流末尾、产出卡片之后；composer 侧入口，不重构消息渲染本体）。
 *
 * 数据源（best-effort 口径，记录于此）：与该轮 AgentCanvasOutputs 产出卡片**同源** ——
 * 最后一条 assistant 消息经 resolveMessageOutputs 解析出的产物数，即 producedCount。
 * 不另造统计通道，避免与卡片各说各话。
 *
 * 显隐：仅当回合已收束（非 streaming）且该轮确有产物时出现；
 * 末条不是收束的 assistant 消息（如用户刚发言）不显示，收据只贴最近一轮。
 * ⚠️ 不用 showTaskCard 做隐藏门（review round 1 F1）：taskProgress.items 在回合收束时
 * **不会清空**（只在下次发送/切会话/loadHistory/新会话时清），发过 task 事件的轮次
 * showTaskCard 会一直为 true，用它当门会让这些轮次的收据永远不出现。
 * 收据与任务进度卡并存是可接受的（模板上收据渲染在其后）。
 */
const TURN_UNDO_DISABLED_TITLE = '需 runtime 批量移除工具，见 ADR'

const lastTurnReceipt = computed(() => {
  if (agent.isStreaming) return null
  const last = agent.messages[agent.messages.length - 1]
  if (!last || last.role !== 'assistant' || last.streaming) return null
  const outputs = assistantOutputsById.value.get(last.id) ?? []
  if (outputs.length === 0) return null
  return {
    ...buildTurnReceipt({ producedCount: outputs.length }),
    /** 与 AgentCanvasOutputs 的「定位全部」同口径：只带可定位（done/failed）的节点。 */
    focusNodeIds: locatableNodeIds(outputs),
  }
})

/** summary 去掉尾部「定位到画布」后的前缀；动作词由模板单独渲染成 focus-all 按钮。 */
const lastTurnReceiptLead = computed(() =>
  lastTurnReceipt.value ? lastTurnReceipt.value.summary.replace(' · 定位到画布', '') : '',
)

function onReceiptFocusAll() {
  // review round 1 F2：无可定位节点时早退，避免向 CanvasPage 派发空 focus-all
  // 触发「当前画布中没有找到对应节点」的误导 toast（对齐 AgentCanvasOutputs 的空集纪律）。
  if (!lastTurnReceipt.value || lastTurnReceipt.value.focusNodeIds.length === 0) return
  onFocusAll(lastTurnReceipt.value.focusNodeIds)
}

const taskRecordPolling = useGenerationPolling((results) => {
  for (const { task, record } of results) {
    taskProgress.value = applyPollRecordToTask(
      taskProgress.value,
      task.nodeId,
      record.status,
    )
  }
})

function startTaskRecordPoll(tasks: GenerationPollTask[]) {
  if (!tasks.length) return
  taskRecordPolling.start(tasks)
}

function pollTasksFromProgress() {
  const tasks: GenerationPollTask[] = []
  for (const it of taskProgress.value.items) {
    if (it.recordId && it.nodeId) {
      tasks.push({ recordId: it.recordId, nodeId: it.nodeId })
    }
  }
  startTaskRecordPoll(tasks)
}

let streamAbortController: AbortController | null = null
const runCancelled = ref(false)
const threadRunState = ref<{ phase?: string | null; runCancelled?: boolean | null } | null>(null)
const cancelledPresentation = ref<AgentPresentationEnvelope | null>(null)
/** Progress line built from the cancel API response, before the checkpoint refresh lands. */
const cancelledProgressText = ref<string | null>(null)
const reconnecting = ref(false)
const recoveredPhaseHint = ref<string | null>(null)

const agentStream = useAgentStream({
  onStale: () => {
    streamAbortController?.abort()
  },
})

const lastAssistantMessage = computed(() =>
  [...agent.messages].reverse().find((m) => m.role === 'assistant'),
)

/* ---- P1 回合状态行：实时秒数 ticker + waiting 收口 + 失败态 ---- */
const nowSec = ref(Date.now())
let statusTicker: number | null = null
watch(
  () => agent.isStreaming,
  (streaming) => {
    if (streaming) {
      nowSec.value = Date.now()
      if (statusTicker === null) {
        statusTicker = window.setInterval(() => {
          nowSec.value = Date.now()
        }, 1000)
      }
    } else if (statusTicker !== null) {
      window.clearInterval(statusTicker)
      statusTicker = null
    }
  },
  { immediate: true },
)
onUnmounted(() => {
  if (statusTicker !== null) window.clearInterval(statusTicker)
})

const turnStatus = computed(() => {
  const waiting = resolveWaiting({
    isStreaming: agent.isStreaming,
    proposePendingConfirm: agent.proposePendingConfirm,
    // 阻塞等待一票通过：等待开始的信号由后端 waiting_user 事件下发
    // （tool_result 要等等待结束才到，靠它反推「等待中」在本语义下恒不成立）
    blockingWait: agent.blockingWait,
  })
  const lastFailed = agent.turnError != null ? failureReason(agent.turnError) : undefined
  // 「正在做什么」：优先 runtime 下发的 activity（P1 决策 8）；当前轮没有则拿 trace 最新一步人话；
  // 都拿不到时 turnStatusLine 内部降级为「处理中」，绝不把内部工具名吐给用户（决策 3 / 5）。
  // runtime activity 更实时（工具起手即到），拿不到才回落到 trace 最新一步的人话
  const traceActivity =
    describeRuntimeActivity(agent.activity) ??
    describeActivity(lastAssistantMessage.value?.executionTrace?.steps)
  return turnStatusLine({
    isStreaming: agent.isStreaming,
    turnStartedAt: lastAssistantMessage.value?.executionTrace?.turnStartedAt,
    now: nowSec.value,
    waiting,
    // P2：恢复中显示「会话恢复中」而非「上游响应超时」（waiting 优先级更高，见 turnStatusBar）
    recovering: agent.recovering,
    waitingTool: agent.blockingWait?.toolName ?? null,
    waitingQuestion: agent.blockingWait?.question ?? null,
    waitingDeadline: agent.blockingWait?.deadlineAt ?? null,
    activity: traceActivity,
    // Q2：本回合实时预估积分（usage_delta 逐段覆盖；null 时状态行不拼预估尾巴）
    estimatedCredits: agent.liveEstimatedCredits,
    lastFailed,
    // P2 T7：settled 收口态——文案与气泡摘要共用 reducer turnSettledText（单源），
    // 状态行只切 mode（'settled'），不复制文案。failed 优先（error 路径 released 显示失败原因）。
    settledText: turnSettledText(lastAssistantMessage.value?.executionTrace),
  })
})
/**
 * P1-3.1：composer 生成中状态行（composer-status-line）数据模型。
 * 数据源全部复用现状，**不新增 store 状态**：
 * - phase：执行轨迹聚合的「正在做什么」人话（runtime activity 优先，回落 trace 最新一步；
 *   与 turnStatus 同源，决策 3/5：绝不把内部工具名吐给用户）。
 * - progress / eta：现链路只有已耗时（turnStartedAt→elapsed），无「完成比例 / 剩余时长」
 *   数据源 → 传 null：进度条走不确定态、ETA 段隐藏（成本未知 → 隐藏而非置零）。
 * - points：Q2 liveEstimatedCredits（usage_delta 实时预估，#415 口径，回合结束清位）；
 *   ≤0 / 缺失视为成本未知 → null 隐藏。
 */
const composerStatus = computed(() =>
  buildStatusLine({
    phase:
      describeRuntimeActivity(agent.activity) ??
      describeActivity(lastAssistantMessage.value?.executionTrace?.steps),
    progressRatio: null,
    etaSeconds: null,
    points:
      agent.liveEstimatedCredits != null && agent.liveEstimatedCredits > 0
        ? agent.liveEstimatedCredits
        : null,
  }),
)
const composerProgressPct = computed(() =>
  composerStatus.value.progress == null
    ? null
    : `${Math.round(composerStatus.value.progress * 100)}%`,
)
/**
 * 阻塞等待 propose_generation（2026-10-01）：确认动作只存在于画布节点，
 * 聊天侧必须明示「去哪确认 + 一键定位」，否则用户只看到转圈无从下手。
 */
const proposeWait = computed(() =>
  agent.blockingWait?.toolName === 'propose_generation' ? agent.blockingWait : null,
)
// RB-D6②：本轮存在 failed 步骤 ⇒ dock 确认区持久警示（把红色 ✗ 与确认决策连起来）。
const turnHasFailedStep = computed(() => hasFailedTraceStep(lastAssistantMessage.value?.executionTrace?.steps))
// P0-C（2026-10-13 事故 cmv51vwpu0008p801hxaxcf8m）：等待结束信号。
// CanvasPage 在等待期对 PUT 载荷强制声明 pending_confirm（防 stale 全量盖写 SSOT），
// 等待结束必须解除，否则确认启动后的 generating/completed 会被倒灌回待确认。
watch(proposeWait, (w, prev) => {
  if (prev && !w) emit('proposeWaitEnd')
})
function locateProposeNode() {
  const nodeId = proposeWait.value?.nodeId
  if (nodeId) onFocusNode(nodeId)
}

/**
 * 琥珀卡取消（2026-10-01；2026-10-06 接显式 decline）：只拒绝该节点的生成提议
 * （clear-propose → 节点回 draft，run 恢复继续对话）；绝不是中止整个 run —— 那是
 * composer「停止」的语义。等待期流式守卫刻意不设（与 locateProposeNode 一致）。
 *
 * 2026-10-06 加的这半根线（生产事故 cmus6ha64001dk601lzsymqfa 第二处）：取消此前**只**
 * 写 Nest SSOT，工具侧靠 SSOT 时序推断「用户拒绝」；把文案中性化以后用户真按了取消，
 * 模型反而不知道，回「请你在画布节点上点一下确认」。现在先显式 `decline`
 * （registry → aborted ⇒ tool result reason=aborted），再清画布 SSOT；
 * 前者失败不阻断后者（轮询兜底仍在，且画布状态必须收敛）。
 */
async function cancelBlockingPropose() {
  const nodeId = resolveProposeCancelNodeId(agent.blockingWait)
  if (!nodeId) return
  const callId = resolveProposeCancelCallId(agent.blockingWait)
  if (callId) {
    try {
      await submitAnswers(
        {
          threadId: agentThreadId.value,
          sessionId: props.sessionId,
          callId,
          answers: {},
          decision: 'decline',
        },
        answersPost,
      )
    } catch {
      // 幂等端点：失败说明网络/鉴权异常，画布侧仍要收敛（轮询兜底会判 rejected）
    }
  }
  emit('clearProposeGeneration', nodeId)
}

/**
 * L1 显式确认（2026-10-06）：画布/dock 点生成时，把 propose 等待以 registry
 * **answered** 收口——runtime 侧 answered 即 confirmed（canvas-write.ts），
 * 因此确认不再依赖「SSOT 状态被正确写入」这条时序链。
 *
 * 返回是否真的发出确认（false = 当前没有该节点的 propose 等待，调用方走原路径）。
 * 失败不阻断画布生成：轮询兜底仍在，最坏退回修复前的行为。
 */
async function confirmProposeWait(nodeId: string): Promise<boolean> {
  const callId = resolveProposeConfirmCallId(agent.blockingWait, nodeId)
  if (!callId) return false
  try {
    await submitAnswers(
      { threadId: agentThreadId.value, sessionId: props.sessionId, callId, answers: {} },
      answersPost,
    )
    return true
  } catch {
    return false
  }
}

const showCancelledCallout = computed(
  () => isRunCancelledState(threadRunState.value) || runCancelled.value,
)
const cancelledCalloutText = computed(() => {
  const text =
    String(cancelledPresentation.value?.body?.text ?? '').trim() ||
    (cancelledProgressText.value ?? '')
  return text || '当前任务已停止，你可以发起新任务或直接输入新的需求。'
})
/** ask_user 阻塞卡（B-6）：生命周期绑定 pending 状态，不再随新 user message 清空（提交/取消才清）。
 * callId 是卡片级提交依据（Task 2 payload），同卡多问题共享同一 callId，逐元素携带便于恢复/拦截取用。 */
const pendingAskUser = ref<Array<{ callId: string; id: string; question: string; options: { label: string; value: string }[]; multiSelect?: boolean; allowOther?: boolean }>>([])
/** 卡片只挂在最后一轮 assistant 回复之后（对话流内，不在消息列表顶部）；用户发新消息后自动隐藏。 */
const lastMessageIsAssistant = computed(() => {
  const msgs = agent.messages
  const last = msgs[msgs.length - 1]
  return !!last && last.role === 'assistant'
})

/**
 * 2026-10-15（三滚动条治理 2/2）：`hasDockPresentation`（dock 展示态 → dock 外层限高滚动）
 * 已随结构一并删除——live 态对话内容（live 时间线 / proposeWait / ask 卡 / 取消提示）
 * 移回 `.agent-chat-scroll` 主滚动流，dock 只留 composer，不再存在第二个滚动上下文。
 * 2026-10-14 的「历史滑不动」问题（dock 内容撑高 shrink-0 压扁 flex-1 滚动区）在流内
 * 结构下不复存在：所有对话内容都在 flex-1 的滚动区里，内容再长也只是让滚动区变长。
 * 唯一保留的内嵌滚动是 dense 态时间线卡片自身（用户口径「思考消息流自带滚动条」），
 * 见 `.agent-turn-timeline--dense` / `.agent-trace--dense` 的限高规则。
 */

/** 组件侧回答回传：payload 组装收敛在 agentAnswers 模块（含明文 HTTP 降级）。 */
function answersPost(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ ok: boolean; json: () => Promise<unknown> }> {
  return fetch(apiUrl(url), { ...init, headers: { ...init.headers, ...authHeaders() } })
}

async function onAskSubmit(payload: { answers: Record<string, string[]>; skipped?: string[] }) {
  const callId = pendingAskUser.value[0]?.callId
  const snapshot = pendingAskUser.value
  pendingAskUser.value = [] // 先清卡防双击双发（幂等端点兜底，但 UI 及时收敛）
  if (!callId) {
    // blocking off 旧路径（Task 2 契约：无 callId 卡片回填为下一轮 user message）——
    // 答案值拼回文本复用 sendMessage，零新建回流；answers 为空（skip）= 用户放弃作答，
    // v1 语义与 cancel 同义，补发「取消」防模型永远等不到信号（final fix I-2）
    const text = Object.values(payload.answers).flat().map((v) => v.trim()).filter(Boolean).join(' ')
    await sendMessage(text || '取消')
    return
  }
  try {
    const result = await submitAnswers({
      threadId: agentThreadId.value,
      sessionId: props.sessionId,
      callId,
      answers: payload.answers,
    }, answersPost)
    if (result.deduped) {
      // 迟到回答（callId 已 settle，如刷新恢复出的卡片）：spec §5.2 降级为普通
      // user message 走新 turn，不得静默吞掉用户答案（final fix I-1）
      const text = Object.values(payload.answers).flat().map((v) => v.trim()).filter(Boolean).join(' ')
      if (text) await sendMessage(text)
    }
  } catch {
    pendingAskUser.value = snapshot // 失败恢复卡（幂等端点保证重试安全）
    ElMessage.error('提交失败，请重试')
  }
}
async function onAskCancel() {
  // 阻塞卡 cancel = 以「全部跳过」语义 resolve 阻塞 pending（空 answers = 全部 skipped；
  // registry answer 即 resolve，工具层 skipped 推导自然生效，模型看到「用户未作答」后续行）。
  // 否则 pending 仍挂着：超时窗口内自由文本走正常消息会撞 409（fix round 1 Finding 2）。
  // 与 onAskSubmit 同模式：先 snapshot 防双击双发，失败恢复卡（幂等端点重试安全）。
  const snapshot = pendingAskUser.value
  const callId = snapshot[0]?.callId
  pendingAskUser.value = []
  if (!callId) {
    // 无 callId 的 v1 卡：对齐 base 行为清卡后发「取消」，模型才能收到放弃信号（final fix I-2）
    void sendMessage('取消')
    return
  }
  try {
    const result = await submitAnswers({
      threadId: agentThreadId.value,
      sessionId: props.sessionId,
      callId,
      answers: {},
    }, answersPost)
    if (result.deduped) return // cancel 空 answers 迟到 = pending 已被别的路径收口，仅收起不发消息（final fix I-1）
  } catch {
    pendingAskUser.value = snapshot
    ElMessage.error('提交失败，请重试')
  }
}
function historyPresentation(msg: AgentStreamMessage): AgentPresentationEnvelope | null {
  if (msg.role !== 'assistant' || msg.streaming || !msg.presentation) return null
  // svg_card 走独立挂载（紧邻本函数调用点的 AgentSvgCard），不进 Host 的 stepper 布局：
  // 落库重放路径不恢复 stepper，进了只会渲染一条空进度条。spec §4.6。
  if (msg.presentation.kind === 'svg_card') return null
  return msg.presentation
}

function historyMacroSelectedIds(presentation: AgentPresentationEnvelope): string[] {
  const schemes = presentation.body?.schemes ?? []
  const recommended = schemes.filter((s) => s.recommended).map((s) => String(s.id))
  if (recommended.length) return recommended
  const maxSelect = presentation.body?.max_select ?? 2
  return schemes.slice(0, maxSelect).map((s) => String(s.id))
}

const canSubmitComposer = computed(() =>
  Boolean(input.value.trim() || sidebar.pendingAttachments.value.length),
)

function openFilePicker() {
  if (!props.readOnly && !isUploading.value) {
    fileInputRef.value?.click()
  }
}

function addAssetReference(attachment: SidebarAttachment) {
  if (props.readOnly) return
  sidebar.addFromPayload(attachment)
}

function addAttachment(attachment: SidebarAttachment) {
  if (props.readOnly) return
  sidebar.addFromPayload({ ...attachment, id: randomId() })
}

function setComposerInput(text: string) {
  input.value = text
  nextTick(() => composerRef.value?.focus())
}

function toggleAttachMenu() {
  if (props.readOnly || isUploading.value) return
  attachMenuOpen.value = !attachMenuOpen.value
}

function pickLocalUpload() {
  attachMenuOpen.value = false
  openFilePicker()
}

function pickAssetLibrary() {
  attachMenuOpen.value = false
  assetPickerOpen.value = true
}

/** ◎ P1-2.3：pick 开关（原 onCanvasRefPickToggle 改名），全文件唯一调用点是角落按钮 composer-canvas-ref-btn */
function toggleCanvasRefPick() {
  emit('canvasRefPickToggle')
}

/** dock 指针入口：pickMode 失活（既有）。移动端条级手势（onBarPointerDown）绑在
 *  composer-bare-bar 自身，不再走 dock 入口（P1-5 三态共条重构）。 */
function onInputDockPointerDown(event: PointerEvent) {
  if (!pickMode.active.value) return
  const target = event.target as Element
  if (target.closest('.composer-canvas-ref-btn')) return
  if (target.closest('.agent-attach-menu')) return
  pickMode.deactivate()
}

async function addFiles(files: FileList | File[]) {
  if (props.readOnly || !files.length) return

  isUploading.value = true
  try {
    for (const file of Array.from(files)) {
      await sidebar.addFromFile(file)
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '上传参考素材失败')
  } finally {
    isUploading.value = false
  }
}

function onFileChange(event: Event) {
  const target = event.target as HTMLInputElement
  void addFiles(target.files ?? []).finally(() => {
    target.value = ''
  })
}

function onDragOver() {
  if (!props.readOnly) isDragOver.value = true
}

function onDragLeave() {
  isDragOver.value = false
}

function onDrop(event: DragEvent) {
  isDragOver.value = false
  void addFiles(event.dataTransfer?.files ?? [])
}

/** 面板是否展开（收缩态只保留右下角 logo FAB） */
const open = ref(false)
/** 浮动窗口模式：面板脱离侧栏，悬浮在画布上，可拖拽 */
const floating = ref(false)

/**
 * 移动端（P1-5）：底部裸条**常驻**——画布始终露出且可点（无 sheet / 无遮罩），
 * composer 不再是「打开的面板」，所以移动端恒 open（fab 随之退役，见模板）。
 * immediate：isMobileLayout 初值在 setup 阶段即由 matchMedia 同步给出。
 */
watch(isMobileLayout, (mobile) => {
  if (mobile) {
    floating.value = false
    open.value = true
  }
}, { immediate: true })

/* ---- 宽度：默认可容纳 dock 底部参数一排，支持拖拉调宽 ---- */
const PANEL_MIN_W = 420
const PANEL_MAX_W = 760
const PANEL_DEFAULT_W = 500
const panelWidth = ref(PANEL_DEFAULT_W)
const resizing = ref(false)

/* ---- 浮窗位置 / 尺寸 ---- */
const floatPos = ref({ x: 0, y: 0 })
const floatWidth = ref(PANEL_DEFAULT_W)
const dragging = ref(false)

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max)
}

const speech = useSpeechRecognition()

const { preferences, load: loadProviderBootstrap } = useProviderBootstrap()
const planningModel = ref(preferences.value?.defaultTextModel ?? '')
/** PI 链路深度思考：默认关，Dock 可开（与文本节点对齐）。
 * 可见条件必须与 pi-runtime 的能力判定同源（shared `supportsThinkingLevel`）——
 * 否则会出现「开关能开、但 pi 侧 model.reasoning=false 被强制降级为 off」的假象。 */
const planningThinking = ref(false)
const planningThinkingEffort = ref<'high' | 'max'>('high')
const showPlanningThinkingControls = computed(() =>
  supportsThinkingLevel(catalogModelKeyFromValue(planningModel.value || '')),
)

watch(showPlanningThinkingControls, (show) => {
  if (!show) {
    planningThinking.value = false
  }
})

function setPlanningThinking(enabled: boolean) {
  planningThinking.value = enabled
  if (!enabled) return
  if (planningThinkingEffort.value !== 'high' && planningThinkingEffort.value !== 'max') {
    planningThinkingEffort.value = 'high'
  }
}

function setPlanningThinkingEffort(effort: 'high' | 'max') {
  planningThinkingEffort.value = effort
  planningThinking.value = true
}

/* P1-2.1：思考档位三档（标准/深入/极限）写回原状态通道：标准→关、深入→high、极限→max。
 * B 级 chip 仅非默认档常驻（裁决 fix-1）；默认档经 C 抽屉「思考档位」入口进入同一 popover。ghost 无背景。 */
const thinkingMenuOpen = ref(false)
const thinkingMenuRef = ref<HTMLElement | null>(null)
useClickOutside(thinkingMenuRef, () => {
  thinkingMenuOpen.value = false
})

function toggleThinkingMenu() {
  thinkingMenuOpen.value = !thinkingMenuOpen.value
}

const currentThinkingLevel = computed<ThinkingLevel>(() => {
  if (!planningThinking.value) return '标准'
  return planningThinkingEffort.value === 'max' ? '极限' : '深入'
})

function setPlanningThinkingLevel(level: ThinkingLevel) {
  thinkingMenuOpen.value = false
  if (level === '标准') {
    setPlanningThinking(false)
    return
  }
  setPlanningThinkingEffort(level === '极限' ? 'max' : 'high')
}

/* ---- 技能选择（显式 Skill；默认自动 / 平台路由） ---- */
const activeSkillId = ref<string | null>(null)
const activeSkill = computed(() => getAgentSkill(activeSkillId.value))
const isProductVisualSkill = computed(() => activeSkillId.value === 'product-visual')
const skillButtonLabel = computed(() => activeSkill.value?.label ?? '技能')
const inputPlaceholder = computed(() =>
  agentInputPlaceholder(activeSkill.value),
)
const showProductVisualEmptyState = computed(
  () =>
    isProductVisualSkill.value
    && !props.readOnly
    && !agent.messages.some((m) => m.role === 'user'),
)
const showProductVisualAttachmentHint = computed(
  () => isProductVisualSkill.value && !props.readOnly,
)
const skillMenuOpen = ref(false)
const skillMenuRef = ref<HTMLElement | null>(null)
useClickOutside(skillMenuRef, () => {
  skillMenuOpen.value = false
})

/* ---- 对话 thread 列表 ---- */
const historyOpen = ref(false)
const historyRef = ref<HTMLElement | null>(null)
const threads = ref<AgentThreadRow[]>([])
useClickOutside(historyRef, () => {
  historyOpen.value = false
})

async function fetchThreads(): Promise<AgentThreadRow[]> {
  try {
    const res = await fetch(
      apiUrl(`/api/agent/chat/threads?sessionId=${encodeURIComponent(props.sessionId)}`),
    )
    const json = await res.json()
    const rows = (json.data ?? []) as AgentThreadRow[]
    threads.value = rows
    return rows
  } catch {
    return []
  }
}

async function toggleHistoryOpen() {
  historyOpen.value = !historyOpen.value
  if (historyOpen.value) {
    await fetchThreads()
  }
}

async function selectThread(threadId: string) {
  if (threadId === agentThreadId.value) {
    historyOpen.value = false
    return
  }
  clearComposer()
  agentThreadId.value = threadId
  persistActiveThreadId(props.sessionId, threadId)
  historyOpen.value = false
  taskProgress.value = emptyTaskProgress()
  runCancelled.value = false
  threadRunState.value = null
  cancelledPresentation.value = null
  cancelledProgressText.value = null
  recoveredPhaseHint.value = null
  await loadHistory()
  void refreshThreadCheckpoint()
}

async function bootstrapThread() {
  clearComposer()
  agent.clear()
  taskProgress.value = emptyTaskProgress()
  const cached = localStorage.getItem(lastThreadStorageKey(props.sessionId))
  const list = await fetchThreads()
  agentThreadId.value = await resolveBootstrapThreadId(props.sessionId, {
    cachedThreadId: cached,
    threads: list,
    messageCountFor: async (threadId) => {
      try {
        const res = await fetch(
          apiUrl(
            `/api/agent/chat/user/messages?sessionId=${encodeURIComponent(props.sessionId)}&threadId=${encodeURIComponent(threadId)}`,
          ),
        )
        const json = await res.json()
        return Array.isArray(json.data) ? json.data.length : 0
      } catch {
        return 0
      }
    },
  })
  persistActiveThreadId(props.sessionId, agentThreadId.value)
  await loadHistory()
  void refreshThreadCheckpoint()
  scrollToBottom(true)
}

onMounted(() => {
  void bootstrapThread()
  void loadProviderBootstrap().then(() => {
    if (!planningModel.value && preferences.value?.defaultTextModel) {
      planningModel.value = preferences.value.defaultTextModel
    }
  })
})

watch(
  () => props.sessionId,
  () => {
    taskProgress.value = emptyTaskProgress()
    runCancelled.value = false
    threadRunState.value = null
    cancelledPresentation.value = null
    cancelledProgressText.value = null
    recoveredPhaseHint.value = null
    void bootstrapThread()
  },
)

function openPanel() {
  if (props.canOpen && !props.canOpen()) return
  if (isMobileLayout.value) floating.value = false
  open.value = true
  emit('expandedChange', true)
  scrollToBottom(true)
}

function closePanel() {
  // P1-5：移动端裸条常驻、无「收起」形态（fab 已退役），closePanel 仅桌面有意义
  if (isMobileLayout.value) return
  open.value = false
  emit('expandedChange', false)
}

function onFocusNode(nodeId: string) {
  emit('focusNode', nodeId)
}

// ── 执行过程折叠状态（2026-10-07 修「打开后没法收起」）──────────────────
// ⚠️ 之前 `AgentExecutionTrace` 的展开态只活在子组件本地 ref，而 reducer 每次写
//   `trace.collapsed`（流式过程反复写）都会经 watch 把它拉回 ⇒ 用户刚展开就被收起。
//   现在**父级持有真相**，子组件只 emit 意图。
//   状态按消息 id 存，避免流式重写 trace 时丢状态；缺省 collapsed=true（保持 v1 默认折叠）。
const traceCollapsed = ref<Record<string, boolean>>({})

type TraceCarrier = { id?: string; executionTrace?: { collapsed?: boolean } }

function historyTraceCollapsed(msg: TraceCarrier): boolean {
  const id = msg?.id
  const fallback = msg?.executionTrace?.collapsed ?? true
  if (!id) return fallback
  return traceCollapsed.value[id] ?? fallback
}

function onToggleTrace(msg: { id?: string }, collapsed: boolean) {
  if (!msg?.id) return
  traceCollapsed.value = { ...traceCollapsed.value, [msg.id]: collapsed }
}

/** 本轮活体trace 的折叠态：与历史同源，但只存一份（本轮只有一个）。 */
const liveTraceCollapsed = ref(true)

function onToggleLiveTrace(collapsed: boolean) {
  liveTraceCollapsed.value = collapsed
}

function onFocusAll(nodeIds: string[]) {
  emit('focusAll', nodeIds)
}

function onExportPack(
  nodeIds: string[],
  exportMode: 'full_package' | 'lightweight' = 'full_package',
) {
  emit('exportPack', nodeIds, exportMode)
}

function toggleFloating() {
  if (isMobileLayout.value) return
  floating.value = !floating.value
  if (floating.value) {
    // 首次浮出时把面板放到画布右侧默认位置
    floatWidth.value = clamp(panelWidth.value, PANEL_MIN_W, window.innerWidth - 48)
    floatPos.value = {
      x: Math.max(16, window.innerWidth - floatWidth.value - 40),
      y: 56,
    }
  }
}

/* ---- 浮窗拖拽（按住头部空白处移动） ---- */
function startDrag(event: MouseEvent) {
  if (!floating.value || isMobileLayout.value) return
  if ((event.target as HTMLElement).closest('button, input, textarea')) return
  event.preventDefault()
  dragging.value = true
  const offsetX = event.clientX - floatPos.value.x
  const offsetY = event.clientY - floatPos.value.y
  const onMove = (ev: MouseEvent) => {
    floatPos.value = {
      x: clamp(ev.clientX - offsetX, -floatWidth.value + 120, window.innerWidth - 120),
      y: clamp(ev.clientY - offsetY, 0, window.innerHeight - 64),
    }
  }
  const onUp = () => {
    dragging.value = false
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

/* ---- 左边缘拖拉调宽（侧栏 / 浮窗通用） ---- */
function startResize(event: MouseEvent) {
  if (isMobileLayout.value) return
  event.preventDefault()
  resizing.value = true
  const floatRight = floatPos.value.x + floatWidth.value
  const onMove = (ev: MouseEvent) => {
    if (floating.value) {
      const width = clamp(floatRight - ev.clientX, PANEL_MIN_W, PANEL_MAX_W)
      floatWidth.value = width
      floatPos.value = { ...floatPos.value, x: floatRight - width }
    } else {
      panelWidth.value = clamp(window.innerWidth - ev.clientX, PANEL_MIN_W, PANEL_MAX_W)
    }
  }
  const onUp = () => {
    resizing.value = false
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

function newAgentSession() {
  clearComposer()
  agent.clear()
  taskProgress.value = emptyTaskProgress()
  runCancelled.value = false
  threadRunState.value = null
  cancelledPresentation.value = null
  cancelledProgressText.value = null
  recoveredPhaseHint.value = null
  agentThreadId.value = createAgentThreadId(props.sessionId)
  persistActiveThreadId(props.sessionId, agentThreadId.value)
  ElMessage.info('已新建对话')
  // 新会话：列表清空，跟随状态一并复位（否则会卡在「回看历史」态）
  followLatest.value = true
  hasNewBelow.value = false
}

function syncCancelledFromThreadState(
  state:
    | {
        phase?: string | null
        runCancelled?: boolean | null
        presentation?: AgentPresentationEnvelope | null
      }
    | null
    | undefined,
): boolean {
  threadRunState.value = state
    ? { phase: state.phase ?? null, runCancelled: state.runCancelled ?? null }
    : null
  const cancelled = isRunCancelledState(state)
  if (cancelled) {
    cancelledPresentation.value = state?.presentation ?? null
  } else if (!runCancelled.value) {
    // A gate-preserved stop leaves the checkpoint uncancelled; keep the local callout.
    cancelledPresentation.value = null
    cancelledProgressText.value = null
  }
  return cancelled
}

/**
 * 重连时拉一次 thread-state（`GET /api/agent/thread-state`，Nest 侧 `getThreadState`
 * **恒返 null** —— 老 LangGraph checkpoint 随 runtime 2026-09-27 退役一起消失）。
 *
 * 保留这次调用是刻意的：端点仍在（删掉会让前端 404），返回恒空 ⇒ 只可能同步
 * 「运行已停止」这一项；原先把 `productVisualPlan` / `shotManifest` / `macroSchemes` /
 * gate 相位等一堆 LangGraph 时代的门控状态从这里回灌的分支，已随门控 UI 一起删除
 * （2026-10-06）。
 */
async function refreshThreadCheckpoint() {
  try {
    const token = localStorage.getItem('token')
    const res = await fetch(
      apiUrl(`/api/agent/thread-state?threadId=${encodeURIComponent(agentThreadId.value)}`),
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const json = (await res.json()) as {
      data?: {
        phase?: string | null
        runCancelled?: boolean | null
        presentation?: AgentPresentationEnvelope | null
      } | null
    }
    syncCancelledFromThreadState(json.data)
  } catch {
    // ignore — checkpoint hint is best-effort
  }
}

/** P1#5/#7：assistant message metadata JSON 安全解析（畸形返回 undefined）。 */
function parseMessageMetadataSafe(raw?: string): { executionEvents?: Array<{ type: string; data: unknown }> } | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as { executionEvents?: Array<{ type: string; data: unknown }> }
  } catch {
    return undefined
  }
}

/** P1#6 缩略图 url 源：canvasNodes 按 nodeId 查 url。 */
function resolveCanvasNodeUrl(nodeId: string): string | undefined {
  const node = props.canvasNodes?.find((n) => n.id === nodeId)
  const url = (node?.data as { url?: string } | undefined)?.url
  return typeof url === 'string' && url ? url : undefined
}

async function loadHistory() {
  agent.clear()
  taskProgress.value = emptyTaskProgress()
  try {
    const res = await fetch(
      apiUrl(
        `/api/agent/chat/user/messages?sessionId=${encodeURIComponent(props.sessionId)}&threadId=${encodeURIComponent(agentThreadId.value)}`,
      ),
    )
    if (!res.ok) {
      ElMessage.warning('对话历史加载失败，请检查网络后刷新')
      return
    }
    const json = await res.json()
    if (json.data?.length) {
      agent.loadHistory(json.data)
      // P1#5：最后一回合若有 task 事件（plan 标记派生），恢复任务卡进度
      const msgs = json.data as Array<{ role: string; metadata?: string }>
      const lastAssistantMsg = [...msgs].reverse().find((m) => m.role === 'assistant')
      const meta = parseMessageMetadataSafe(lastAssistantMsg?.metadata)
      const seeded = seedTaskProgressFromEvents(meta?.executionEvents ?? [])
      if (seeded) taskProgress.value = seeded
      // P1#7：最后一回合若有未答 ask_user 且之后无用户消息，恢复待答卡
      // B-6：callId 随 metadata.executionEvents 落盘（agent.service 提取 cmd 整体入列），恢复时回填提交依据
      const lastAssistantIdx = msgs.map((m) => m.role).lastIndexOf('assistant')
      const hasUserAfter = msgs.slice(lastAssistantIdx + 1).some((m) => m.role === 'user')
      const askCmd = (meta?.executionEvents ?? [])
        .filter((e) => e.type === 'canvas_command')
        .map((e) => e.data as { type?: string; callId?: string; questions?: Array<Omit<(typeof pendingAskUser.value)[number], 'callId'>> })
        .find((c) => c.type === 'ask_user' && c.questions?.length)
      if (askCmd && !hasUserAfter) {
        pendingAskUser.value = askCmd.questions!.map((q) => ({ ...q, callId: askCmd.callId ?? '' }))
      }
    }
  } catch {
    ElMessage.warning('对话历史加载失败，请检查网络后刷新')
  }
  scrollToBottom(true)
}

function toggleVoice() {
  if (speech.listening.value) {
    speech.stop()
    return
  }
  speech.start((text, isFinal) => {
    if (isFinal) {
      input.value = input.value ? `${input.value} ${text}` : text
    }
  })
}

/* ---- 移动端裸条状态（P1-5，2026-10-16 三态共条重构） ----
 * 旧「收缩/伸展 + 长按卡片录音」形态随全屏 sheet 一并退役（Task 13 会按
 * onComposerHold 发射点重接 ASR，录音 UI（agent-composer-rec）保留为接线目标）。
 * 桌面端不受影响，仍走 DockMicButton 的 toggleVoice。 */
const composerExpanded = ref(false)
const holdActive = ref(false)
const voiceInterim = ref('')
const voiceFinalText = ref('')
const voiceCancelled = ref(false)
const voiceElapsedSec = ref(0)
const composerDockRef = ref<HTMLElement | null>(null)

// 输入框被程序填充（如待发消息取回）时自动进入伸展态
watch(input, (v) => {
  if (isMobileLayout.value && v.trim()) composerExpanded.value = true
})

function onComposerFocusIn() {
  if (isMobileLayout.value) composerExpanded.value = true
}

function onComposerFocusOut(e: FocusEvent) {
  if (!isMobileLayout.value) return
  const next = e.relatedTarget as Node | null
  if (next && composerDockRef.value?.contains(next)) return // 焦点仍在卡内（如点模型菜单）
  // 延迟收起：给「聚焦丢失但有交互意图」的场景留窗口；有内容则保持伸展
  window.setTimeout(() => {
    if (!input.value.trim() && !holdActive.value) composerExpanded.value = false
  }, 150)
}

/* ---- P1-5 移动端裸条三态（barShape 单源路由） ----
 * idle：条内仅 ＋ + 「按住说话 · 点按输入」提示（P1-5.3）；stacked/queued 见 mobileBarLayout.ts。
 * 伸展态（点按后）在 barShape 上仍属 idle 形态（无芯片、非生成），但渲染输入行。 */
const mobileBarShape = computed(() =>
  barShape({ hasRefs: pendingAttachmentItems.value.length > 0, isStreaming: agent.isStreaming }),
)
const mobileBarIdle = computed(
  () =>
    isMobileLayout.value &&
    mobileBarShape.value === 'idle' &&
    !composerExpanded.value &&
    !holdActive.value,
)

/* ---- P1-5.3 条级手势：点按=切输入态，按住 ≥300ms=onComposerHold（Task 13 接语音）。
 * 判据（P1-5.3）：子控件（＋/◎/模型/发送）命中一律不触发条手势——pointerdown/up 都用
 * closest 排除按钮命中，且子控件 click 均 .stop。 */
let barHoldTimer: number | null = null
let barGestureStartAt = 0

/** 按住说话发射点：Task 13 在此接 ASR（录音时长/电平/上滑取消复用 agent-composer-rec UI）。
 * 当前为空实现发射点（brief 指定）， hold 尚不产生任何副作用。 */
function onComposerHold() {
  /* Task 13（P2-2.2）接线点：beginHoldTalk / releaseVoice 逻辑见 git 历史 */
}

function onBarGestureOnChild(e: PointerEvent): boolean {
  const target = e.target as HTMLElement | null
  return !!target?.closest('button, a, [role="button"], input, textarea')
}

function onBarPointerDown(e: PointerEvent) {
  if (!mobileBarIdle.value || props.readOnly) return
  if (onBarGestureOnChild(e)) return
  barGestureStartAt = Date.now()
  barHoldTimer = window.setTimeout(() => {
    barHoldTimer = null
    onComposerHold()
  }, COMPOSER_HOLD_MS)
}

function onBarPointerUp(e: PointerEvent) {
  if (barHoldTimer === null) return // hold 已触发或非空闲态按下
  window.clearTimeout(barHoldTimer)
  barHoldTimer = null
  if (onBarGestureOnChild(e)) return
  // 未达 hold 阈值 = 点按 → 切输入态并聚焦（classifyGesture 为 Task 13 的正式分派器）
  if (classifyGesture(Date.now() - barGestureStartAt) === 'tap') {
    composerExpanded.value = true
    void nextTick(() => composerRef.value?.focus())
  }
}

function onBarPointerCancel() {
  if (barHoldTimer !== null) {
    window.clearTimeout(barHoldTimer)
    barHoldTimer = null
  }
}

function formatRecTime(total: number): string {
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function cancelActiveStream() {
  if (!agent.isStreaming) return
  runCancelled.value = true
  const { apiOk, completedTasks, totalTasks } = await cancelAgentRun({
    threadId: agentThreadId.value,
    sessionId: props.sessionId,
    abort: () => {
      streamAbortController?.abort()
      agentStream.stop()
      agent.finishStreaming()
    },
    postCancel: (body) =>
      fetch(apiUrl('/api/agent/runs/cancel'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      }).then((r) => {
        if (!r.ok) throw new Error(`cancel failed: ${r.status}`)
        return r.json()
      }),
  })
  cancelledProgressText.value = cancelledCalloutTextFromProgress(completedTasks, totalTasks)
  ElMessage.info(apiOk ? '已停止当前任务，您可以发送新需求' : '已断开回复，后台可能仍在收尾')
  if (apiOk) await refreshThreadCheckpoint()
}

async function send() {
  if (isUploading.value) return
  if (agent.isStreaming) {
    // 底部统一按钮在流式中 = 停止。停止后若有待发消息则自动发出（中止即发，抄 WorkBuddy）。
    await cancelActiveStream()
    return
  }
  if (!canSubmitComposer.value) return
  if (!auth.isLoggedIn) {
    auth.openLogin()
    return
  }
  persistActiveThreadId(props.sessionId, agentThreadId.value)

  const message = input.value.trim()
  input.value = ''
  await sendMessage(message)
}

/**
 * 流式中发送 = 插话（steering 队列，2026-10-02）。
 *
 * 此前的行为是把文本塞进 `queuedMessage`（注释自写「最多 1 条，抄 WorkBuddy」），
 * 等 `isStreaming` 转 false 才作为**一条全新 prompt** 补发 —— 刷新即丢、断网即丢，
 * 服务端还在一路拿 409 硬拒。现在直接 `POST /api/agent/runs/steer`：消息由 pi-runtime
 * **durable 落盘**进 vendor steering 队列，当前 run 的下一个 turn 边界就接住，
 * 事件流不断、上下文不断，插话立刻生效。
 *
 * @returns 是否成功入队。失败（runtime 未接管 / 会话已回收）由调用方回退兜底，
 *          绝不能把用户打的字吞掉。
 */
/**
 * 把槽位里的消息投递到 vendor 队列（steering 或 followUp 通道）。
 *
 * 「算不算真的入队」这一判定抽到 `queueDelivery.ts` 单独单测：这里只管状态迁移与文案，
 * 判定规则（HTTP 200 + `queued:false` 算失败、`code!==0` 算失败）在那一侧有注释与测试。
 * 失败时消息不从用户眼皮底下蒸发 —— 槽位留在 failed 态，动作区给出「取回内容」。
 */
/**
 * 当前有**未作答**的阻塞式卡（ask_user / propose_generation pending）。
 *
 * 存在理由（2026-10-02 组合漏洞）：agent 卡在 `registry.waitForUser` 里时，pi-runtime 的
 * `prompting` 标志**恒为 true**（它只在 prompt 包住的一轮结束后才清位），所以
 * `POST /sessions/:id/steer|followup` 一律 202 + `queued:true`。消息于是躺进 lane inbox，
 * 要等 ask 落定 → tool_result → 模型跑到某个边界才可能被选中。也就是说：这一轮**根本没有
 * 在回答**，气泡却按「已并入当前回答」回话，用户据此以为自己改成了刚要选的那项。
 * 这里把那条假文案降成诚实的时序说明，并把按钮文案带上「答完这张卡后接」。
 */
const pendingAskBlocking = computed(() => pendingAskUser.value.length > 0)

async function deliverQueued(intent: QueueIntent): Promise<boolean> {
  const slot = queued.value
  if (!slot || slot.text.trim() === '' || slot.state !== 'pending') return false
  slot.state = 'pending'
  slot.hint = ''
  const endpoint = intent === 'steer' ? '/api/agent/runs/steer' : '/api/agent/runs/followup'
  try {
    const res = await fetch(apiUrl(endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        sessionId: props.sessionId,
        threadId: agentThreadId.value,
        text: slot.text,
      }),
      signal: AbortSignal.timeout(5000),
    })
    const body: unknown = await res.json().catch(() => null)
    const verdict = parseQueueDelivery({ ok: res.ok, status: res.status, body })
    if (!verdict.delivered) {
      throw new Error(verdict.reason)
    }
    slot.state = 'accepted'
    // 有未作答的卡时不能说「已并入当前回答」——本轮此刻正在等用户选一个答案，
    // 没有「当前回答」可言（见 pendingAskBlocking 注释）
    slot.hint = acceptedHint(intent, pendingAskUser.value.length > 0)
    // ⚠️ 刻意不再自动收起（原来 2.6s 后自己消失）：agent 从入队到首字常 20~40s，
    // 期间气泡若消失，用户会误以为消息丢了。这里常驻，收到 QUEUE_APPLIED_EVENTS 再推进到
    // 「已接住」，最终由用户点「知道了」收起。
    return true
  } catch (err) {
    slot.state = 'failed'
    slot.hint = err instanceof Error ? err.message : '投递失败'
    return false
  }
}

/**
 * 输入框回车提交。流式中**不自动投递**，只把消息挂进待选气泡，动作权留给用户：
 * steer（立刻接住）与 followUp（收尾接住）是两种送达时机，不能替他默认选一个。
 * 非流式中走正常发送。底部「停止」按钮走 `send()`，二者分离。
 */
async function onComposerSubmit() {
  if (agent.isStreaming) {
    const text = input.value
    if (!text.trim()) return
    input.value = ''
    queued.value = { text, intent: null, state: 'pending', hint: '' }
    await nextTick()
    scrollToBottom(true)
    return
  }
  await send()
}

function dismissQueued() {
  queued.value = null
}

/** ✎ 取回内容：把消息退回输入框（不另开卡片），投递未成功时这是唯一的挽回入口 */
function requeueQueued() {
  const slot = queued.value
  if (!slot) return
  input.value = slot.text
  dismissQueued()
  nextTick(() => composerRef.value?.focus())
}

async function onForceChoiceAction(message: string) {
  await sendMessage(message)
}

function fillExampleUtterance(text: string) {
  if (props.readOnly || agent.isStreaming) return
  input.value = text
  nextTick(() => composerRef.value?.focus())
}

/**
 * P1-1.1：首屏通用样例池 —— 按画布相（空画布 / 有选中 / 有产物）给出 ≤4 条样例。
 * 空画布条目复用产品视觉分支（PRODUCT_VISUAL_GUIDANCE）的口吻，但改写为通用短句。
 */
const EXAMPLE_UTTERANCE_POOL: UtterancePool = {
  empty: [
    '这是我们的大闸蟹礼盒，帮我做一套电商包装推广图：主视觉 + 结构图 + 送礼场景，风格喜庆高级',
    '用这张产品实拍图出电商主图和两张生活场景图，突出产品卖点和质感',
    '画一个产品落地页 hero 区块，标题「把灵感变成图像」，配一张氛围插图',
    '新建一个文字节点，帮我先把创意思路列成大纲',
  ],
  selection: [
    '把选中的节点重画成扁平插画风',
    '基于选中节点再出两张风格变体',
    '给选中节点补一段详情页文案',
  ],
  artifact: [
    '把当前产物改成竖版海报构图',
    '基于当前产物再生成一张深色背景版本',
    '为当前产物配一段电商卖点文案',
  ],
}

/** 画布相派生：选中优先（selection），其次看是否有已产出物（artifact），否则空画布（empty）。 */
const currentCanvasPhase = computed<CanvasPhase>(() => {
  if (props.selectedNodeIds?.length || props.selectedNode) return 'selection'
  const nodes = props.canvasNodes ?? []
  const hasArtifact = nodes.some((n) => {
    const data = n.data ?? {}
    return (typeof data.url === 'string' && !!data.url)
      || (typeof data.content === 'string' && !!data.content.trim())
  })
  return hasArtifact ? 'artifact' : 'empty'
})

const exampleUtterances = computed(() =>
  selectExampleUtterances(currentCanvasPhase.value, EXAMPLE_UTTERANCE_POOL),
)

/**
 * P1-1.2：样例 chips 点击只填充输入框（focus + 可编辑草稿），绝不自动提交 ——
 * 发送意图必须由用户显式表达。与 fillExampleUtterance 同款预填模式。
 */
function fillFromUtterance(u: string) {
  if (props.readOnly || agent.isStreaming) return
  input.value = buildDraftFromUtterance(u)
  nextTick(() => composerRef.value?.focus())
}

async function startNewTask() {
  if (agent.isStreaming || isUploading.value) return
  await sendMessage('__new_task__')
}

function goToWorkflowHome() {
  void router.push('/workflow')
}

async function createOwnCanvas() {
  if (!auth.isLoggedIn) {
    auth.openLogin()
    return
  }
  try {
    const { data } = await sessionsApi.create({ title: '我的画布' })
    void router.push(`/workflow/${data.data.id}`)
  } catch {
    goToWorkflowHome()
  }
}

/**
 * @param branchFromEntryId ③ 重跑：pi 会话内目标消息的 entryId。提供时后端先 fork 出
 *   「截断到该消息之前」的新分支线程，再在新线程上跑本轮（真正的后端线程截断）。
 */
async function sendMessage(message: string, branchFromEntryId?: string) {
  // §5.3（③ 已确认）：pending 期间对话输入一律按 answer，自由文本填充首个未答问题。
  // 简化：B-6 卡片在答满后已自动提交消失，pending 存在 = 至少一题未答 → 首个问题即目标
  if (pendingAskUser.value.length > 0) {
    const target = pendingAskUser.value[0]
    const askSnapshot = pendingAskUser.value
    pendingAskUser.value = []
    if (target.callId) {
      try {
        const result = await submitAnswers({
          threadId: agentThreadId.value,
          sessionId: props.sessionId,
          callId: target.callId,
          answers: { [target.id]: [message] },
        }, answersPost)
        if (result.deduped) {
          // 迟到回答（callId 已 settle）：spec §5.2 降级为普通 user message 走新 turn
          //（final fix I-1）；pending 已清，递归进入正常消息流程不再被拦截
          await sendMessage(message)
        }
      } catch {
        pendingAskUser.value = askSnapshot // 失败恢复卡（幂等端点保证重试安全）
        ElMessage.error('提交失败，请重试')
      }
      return
    }
    // 无 callId（blocking off 旧路径）：pending 已清，落回下方正常 user message 流程
  }
  pendingAskUser.value = []
  const selectableTextModels = preferences.value?.selectableTextModels ?? []
  if (planningModel.value && !selectableTextModels.includes(planningModel.value)) {
    ElMessage.warning('当前规划模型已停用，请重新选择')
    return
  }

  persistActiveThreadId(props.sessionId, agentThreadId.value)
  taskProgress.value = emptyTaskProgress()

  const { attachments: pendingAttachments } = sidebar.toPayload()
  const attachments = pendingAttachments
  const mentionedKeys = normalizeMentionedKeys(parseRefMentions(message))
  const refOrder = attachments.map((a) => a.id)
  const attachmentRefKeys = assignRefKeysFor(attachments)
  // SEL-REF：指代信号在**发送瞬间**冻结一份（Review Focus #5：用户发送后改选，
  // 回执仍须与实际发出的内容一致；且这是回执唯一的数据源，不依赖模型）。
  const bindingIds = props.selectedNodeIds?.length ? props.selectedNodeIds.slice() : []
  const userMessageExtras = {
    ...(attachments.length ? { attachments, attachmentRefKeys } : {}),
    ...(bindingIds.length ? { selectionNodeIds: bindingIds } : {}),
  }

  if (props.readOnly) {
    agent.addUserMessage(message, userMessageExtras)
    sidebar.clear()
    agent.startAssistantMessage()
    agent.appendText(
      '⚠️ 此画布不属于当前账号，无法写入。请返回工作台新建画布，或使用画布所有者账号登录。',
    )
    agent.finishStreaming()
    await nextTick()
    scrollToBottom(true)
    return
  }
  agent.addUserMessage(message, userMessageExtras)
  sidebar.clear()
  agent.isStreaming = true
  agent.startAssistantMessage()
  await nextTick()
  scrollToBottom(true)

  // Generate idempotency key for this request
  const idempotencyKey = buildIdempotencyKey(agentThreadId.value)
  // Track whether SSE stream ended normally (received [DONE])
  let streamEndedNormally = false
  recoveredPhaseHint.value = null
  runCancelled.value = false
  threadRunState.value = null
  cancelledPresentation.value = null
  cancelledProgressText.value = null
  streamAbortController = new AbortController()
  agentStream.start()

  try {
    const token = localStorage.getItem('token')
    const res = await fetch(apiUrl('/api/agent/chat/conversation'), {
      method: 'POST',
      signal: streamAbortController.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        sessionId: props.sessionId,
        message,
        threadId: agentThreadId.value,
        skillId: activeSkillId.value ?? undefined,
        model: planningModel.value || undefined,
        thinking: showPlanningThinkingControls.value ? planningThinking.value : false,
        thinkingEffort:
          showPlanningThinkingControls.value && planningThinking.value
            ? planningThinkingEffort.value
            : undefined,
        // SEL-REF：指代信号是**唯一新增上行字段**；`focusNodeId` 由服务端从它派生
        // （规格 §5.3），前端不再单独发 —— 双字段各自独立写会静默漂移。
        selectedNodeIds: bindingIds.length ? bindingIds : undefined,
        attachments: attachments.length ? attachments : undefined,
        refOrder: refOrder.length ? refOrder : undefined,
        mentionedKeys,
        // ③ 重跑：后端线程截断切点（缺省 = 普通发送，不 fork）
        branchFromEntryId: branchFromEntryId || undefined,
      }),
    })

    const reader = res.body?.getReader()
    if (!reader) return

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        if (line === 'data: [DONE]') {
          streamEndedNormally = true
          continue
        }
        try {
          const event = JSON.parse(line.slice(6)) as { type: string; data: unknown }
          agentStream.touch()
          handleEvent(event)
        } catch { /* skip */ }
      }
    }
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      agent.markTurnError(err)
      agent.appendText(`\n\n⚠️ 请求失败: ${err}`)
    }
  } finally {
    agentStream.stop()
    streamAbortController = null
    // SSE abnormal-end detection: stream broke without [DONE]
    if (!streamEndedNormally && !runCancelled.value) {
      const last = agent.messages[agent.messages.length - 1]
      if (last?.role === 'assistant' && !last.content.trim()) {
        agent.appendText('\n\n⚠️ 连接意外断开，请稍后重试。')
      } else if (last?.role === 'assistant' && agentStream.unreachable.value) {
        if (!last.content.includes(RUNTIME_UNREACHABLE_SNIPPET)) {
          last.content += `\n\n⚠️ ${RUNTIME_UNREACHABLE_SNIPPET}，已保存进度。请使用弹出卡片的「重连」继续。`
        }
      } else if (last?.role !== 'assistant') {
        // 🔴 零事件场景（2026-10-07 生产事故复盘）：上面两条分支**都**以
        // `last?.role === 'assistant'` 为前提，而「本轮一个事件都没收到」时
        // assistant 消息压根不会被创建 ⇒ 两条全部落空、`appendText` 又会静默 no-op
        // ⇒ 用户屏幕上什么都不出现（实测：run 被 vendor 以 LaneBusy 拒掉，SSE 9ms 断开）。
        // 走 appendTurnNotice：它会先补一条 assistant 消息再落文本，保证文案可见。
        //
        // ⚠️ 用词刻意**不写**「生成服务不可达」：那断言的是不可达（需真实健康探测佐证），
        // 这里只证实了「连接中断且没收到内容」。把未证实的事说成事实会误导排查。
        agent.appendTurnNotice(
          '\n\n⚠️ 本轮连接中断，没有收到任何回复内容。可点「重试」；若仍无响应，点「新建对话」后重发。',
        )
      }
    }

    const last = agent.messages[agent.messages.length - 1]
    if (!runCancelled.value && last?.role === 'assistant' && !last.content.trim()) {
      agent.appendText('（本轮无文本回复。若还需确认，可再发「确认」；或点「新建对话」后重试。）')
    }
    agent.finishStreaming()
    await reconcileLatestAssistant()
    await refreshThreadCheckpoint()
    // canvas_action 已流内实时 emit（2026-10-01），无积压可 flush
    // 始终回拉：Runtime 已写 Session.canvasData；本地 save 不得用旧节点覆盖
    emit('turnComplete')
    scrollToBottom()
    // 本轮收尾后才开旁听：followUp 是**收尾边界之后**才接住、由 pi-runtime drain 派生的新一代，
    // 不在主流里（主流已 close）。挂上旁听流，人切回来才看得见「接着往下写」的那一段。
    void listenFollowUpTail()
  }
}

/**
 * 旁听「本轮之后」的事件（纯订阅，不发 prompt）。
 *
 * 只在主流收尾后启动一次，且有硬上限（默认重挂 3 轮 + 每轮 20s）：旁听流本身不是产品主路径，
 * 无限重挂会让每个静默会话都白占一条长连接。收到 `agent_end` **不做收尾**（续跑可能还在路上），
 * 由 idle 计时器自行退出。
 */
const FOLLOWUP_TAIL_MAX_ROUNDS = 3
const FOLLOWUP_TAIL_IDLE_MS = 20_000
let followUpTailRounds = 0
let followUpTailAbort: AbortController | null = null

async function listenFollowUpTail(): Promise<void> {
  followUpTailRounds += 1
  if (followUpTailRounds > FOLLOWUP_TAIL_MAX_ROUNDS) return
  followUpTailAbort?.abort()
  const controller = new AbortController()
  followUpTailAbort = controller
  // 手动造 idle 闸门而不用 `AbortSignal.any`：后者要 Chrome 116+/Safari 17.4+，
  // 本项目其余地方只用到 `AbortSignal.timeout`，别为一个旁听流引入新的兼容面。
  const idleTimer = setTimeout(() => controller.abort(), FOLLOWUP_TAIL_IDLE_MS)
  try {
    const res = await fetch(
      apiUrl(
        `/api/agent/runs/events?sessionId=${encodeURIComponent(props.sessionId)}&threadId=${encodeURIComponent(agentThreadId.value)}`,
      ),
      {
        headers: authHeaders(),
        signal: controller.signal,
      },
    )
    if (!res.ok || !res.body) return
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const line = raw.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        let payload: { type: string; data?: unknown } | null = null
        try {
          payload = JSON.parse(line.slice(5).trim())
        } catch {
          continue
        }
        if (!payload) continue
        // 与主流的事件契约完全一致（Nest 两端共用 mapPiEventToUiEvent），
        // 所以 text_delta 增量直接追加到最后一条 assistant 下面 —— 正是「同一段接着写」。
        if (payload.type === 'text_delta') {
          agent.appendText((payload.data as { text?: string } | undefined)?.text ?? '')
          scrollToBottom()
        } else if (payload.type === 'canvas_action') {
          emit('canvasActions', [payload.data as never])
        }
      }
    }
  } catch {
    /* 旁听流断开是常态，不做提示；下一轮 idle 结束或用户主动发送时自愈 */
  } finally {
    clearTimeout(idleTimer)
    followUpTailAbort = null
  }
}

async function reconnectStream() {
  if (reconnecting.value) return
  reconnecting.value = true
  try {
    streamAbortController?.abort()
    agentStream.stop()

    const health = await checkRuntimeHealthViaNest()
    if (!health?.ok) {
      recoveredPhaseHint.value = '生成服务仍不可达，请稍后再试'
      return
    }

    const token = localStorage.getItem('token')
    const res = await fetch(
      apiUrl(`/api/agent/thread-state?threadId=${encodeURIComponent(agentThreadId.value)}`),
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const json = (await res.json()) as {
      data?: {
        phase?: string | null
        runCancelled?: boolean | null
        finished?: boolean
        presentation?: AgentPresentationEnvelope | null
      } | null
    }
    // 2026-10-06：LangGraph 时代的门控回灌（gate 相位 / 方案 / 镜头 / 交付选型）已随
    // 确认型卡片一起删除。thread-state 端点仍在但恒返 null，这里只同步「运行已停止」。
    const cancelled = syncCancelledFromThreadState(json.data)

    if (agent.isStreaming) {
      agent.finishStreaming()
    }
    agentStream.reset()
    await reconcileLatestAssistant()
    emit('turnComplete')

    // PHASE_LABELS 已随 P2#10 退役：pi 链路 thread-state 不携带 LangGraph phase，
    // 恢复提示不再插值阶段名（pi 路径下 label 恒为「未知」）
    recoveredPhaseHint.value =
      cancelled
        ? '服务已恢复。上一轮已停止，可发起新任务。'
        : json.data?.finished
        ? '服务已恢复。上一轮已完成，可继续新的指令。'
        : '服务已恢复。上一轮尚未完成，请继续操作。'
    pollTasksFromProgress()
  } catch {
    recoveredPhaseHint.value = '重连失败，请稍后再试'
  } finally {
    reconnecting.value = false
    scrollToBottom(true)
  }
}

/** 流结束后用 DB 历史补齐最终文案。P1#11：以 thread-state 回合终态替代文本 snippet 匹配。 */
async function reconcileLatestAssistant() {
  const pull = async () => {
    const res = await fetch(
      apiUrl(
        `/api/agent/chat/user/messages?sessionId=${encodeURIComponent(props.sessionId)}&threadId=${encodeURIComponent(agentThreadId.value)}`,
      ),
      // 同 thread-state：禁缓存，避免 304 空体让 res.json() 抛错、静默中断回查
      { cache: 'no-store' },
    )
    const json = await res.json()
    const rows = (json.data || []) as Array<{ role: string; content: string }>
    const lastDb = pickAssistantForLatestUserTurn(rows)
    if (!lastDb?.content?.trim()) return null
    const lastLocal = agent.messages[agent.messages.length - 1]
    if (
      lastLocal?.role === 'assistant'
      && shouldApplyReconciledAssistant(lastLocal.content || '', lastDb.content)
    ) {
      lastLocal.content = lastDb.content
    }
    return lastDb.content
  }

  try {
    await pull()
    // 终态判定：finished → 停；未完成 → 每次拉取前先查 thread-state，上限 36×5s 兜底
    // I-2 修复：thread-state 连续读取失败达阈值（≈15s）→ 注入不可达告警并 break，
    // 避免旧 reconcile 删除后失去 pi-runtime 宕机的可见反馈。
    // 2026-10-01 修正：达阈值后**先做一次真实健康探测**再决定是否告警——
    // 状态读取失败（304/抖动/单次 5xx）不等于 runtime 不可达，探测健康就必须闭嘴。
    let consecutiveNulls = 0
    for (let i = 0; i < RECONCILE_MAX_POLLS; i++) {
      const read = await fetchThreadStateSafe(agentThreadId.value)
      if (read.ok) {
        consecutiveNulls = 0
      } else {
        consecutiveNulls++
      }
      if (shouldInjectUnreachableSnippet(consecutiveNulls)) {
        const health = await checkRuntimeHealthViaNest()
        if (shouldInjectUnreachableSnippet(consecutiveNulls, health)) {
          const last = agent.messages[agent.messages.length - 1]
          if (last?.role === 'assistant' && !last.content.includes(RUNTIME_UNREACHABLE_SNIPPET)) {
            last.content += `\n\n⚠️ ${RUNTIME_UNREACHABLE_SNIPPET}，已保存进度。请点击下方「重连」继续。`
            scrollToBottom()
          }
        }
        break
      }
      if (!shouldKeepReconciling(read.ok ? read.state : null, i)) break
      await new Promise((r) => setTimeout(r, 5_000))
      await pull()
      scrollToBottom()
    }
  } catch {
    // ignore
  }
}

const dockNotice = useDockNoticeStore()

/**
 * 不可达 / 重连提示 → dock 通知卡片（合并原 agent-stream-banner）。
 * - 流卡死（unreachable）：常驻 warning 卡 + 「重连」按钮
 * - 重连成功：success 卡（自动消失）
 * - 重连失败：更新为 error 卡（常驻 + 「重连」按钮）
 */
const RUNTIME_NOTICE_ID = 'runtime-unreachable'
function syncRuntimeNotice() {
  const unreachable = agentStream.unreachable.value
  const hint = recoveredPhaseHint.value
  if (unreachable) {
    // 不可达优先：清掉可能残留的重连结果提示，弹出常驻重连卡
    recoveredPhaseHint.value = null
    dockNotice.pushNotice({
      id: RUNTIME_NOTICE_ID,
      tone: 'warning',
      title: '生成服务暂时不可达',
      message: '已保存进度，出图状态仍可通过轮询更新。',
      action: { label: '重连', onClick: () => void reconnectStream() },
      ttl: 0,
    })
    return
  }
  if (hint) {
    if (hint.includes('已恢复')) {
      dockNotice.dismiss(RUNTIME_NOTICE_ID)
      dockNotice.pushNotice({
        tone: 'success',
        title: '服务已恢复',
        message: hint.replace('服务已恢复。', ''),
        ttl: 5000,
      })
    } else {
      dockNotice.pushNotice({
        id: RUNTIME_NOTICE_ID,
        tone: 'error',
        title: '重连失败',
        message: hint,
        action: { label: '重连', onClick: () => void reconnectStream() },
        ttl: 0,
      })
    }
    return
  }
  dockNotice.dismiss(RUNTIME_NOTICE_ID)
}

watch(
  [() => agentStream.unreachable.value, () => recoveredPhaseHint.value],
  syncRuntimeNotice,
  { immediate: true },
)

function handleEvent(event: { type: string; data: unknown }) {
  // 任一「agent 已在这条补充上产出内容」的事件到达 → 气泡推进到「已接住」（不用等模型复述）
  if (QUEUE_APPLIED_EVENTS.has(event.type)) markQueueApplied()
  switch (event.type) {
    case 'text_replace':
      agent.replaceAssistantText((event.data as { text: string }).text)
      scrollToBottom()
      break
    case 'text_delta':
      agent.appendText((event.data as { text: string }).text)
      scrollToBottom()
      break
    case 'pi_message_end': {
      // ③ 重跑：捕获 pi 会话内消息的 entryId（pi 原始载荷 `{ message, entryId }`）。
      // 只认 user 消息 —— 它才是「从这条重新生成」的合法 fork 切点。
      const d = event.data as { entryId?: string; message?: { role?: string } } | null
      const entryId = typeof d?.entryId === 'string' ? d.entryId : ''
      if (entryId && d?.message?.role === 'user') {
        // 落到最后一条 user 消息：本轮刚提交的用户消息即 fork 候选切点
        for (let i = agent.messages.length - 1; i >= 0; i -= 1) {
          const m = agent.messages[i]
          if (m && m.role === 'user') {
            m.entryId = entryId
            break
          }
        }
      }
      break
    }
    case 'thread_forked': {
      // ③ 重跑：后端已完成线程截断（新分支会话已建）。切换 agentThreadId ——
      // 之后的发送 / 订阅 / 历史拉取都必须走新线程，否则又会落回被截断前的旧线程。
      const d = event.data as { threadId?: string } | null
      const nextThreadId = typeof d?.threadId === 'string' ? d.threadId : ''
      if (nextThreadId && nextThreadId !== agentThreadId.value) {
        agentThreadId.value = nextThreadId
        persistActiveThreadId(props.sessionId, nextThreadId)
      }
      break
    }
    case 'tool_call': {
      // P2：真实工具开始 = 恢复结束（清「会话恢复中」瞬时态）
      agent.setRecovering(false)
      const d = event.data as { name: string; toolCallId?: string; args?: unknown }
      agent.beginToolCall({ toolCallId: d.toolCallId, name: d.name, args: d.args })
      // 治理 2/2：live 内容已入主滚动流，内容增长须跟随（仅 followLatest 时生效）
      scrollToBottom()
      break
    }
    case 'waiting_user': {
      // 阻塞等待可见化（2026-10-01）：后端在等待**开始**/结束各发一次。
      // waiting → 状态行收口为「等待你在画布上确认生成 / 等待你作答：<题面> / 等待你确认」；
      // resolved → 清位。question 来自 ask_user 的 meta.questionTitle。
      const d = event.data as {
        status?: string
        toolName?: string
        callId?: string
        nodeId?: string
        /** ask_user 经 meta.questionTitle 下发的题面（2026-10-02） */
        question?: string
        timeoutMs?: number
        /** P1：waiting_user 也带 reason（供 TurnTimeline warn notice 文案） */
        reason?: string
      }
      if (d.status === 'resolved' || !d.toolName) {
        agent.setBlockingWait(null)
      } else {
        // timeoutMs 是等待总时长（线上 300000）：以收到事件的时刻为起点算取消时刻，前端倒计时才有可比性
        agent.setBlockingWait({
          toolName: d.toolName,
          callId: d.callId,
          nodeId: d.nodeId,
          question: d.question,
          timeoutMs: d.timeoutMs,
        })
        // P1：waiting_user → TurnTimeline warn notice（flag 关闭时 feedTimeline 内短路，零成本）
        agent.trackWaitingUser({ status: d.status, toolName: d.toolName, nodeId: d.nodeId, reason: d.reason })
        // L2：propose 等待开始即把画布节点同步成 pending_confirm（消除 stale draft，
        // 否则等待期任何 saveCanvas 都会用 draft 覆盖 SSOT 的待确认 → 被误判「用户取消」）
        if (d.toolName === 'propose_generation' && d.nodeId) {
          emit('proposeWaitStart', d.nodeId)
        }
      }
      break
    }
    case 'activity': {
      // 「正在做什么」（决策 8）：runtime 在工具起手时下发，比 tool_call 更早到。
      // 中文在组件层查 TOOL_PRESENTATION 出（决策 7：runtime 只声明意图、不塞文案）。
      // P2：真实活动到达 = 恢复结束（清「会话恢复中」瞬时态）。
      agent.setRecovering(false)
      const d = event.data as { toolName?: string; done?: number; total?: number };
      agent.setActivity({ toolName: d.toolName, done: d.done, total: d.total });
      break;
    }
    case 'recovery': {
      // P2「会话恢复中」：vendor retry_scheduled{recovery:true} 透传。置位瞬时态，
      // 状态行显示「会话恢复中」而非误导性的「上游响应超时」；真实进度（activity/
      // tool_call）或回合结束（store endTurn）清位。
      agent.setRecovering(true)
      break
    }
    case 'pi_compaction': {
      // 审计 #6：压缩对用户可见。开始→状态行「压缩上下文」；结束（completed/
      // declined/aborted/failed 一律）→清除。成败不在此处报错（metrics 观测口径）。
      const d = event.data as { phase?: string } | undefined;
      agent.setActivity(d?.phase === 'start' ? { toolName: 'compaction' } : null);
      break;
    }
    case 'tool_result': {
      const d = event.data as { name: string; toolCallId?: string; result: unknown; isError?: boolean }
      agent.endToolCall(d.toolCallId, d.name, d.result, d.isError === true)
      // 治理 2/2：live 内容已入主滚动流（同 tool_call）
      scrollToBottom()
      break
    }
    case 'canvas_action': {
      // 流内实时上屏（2026-10-01 修）：不等流结束 flush —— 阻塞 propose 等待期
      // 节点必须立即可见/可确认。add_node 已按 id upsert（#91），重复投递幂等。
      const action = event.data as Parameters<typeof agent.addCanvasAction>[0]
      agent.addCanvasAction(action)
      emit('canvasActions', [action])
      break
    }
    case 'node_status': {
      const data = event.data as { nodeId: string; status: string; url?: string }
      agent.trackNodeStatus(data)
      break
    }
    case 'step':
      agent.trackStep(event.data as Parameters<typeof agent.trackStep>[0])
      // 治理 2/2：live trace 步骤已入主滚动流（同 tool_call 口径）
      scrollToBottom()
      break
    case 'phase_hint':
      agent.trackPhaseHint(event.data as { phase?: string; label: string })
      break
    case 'thinking':
      agent.trackThinking(event.data as { status: string; summary?: string })
      // 治理 2/2：思考流已入主滚动流，增长须跟随（同 text_delta 口径）
      scrollToBottom()
      break
    case 'turn_usage':
      agent.trackTurnUsage(
        event.data as {
          inputTokens: number
          outputTokens: number
          cacheReadTokens?: number
          cacheWriteTokens?: number
          cost?: number
          estimatedCredits?: number
        },
      )
      break
    case 'usage_delta':
      // Q2（2026-10-14）：实时预估积分快照（transient）→ 状态行 running 段「预估 -N积分」
      agent.trackUsageDelta(event.data as { estimatedCredits?: number })
      break
    case 'turn_settled':
      // P2 T7：结算明细 → trace.settled（settled 态摘要/状态行数据源）+ 余额刷新。
      // 事件经既有 executionEvents 重放通道持久化，刷新后由 loadHistory 重放还原。
      agent.trackTurnSettled(
        event.data as Parameters<typeof agent.trackTurnSettled>[0],
      )
      break
    case 'explore':
      agent.trackExplore(event.data as Parameters<typeof agent.trackExplore>[0])
      // 治理 2/2：探索步骤同样入主滚动流（同 step 口径）
      scrollToBottom()
      break
    // SEL-REF：服务端确认本轮**实际注入**了哪些节点。只有收到它，回执才显示。
    // 前端读不到 Nest 的 SEL_REF_ENABLED ⇒ 不能按本地快照自行推断（评审 C1）。
    case 'selection_binding': {
      const data = event.data as { nodes?: Array<{ id: string; type: string; title: string }> }
      if (Array.isArray(data?.nodes)) agent.confirmSelectionBinding(data.nodes)
      break
    }
    case 'canvas_command': {
      const cmd = event.data as {
        type: string
        nodeId?: string
        nodeIds?: string[]
        exportMode?: 'full_package' | 'lightweight'
        attachments?: SidebarAttachment[]
        mode?: 'grid' | 'along_edges'
        gap?: number
        edges?: { source: string; target: string }[]
        /** render_canvas_view 产物（spec §4.6 第 2 跳）。净化在 AgentSvgCard 内做（§4.5）。 */
        svg?: string
        title?: string
        annotations?: Array<{ nodeId: string; text: string; severity: 'info' | 'warn' }>
        /**
         * D4 §4.5 呈现分工：本轮该呈现哪一种（后端 `presentResultDual` 双写时两条同值）。
         *
         * ⛔ **前端拿不到 `overlay.kind`**（它不在这两条 command 的原形状里）⇒ 无法自己
         * 算判据，只能读后端结论；**不要在前端复刻这套规则**，两处实现必然漂移。
         * 字段缺失（旧消息 / 重放路径）⇒ 沿用既有 `PRESENTATION_KIND_PRIORITY`。
         */
        preferredKind?: 'svg_card' | 'node_graph'
      }
      /**
       * D4 §4.5：**只有 node_graph 需要门禁**，svg_card 一侧刻意不加。
       *
       * ⭐ 为什么用「跳过 node_graph」而不是「改 `PRESENTATION_KIND_PRIORITY`」：
       * `presentation` 是**单值**字段，而 `setPresentation` 的同 kind 覆盖语义被
       * `agent.setPresentation.test.ts` 锁成活契约。跳过落选那条 ⇒ svg_card 那次调用面对的是
       * 空 `presentation`（`currentRank = -1`）必然写入，**既不动优先级表也不碰契约**；
       * 反过来无论 `canvasCommands` 顺序如何（后端固定 `[svg_card, node_graph]`）都成立。
       *
       * ⛔ **svg_card 侧加同款门禁是错的**（变异验证实测：删掉它测试仍全绿 ⇒ 该门禁
       * 在双写场景下完全不可观测）：`PRESENTATION_KIND_PRIORITY` 里 node_graph rank 2 >
       * svg_card rank 1 ⇒ `node_graph` 后续那次调用**总会覆盖** svg_card，跳不跳过都一样。
       * 而它唯一可观测的场景（`node_graph` 命令缺席，例如 nodeGraph 节点为空、
       * 或只收到 update 快照的一条）作用恰好是**制造空白**——把唯一的保底呈现也跳掉。
       * svg_card 是「有内容就给人看」的保底，不该参与分工。
       *
       * ⛔ 白名单：`preferredKind` 若是未知值（脏数据 / 后端新增第三种呈现而本仓没同步），
       * 一律**不判落选**⇒ 退回既有优先级，绝不出现「两条都被跳过 ⇒ 空白且无报错」。
       */
      const PRESENTATION_KINDS = ['svg_card', 'node_graph'] as const
      const nodeGraphDeprioritized = (c: { type: string; preferredKind?: string }) =>
        c.preferredKind !== undefined &&
        (PRESENTATION_KINDS as readonly string[]).includes(c.preferredKind) &&
        c.preferredKind !== 'node_graph'
      if (cmd.type === 'focus_node' && cmd.nodeId) {
        onFocusNode(cmd.nodeId)
      } else if (cmd.type === 'focus_nodes' && cmd.nodeIds?.length) {
        onFocusAll(cmd.nodeIds)
      } else if (cmd.type === 'export_pack') {
        // Agent export_media_package → browser downloads workflow zip (graph + media)
        onExportPack(
          Array.isArray(cmd.nodeIds) ? cmd.nodeIds : [],
          cmd.exportMode === 'lightweight' ? 'lightweight' : 'full_package',
        )
      } else if (cmd.type === 'undo') {
        emit('undo')
      } else if (cmd.type === 'redo') {
        emit('redo')
      } else if (cmd.type === 'open_image_editor' && cmd.nodeId) {
        emit('openImageEditor', cmd.nodeId)
      } else if (cmd.type === 'arrange_nodes' && cmd.nodeIds && cmd.nodeIds.length >= 2) {
        emit('arrangeNodes', {
          nodeIds: cmd.nodeIds,
          mode: cmd.mode === 'along_edges' ? 'along_edges' : 'grid',
          gap: cmd.gap ?? 40,
          edges: cmd.edges?.length ? cmd.edges : undefined,
        })
      } else if (cmd.type === 'introduce_nodes' && cmd.attachments?.length) {
        for (const att of cmd.attachments) {
          if (sidebar.pendingAttachments.value.length >= SIDEBAR_ATTACHMENT_MAX) break
          sidebar.addFromPayload(att)
        }
      } else if (
        cmd.type === 'node_graph' &&
        Array.isArray((cmd as unknown as { nodes?: unknown }).nodes) &&
        !nodeGraphDeprioritized(cmd)
      ) {
        // 🔀 render_canvas_view 的结构化产物（2026-07）：Vue Flow 渲染，可拖拽 / 带缩略图。
        // ⚠️ **必须在 svg_card 分支之前**（A 方案：node_graph 优先、静态 SVG 降级）。
        // ⚠️ 不塞 AgentPresentationHost：与 svg_card 同款理由（落库路径不恢复 stepper）。
        // ⛔ 但 D4 §4.5：模型传了 overlay（情绪/预算/严重度）时本载荷**没有 severity/mark
        //   字段**承载它 ⇒ 这时必须让 svg_card 赢，否则 D3-3 视觉语言被静默丢弃。
        //   判据由后端算好后用 `preferred` 下发，这里只读不算。
        const ng = cmd as unknown as NodeGraphBodyPayload
        // ⚠️ body 走 `AgentPresentationBody` 的**可选字段**（不是联合类型，见 types.ts 注释）：
        //   联合类型会让所有下游 `body.text` / `body.schemes` 访问变成 TS2339（实测 16 处）。
        agent.setPresentation({
          kind: 'node_graph',
          stepper: { current: '', completed: [] },
          title: ng.title ?? cmd.title,
          body: {
            graph_nodes: ng.nodes,
            graph_edges: ng.edges ?? [],
            graph_droppedNodeIds: ng.droppedNodeIds,
            graph_totalNodeCount: ng.totalNodeCount,
            nodeGraphTitle: ng.title,
          },
        } as unknown as AgentPresentationEnvelope)
      } else if (cmd.type === 'svg_card' && cmd.svg !== undefined) {
        // render_canvas_view 产物：净化在 AgentSvgCard 内做（spec §4.5）。
        // ⚠️ 刻意不塞 AgentPresentationHost：svg_card 是独立挂载（无 stepper 布局），
        // 因为落库重放路径不恢复 stepper。
        // ⚠️ 净化器（svg-sanitize.ts 的 ALLOWED_ELEMENTS / ALLOWED_ATTRS）兜住的是
        // **可表达范围**，管不了**选择器作用域** —— AgentSvgCard 组件自身**没有 <style> 块**，
        // 真正 document-global 的是**净化后 SVG 内部的 <style>**（ALLOWED_ELEMENTS 收了
        // 'style'），经 AgentSvgCard 模板里的 v-html 注入直接落进本文档，无 shadow root、
        // 无 scoped。故净化器拦不住「选择器命中卡片以外的元素」。
        // 产出方（services/pi-runtime/src/tools/render-canvas-view.ts 的 build* 系列）
        // 新增图元时，必须同步过净化器白名单，否则整块被剥；净化器不报错，静默降级成空卡片。
        agent.setPresentation({
          kind: 'svg_card',
          stepper: { current: '', completed: [] },
          title: cmd.title,
          body: { svg: cmd.svg, annotations: cmd.annotations },
        })
      } else if (cmd.type === 'ask_user') {
        const card = cmd as { callId?: string; questions?: Array<Omit<(typeof pendingAskUser.value)[number], 'callId'>> }
        if (card.questions?.length) {
          // B-6：callId 是卡片级提交依据（update 快照 / end 旧路径透传），逐元素填充
          pendingAskUser.value = card.questions.map((q) => ({ ...q, callId: card.callId ?? '' }))
        }
      }
      break
    }
    case 'task_list':
    case 'task_update':
    case 'task_summary': {
      const prev = taskProgress.value
      taskProgress.value = applyTaskEvent(
        taskProgress.value,
        event as Parameters<typeof applyTaskEvent>[1],
      )
      if (event.type === 'task_update') {
        const data = event.data as {
          recordId?: string
          id?: string
          status?: string
          errorHint?: string
          errorCode?: string
        }
        const item = taskProgress.value.items.find((it) => it.id === data.id)
        if (item) {
          agent.trackTaskUpdate({
            id: item.id,
            status: data.status ?? item.status,
            title: item.title,
            nodeId: item.nodeId,
            errorHint: data.errorHint ?? item.errorHint,
            errorCode: data.errorCode ?? item.errorCode,
          })
        }
        if (item?.recordId && item.nodeId) {
          startTaskRecordPoll([{ recordId: item.recordId, nodeId: item.nodeId }])
        }
      } else if (event.type === 'task_list' && taskProgress.value.items.length !== prev.items.length) {
        pollTasksFromProgress()
      }
      scrollToBottom()
      break
    }
    case 'ping':
    case 'heartbeat':
      // 控制器每 15s 下发的保活帧；touch() 已在流读取循环中调用，此处无需额外处理
      break
    case 'run_cancelled': {
      runCancelled.value = true
      const data = event.data as {
        text?: string
        presentation?: AgentPresentationEnvelope | null
      }
      if (data.presentation) cancelledPresentation.value = data.presentation
      const text = String(data.text ?? '').trim()
      if (text) {
        agent.appendText(`\n\n${text}`)
        scrollToBottom()
      }
      break
    }
    // `interrupt` / `done` 两个门控事件已整段下线（2026-10-06）：
    //   生产侧 —— 老 LangGraph runtime 于 2026-09-27 退役，runtime 与 Nest 都不再产出这两个事件；
    //   消费侧 —— 它们当时唯一的用途是把确认卡片所需的门控状态（gate 相位 / chipSet /
    //   retake / 方案与交付选型）回灌进侧栏，随卡片一起删除。
    // 故此处不留 `case`：事件真出现也只是被忽略，不再制造任何 UI。
    case 'force_choice': {
      const kind = (event.data as { kind?: string }).kind
      if (kind === 'plan_max_revise' || kind === 'copy_max_revise' || kind === 'gen_partial') {
        forceChoiceKind.value = kind
        forceChoiceOpen.value = true
      }
      break
    }
    case 'error': {
      const data = event.data as {
        message?: string
        error_type?: string
        retry_hint?: string
        tool_name?: string
      }
      agent.markTurnError(data)
      agent.trackStructuredError(data)
      agent.appendText(`\n\n⚠️ ${data.message || '发生错误'}`)
      // dock 上沿窄卡片（失败提醒复用入口）：已分类的失败（如余额不足）弹充值/重试提醒
      if (data.error_type) {
        const retry = data.retry_hint ? ` ${data.retry_hint}` : '请稍后重试。'
        dockNotice.pushNotice({
          tone: 'error',
          title: data.error_type === 'insufficient_balance' ? '生成失败 · 渠道余额不足' : '生成失败',
          message: `${data.message || '本轮生成失败。'}${retry}`,
        })
      }
      break
    }
  }
}

/** 距底部多少像素内仍算「贴底」：超过即认定用户在回看历史，停止自动跟随。 */
const NEAR_BOTTOM_PX = 48
/** 是否跟随最新。false = 用户正在回看历史，禁止任何自动拉回底部。 */
const followLatest = ref(true)
/** 脱离底部期间，下方有新内容进来 */
const hasNewBelow = ref(false)

function isNearBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
}

/** 用户滚动：贴底 → 恢复跟随；离开底部 → 暂停跟随（此后不再打断阅读）。 */
function onChatScroll() {
  const el = chatContainer.value
  if (!el) return
  const near = isNearBottom(el)
  followLatest.value = near
  if (near) hasNewBelow.value = false
}

/**
 * 滚到底部。
 * force=true 用于「用户明确想看最新」的场景（发消息 / 打开面板 / 载入历史 / 重连），
 * 会连跟随状态一起恢复；默认 false = 受跟随状态约束，用户回看历史时静默跳过。
 */
function scrollToBottom(force = false) {
  if (!force && !followLatest.value) {
    hasNewBelow.value = true
    return
  }
  followLatest.value = true
  hasNewBelow.value = false
  nextTick(() => {
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight
    }
  })
}

/** 点「回到底部」：恢复跟随并跳到最新。 */
function jumpToLatest() {
  scrollToBottom(true)
}

function reconcileFromNodes(rawNodes: CanvasNodeLike[]) {
  if (!taskProgress.value.items.length) return
  let next = reconcileTaskProgress(taskProgress.value, rawNodes)
  // W11: canvas generationRecordId → start poll for matching task items
  for (const n of rawNodes) {
    const recordId = n.data?.generationRecordId
    if (typeof recordId !== 'string' || !recordId) continue
    const item = next.items.find((it) => it.nodeId === n.id)
    if (item && !item.recordId) {
      next = applyTaskEvent(next, {
        type: 'task_update',
        data: { id: item.id, status: item.status, recordId },
      })
    }
  }
  pollTasksFromProgress()
  if (shouldFinishTaskCard(next, rawNodes) && !next.finished) {
    next = {
      ...next,
      finished: true,
      summary: next.summary ?? synthesizeSummary(next),
    }
  }
  taskProgress.value = next
}

defineExpose({
  openPanel,
  closePanel,
  setComposerInput,
  addAttachment,
  reconcileFromNodes,
  /** L1：画布/dock 点生成时显式确认 propose 等待（answered），不再靠 SSOT 时序推断 */
  confirmProposeWait,
  addFromCanvasNodes: (nodes: FocusNodeLike[]): CanvasRefAddResult => {
    const result = sidebar.addFromCanvasNodesDetailed(nodes)
    if (result.added < nodes.length && nodes.length === 1) {
      if (result.empty) ElMessage.warning('该节点暂无可用内容')
      else if (result.duplicate) ElMessage.info('该节点已在引用中')
    } else if (result.added < nodes.length && sidebar.pendingAttachments.value.length >= SIDEBAR_ATTACHMENT_MAX) {
      ElMessage.warning(`最多 ${SIDEBAR_ATTACHMENT_MAX} 个参考素材`)
    }
    return result
  },
})
</script>

<template>
  <aside
    class="agent-side-rail shrink-0 overflow-visible"
    :class="{
      'is-resizing': resizing,
      'is-docked-open': open && !floating && !isMobileLayout,
    }"
    :style="{ width: asidePanelWidth }"
  >
    <div class="flex h-full min-h-0">
      <!-- 收缩态：右下角 agent logo 悬浮按钮（移动端裸条常驻，fab 仅桌面收缩态） -->
      <Teleport to="body">
        <button
          v-if="!open && !pickModeActive"
          type="button"
          class="agent-fab"
          title="打开 AI 助手"
          @click="openPanel"
        >
          <NeoAgentLogo size="sm" />
        </button>
      </Teleport>

      <!-- 面板：侧栏内嵌 or 浮动窗口 or 移动端贴底裸条容器（Teleport 到 body） -->
      <Teleport to="body" :disabled="!panelTeleported">
        <div
          v-show="open"
          class="agent-panel-shell flex min-h-0 h-full min-w-0 flex-col overflow-hidden"
          :class="[
            isMobileLayout ? 'agent-panel-mobile-dock' : floating ? 'agent-panel-floating' : 'agent-panel-inline flex-1',
            { 'is-dragging': dragging },
          ]"
          :style="floating && !isMobileLayout ? {
            left: `${floatPos.x}px`,
            top: `${floatPos.y}px`,
            width: `${floatWidth}px`,
          } : undefined"
        >
          <!-- 左边缘拖拉调宽 -->
          <div
            v-if="!isMobileLayout"
            class="agent-resize-handle"
            title="拖拉调整宽度"
            @mousedown="startResize"
          />

          <!-- 顶栏：logo + 新建 / 历史 / 浮窗切换 / 收起（浮窗模式可按住拖动）。
               P1-5 fix-1：移动端保留（新建对话 / 会话历史入口随贴底容器常驻，
               收起 / 浮窗为桌面专属按钮移动端隐藏；startDrag 移动端本身 no-op） -->
          <div
            class="agent-panel-header flex items-center justify-between px-3 py-2"
            :class="floating && !isMobileLayout ? 'cursor-move' : ''"
            @mousedown="startDrag"
          >
            <div class="flex min-w-0 items-center gap-2">
              <NeoAgentLogo size="xs" active />
              <!-- 移动端：头像即品牌 logo，不再重复「lnk·π agent」文字（2026-10-15 移动端重构） -->
              <p v-if="!isMobileLayout" class="agent-subtitle truncate text-[11px]">lnk·π agent</p>
            </div>
            <div class="flex items-center gap-0.5">
              <!-- 新建 agent 会话 -->
              <button type="button" class="agent-head-btn" title="新建对话" @click="newAgentSession">
                <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75">
                  <path stroke-linecap="round" d="M12 5v14M5 12h14" />
                </svg>
              </button>

              <!-- 历史记录 -->
              <div ref="historyRef" class="relative">
                <button
                  type="button"
                  class="agent-head-btn"
                  :class="historyOpen ? 'is-active' : ''"
                  title="对话历史"
                  @click="toggleHistoryOpen"
                >
                  <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75">
                    <circle cx="12" cy="12" r="9" />
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 7v5l3 2" />
                  </svg>
                </button>
                <div
                  v-if="historyOpen"
                  class="neo-popover absolute right-0 top-full z-20 mt-1.5 max-h-[280px] w-[240px] overflow-y-auto rounded-xl py-1"
                  @click.stop
                >
                  <p class="px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--lnk-text-muted)]">对话历史</p>
                  <button
                    v-for="thread in threads"
                    :key="thread.id"
                    type="button"
                    class="neo-popover-item block w-full px-3 py-2 text-left text-xs"
                    :class="thread.id === agentThreadId ? '!bg-[var(--lnk-hi-bg)] !text-[var(--lnk-hi-text)] shadow-[var(--lnk-hi-shadow)]' : ''"
                    :title="thread.title"
                    @click="selectThread(thread.id)"
                  >
                    <span class="block truncate font-medium">{{ thread.title }}</span>
                    <span class="block text-[10px] opacity-60">{{ formatSessionTime(thread.updatedAt) }}</span>
                  </button>
                  <p v-if="!threads.length" class="px-3 py-4 text-center text-[11px] text-[var(--lnk-text-muted)]">
                    暂无对话记录
                  </p>
                </div>
              </div>

              <!-- 浮动窗口切换：面板脱离/停靠侧栏 -->
              <button
                v-if="!isMobileLayout"
                type="button"
                class="agent-head-btn"
                :class="floating ? 'is-active' : ''"
                :title="floating ? '停靠回侧栏' : '切换为浮动窗口'"
                @click="toggleFloating"
              >
                <!-- 浮窗图标：主窗 + 右上悬浮小窗（带弹出箭头） -->
                <svg v-if="!floating" viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75">
                  <path stroke-linecap="round" d="M20 9V5.5A1.5 1.5 0 0 0 18.5 4H5.5A1.5 1.5 0 0 0 4 5.5v10A1.5 1.5 0 0 0 5.5 17H9" />
                  <rect x="12" y="12" width="9" height="8" rx="1.5" />
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9.5 9.5 13 6m0 0h-2.8M13 6v2.8" transform="translate(-1 1)" />
                </svg>
                <!-- 停靠图标：小窗收回主窗 -->
                <svg v-else viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <path stroke-linecap="round" d="M15 4v16M15 12h6" opacity="0.4" />
                  <path stroke-linecap="round" stroke-linejoin="round" d="m11 9-3 3 3 3M8 12h5" />
                </svg>
              </button>

              <!-- 收起：回到右下角 logo（桌面专属；移动端裸条常驻无「收起」形态） -->
              <button v-if="!isMobileLayout" type="button" class="agent-head-btn" title="收起助手" @click="closePanel">
                <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
          </div>

          <div
            v-if="readOnly"
            class="agent-readonly-banner mx-3 mt-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2.5 text-[11px] leading-relaxed text-warning"
          >
            <p>此画布属于其他账号，Agent 无法写入节点。</p>
            <p class="mt-1 opacity-80">请新建自己的画布，或使用画布所有者账号登录。</p>
            <div class="mt-2.5 flex flex-wrap gap-2">
              <button type="button" class="agent-readonly-btn" @click="goToWorkflowHome">
                返回工作台
              </button>
              <button type="button" class="agent-readonly-btn agent-readonly-btn-primary" @click="createOwnCanvas">
                新建画布
              </button>
            </div>
          </div>

          <!-- 不可达 / 重连提示已迁至 dockNotice（见 syncRuntimeNotice）；不再在面板内渲染横幅 -->

          <!-- 消息列表（外层 wrap 只用于定位「回到底部」浮标，不改变原滚动容器结构）。
               P1-5 fix-1：移动端对话流回归贴底容器（spec §1 消息流渲染不在整改范围、
               spec §5.2 只要求 composer 脱离全屏 sheet）；移动端经 max-height ≈40vh
               限高滚动，画布仍露出上半（P1-5.1）。渲染样式桌面/移动同源，不做重排。 -->
          <div class="agent-chat-wrap relative flex min-h-0 flex-1 flex-col">
            <div
              ref="chatContainer"
              class="agent-chat-scroll min-h-0 flex-1 overflow-y-auto py-3"
              @scroll.passive="onChatScroll"
            >
            <div v-if="showProductVisualEmptyState" class="agent-empty agent-pv-empty px-3 py-10 text-center">
              <p class="text-sm">描述你的产品视觉需求</p>
              <p class="mt-1 text-[11px] opacity-70">上传产品图后说明用途；风格在方案卡片中选择</p>
              <div class="mt-4 flex flex-col gap-2">
                <button
                  v-for="example in PRODUCT_VISUAL_GUIDANCE.exampleUtterances"
                  :key="example.id"
                  type="button"
                  class="agent-pv-example-btn rounded-lg border px-3 py-2 text-left text-[12px] leading-snug"
                  data-testid="pv-example-utterance"
                  @click="fillExampleUtterance(example.text)"
                >
                  <span class="font-medium">{{ example.label }}</span>
                  <span class="mt-0.5 block text-[11px] opacity-70 line-clamp-2">{{ example.text }}</span>
                </button>
              </div>
            </div>
            <!-- P1-1：通用首屏 —— persona 压成一行轻量文案（P1-1.3），视觉重心让给
                 4 条按画布相选取的样例 chips（P1-1.1）；点击 chips 只填充输入框（P1-1.2）。 -->
            <div v-else-if="!agent.messages.length" class="agent-empty agent-composer-firstscreen px-3 pb-2 pt-6">
              <p class="agent-composer-persona text-center text-[12px] leading-relaxed" data-testid="agent-persona-line">
                lnk·π 助手 · 说一句创意，我来画
              </p>
              <div class="agent-example-chips mt-3 flex flex-wrap justify-center gap-2">
                <button
                  v-for="u in exampleUtterances"
                  :key="u"
                  type="button"
                  class="agent-example-chip rounded-lg border px-3 py-1.5 text-left text-[12px] leading-snug"
                  data-testid="agent-example-chip"
                  @click="fillFromUtterance(u)"
                >
                  {{ u }}
                </button>
              </div>
            </div>
            <div
              v-for="msg in agent.messages"
              :key="msg.id"
              class="agent-turn"
              :class="msg.role === 'user' ? 'agent-turn--user' : 'agent-turn--assistant'"
            >
              <!-- 用户气泡的二次编辑态是**同一张卡片**：同一个 .agent-bubble-user 容器，
                   宽度/底色/圆角/内边距全不变，只有底部那一排按钮换成「取消 / 发送」。
                   唯一需要额外声明的是宽度基准（agent-bubble-user--editing）：
                   展示态靠 `max-width: 88%` + 内容撑满（长文案即取满 88%），
                   而编辑态内容是一张 textarea，天然比正文窄 ⇒ shrink-to-fit 会把卡片收窄、
                   看起来就换了张卡片。见下方 .agent-bubble-user--editing 的注释。 -->
              <div
                v-if="shouldShowMessageBubbleText(msg)"
                class="agent-bubble text-[13px] leading-relaxed"
                :class="[
                  msg.role === 'user' ? 'agent-bubble-user' : 'agent-bubble-assistant',
                  isMessageUnderEdit(msg) ? 'agent-bubble-user--editing' : '',
                  isUserSystemEvent(msg) ? 'agent-bubble-user--system' : '',
                ]"
              >
                <AgentProseBlock
                  v-if="shouldRenderSchemeDraftProse(msg)"
                  :content="msg.content"
                />
                <!-- 已发送用户消息的就地二次编辑（抄 WorkBuddy：默认只显编辑/复制，点编辑才出发送/取消）。
                     编辑态 = 同一张用户卡片的另一种状态，**不是**另一张卡：
                     · 卡片壳（底色 / 描边 / 圆角 / 内边距 / 宽度）全部沿用 .agent-bubble-user；
                     · 正文换成**无缝** textarea（transparent + 无描边 + 零内边距 + display:block），
                       文字起点与展示态正文逐像素对齐 —— 原先它自带 rounded/border/bg 与 p-2，
                       在卡片里套出一块「卡中卡」，正是「看着换了张卡片」的主因；
                     · 底部一排仍落在卡片内、与展示态图标行**同槽同高**（见 .agent-edit-actions）：
                       展示态是「编辑 / 复制 / 复用本轮」，编辑态是「取消 / 发送」，仅此不同；
                     · 该消息的**历史正文**与**操作行**退场（见 isMessageUnderEdit），
                       免得同一段话在 textarea 与下方正文里各出现一次、下面还挂三个无用按钮。 -->
                <p
                  v-else-if="isMessageUnderEdit(msg)"
                  class="agent-edit-card"
                >
                  <textarea
                    v-model="editingDraft"
                    class="agent-edit-textarea w-full resize-y text-[13px] leading-relaxed outline-none"
                    rows="3"
                    @keydown.meta.enter.prevent="sendEditedUserMessage(msg)"
                    @keydown.ctrl.enter.prevent="sendEditedUserMessage(msg)"
                  />
                  <span class="agent-edit-hint mt-1 block text-[10px]">
                    ⓘ 编辑后将从此处重新开始对话，已有产物不会被删除
                  </span>
                  <span class="agent-edit-actions">
                    <button type="button" class="agent-edit-btn" @click="cancelEditUserMessage">取消</button>
                    <button type="button" class="agent-edit-btn agent-edit-btn--primary" @click="sendEditedUserMessage(msg)">发送</button>
                  </span>
                </p>
                <!-- 2026-10-07 顺序调整：执行过程提到**文本之前**（用户口径「操作过程实时流式，
                     先看到过程再看总结」）。原来顺序是 文本 → 画布产出 → 执行过程，
                     读完结论才知发生了什么，且折叠区在底部很难被注意到。 -->
                <AgentExecutionTrace
                  v-if="msg.role === 'assistant' && msg.executionTrace && !liveTrace && !turnTimelineOn"
                  :trace="msg.executionTrace"
                  :streaming="Boolean(msg.streaming)"
                  :collapsed="historyTraceCollapsed(msg)"
                  @update:collapsed="onToggleTrace(msg, $event)"
                  @focus-node="onFocusNode($event)"
                />
                <!-- 宿主回注的系统事件（spec §6.4，PR3）：用户消息带 [系统事件· 前缀时
                     渲染「系统」标签 + 事件态卡片（左侧竖线），见 .agent-bubble-user--system -->
                <span
                  v-if="isUserSystemEvent(msg)"
                  class="agent-system-tag"
                >系统</span>
                <!-- P1（agent-turn-timeline-design §5-P1）：flag 开启且该消息有 timeline 时，
                     由单一时间线组件承接 thinking/text/tool/canvas/artifact/notice，
                     取代下方「旧 trace + 独立正文 + 独立产物 + 独立摘要行」的槽位拼装。
                     产物（artifact）原位出现、摘要 notice 落在最末（D1/D2/现象3/4 的解）。 -->
                <AgentTurnTimeline
                  v-if="useTimeline(msg) && msg.id !== liveTimelineMessageId"
                  class="mt-1.5"
                  :parts="msg.timeline!.parts"
                  :streaming="Boolean(msg.streaming)"
                  :resolve-node-url="resolveCanvasNodeUrl"
                  @retry-node="emit('generateNode', $event)"
                  @focus-node="onFocusNode($event)"
                />
                <p v-if="hasBubbleText(msg) && !isMessageUnderEdit(msg) && !useTimeline(msg)" class="whitespace-pre-wrap">
                  {{
                    msg.role === 'user'
                      ? visibleUserContent(msg)
                      : visibleAssistantContent(msg)
                  }}<span v-if="msg.streaming && hasBubbleText(msg)" class="animate-pulse">▊</span>
                  <span
                    v-if="msg.role === 'assistant' && msg.executionTrace?.totalMs != null && !msg.streaming"
                    class="ml-1 text-[11px] opacity-60"
                  >· {{ formatTraceDuration(msg.executionTrace.totalMs) }}</span>
                </p>
                <AgentRefStrip
                  v-if="msg.role === 'user' && msg.attachments?.length"
                  class="agent-ref-strip--in-user-bubble mt-2"
                  :items="makeAttachmentItems(msg.attachments, msg.attachmentRefKeys)"
                  :removable="false"
                  history-interactive
                  @reattach="reattachFromHistory"
                />
                <!-- SEL-REF R-S8：指代回执。逐消息渲染。数据源是**服务端 selection_binding
                     确认**（评审 C1）：本地 id 快照只作留档，不参与渲染 —— 前端读不到
                     Nest 的 SEL_REF_ENABLED，按快照渲染会让回执在开关关闭时仍在说谎。 -->
                <AgentSelectionBindingChip
                  v-if="msg.role === 'user' && msg.selectionBindingConfirmed?.length"
                  class="mt-2"
                  :node-ids="msg.selectionNodeIds ?? []"
                  :nodes="canvasNodesForBinding"
                  :confirmed="msg.selectionBindingConfirmed"
                />
                <!-- 2026-10-12：「复用本轮（提示词 + 引用）」从气泡正文中段
                     （原为虚线胶囊文字按钮、独占一行）收敛为**图标**，
                     与底部「编辑 / 复制」并列 —— 中段那颗胶囊占掉了气泡内部
                     可编辑空间（用户口径），且同一行里只有它是文字按钮。
                     功能入口不变：判据仍是 canReuseTurn(msg)（role=user 且有正文或引用）。 -->
                <AgentCanvasOutputs
                  v-if="msg.role === 'assistant' && !turnTimelineOn && (assistantOutputsById.get(msg.id)?.length ?? 0) > 0"
                  :outputs="assistantOutputsById.get(msg.id) ?? []"
                  :resolve-node-url="resolveCanvasNodeUrl"
                  @focus-node="onFocusNode($event)"
                  @focus-all="onFocusAll($event)"
                />
                <!-- P0（agent-turn-timeline-design §5 P0-4）：回合摘要行落在产物之后（时间线最末）。
                     条件：assistant + 本回合已结束（!streaming）+ 有 trace + 行非空。
                     P1：timeline 模式下摘要由时间线末尾的 notice part 承担，这里不再重复渲染。 -->
                <p
                  v-if="msg.role === 'assistant' && !turnTimelineOn && !msg.streaming && msg.executionTrace && bubbleSummaryLine(msg)"
                  data-testid="turn-summary-line"
                  class="mt-1 pl-4 text-[10px] text-[var(--lnk-text-muted)]"
                >
                  {{ bubbleSummaryLine(msg) }}
                </p>
                <AgentPresentationHost
                  v-if="historyPresentation(msg)"
                  :presentation="historyPresentation(msg)!"
                  disabled
                  :macro-selected-ids="historyMacroSelectedIds(historyPresentation(msg)!)"
                  @focus-node="onFocusNode($event)"
                  @focus-all="onFocusAll($event)"
                />
                <!--
                  svg_card 独立挂载（spec §4.6）：不进 AgentPresentationHost 的 stepper 布局。
                  门禁复用 hasRenderableSvgCard()（与气泡放行同一判据，不会漂移）：
                  该函数用 `!== undefined` 而非真值 —— 服务端超 SVG_MAX_CHARS 时下发
                  `svg: ""`（字段在、值为空），AgentSvgCard 靠这个区分「过大被丢弃」与
                  「解析失败」并给出可见文案。真值门禁会把该降级分支整条吞掉。

                  ⚠️ 同 switch 分支处的 Ruling-3 约束：净化器（svg-sanitize.ts 的
                  ALLOWED_ELEMENTS / ALLOWED_ATTRS）兜住的是**可表达范围**，管不了
                  **选择器作用域** —— AgentSvgCard 组件自身**没有 <style> 块**，真正
                  document-global 的是**净化后 SVG 内部的 <style>**（ALLOWED_ELEMENTS 收了
                  'style'），经 AgentSvgCard 模板里的 v-html 注入直接落进本文档，无 shadow root、
                  无 scoped。故净化器拦不住「选择器命中卡片以外的元素」。产出方
                  （services/pi-runtime/src/tools/render-canvas-view.ts 的 build* 系列）
                  新增图元时，必须同步过净化器白名单，否则整块被剥；净化器不报错，
                  静默降级成空卡片。
                -->
                <!-- 🔀 A ���案（2026-07）：node_graph 优先、svg_card 降级。
                     v-if / v-else-if 的顺序**就是优先级**（与 stores/agent.ts 的 `??` 左偏一致）。 -->
                <AgentNodeGraph
                  v-if="hasRenderableNodeGraph(msg)"
                  class="mt-2"
                  :body="{ nodes: msg.presentation.body?.graph_nodes ?? [], edges: msg.presentation.body?.graph_edges ?? [], title: msg.presentation.title }"
                  :title="msg.presentation.title"
                  :session-id="sessionId"
                  @focus-node="onFocusNode($event)"
                  @import-to-canvas="emit('importNodeGraph', nodeGraphPayload(msg))"
                />
                <AgentSvgCard
                  v-else-if="hasRenderableSvgCard(msg)"
                  class="mt-2"
                  :svg="msg.presentation.body.svg"
                  :title="msg.presentation.title"
                  :annotations="msg.presentation.body.annotations"
                />
                <!--
                  ⚠️ 工具调用不再在此平铺渲染（2026-10-06 下线 ToolCallCard）：
                  msg.executionTrace 是执行过程的唯一 SSOT（含每条 tool 步 + 人话化文案，
                  数据源与 toolCalls 同一批 SSE 事件）—— 此前两处同屏渲染造成
                  「创建节点 / 处理中 / 提议生成」整组重复出现两遍（刷新后 loadHistory
                  不恢复 toolCalls，所以只在活体会话可见）。活体流式期间由钉底 dense
                  trace 承载（可展开），回落路径见 AgentExecutionTrace。
                -->
                <div
                  v-if="
                    (canShowMessageActions(msg) || canShowUserMessageActions(msg)) &&
                    !isMessageUnderEdit(msg)
                  "
                  class="agent-msg-actions"
                >
                  <template v-if="msg.role === 'assistant'">
                  <button
                    type="button"
                    class="agent-msg-action-btn"
                    :class="{ 'is-active': messageFeedback[msg.id] === 'up' }"
                    title="有帮助"
                    aria-label="有帮助"
                    @click="toggleMessageFeedback(msg.id, 'up')"
                  >
                    <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M7 11v8m0-8V7a2 2 0 0 1 2-2h1.5a1.5 1.5 0 0 1 1.4 1.02l1.12 3.36a2 2 0 0 0 1.9 1.34H17a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-1.5l-.84 2.52A1.5 1.5 0 0 1 13.18 21H10a2 2 0 0 1-2-2v-8z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="agent-msg-action-btn"
                    :class="{ 'is-active': messageFeedback[msg.id] === 'down' }"
                    title="无帮助"
                    aria-label="无帮助"
                    @click="toggleMessageFeedback(msg.id, 'down')"
                  >
                    <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M17 13V5m0 8v3a2 2 0 0 1-2 2h-1.5a1.5 1.5 0 0 1-1.4-1.02l-1.12-3.36a2 2 0 0 0-1.9-1.34H7a2 2 0 0 0-2 2v1a2 2 0 0 0 2 2h1.5l.84-2.52A1.5 1.5 0 0 0 10.82 3H14a2 2 0 0 1 2 2v8z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="agent-msg-action-btn"
                    :class="{ 'is-active': copiedMessageId === msg.id }"
                    :title="copiedMessageId === msg.id ? '已复制' : '复制回复'"
                    aria-label="复制回复"
                    @click="copyAssistantMessage(msg)"
                  >
                    <svg v-if="copiedMessageId !== msg.id" viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                      <rect x="9" y="9" width="11" height="11" rx="2" />
                      <path stroke-linecap="round" d="M5 15V5a2 2 0 0 1 2-2h10" />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </button>
                  </template>
                  <template v-else>
                    <button
                      type="button"
                      class="agent-msg-action-btn"
                      title="编辑"
                      aria-label="编辑"
                      @click="editUserMessage(msg)"
                    >
                      <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="agent-msg-action-btn"
                      :class="{ 'is-active': copiedMessageId === msg.id }"
                      :title="copiedMessageId === msg.id ? '已复制' : '复制'"
                      aria-label="复制"
                      @click="copyUserMessage(msg)"
                    >
                      <svg v-if="copiedMessageId !== msg.id" viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                        <rect x="9" y="9" width="11" height="11" rx="2" />
                        <path stroke-linecap="round" d="M5 15V5a2 2 0 0 1 2-2h10" />
                      </svg>
                      <svg v-else viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </button>
                    <!-- 复用本轮：图标化（原为气泡中段的虚线胶囊文字按钮）。
                         文案移入 title/aria-label，行内只留 ↺ 图标 —— 与 编辑/复制 同尺寸同权重。 -->
                    <button
                      v-if="canReuseTurn(msg)"
                      type="button"
                      class="agent-msg-action-btn"
                      title="复用本轮（提示词 + 引用）"
                      aria-label="复用本轮（提示词 + 引用）"
                      data-testid="reuse-turn-btn"
                      @click="reattachTurnFromHistory(msg)"
                    >
                      <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                        <path stroke-linecap="round" stroke-linejoin="round" d="M1 4v6h6" />
                      </svg>
                    </button>
                  </template>
                </div>
              </div>
            </div>
            <!-- P1-4.1：回合产出收据行 —— 消息流末尾（产出卡片之后）、composer 侧入口。
                 不重构消息渲染本体（Out of Scope §1）。文案由 composer/turnReceipt.ts 纯模块给出：
                 「定位到画布」复用既有 focus-all 事件（同 AgentCanvasOutputs 的 locatableNodeIds 口径）；
                 「全部保留」= 当前行为（无操作确认态）；
                 「撤销本轮」在 runtime 批量移除工具落地前 disabled（评估见 docs/adr/0010）。 -->
            <div
              v-if="lastTurnReceipt"
              class="agent-turn-receipt"
              data-testid="turn-receipt"
            >
              <span class="agent-turn-receipt__summary">
                {{ lastTurnReceiptLead }}
                <span class="agent-turn-receipt__dot">·</span>
                <button
                  type="button"
                  class="agent-turn-receipt__link"
                  data-testid="turn-receipt-focus"
                  @click="onReceiptFocusAll"
                >定位到画布</button>
              </span>
              <span class="agent-turn-receipt__actions">
                <button
                  type="button"
                  class="agent-turn-receipt__btn"
                  data-testid="turn-receipt-keep-all"
                >{{ lastTurnReceipt.keepAll }}</button>
                <button
                  type="button"
                  class="agent-turn-receipt__btn"
                  data-testid="turn-receipt-undo"
                  disabled
                  :title="TURN_UNDO_DISABLED_TITLE"
                >{{ lastTurnReceipt.undoTurn }}</button>
              </span>
            </div>
            <AgentTaskProgressCard
              v-if="showTaskCardAtComposer"
              class="mx-3"
              :progress="taskProgress"
              @focus-node="onFocusNode($event)"
            />
            <!-- 2026-10-15（三滚动条治理 2/2）：live 态对话内容移回主滚动流——
                 用户口径「composer 上方的对话内容是一整套页面，只有思考消息流自带滚动条」。
                 此前这些块挂在 dock 外层独立滚动容器（.agent-dock-scroll--scrollable）里，
                 与消息列表构成两个割裂的滚动上下文；dock 现在只留 composer。
                 2/2 同时把 dense 卡片限高滚动收回卡片自身（唯一允许的内嵌滚动），
                 #416 的「历史滑不动」在流内结构下不复存在（内容全在 flex-1 滚动区里）。
                 注：门控决策注释（确认入口收敛）随内容一并搬移，仍然有效。 -->
            <!-- 活体过程卡：钉在 composer 上方（P0 决策 1）；回合收束后由上面的气泡内 trace 接管。
                 P2-2：flag on 时改用 AgentTurnTimeline(dense)，与历史气泡同一套 parts 渲染。 -->
            <AgentExecutionTrace
              v-if="liveTrace && !liveTimeline"
              class="agent-live-trace mb-1"
              :trace="liveTrace"
              :streaming="agent.isStreaming"
              :collapsed="liveTraceCollapsed"
              dense
              @update:collapsed="onToggleLiveTrace"
              @focus-node="onFocusNode($event)"
            />
            <AgentTurnTimeline
              v-else-if="liveTimeline"
              class="agent-live-trace mb-1"
              :parts="liveTimeline.parts"
              :resolve-node-url="resolveCanvasNodeUrl"
              :streaming="agent.isStreaming"
              dense
              @retry-node="onLiveTimelineRetry"
              @focus-node="onFocusNode($event)"
            />
            <!-- 阻塞等待 propose_generation（2026-10-14 移入 dock）：等待期回合内容钉在上方
                 live 时间线、气泡内近空，提示条留在消息流会被视觉顶到内容「上面」；
             移到 live 区之下、状态行之上 = 视觉上落在回合内容「下面」、贴 composer。
             Q2（2026-10-15）传送门升级：整句文案即「点击定位节点」传送门——点击文案本身
             就把视口送到画布节点（fitView + 定位闪烁），不再让定位能力藏在句尾小按钮里
             （用户反馈：「升级点击定位节点传送门」）。无 nodeId 时降级为纯文本。 -->
            <!--
              P1-5 移动端裸条形态：等待/收口系统层（proposeWait 提示 / 旧状态行 waiting·failed·settled /
              ask_user 卡 / 取消提示）已移出 chat-wrap（其下、输入区之上）——移动端不渲染对话流，
              但这些阻塞交互必须贴条可达；桌面视觉位置不变。门控决策注释随内容一并搬移。 -->
            <!--
              侧栏门控/确认卡已全量下线（2026-10-06 决策）：以下旧分支被删除 ——
              retake 提示、图片质检门、宏观方案卡、方案多选卡、定稿交付卡、shot/topo/copy
              确认行。判据是它们**没有任何生产者**：老 LangGraph runtime 2026-09-27 退役，
              `GET /agent/thread-state` 恒返 null（agent.service.ts「checkpoint 随它一起消失」），
              runtime/Nest 都不再发 `interrupt` / `done` 门控事件。
              确认入口收敛为两处：**画布节点「生成」按钮**（propose 阻塞等待）与**直接输入文字**。
            -->
          </div>
            <!-- 回看历史时的回到底部入口：仅在未跟随底部时出现 -->
            <button
              v-if="!followLatest"
              type="button"
              class="agent-jump-latest"
              data-testid="jump-to-latest"
              :title="hasNewBelow ? '下方有新消息，回到底部' : '回到底部'"
              @click="jumpToLatest"
            >
              <span v-if="hasNewBelow" class="agent-jump-dot" aria-hidden="true"></span>
              <span>{{ hasNewBelow ? '有新消息' : '回到底部' }}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14m0 0-5-5m5 5 5-5" />
              </svg>
            </button>
          </div>

          <!-- 等待/收口系统层（P1-5 自 chat-wrap 移出）：桌面 = 输入区正上方原位；
               移动端 = 贴底容器内、裸条上方的系统层（阻塞交互贴条可达） -->
          <div
            v-if="proposeWait"
            class="mx-0.5 mb-1 rounded-xl border border-warning-border bg-warning-bg px-3 py-2 text-[12px] text-warning"
            data-testid="propose-wait-hint"
          >
            <p v-if="turnHasFailedStep" data-testid="failed-step-warning" class="mb-1 text-[11px] leading-4" :style="{ color: 'var(--lnk-text-muted)' }">
              ⚠️ 本轮有执行失败的步骤（如参考图挂载），确认生成前请检查执行记录。
            </p>
            <div class="flex items-start gap-2">
              <span class="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-warning"></span>
              <p class="flex-1 leading-relaxed">
                点👉🏻图标锚定画布「查看提示词」
              </p>
            </div>
            <div class="mt-1.5 flex items-center gap-1.5">
              <button
                v-if="proposeWait.nodeId"
                type="button"
                class="inline-flex h-7 items-center gap-1 rounded-lg border border-warning-border bg-white px-2 text-[11px] font-medium text-warning hover:bg-warning-bg-hover hover:border-warning-border-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-overlay/40"
                data-testid="propose-wait-locate"
                aria-label="点击定位到画布上待确认的节点"
                @click="locateProposeNode"
              >
                <!-- 定位锚图标：标准定位/瞄准字形（品牌 45° 定位锚 PNG 未入库，先用内联 SVG；要品牌对角字形再落库替换） -->
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                </svg>
                <span>定位</span>
              </button>
              <button
                type="button"
                class="rounded-lg border border-warning-border bg-white px-2 py-1 text-[11px] font-medium text-warning hover:bg-warning-bg-hover hover:border-warning-border-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-overlay/40"
                data-testid="propose-wait-cancel"
                @click="cancelBlockingPropose"
              >
                取消
              </button>
            </div>
          </div>
          <!-- P1-3.1 双显修复（T8 review 裁决）：流式 running 态由 composer-status-line
               独占播报；本行只保留 waiting / failed / settled 态，避免阶段+积分双重显示 -->
          <p
            v-if="turnStatus && !(agent.isStreaming && turnStatus.mode === 'running')"
            class="agent-turn-status mx-0.5 mb-1 text-[11px]"
            :class="`agent-turn-status--${turnStatus.mode}`"
            data-testid="turn-status-line"
          >
            {{ turnStatus.text }}
            <span v-if="turnStatus.hint" class="ml-1 opacity-70">{{ turnStatus.hint }}</span>
          </p>
          <!-- ask_user 卡片贴 composer（2026-10-14，P1-5 移出 chat-wrap）：等待态的唯一交互面贴输入框；
               pendingAskUser 是 live-only 状态（提交/取消即清），无历史持久化诉求。 -->
          <AskUserCard
            v-if="pendingAskUser.length && lastMessageIsAssistant"
            class="mx-0.5 mb-2"
            :questions="pendingAskUser"
            @submit="onAskSubmit"
            @cancel="onAskCancel"
          />
          <div
            v-if="showCancelledCallout"
            class="mb-2 px-0.5"
            data-testid="run-cancelled-callout"
          >
            <p
              class="mb-2 rounded-lg border border-[var(--lnk-border-subtle)] bg-[var(--lnk-surface-raised)] px-2 py-1.5 text-xs leading-relaxed text-[var(--lnk-text-secondary)]"
            >
              {{ cancelledCalloutText }}
            </p>
            <button
              type="button"
              class="neo-ctl agent-preset-primary rounded-lg px-3 py-1.5 text-xs font-medium"
              data-testid="new-task-chip"
              :disabled="agent.isStreaming || isUploading"
              @click="startNewTask()"
            >
              发起新任务
            </button>
          </div>

          <!-- 底部输入 dock：与节点 dock-studio 同款毛玻璃 -->
          <div class="agent-input-area shrink-0 px-2.5 pb-2.5 pt-1">
            <!-- 2026-10-15（治理 2/2）：dock 不再承载对话内容与滚动——
                 live 时间线 / 提示卡 / ask 卡已移回上方主滚动流；这里只剩 composer 与其周边固定件。 -->
            <!-- P1-3.1：生成中状态行——输入区上方、ref 芯片层之上，≤24px。
                 左=阶段文案（执行轨迹聚合）、中=细进度条（无比例源 → 不确定态）、
                 右=预估剩余时长 + 本轮预估积分（成本未知段隐藏）。
                 停止键仍在 DockGenerateButton 同一槽位切换（P1-3.2 保护项，不动坐标）。 -->
            <div
              v-if="agent.isStreaming"
              class="composer-status-line"
              role="status"
              aria-live="polite"
            >
              <span class="composer-status-phase">{{ composerStatus.phase }}</span>
              <span
                class="composer-status-track"
                :class="{ 'is-indeterminate': composerProgressPct === null }"
                aria-hidden="true"
              >
                <span
                  class="composer-status-fill"
                  :style="composerProgressPct ? { width: composerProgressPct } : undefined"
                />
              </span>
              <span v-if="composerStatus.eta" class="composer-status-eta">{{ composerStatus.eta }}</span>
              <span v-if="composerStatus.points" class="composer-status-points">{{ composerStatus.points }}</span>
            </div>
            <div
              ref="composerDockRef"
              class="agent-input-dock"
              :class="{
                'is-drop-target': isDragOver,
              }"
              data-testid="agent-input-dock"
              @dragover.prevent="onDragOver"
              @dragleave.prevent="onDragLeave"
              @drop.prevent="onDrop"
              @pointerdown="onInputDockPointerDown"
              @focusin="onComposerFocusIn"
              @focusout="onComposerFocusOut"
            >
              <div
                v-if="showHistoryReattachCoachmark"
                class="agent-history-coachmark mx-0.5 mb-2 flex items-start gap-2 rounded-xl border px-3 py-2 text-[11px] leading-snug"
                role="status"
              >
                <span class="min-w-0 flex-1 text-[var(--lnk-text-secondary)]">
                  点击历史消息中的 ↺ 引用可再次加入输入框；点消息右下角的 ↺ 可一键带回提示词与全部引用。
                </span>
                <button
                  type="button"
                  class="agent-history-coachmark__dismiss shrink-0 rounded-md px-2 py-0.5 text-[10px] font-medium"
                  @click="dismissHistoryReattachCoachmark"
                >
                  知道了
                </button>
              </div>
                <!--
                流式中的插话槽位（2026-10-02 重写）：不打断当前轮，两个动作分别是 vendor 队列的
                两种送达时机 —— 立即插话(steer) / 等跑完再说(followUp)，互斥二选一。
                pending = 等你点（不自动派发）；accepted = 已入队（常驻，不自动收）；
                applied = agent 已开口/动手（由 QUEUE_APPLIED_EVENTS 推进，替代原先让模型复述一句的做法）；
                failed = 入队失败，文字保留在槽位里，只能「取回输入框」或「放弃」。
              -->
              <div
                v-if="queued"
                class="agent-queued-bubble mx-3 mb-2 rounded-lg border px-3 py-2"
                :class="queued.state === 'failed'
                  ? 'border-[var(--lnk-error)]/40 bg-[var(--lnk-error)]/10'
                  : queued.state === 'pending'
                    ? 'border-[var(--lnk-accent)]/40 bg-[var(--lnk-accent)]/10'
                    : 'border-[var(--lnk-success)]/40 bg-[var(--lnk-success)]/10'"
                :data-queue-state="queued.state"
                :data-queue-intent="queued.intent ?? ''"
              >
                <div class="flex items-start gap-2">
                  <span
                    class="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
                    :class="queued.state === 'failed'
                      ? 'bg-[var(--lnk-error)]/20 text-[var(--lnk-error)]'
                      : queued.state === 'pending'
                        ? 'bg-[var(--lnk-accent)]/20 text-[var(--lnk-accent)]'
                        : 'bg-[var(--lnk-success)]/20 text-[var(--lnk-success)]'"
                  >
                    {{
                      queued.state === 'pending'
                        ? '待发'
                        : queued.state === 'failed'
                          ? '未送达'
                          : queued.state === 'applied'
                            ? '已接住'
                            : '已入队'
                    }}
                  </span>
                  <p class="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--lnk-text-primary)]">{{ queued.text }}</p>
                </div>
                <p
                  v-if="queued.hint"
                  class="mt-1 text-[11px] leading-snug text-[var(--lnk-text-muted)]"
                  data-testid="queued-hint"
                >
                  {{ queued.hint }}
                </p>
                <div class="mt-1.5 flex flex-wrap items-center gap-2">
                  <template v-if="queued.state === 'pending'">
                    <!--
                      有未作答的卡时，两条动作都还是能点的（用户可能就是想在选之前补一句），
                      但必须把「会排在你的答案之后」说在前面 —— 否则点下去得到的是
                      「已并入当前回答」，而那一轮根本没在回答（2026-10-02 组合漏洞）。
                    -->
                    <p
                      v-if="pendingAskBlocking"
                      class="w-full text-[11px] leading-snug text-[var(--lnk-text-muted)]"
                      data-testid="queued-ask-blocked-hint"
                    >
                      agent 正在等你作答 · 下面这两条都会排在你答完这张卡之后（建议先答这张卡）
                    </p>
                    <button type="button" class="queued-act queued-act--primary" @click="deliverQueued('steer')">
                      ⏵ 立即插话{{ pendingAskBlocking ? '（答完这张卡后接）' : '' }}
                    </button>
                    <button type="button" class="queued-act" @click="deliverQueued('followup')">
                      🕒 等它跑完再说
                    </button>
                    <button type="button" class="queued-act" @click="requeueQueued">✎ 取回内容</button>
                    <button type="button" class="queued-act" @click="dismissQueued">🗑 放弃</button>
                  </template>
                  <template v-else>
                    <button v-if="queued.state === 'failed'" type="button" class="queued-act queued-act--primary" @click="requeueQueued">
                      ✎ 取回内容
                    </button>
                    <button type="button" class="queued-act" @click="dismissQueued">
                      {{ queued.state === 'accepted' || queued.state === 'applied' ? '知道了' : '放弃' }}
                    </button>
                  </template>
                </div>
              </div>
              <!-- P1-5 移动端底部裸条（三态共条）：
                   本容器桌面端 display:contents（dock 内布局零改动）；移动端成为贴底裸条表面，
                   内部经 CSS 摊平为 [芯片行?][＋/文本/模型⌄/发送]。系统层（composer-status-line /
                   插话选项）在本条上方；文本直接落条内（无内嵌输入框）；◎ 锚条左顶点。 -->
              <div
                class="composer-bare-bar"
                role="group"
                aria-label="消息输入"
                :class="{
                  'is-stacked': mobileBarShape === 'stacked',
                  'is-idle': mobileBarIdle,
                  'is-holding': holdActive,
                  'is-cancel': holdActive && voiceCancelled,
                }"
                data-testid="composer-bare-bar"
                @pointerdown="onBarPointerDown"
                @pointerup="onBarPointerUp"
                @pointercancel="onBarPointerCancel"
              >
                <!-- P1-5.3 判据锚：条内控件 = ＋（aria-label="更多"）/ ◎（左顶点）/ 模型⌄ / 发送，
                     均 ghost 无背景；空闲态条内仅 ＋ + 「按住说话 · 点按输入」提示；
                     条级手势排除子控件命中（pointerdown/up closest 排除 + 子控件 @click.stop） -->
              <div class="agent-composer">
                <p
                  v-if="showComposerReattachHint"
                  class="agent-composer-reattach-hint mb-1.5 px-0.5 text-[10px] leading-snug text-[var(--lnk-text-muted)]"
                >
                  点击上方历史消息中的 ↺ 引用，或消息右下角的 ↺，可再次加入本次对话
                </p>
                <p
                  v-if="showProductVisualAttachmentHint && !pendingAttachmentItems.length"
                  class="agent-composer-attachment-hint mb-1.5 px-0.5 text-[10px] leading-snug text-[var(--lnk-text-muted)]"
                  data-testid="pv-attachment-hint"
                >
                  {{ PRODUCT_VISUAL_GUIDANCE.attachmentHint }}
                </p>
                <AgentRefStrip
                  v-if="pendingAttachmentItems.length"
                  class="agent-composer__refs"
                  :items="pendingAttachmentItems"
                  :removable="true"
                  @remove="sidebar.remove"
                  @mention="insertRefMention"
                  @reorder="sidebar.reorder"
                />
                <!-- 录音态（P2-2.2/Task 13 接 onComposerHold 后可达）：复用既有 agent-composer-rec -->
                <template v-if="isMobileLayout && holdActive">
                  <div class="agent-composer-rec" data-testid="agent-voice-recording">
                    <span class="agent-composer-rec__mic" aria-hidden="true">
                      <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75">
                        <rect x="9" y="2" width="6" height="12" rx="3" />
                        <path stroke-linecap="round" d="M5 10a7 7 0 0 0 14 0" />
                        <path stroke-linecap="round" d="M12 17v5" />
                      </svg>
                    </span>
                    <span class="agent-composer-rec__text">
                      {{ voiceCancelled ? '松开取消' : (voiceFinalText + voiceInterim || '正在聆听…') }}
                    </span>
                    <span class="agent-composer-rec__time">{{ formatRecTime(voiceElapsedSec) }}</span>
                  </div>
                  <p class="agent-composer-rec__hint" :class="{ 'is-cancel': voiceCancelled }">
                    {{ voiceCancelled ? '已取消 · 松开放弃' : '松开发送 · 上滑取消' }}
                  </p>
                </template>
                <div v-else class="agent-composer__input-wrap">
                <MentionInput
                  ref="composerRef"
                  v-model="input"
                  class="agent-composer__mention w-full"
                  :mentions="mentionOptions"
                  :placeholder="agent.isStreaming
                    ? '输入消息…加入待发队列'
                    : inputPlaceholder"
                  :disabled="readOnly || isUploading"
                  :leading-inset="readOnly || isMobileLayout ? 0 : COMPOSER_PICK_INSET"
                  :mobile-enter-newline="isMobileLayout"
                  submit-on-enter
                  @submit="onComposerSubmit"
                />
                  <button
                    v-if="canvasRefEntryVisible"
                    type="button"
                    class="composer-canvas-ref-btn agent-hit-expand"
                    :class="{ 'is-active': pickMode.active.value }"
                    :disabled="isUploading"
                    data-hit="l"
                    aria-label="引用画布节点"
                    @click.stop="toggleCanvasRefPick"
                  >
                    <CanvasRefTargetIcon :size="14" :filled="pickMode.active.value" />
                  </button>
                </div>
                <!-- P1-5.3 空闲态 affordance：纯 span 提示（非 placeholder）；桌面恒不渲染 -->
                <span v-if="mobileBarIdle" class="composer-bar-hint">按住说话 · 点按输入</span>
              </div>
              <input
                ref="fileInputRef"
                type="file"
                class="sr-only"
                multiple
                :disabled="readOnly || isUploading"
                @change="onFileChange"
              >

              <div class="agent-dock-actions">
                <!-- 「+」提升为 actions 首子元素（2026-10-15 二次重构，对齐 WorkBuddy 红批注
                     「+号移到左边」）：移动端伸展态位于底行最左；收缩态经 display:contents
                     单行化后位于输入框左侧。桌面视觉顺序不变（原本就是 params 第一位）。 -->
                <div ref="attachMenuRef" class="agent-attach-menu relative">
                    <button
                      type="button"
                      class="dock-ghost-ctl agent-hit-expand flex h-8 w-8 items-center justify-center rounded-lg"
                      aria-label="更多"
                      data-hit="l"
                      :class="{ 'is-open': attachMenuOpen }"
                      :disabled="readOnly || isUploading"
                      :title="readOnly ? '只读画布不能添加参考素材' : '添加引用素材'"
                      @click.stop="toggleAttachMenu"
                    >
                      <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75">
                        <path stroke-linecap="round" d="M12 5v14M5 12h14" />
                      </svg>
                    </button>
                    <div
                      v-if="attachMenuOpen"
                      class="neo-popover absolute bottom-full left-0 z-30 mb-1 w-[220px] rounded-xl py-1"
                      @click.stop
                    >
                      <button
                        type="button"
                        class="neo-popover-item flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs"
                        @click="pickLocalUpload"
                      >
                        <span class="agent-attach-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-full">
                          <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M12 16V4m0 0l-4 4m4-4l4 4" />
                            <path stroke-linecap="round" d="M4 17v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1" />
                          </svg>
                        </span>
                        <span>本地上传</span>
                      </button>
                      <button
                        type="button"
                        class="neo-popover-item flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs"
                        @click="pickAssetLibrary"
                      >
                        <span class="agent-attach-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-full">
                          <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                            <rect x="3" y="5" width="18" height="14" rx="2" />
                            <path stroke-linecap="round" d="M3 9h18M8 5V3m8 2V3" />
                          </svg>
                        </span>
                        <span>我的资产库</span>
                      </button>
                      <!-- P1-2.4 裁决 fix-1：C 抽屉「思考档位」= 参数预设槽位，与 B chip 共用同一 popover/状态 -->
                      <button
                        v-if="showPlanningThinkingControls"
                        type="button"
                        class="neo-popover-item flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs"
                        @click="attachMenuOpen = false; toggleThinkingMenu()"
                      >
                        <span class="agent-attach-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-full">
                          <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                            <path stroke-linecap="round" d="M4 8h8M20 8h-4M4 16h4M20 16h-8" />
                            <circle cx="14" cy="8" r="2" />
                            <circle cx="10" cy="16" r="2" />
                          </svg>
                        </span>
                        <span>思考档位</span>
                      </button>
                    </div>
                </div>

                <div class="agent-dock-params">
                  <UniversalModelSelector
                    v-if="shouldShowModelChip(activeSkillId)"
                    v-model="planningModel"
                    type="text"
                    ghost
                    class="agent-model-hit"
                  />

                  <!-- P1-2.1：B 级 chip 仅非默认档常驻；默认档经 C 抽屉「思考档位」进入同一 popover，写回原状态通道
                       （agent-dock-thinking：移动端裸条按 spec §5.5 只留 +/模型/发送，此槽位 CSS 隐藏） -->
                  <div
                    v-if="showPlanningThinkingControls || thinkingMenuOpen"
                    ref="thinkingMenuRef"
                    class="agent-dock-thinking relative"
                  >
                    <button
                      v-if="currentThinkingLevel !== '标准'"
                      type="button"
                      class="dock-ghost-ctl flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs"
                      :class="{ 'is-open': thinkingMenuOpen }"
                      :disabled="props.readOnly"
                      title="思考档位"
                      @click="toggleThinkingMenu"
                    >
                      <span>{{ levelLabel(currentThinkingLevel) }}</span>
                      <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    <div
                      v-if="thinkingMenuOpen"
                      class="neo-popover absolute bottom-full left-0 z-30 mb-1 w-[132px] rounded-xl py-1"
                      @click.stop
                    >
                      <button
                        v-for="lv in THINKING_LEVELS"
                        :key="lv"
                        type="button"
                        class="neo-popover-item flex w-full items-center justify-between px-3 py-2 text-left text-xs"
                        :class="{ 'is-selected': lv === currentThinkingLevel }"
                        :disabled="props.readOnly"
                        @click="setPlanningThinkingLevel(lv)"
                      >
                        <span>{{ lv }}</span>
                        <span v-if="lv === currentThinkingLevel" class="opacity-60">✓</span>
                      </button>
                    </div>
                  </div>

                  <div ref="skillMenuRef" class="relative">
                  <button
                    type="button"
                    class="agent-skill-trigger dock-ghost-ctl flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs"
                    :class="{ 'is-open': skillMenuOpen, 'has-value': activeSkillId !== null }"
                    title="技能"
                    @click="skillMenuOpen = !skillMenuOpen"
                  >
                    <span class="agent-skill-trigger__icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM16.5 6.75h.008v.008H16.5V6.75z" />
                      </svg>
                    </span>
                    <span class="max-w-[72px] truncate font-medium">{{ skillButtonLabel }}</span>
                  </button>
                  <div
                    v-if="skillMenuOpen"
                    class="neo-popover absolute bottom-full left-0 z-30 mb-1 w-[240px] rounded-xl py-1"
                    @click.stop
                  >
                    <button
                      type="button"
                      class="neo-popover-item agent-popover-skill-item flex w-full items-start gap-2 px-3 py-2 text-left"
                      :class="{ 'is-selected': activeSkillId === null }"
                      @click="activeSkillId = null; skillMenuOpen = false"
                    >
                      <span class="agent-skill-icon mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
                        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                        </svg>
                      </span>
                      <span class="min-w-0">
                        <span class="text-xs font-medium">自动</span>
                        <span class="block truncate text-[10px] opacity-60">平台路由，单张/图生图优先</span>
                      </span>
                    </button>
                    <div class="mx-3 my-1 border-t border-[var(--lnk-border-subtle)] opacity-40" />
                    <button
                      v-for="skill in AGENT_SKILLS"
                      :key="skill.id"
                      type="button"
                      class="neo-popover-item agent-popover-skill-item flex w-full items-start gap-2 px-3 py-2 text-left"
                      :class="{ 'is-selected': skill.id === activeSkillId }"
                      @click="activeSkillId = skill.id; skillMenuOpen = false"
                    >
                      <span class="agent-skill-icon mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
                        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                        </svg>
                      </span>
                      <span class="min-w-0">
                        <span class="text-xs font-medium">{{ skill.label }}</span>
                        <span class="block truncate text-[10px] opacity-60">{{ skill.desc }}</span>
                      </span>
                    </button>
                    <p v-if="!AGENT_SKILLS.length" class="px-3 py-2 text-[10px] opacity-50">暂无已安装技能</p>
                  </div>
                </div>
                </div>

                <div class="agent-dock-primary">
                  <!-- 还原收缩态麦克风图标：移动端点按麦克风 + 长按录音双通道（#423 原始设计） -->
                  <DockMicButton
                    :listening="speech.listening.value"
                    :disabled="agent.isStreaming || isUploading"
                    @toggle="toggleVoice"
                  />
                  <DockGenerateButton
                    :generating="agent.isStreaming"
                    :disabled="isUploading || (!agent.isStreaming && !canSubmitComposer)"
                    @generate="send"
                  />
                </div>
              </div>
              </div>
              <!-- /composer-bare-bar -->
            </div>
          </div>
        </div>
      </Teleport>
      <ForceChoiceDialog
        v-model="forceChoiceOpen"
        :kind="forceChoiceKind"
        @action="onForceChoiceAction"
      />
      <AgentAssetPicker v-model:open="assetPickerOpen" @pick="addAssetReference" />
    </div>
  </aside>
</template>

<style scoped>
.agent-side-rail {
  position: relative;
  background: var(--lnk-surface-canvas);
  transition: width 0.3s ease, background 0.25s ease;
}

.agent-side-rail.is-docked-open {
  border-left: 1px solid var(--lnk-border-subtle);
}

.agent-side-rail.is-resizing {
  transition: none;
}

/* ---- 收缩态右下角 logo 悬浮按钮 ---- */
.agent-fab {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 55;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.agent-fab:hover {
  transform: scale(1.08);
}

/* ---- 面板外壳 ---- */
.agent-panel-inline {
  position: relative;
  background: var(--lnk-surface-canvas);
}

.agent-panel-floating {
  position: fixed;
  z-index: 60;
  height: min(680px, calc(100vh - 72px));
  max-width: calc(100vw - 32px);
  border: 1px solid var(--lnk-border-default);
  border-radius: 20px;
  background: var(--lnk-surface-overlay);
  box-shadow: var(--lnk-shadow-lg);
  backdrop-filter: blur(28px) saturate(1.4);
  -webkit-backdrop-filter: blur(28px) saturate(1.4);
  overflow: hidden;
}

.agent-panel-floating.is-dragging {
  user-select: none;
}

/* ---- P1-5 移动端贴底裸条容器（替代全屏 sheet）----
 * 面板不再是一张卡：容器透明、不挡画布（pointer-events 穿透空区），
 * 内部 = 系统层（状态行 / 插话选项，仅生成态）+ composer-bare-bar 一条贴底。
 * 画布始终露出上半且可点（P1-5.1/5.2），全面屏底部 home indicator 由
 * env(safe-area-inset-bottom) 让位（Android inset=0 时无副作用）。 */
/* 复合选择器压过模板上的 Tailwind h-full / overflow-hidden 工具类 */
.agent-panel-mobile-dock.agent-panel-shell {
  position: fixed;
  bottom: env(safe-area-inset-bottom, 0px);
  right: 12px;
  left: 12px;
  z-index: 70;
  height: auto;
  max-height: none;
  overflow: visible;
  border: none;
  background: transparent;
  box-shadow: none;
  pointer-events: none;
}

.agent-panel-mobile-dock > * {
  pointer-events: auto;
}

/* 系统层不承载卡片视觉：dock 只做布局容器，表面只有裸条一条 */
.agent-panel-mobile-dock .agent-input-dock {
  padding: 0;
  border: none;
  background: transparent;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.agent-panel-mobile-dock .agent-input-dock::before {
  display: none;
}

.agent-panel-mobile-dock .agent-input-area {
  padding: 0;
}

/* P1-5 fix-1：顶栏在移动端收为 slim 行（新建/历史入口），桌面顶栏样式不动 */
.agent-panel-mobile-dock .agent-panel-header {
  padding: var(--lnk-space-1) var(--lnk-space-2);
  border-bottom: none;
}

/* P1-5 fix-2：历史 popover 在贴底容器内改为向上展开——顶栏贴视口底，向下开
   会随容器高度（会话短时更矮）超出视口底、历史不可达；桌面 popover 行为不变
   （本规则仅在 .agent-panel-mobile-dock 作用域内生效，压过模板 top-full/mt-1.5） */
.agent-panel-mobile-dock .agent-panel-header .neo-popover {
  top: auto;
  bottom: calc(100% + var(--lnk-space-1));
  margin-top: 0;
}

/* P1-5 fix-1：移动端对话流限高滚动——画布始终露出上半（P1-5.1），不遮罩不加 sheet */
.agent-panel-mobile-dock .agent-chat-wrap {
  flex: 0 0 auto;
  min-height: 0;
  max-height: 40vh;
}

/* ---- 左边缘拖拉调宽 ---- */
.agent-resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -3px;
  z-index: 5;
  width: 7px;
  cursor: ew-resize;
}

.agent-resize-handle::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 2px;
  background: transparent;
  transition: background 0.15s ease;
}

.agent-resize-handle:hover::after {
  background: color-mix(in srgb, var(--lnk-hi-text) 35%, transparent);
}

.agent-panel-floating .agent-resize-handle {
  left: 0;
}

.agent-panel-header {
  border-bottom: 1px solid var(--lnk-border-subtle);
}

.agent-subtitle {
  color: var(--lnk-text-muted);
}

.agent-head-btn {
  display: flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: var(--lnk-text-muted);
  transition: background 0.15s ease, color 0.15s ease;
}

.agent-head-btn:hover {
  background: var(--lnk-hover-overlay);
  color: var(--lnk-text-primary);
}

.agent-head-btn.is-active {
  background: var(--lnk-hi-bg);
  color: var(--lnk-hi-text);
  box-shadow: var(--lnk-hi-shadow);
}

.agent-readonly-btn {
  border-radius: 8px;
  /* P6：amber 硬编码收编为 warning 三件套（P2d 在本文件转了 Tailwind 类，此处是 SCSS 漏网）。
     文字用实色 --lnk-warning：浅色主题下原 amber-100 压浅玻璃不可读，amber-800 修复。 */
  border: 1px solid var(--lnk-warning-border);
  background: rgba(0, 0, 0, 0.15);
  padding: 4px 10px;
  font-size: var(--lnk-text-2xs);
  line-height: 1.4;
  color: var(--lnk-warning);
  transition: background 0.15s ease, border-color 0.15s ease;
}

.agent-readonly-btn:hover {
  background: var(--lnk-warning-bg);
  border-color: var(--lnk-warning-border-hover);
}

.agent-readonly-btn-primary {
  border-color: var(--lnk-warning-border-hover);
  background: var(--lnk-warning-bg);
  color: var(--lnk-warning);
}

.agent-readonly-btn-primary:hover {
  background: var(--lnk-warning-bg-hover);
}

/* ---- 消息列表：面板内唯一的主滚动上下文（治理 2/2 起对话内容全在此） ----
 * ⚠️ 2026-10-15（三滚动条治理 1/2）：此处原有 `flex: 1 1 45%` + `min-height: min(360px, 52%)`。
 * ① 冲突：scoped 选择器带 [data-v-x] 属性，特异性高于模板上的 Tailwind `flex-1 min-h-0`
 *    ⇒ 那两个类是**死类**，`min-h-0`（滚动容器正确收缩的前提）实际从未生效。
 * ② 危害：`min-height` 硬下限即使内容很少也强行占高，加剧多滚动条与布局抖动。
 * ⇒ 只保留布局必需项（flex 列 + gap）；伸缩与收缩交给模板的 flex-1 min-h-0 单一来源。
 * （2/2：live 态对话内容已移入本容器，dock 不再有第二个滚动上下文。）
 */
.agent-chat-scroll {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ---- 回到底部浮标（回看历史时出现） ---- */
.agent-jump-latest {
  position: absolute;
  right: 14px;
  bottom: 10px;
  z-index: 6;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: var(--lnk-text-2xs);
  line-height: 1;
  color: var(--lnk-hi-text);
  background: color-mix(in srgb, var(--lnk-hi-bg) 88%, transparent);
  box-shadow: var(--lnk-shadow-md);
  backdrop-filter: blur(8px);
  transition: background 0.15s ease, transform 0.15s ease;
  animation: agent-jump-in 0.16s ease-out;
}

.agent-jump-latest:hover {
  background: var(--lnk-hi-bg);
  transform: translateY(-1px);
}

.agent-jump-latest svg {
  width: 12px;
  height: 12px;
}

.agent-jump-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: #f87171;
}

@keyframes agent-jump-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 2026-10-15（治理 2/2）：.agent-dock-scroll / --scrollable 已随结构删除——
 * dock 只留 composer，对话内容全部在 .agent-chat-scroll 主滚动流里，
 * 面板内常驻滚动上下文唯一。
 * dense 时间线卡片的限高（用户口径「思考消息流自带滚动条」）规则本体
 * 在各组件自身 scoped style：AgentTurnTimeline / AgentExecutionTrace 的 --dense。 */

.agent-turn--user {
  display: flex;
  justify-content: flex-end;
  padding: 0 12px;
}

.agent-turn--assistant {
  width: 100%;
  padding: 0 12px;
}

.agent-empty {
  color: var(--lnk-text-muted);
}

.agent-pv-example-btn {
  border-color: var(--lnk-border-subtle);
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-secondary);
  transition: border-color 0.15s ease, background 0.15s ease;
}

.agent-pv-example-btn:hover {
  border-color: var(--lnk-accent, var(--lnk-border-subtle));
  background: color-mix(in srgb, var(--lnk-surface-raised) 92%, var(--lnk-accent, #888) 8%);
}

/*
 * P1-1：首屏通用样例 chips —— ghost 样式，仅用 --lnk-* L2 令牌。
 * 样例属系统层内容而非控件：surface-raised 底 + border-default 描边
 * 是线框指南 §4 对样例 chips 的许可组合；不引入 hex/rgba。
 */
.agent-example-chip {
  border-color: var(--lnk-border-default);
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-secondary);
  transition: border-color 0.15s ease, color 0.15s ease;
}

.agent-example-chip:hover {
  border-color: var(--lnk-border-strong);
  color: var(--lnk-text-primary);
}

.agent-example-chip:focus-visible {
  outline: none;
  border-color: var(--lnk-border-focus);
}

/*
 * P1-4.1：回合产出收据行 —— 消息流末尾的轻量汇总条。
 * 仅消费 --lnk-* L2 令牌（禁新增 hex，design-token.test.ts 守卫）。
 * 文本按钮沿用 ghost 组合（surface-raised 底 + border-default 描边），
 * 与样例 chips 同一许可组合（线框指南 §4）。
 */
.agent-turn-receipt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--lnk-space-2);
  margin: var(--lnk-space-1) var(--lnk-space-3) 0;
  padding: var(--lnk-space-1) var(--lnk-space-2);
  border: 1px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-md);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  color: var(--lnk-text-muted);
}

.agent-turn-receipt__dot {
  margin: 0 var(--lnk-space-1);
  color: var(--lnk-text-muted);
}

.agent-turn-receipt__link {
  padding: 0;
  border: none;
  background: none;
  color: var(--lnk-text-secondary);
  font-size: inherit;
  line-height: inherit;
  cursor: pointer;
  transition: color 0.15s ease;
}

.agent-turn-receipt__link:hover {
  color: var(--lnk-text-primary);
}

.agent-turn-receipt__link:focus-visible {
  outline: none;
  color: var(--lnk-text-primary);
}

.agent-turn-receipt__actions {
  display: inline-flex;
  align-items: center;
  gap: var(--lnk-space-2);
  flex-shrink: 0;
}

.agent-turn-receipt__btn {
  padding: 0 var(--lnk-space-2);
  border: 1px solid var(--lnk-border-default);
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-secondary);
  font-size: inherit;
  line-height: inherit;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;
}

.agent-turn-receipt__btn:hover {
  border-color: var(--lnk-border-strong);
  color: var(--lnk-text-primary);
}

.agent-turn-receipt__btn:focus-visible {
  outline: none;
  border-color: var(--lnk-border-focus);
}

.agent-turn-receipt__btn:disabled {
  border-color: var(--lnk-border-subtle);
  color: var(--lnk-text-disabled);
  cursor: not-allowed;
}

.agent-composer-attachment-hint {
  border-left: 2px solid var(--lnk-border-subtle);
  padding-left: 8px;
}

.agent-bubble-user {
  max-width: 88%;
  border: 1px solid var(--agent-user-border);
  border-radius: 16px;
  background: var(--agent-user-bg);
  color: var(--agent-user-text);
  box-shadow: var(--agent-user-shadow);
  padding: 8px 12px;
}

/*
 * 编辑态宽度基准 = 展示态的宽度上限。
 *
 * 展示态：`max-width: 88%` + 内容撑满 —— 正文够长时卡片就取满 88%（用户截图那张即是）。
 * 编辑态：正文被换成一张 textarea，天然比正文窄，`max-width` 拦不住 shrink-to-fit，
 *         卡片会被收窄到 ~288px，看起来「换了张卡片」（用户 2026-10-12 口径）。
 * ⇒ 显式给同一张卡片补上 width: 88%，两种状态同一外形；`max-width: 88%` 仍在兜底。
 *   展示态**不动**（没有这条类），短消息的窄气泡照旧。
 */
.agent-bubble-user--editing {
  width: 88%;
}

/*
 * 宿主回注的系统事件消息（spec §6.4，PR3）：「[系统事件·」前缀的用户轮次。
 * 视觉上必须一眼区别于真人发言：左侧竖线 + info 语义面 + 「系统」标签。
 * 令牌只消费 L2（--lnk-info-* / --lnk-text-* / --lnk-radius-*），
 * 禁新增 hex（design-token.test.ts 守卫）。
 */
.agent-bubble-user--system {
  max-width: 100%;
  border: 1px solid var(--lnk-info-border);
  border-left-width: 3px;
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-info-bg);
}

.agent-system-tag {
  display: inline-block;
  margin-bottom: var(--lnk-space-1);
  padding: 0 var(--lnk-space-2);
  border: 1px solid var(--lnk-info-border);
  border-radius: var(--lnk-radius-full);
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
}

.agent-bubble-assistant {
  width: 100%;
  max-width: none;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--agent-assistant-text);
  box-shadow: none;
  padding: 4px 0 8px;
}

.agent-bubble-assistant :deep(.agent-tools) {
  border-color: var(--agent-assistant-divider);
}

.agent-bubble-assistant :deep(.agent-canvas-outputs) {
  border-color: var(--agent-assistant-divider);
}

.agent-msg-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 8px;
  opacity: 0.55;
  transition: opacity 0.15s ease;
}

.agent-turn--assistant:hover .agent-msg-actions,
.agent-msg-actions:focus-within {
  opacity: 1;
}

.agent-msg-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--agent-assistant-muted);
  transition: background 0.15s ease, color 0.15s ease;
}

.agent-msg-action-btn:hover {
  background: var(--lnk-hover-overlay);
  color: var(--lnk-text-primary);
}

.agent-msg-action-btn.is-active {
  background: var(--lnk-pressed-overlay);
  color: var(--lnk-text-primary);
}

/* 用户气泡内引用 chip：棋盘底 + 描边，白/浅图也能辨认 */
.agent-bubble-user :deep(.dock-ref-chip.has-media) {
  border-color: color-mix(in srgb, var(--agent-user-text) 16%, transparent);
  background-color: var(--agent-user-media-bg);
  background-image:
    linear-gradient(45deg, var(--agent-user-media-checker) 25%, transparent 25%),
    linear-gradient(-45deg, var(--agent-user-media-checker) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--agent-user-media-checker) 75%),
    linear-gradient(-45deg, transparent 75%, var(--agent-user-media-checker) 75%);
  background-size: 8px 8px;
  background-position: 0 0, 0 4px, 4px -4px, -4px 0;
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, #fff 42%, transparent),
    var(--lnk-shadow-xs);
}

.agent-bubble-user :deep(.dock-ref-chip.has-media .dock-ref-chip__key) {
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.75);
}

.agent-bubble-user :deep(.dock-ref-chip:not(.has-media)) {
  border-color: color-mix(in srgb, var(--agent-user-text) 14%, transparent);
  background: color-mix(in srgb, var(--agent-user-text) 8%, transparent);
  color: color-mix(in srgb, var(--agent-user-text) 72%, transparent);
}

.agent-bubble-user :deep(.dock-ref-chip:not(.has-media) .dock-ref-chip__key) {
  color: var(--agent-user-text);
  text-shadow: none;
}

/* 「复用本轮」按钮样式（.agent-bubble-reuse-btn）已于 2026-10-12 删除：
   该入口收敛为 .agent-msg-action-btn 图标按钮，与 编辑/复制 共用同一套样式。 */

.agent-history-coachmark {
  border-color: color-mix(in srgb, var(--lnk-hi-text) 14%, var(--lnk-border-subtle));
  background: color-mix(in srgb, var(--lnk-hi-bg) 8%, var(--lnk-hover-overlay));
}

.agent-history-coachmark__dismiss {
  border: 1px solid var(--lnk-border-subtle);
  background: var(--lnk-hi-bg);
  color: var(--lnk-hi-text);
  box-shadow: var(--lnk-hi-shadow);
}

.agent-composer-reattach-hint {
  border-left: 2px solid color-mix(in srgb, var(--lnk-hi-text) 18%, transparent);
  padding-left: 8px;
}

.agent-tools {
  border-top: 1px solid var(--lnk-border-subtle);
}

/* ---- 流式中待发消息气泡（排队，抄 WorkBuddy） ---- */
.agent-queued-bubble {
  animation: agent-queued-in 0.18s ease;
}

@keyframes agent-queued-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ⚠️ 别用 --lnk-hi-bg 配 --lnk-text-primary：--lnk-hi-bg 深主题是纯白 #ffffff、浅主题是深色 #17181d，
   而 --lnk-text-primary 深主题近白、浅主题近黑 —— 「底色与字色同向」，两个主题都会把字吞掉。
   中性高亮控件的正确配对是 --lnk-hi-bg 配 --lnk-hi-text；这里次级动作不用高亮块，
   改用 surface 底 + 主文字色（两个主题都保证对比度）。 */
.queued-act {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--lnk-border-strong);
  border-radius: 999px;
  background: var(--lnk-surface-raised);
  padding: 2px 9px;
  font-size: var(--lnk-text-2xs);
  line-height: 1.5;
  color: var(--lnk-text-primary);
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.queued-act:hover {
  background: color-mix(in srgb, var(--lnk-text-primary) 12%, var(--lnk-surface-raised));
  border-color: color-mix(in srgb, var(--lnk-text-primary) 28%, transparent);
}

.queued-act--primary {
  border-color: color-mix(in srgb, var(--lnk-accent) 45%, transparent);
  /* --lnk-accent 是固定紫 #6d5dfc，深底上对比度不够；--lnk-accent-text 深底亮紫 / 浅底深紫 */
  color: var(--lnk-accent-text);
  background: color-mix(in srgb, var(--lnk-accent) 10%, transparent);
}

.queued-act--primary:hover {
  background: color-mix(in srgb, var(--lnk-accent) 18%, transparent);
}

/* ---- 已发送用户消息就地二次编辑（同一张用户卡片的编辑态，不是另一张卡） ----
 * 这里的每一条都是「与展示态对齐」的：卡片壳与宽度由 .agent-bubble-user（+--editing）负责，
 * 本块只负责把 textarea 做无缝、把底部一排按钮摆回展示态图标行的槽位。 */
.agent-edit-card {
  display: block;
}

/* 无缝正文：去掉 rounded/border/bg/p-2，文字起点与展示态正文完全对齐。
 * display:block 顺手消掉 textarea 作为 inline-block 时的基线余隙。 */
.agent-edit-textarea {
  display: block;
  font-family: inherit;
  background: transparent;
  border: 0;
  padding: 0;
  color: inherit;
}

/* 提示语取用户气泡自己的文字色（而非全局 --lnk-text-muted）：
 * 它落在 --agent-user-bg 上，跟随气泡的明暗才不会有对比度缺口。 */
.agent-edit-hint {
  color: color-mix(in srgb, var(--agent-user-text) 62%, transparent);
}

/* 展示态图标行 .agent-msg-actions 的同槽：同样的左对齐、8px 顶距、26px 行高。
 * 不共用那个类是因为它有 opacity: 0.55 + hover 才到 1 —— 编辑中的按钮必须常亮。 */
.agent-edit-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

/* 同上：次级按钮不能用 --lnk-hi-bg + --lnk-text-primary 的同向配色（白底白字 / 深底深字） */
.agent-edit-btn {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  border: 1px solid var(--lnk-border-strong);
  border-radius: 999px;
  background: var(--lnk-surface-raised);
  padding: 2px 12px;
  font-size: var(--lnk-text-2xs);
  line-height: 1.6;
  color: var(--lnk-text-primary);
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.agent-edit-btn:hover {
  background: color-mix(in srgb, var(--lnk-text-primary) 12%, var(--lnk-surface-raised));
}

.agent-edit-btn--primary {
  border-color: color-mix(in srgb, var(--lnk-accent) 45%, transparent);
  color: var(--lnk-accent-text);
  background: color-mix(in srgb, var(--lnk-accent) 12%, transparent);
}

.agent-edit-btn--primary:hover {
  background: color-mix(in srgb, var(--lnk-accent) 20%, transparent);
}

.agent-turn--user:hover .agent-msg-actions,
.agent-bubble-user:hover ~ .agent-msg-actions {
  opacity: 1;
}

/* ---- P1-3.1：生成中状态行（输入区上方 ≤24px；只用 --lnk-* L2 令牌） ---- */
.composer-status-line {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  margin: 0 2px 2px;
  overflow: hidden;
  font-size: var(--lnk-text-2xs);
  line-height: 16px;
  color: var(--lnk-text-muted);
}

.composer-status-phase {
  flex: none;
  white-space: nowrap;
}

.composer-status-track {
  position: relative;
  flex: 1;
  height: 3px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--lnk-ink-200);
}

.composer-status-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 0;
  border-radius: 2px;
  background: var(--lnk-accent);
  transition: width 0.3s var(--lnk-ease-standard, ease);
}

/* 无完成比例数据源 → 不确定态（扫动），绝不渲染假进度 */
.composer-status-track.is-indeterminate .composer-status-fill {
  width: 30%;
  animation: composer-status-sweep 1.2s ease-in-out infinite;
}

@keyframes composer-status-sweep {
  from {
    left: -30%;
  }
  to {
    left: 100%;
  }
}

/* ---- 底部输入 dock（对齐 dock-studio 毛玻璃） ---- */
.agent-input-dock {
  position: relative;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  overflow: visible;
  border: 1px solid var(--lnk-border-default);
  border-radius: 18px;
  background: var(--lnk-surface-glass);
  backdrop-filter: blur(var(--lnk-glass-blur)) saturate(1.5);
  -webkit-backdrop-filter: blur(var(--lnk-glass-blur)) saturate(1.5);
  box-shadow: var(--lnk-shadow-xl);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.agent-input-dock::before {
  content: '';
  position: absolute;
  top: 0;
  right: 20px;
  left: 20px;
  height: 1px;
  pointer-events: none;
  background: linear-gradient(90deg, transparent, var(--lnk-glass-topline), transparent);
}

.agent-input-dock:focus-within {
  border-color: color-mix(in srgb, var(--lnk-hi-text) 28%, var(--lnk-border-default));
  box-shadow:
    var(--lnk-shadow-xl),
    0 0 0 2px color-mix(in srgb, var(--lnk-hi-text) 14%, transparent);
}

.agent-input-dock.is-drop-target {
  border-color: color-mix(in srgb, var(--lnk-hi-text) 35%, var(--lnk-border-subtle));
  background: var(--lnk-hover-overlay);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--lnk-hi-text) 18%, transparent);
}

.agent-prompt-field {
  width: 100%;
  min-height: 76px;
  max-height: 180px;
  resize: none;
  border: none;
  background: transparent;
  outline: none;
  font-size: var(--lnk-text-sm);
  line-height: 1.55;
  color: var(--lnk-text-primary);
}

.agent-prompt-field::placeholder {
  color: var(--lnk-text-muted);
}

.agent-dock-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding-top: 6px;
}

.agent-dock-params {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.agent-dock-primary {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.agent-skill-icon {
  background: var(--lnk-hover-overlay);
  color: var(--lnk-text-secondary);
  transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
}

.agent-skill-trigger__icon {
  display: inline-flex;
  color: var(--lnk-text-secondary);
  transition: color 0.15s ease;
}

.agent-skill-trigger:hover .agent-skill-trigger__icon,
.agent-skill-trigger.is-open .agent-skill-trigger__icon {
  color: var(--lnk-text-primary);
}

.agent-skill-trigger.has-value {
  border-color: color-mix(in srgb, var(--lnk-hi-text) 12%, var(--lnk-border-subtle));
  background: color-mix(in srgb, var(--lnk-hi-bg) 10%, var(--lnk-hover-overlay));
}

.agent-skill-trigger.has-value .agent-skill-trigger__icon {
  color: var(--lnk-text-primary);
}

.agent-popover-skill-item.is-selected {
  background: var(--lnk-hi-bg) !important;
  color: var(--lnk-hi-text) !important;
  box-shadow: var(--lnk-hi-shadow);
}

.agent-popover-skill-item.is-selected .agent-skill-icon {
  background: color-mix(in srgb, var(--lnk-hi-text) 10%, transparent);
  color: var(--lnk-hi-text);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--lnk-hi-text) 12%, transparent);
}

.agent-preset-primary {
  background: var(--lnk-hi-bg) !important;
  color: var(--lnk-hi-text) !important;
  border-color: transparent !important;
  box-shadow: var(--lnk-hi-shadow);
}

.agent-preset-primary:hover:not(:disabled) {
  filter: brightness(1.04);
}

/* ---- P1 回合状态行 ---- */
.agent-turn-status {
  color: var(--lnk-text-muted);
}

.agent-turn-status--failed {
  color: #fca5a5;
}

.agent-turn-status--waiting {
  color: var(--lnk-text-secondary);
}

.agent-composer {
  min-width: 0;
}

.agent-composer__refs {
  margin-bottom: 4px;
}

.agent-composer__input-wrap {
  position: relative;
  min-width: 0;
  width: 100%;
  overflow: visible;
}

.agent-composer__mention {
  min-width: 0;
}

/* ---- P0-4 移动端命中区扩展（视觉尺寸不变，基线 B8: 24/28/32） ----
 * 透明 ::after 外扩可点区域：24px 控件（mic，data-hit="m"）→ inset -10px 凑满 44px；
 * 28/32px 控件（generate 锚 / ＋ / 模型 chip，data-hit="l"）→ inset -8px。
 * 仅 ≤767px 生效，桌面命中区与视觉完全不变。 */
.agent-hit-expand {
  position: relative;
}

.agent-hit-expand::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
}

/* 模型 chip：触发按钮在 UniversalModelSelector 组件内部，class 落在组件根 wrapper 上，
 * 需 :deep 穿透把同一扩展挂到真实按钮 */
.agent-model-hit > :deep(button) {
  position: relative;
}

.agent-model-hit > :deep(button)::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
}

@media (max-width: 767px) {
  .agent-hit-expand[data-hit='m']::after {
    inset: -10px; /* 24px → 44px */
  }

  .agent-hit-expand[data-hit='l']::after {
    inset: -8px; /* 28/32px → 44px+ */
  }

  .agent-model-hit > :deep(button)::after {
    inset: -8px;
  }
}

/* ---- P1-5 移动端底部裸条（三态共条，对齐线稿 §3） ----
 * 桌面：.composer-bare-bar 仅是 display:contents 的透明容器 —— dock 内布局零改动。
 * 移动端（.agent-panel-mobile-dock 作用域）：容器成为裸条表面，内部摊平为
 *   [ref 芯片行?] + [＋ / 文本 / 模型⌄ / 发送]（stacked 双行、idle/queued 单行）。
 * idle：条内仅 ＋ + 「按住说话 · 点按输入」提示（P1-5.3），radius-full、min-height 48；
 * queued（生成中无引用）：占位「输入消息…加入待发队列」+ 发送槽位换停止（P1-3.2）。
 * 表面 = surface-raised + border-default + shadow-sm；文本直接落条内，无内嵌输入框；
 * ◎ absolute 锚条左顶点（.composer-canvas-ref-btn 既有 translate(-50%,-50%) 规则不变，
 *   移动端把 .agent-composer__input-wrap 改 static，让条成为 ○ 的包含块）。 */
.composer-bare-bar {
  display: contents;
}

/* 复合选择器压过模板上的 Tailwind 工具类；仅移动端 shell 内生效 */
.agent-panel-mobile-dock .composer-bare-bar {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--lnk-space-1);
  min-height: 48px;
  padding: 0 var(--lnk-space-2);
  border: 1.5px solid var(--lnk-border-default);
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-raised);
  box-shadow: var(--lnk-shadow-sm);
  transition:
    border-color var(--lnk-duration-fast) var(--lnk-ease-standard),
    box-shadow var(--lnk-duration-fast) var(--lnk-ease-standard);
}

.agent-panel-mobile-dock .composer-bare-bar:focus-within {
  border-color: var(--lnk-border-focus);
  box-shadow: var(--lnk-shadow-sm), 0 0 0 2px var(--lnk-accent-subtle);
}

/* 空闲态手势面：条自身禁掉滚动手势接管，否则按住时 pointermove/up 被浏览器打断 */
.agent-panel-mobile-dock .composer-bare-bar.is-idle {
  touch-action: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
  cursor: pointer;
}

/* stacked：芯片行独占一行（basis 100% 强制换行），输入行 ＋/文本/模型⌄/发送 */
.agent-panel-mobile-dock .composer-bare-bar.is-stacked {
  border-radius: var(--lnk-radius-xl);
  padding: var(--lnk-space-1) var(--lnk-space-2);
}

/* 摊平 agent-composer / dock-actions：同一套 DOM，桌面/移动两种编排 */
.agent-panel-mobile-dock .composer-bare-bar .agent-composer,
.agent-panel-mobile-dock .composer-bare-bar .agent-dock-actions {
  display: contents;
}

.agent-panel-mobile-dock .composer-bare-bar .agent-composer__refs {
  order: -2;
  flex: 1 1 100%;
  margin-bottom: 0;
}

.agent-panel-mobile-dock .composer-bare-bar .agent-attach-menu {
  order: -1;
  flex-shrink: 0;
}

.agent-panel-mobile-dock .composer-bare-bar .agent-composer__input-wrap {
  order: 0;
  position: static; /* 让 ◎ 的包含块上移到裸条（左顶点锚定） */
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
}

.agent-panel-mobile-dock .composer-bare-bar .agent-composer__mention {
  flex: 1 1 auto;
  min-width: 0;
}

.agent-panel-mobile-dock .composer-bare-bar .agent-dock-params {
  order: 1;
  display: flex;
  flex: 0 0 auto;
  flex-wrap: nowrap;
  align-items: center;
}

.agent-panel-mobile-dock .composer-bare-bar .agent-dock-primary {
  order: 2;
  flex-shrink: 0;
  margin-left: 0;
}

/* 空闲态：条内只留 ＋ + 提示（P1-5.3：不常驻模型/发送/独立 mic） */
.agent-panel-mobile-dock .composer-bare-bar.is-idle .agent-composer__input-wrap,
.agent-panel-mobile-dock .composer-bare-bar.is-idle .agent-dock-params,
.agent-panel-mobile-dock .composer-bare-bar.is-idle .agent-dock-primary {
  display: none;
}

/* 输入/生成态：条上控件 = ＋/模型/发送 3 个（spec §5.5）——思考槽位、技能、独立 mic 隐藏 */
.agent-panel-mobile-dock .composer-bare-bar .agent-dock-thinking,
.agent-panel-mobile-dock .composer-bare-bar .agent-skill-trigger,
.agent-panel-mobile-dock .composer-bare-bar .dock-mic-btn {
  display: none;
}

/* 单行提示行（桌面卡内提示不适用于裸条） */
.agent-panel-mobile-dock .composer-bare-bar .agent-composer-reattach-hint,
.agent-panel-mobile-dock .composer-bare-bar .agent-composer-attachment-hint {
  display: none;
}

/* 空闲 affordance：纯文本提示（非 placeholder），与条内 ＋ 同行 */
.agent-panel-mobile-dock .composer-bar-hint {
  order: 0;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  padding-left: 2px;
  font-size: var(--lnk-text-base);
  line-height: var(--lnk-lh-base);
  color: var(--lnk-text-muted);
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 条内文本直接落表面（两层契约）：压掉 MentionInput 桌面卡的 96px 高度档，
 * 对齐线稿 m-line（min 34）与 m-text（text-base/22）；
 * ◎ 空态隐藏由 canvasRefEntryVisible 门控，文本行起点由条内 ＋ 占位让位（无重叠） */
.agent-panel-mobile-dock .composer-bare-bar :deep(.mention-input-backdrop),
.agent-panel-mobile-dock .composer-bare-bar :deep(.mention-input-field) {
  min-height: 34px;
  max-height: 120px;
  padding: 4px 2px;
  font-size: var(--lnk-text-base);
  line-height: var(--lnk-lh-base);
}

/* 录音中：条描边随状态走（accent=聆听 / red=上滑取消） */
.agent-panel-mobile-dock .composer-bare-bar.is-holding {
  border-color: color-mix(in srgb, var(--lnk-accent-text) 45%, var(--lnk-border-default));
}

.agent-panel-mobile-dock .composer-bare-bar.is-holding.is-cancel {
  border-color: color-mix(in srgb, var(--lnk-red-600) 55%, var(--lnk-border-default));
}

.agent-composer-rec {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 36px;
  padding: 4px 2px;
  user-select: none;
  -webkit-user-select: none;
}

.agent-composer-rec__mic {
  display: inline-flex;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: color-mix(in srgb, var(--lnk-hi-bg) 18%, var(--lnk-hover-overlay));
  color: var(--lnk-hi-text);
  animation: agent-rec-pulse 1.2s ease-in-out infinite;
}

.agent-input-dock.is-cancel .agent-composer-rec__mic {
  color: var(--lnk-error);
  background: color-mix(in srgb, var(--lnk-error) 14%, var(--lnk-hover-overlay));
  animation: none;
}

.agent-composer-rec__text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  font-size: var(--lnk-text-sm);
  line-height: 1.5;
  color: var(--lnk-text-primary);
}

.agent-composer-rec__time {
  flex-shrink: 0;
  font-size: var(--lnk-text-2xs);
  font-variant-numeric: tabular-nums;
  color: var(--lnk-text-muted);
}

.agent-composer-rec__hint {
  margin: 2px 2px 0;
  text-align: center;
  font-size: var(--lnk-text-2xs); /* P0-2.2：原 10px 引导档升 2xs(11px) */
  color: var(--lnk-text-muted);
}

.agent-composer-rec__hint.is-cancel {
  color: var(--lnk-error);
}

@keyframes agent-rec-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

/* ◎ P1-2.3 ghost 入口：22px 视觉、无玻璃底（透明背景/无边框），圆心 = 表面左顶点；
 * PC 命中 32px（透明 ::after inset -5px）；≤767px 由 .agent-hit-expand[data-hit='l'] 扩到 44px。
 * 仅 color 过渡 —— 退役 hover-only 球的全部 halo/lens/光效。 */
.composer-canvas-ref-btn {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 5;
  isolation: isolate;
  overflow: visible;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--lnk-radius-full);
  background: transparent;
  color: var(--lnk-accent-text);
  transform: translate(-50%, -50%);
  transition: color var(--lnk-duration-fast) var(--lnk-ease-standard);
  cursor: pointer;
}

.composer-canvas-ref-btn::after {
  content: '';
  position: absolute;
  inset: -5px;
}

.composer-canvas-ref-btn:hover {
  color: var(--lnk-accent-hover);
}

.composer-canvas-ref-btn:focus-visible {
  outline: 2px solid var(--lnk-border-focus);
  outline-offset: 2px;
}

.agent-attach-icon {
  background: var(--lnk-hover-overlay);
  color: var(--lnk-text-secondary);
}
</style>
