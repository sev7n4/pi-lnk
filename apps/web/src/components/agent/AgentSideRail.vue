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
import AgentAssetPicker from '@/components/agent/AgentAssetPicker.vue'
import AgentTaskProgressCard from '@/components/agent/AgentTaskProgressCard.vue'
import AgentCanvasOutputs from '@/components/agent/AgentCanvasOutputs.vue'
import AgentExecutionTrace from '@/components/agent/AgentExecutionTrace.vue'
import { resolveMessageOutputs } from '@/components/agent/agentCanvasOutputs'
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
import ProductVisualDeliveryCard from '@/components/agent/ProductVisualDeliveryCard.vue'
import AskUserCard from '@/components/agent/AskUserCard.vue'
import ToolCallCard from '@/components/agent/ToolCallCard.vue'
import { collapseToolCalls } from '@/components/agent/collapseToolCalls'
import AgentPresentationHost from '@/components/agent/presentation/AgentPresentationHost.vue'
import AgentProseBlock from '@/components/agent/presentation/AgentProseBlock.vue'
import AgentMacroSchemeCards from '@/components/agent/presentation/AgentMacroSchemeCards.vue'
import { hasSchemeDraftSections, splitAssistantDraftMessage } from '@/components/agent/presentation/schemeDraftProse'
import type { AgentPresentationEnvelope } from '@/components/agent/presentation/types'
import {
  confirmAtomicGeneration as runConfirmAtomicGeneration,
  detectAgentChipSet,
  canvasHasRecipeParent,
  resolveAtomicConfirmNodeId,
  resolvePendingConfirmNodeId,
} from '@/components/agent/agentChipSet'
import { resolveProposeCancelNodeId } from '@/components/agent/proposeWaitActions'
import {
  chipSetFromInterrupt,
  interruptPayloadFromThreadState,
  buildRetakeContinueMessage,
  isRunCancelledState,
  isRetakePendingPhase,
  resolveImageQaBodyText,
  resolveImageQaChecks,
  resolveImageQaOptions,
  resolveImageQaTitle,
  buildSchemeConfirmMessage,
  buildMacroSchemeConfirmMessage,
  buildMacroAbFooterHint,
  buildVisualIntentSummary,
  buildDeliveryConfirmMessage,
  buildDeliveryRefineMessage,
  buildDeliverySwitchMessage,
  buildShotDeliveryConfirmMessage,
  buildShotDeliverySwitchMessage,
  defaultDeliverySelections,
  defaultMacroSchemeSelection,
  toggleMacroSchemeSelection,
  defaultSchemeSelections,
  defaultShotDeliverySelections,
  selectableImageTypes,
  filterAssistantVisibleText,
  filterUserVisibleText,
  buildClientDeliveryGroups,
  resolveGatePrimaryActionLabel,
  type AgentInterruptPayload,
  type ImageQaMetrics,
  type ProductVisualMacroScheme,
  type ProductVisualPlan,
  type ProductVisualShot,
} from '@/components/agent/agentInterruptGate'
import { phaseHintFromInterrupt } from '@/components/agent/executionStepLabels'
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
import UniversalModelSelector from '@/components/canvas/UniversalModelSelector.vue'
import CanvasRefTargetIcon from '@/components/shared/CanvasRefTargetIcon.vue'
import { useCanvasRefPickMode } from '@/composables/useCanvasRefPickMode'
import { formatDuration as formatTraceDuration } from '@/components/agent/executionStepLabels'
import { formatSessionTime, lastThreadStorageKey } from '@/utils/formatSessionTime'
import { randomId } from '@/utils/randomId'
import { submitAnswers } from '@/components/agent/agentAnswers'
import { failureReason, resolveWaiting, turnStatusLine } from '@/components/agent/turnStatusBar'
import { hasBubbleContent, hasBubbleText } from '@/components/agent/bubbleVisibility'
import {
  describeActivity,
  describeRuntimeActivity,
} from '@/components/agent/activityLine'
import { nextChips, type NextChipAction } from '@/components/agent/nextChips'
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
  /** arrange_nodes 工具：agent 触发自动排列（grid / along_edges），CanvasPage 应用布局 */
  arrangeNodes: [payload: { nodeIds: string[]; mode: 'grid' | 'along_edges'; gap: number; edges?: { source: string; target: string }[] }]
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
 * 流式中的待发消息（排队，最多 1 条）。抄 WorkBuddy：流式中输入并回车 → 进入待发气泡，
 * 不打断当前轮；当前轮结束（done）或用户点停止（中止即发）时自动发出。
 */
const queuedMessage = ref('')
/** 已发送用户消息的就地二次编辑：正在编辑的消息 id */
const editingMessageId = ref<string | null>(null)
const editingDraft = ref('')
const composerRef = ref<InstanceType<typeof MentionInput> | null>(null)
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

/**
 * P0 决策 2：零内容不渲染气泡（判定在 bubbleVisibility.ts，纯函数可单测）。
 * 阻塞等待期不产生 token，旧实现「流式恒 true」会留下一个空白气泡 + 闪烁光标 = 白块。
 */
function shouldShowMessageBubbleText(msg: AgentStreamMessage): boolean {
  return hasBubbleContent(msg)
}

function shouldRenderSchemeDraftProse(msg: AgentStreamMessage): boolean {
  if (msg.role !== 'assistant' || msg.streaming) return false
  const { prose } = splitAssistantDraftMessage(msg.content ?? '')
  return productVisualSchemeV2.value && hasSchemeDraftSections(prose)
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

const showPickHint = computed(
  () => !props.readOnly && pendingAttachmentItems.value.length === 0 && !pickMode.active.value,
)

/** 输入框左上角 🎯 圆心重合时的文字起始内边距（半径 + 小间距） */
const COMPOSER_PICK_INSET = 18

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
const showTaskCardAtComposer = computed(
  () => showTaskCard.value && !queuedMessage.value.trim(),
)

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
/** P0-06: authoritative gate from SSE interrupt or thread-state reconnect */
const interruptGate = ref<AgentInterruptPayload | null>(null)
/** LangGraph checkpoint: same thread can regenerate/variant on prior atomic node */
const hasAtomicCheckpoint = ref(false)
/** Phase 2c.3: thread-state atomicNodeId for dock-mapped atomic confirm */
const atomicNodeId = ref<string | null>(null)

const agentStream = useAgentStream({
  onStale: () => {
    streamAbortController?.abort()
  },
})

/** 方案确认门 / 主文案确认门：侧栏快捷钮 */
const lastAssistantMessage = computed(() =>
  [...agent.messages].reverse().find((m) => m.role === 'assistant'),
)

const chipSet = computed(() => {
  // generation_propose chips 已下线（2026-10-01 决策）：propose 确认入口唯一 =
  // 画布节点「生成」按钮（阻塞等待期由琥珀卡指引 + 定位/取消），聊天侧不再出确认卡。
  const fromInterrupt = chipSetFromInterrupt(interruptGate.value)
  if (fromInterrupt) return fromInterrupt

  if (agent.isStreaming) return null
  const last = lastAssistantMessage.value
  // 修复 P1-4：把"最近用户消息"传入 detectAgentChipSet，避免 modify 阶段误显示 plan 按钮
  const lastUser = [...agent.messages].reverse().find((m) => m.role === 'user')
  return detectAgentChipSet(last?.content || '', {
    latestUserText: lastUser?.content,
  })
})

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
  // waiting 收紧：propose pending_confirm 一票通过；文本片段类 chip 需静默 ≥2s
  // （detectAgentChipSet 基于 assistantText 片段匹配，流式途中即可能命中——假阳性防线）
  const waiting = resolveWaiting({
    isStreaming: agent.isStreaming,
    proposePendingConfirm: agent.proposePendingConfirm,
    // 阻塞等待一票通过：等待开始的信号由后端 waiting_user 事件下发
    // （tool_result 要等等待结束才到，靠它反推「等待中」在本语义下恒不成立）
    blockingWait: agent.blockingWait,
    chipSet: chipSet.value,
    textIdleMs: nowSec.value - agent.lastTextDeltaAt,
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
    waitingTool: agent.blockingWait?.toolName ?? null,
    waitingDeadline: agent.blockingWait?.deadlineAt ?? null,
    activity: traceActivity,
    lastFailed,
  })
})
/**
 * 阻塞等待 propose_generation（2026-10-01）：确认动作只存在于画布节点，
 * 聊天侧必须明示「去哪确认 + 一键定位」，否则用户只看到转圈无从下手。
 */
const proposeWait = computed(() =>
  agent.blockingWait?.toolName === 'propose_generation' ? agent.blockingWait : null,
)
function locateProposeNode() {
  const nodeId = proposeWait.value?.nodeId
  if (nodeId) onFocusNode(nodeId)
}

/**
 * 琥珀卡取消（2026-10-01）：只拒绝该节点的生成提议（clear-propose → 节点回 draft，
 * runtime 轮询判 rejected → run 恢复继续对话）；绝不是中止整个 run —— 那是
 * composer「停止」的语义。等待期流式守卫刻意不设（与 locateProposeNode 一致）。
 */
function cancelBlockingPropose() {
  const nodeId = resolveProposeCancelNodeId(agent.blockingWait)
  if (!nodeId) return
  emit('clearProposeGeneration', nodeId)
}

/**
 * 下一步动作（决策 4）：唯一一处 chips 渲染源。
 * 白名单在 nextChips.ts，这里只负责喂输入 —— 未知 chipSet 直接产出空数组 = 不渲染任何按钮。
 */
const dockChips = computed(() =>
  nextChips({
    chipSet: chipSet.value,
    canPromoteVariant: canPromoteVariant.value,
    qaOptions: awaitingImageQa.value
      ? imageQaOptions.value.map((o) => ({ id: o.id, label: o.label, message: o.message }))
      : null,
  }),
)
function runNextChip(action: NextChipAction) {
  switch (action.kind) {
    case 'preset':
      void sendPreset(action.text)
      break
    case 'confirm_atomic':
      confirmAtomicChip()
      break
    case 'cancel_atomic':
      cancelAtomicChip()
      break
    case 'scheme_confirm':
      void sendSchemeConfirm()
      break
    case 'scheme_revise':
      void sendSchemeRevisePreset()
      break
    case 'macro_confirm':
      void sendMacroSchemeConfirm()
      break
    case 'macro_revise':
      void sendMacroSchemeRevise()
      break
    case 'qa_option':
      void sendPreset(action.message)
      break
    default:
      break
  }
}

const awaitingCopyConfirm = computed(() => chipSet.value === 'copy')
const awaitingTopoConfirm = computed(() => chipSet.value === 'topo')
const canPromoteVariant = computed(() => canvasHasRecipeParent(props.canvasNodes))
const awaitingImageQa = computed(() => chipSet.value === 'image_qa' && !isRetakePending.value)
const isRetakePending = computed(() =>
  isRetakePendingPhase({
    phase: interruptGate.value?.phase,
    retakePending: retakePending.value,
  }),
)
const imageQaTitle = computed(() => resolveImageQaTitle(gatePresentation.value))
const imageQaBodyText = computed(() => resolveImageQaBodyText(gatePresentation.value))
const imageQaChecks = computed(() => resolveImageQaChecks(gatePresentation.value))
const imageQaOptions = computed(() => resolveImageQaOptions(gatePresentation.value))
const showRetakeContinueChip = computed(
  () => isRetakePending.value && pendingAttachmentItems.value.length > 0,
)
const retakeCalloutText = computed(() => {
  const pres = gatePresentation.value
  const body = String(pres?.body?.text ?? '').trim()
  if (body) return body
  const title = String(pres?.title ?? '').trim()
  if (title) return title
  return '请上传新照片，上传完成后点继续'
})
const retakeContinueLabel = computed(
  () => gatePresentation.value?.secondary_actions?.[0]?.label ?? '继续',
)
const showCancelledCallout = computed(
  () => isRunCancelledState(threadRunState.value) || runCancelled.value,
)
const cancelledCalloutText = computed(() => {
  const text =
    String(cancelledPresentation.value?.body?.text ?? '').trim() ||
    (cancelledProgressText.value ?? '')
  return text || '当前任务已停止，你可以发起新任务或直接输入新的需求。'
})
const awaitingSchemeSelect = computed(() => chipSet.value === 'scheme_select')
const awaitingMacroSchemeSelect = computed(() => chipSet.value === 'macro_scheme_select')
const awaitingShotConfirm = computed(
  () =>
    interruptGate.value?.phase === 'await_shot_confirm' ||
    interruptGate.value?.node === 'await_shot_confirm' ||
    interruptGate.value?.phase === 'await_shot_topo_confirm' ||
    interruptGate.value?.node === 'await_shot_topo_confirm',
)
const gatePresentation = computed(() => interruptGate.value?.presentation ?? null)
const completionPresentation = ref<AgentPresentationEnvelope | null>(null)
const showCompletionPresentation = computed(
  () => completionPresentation.value?.kind === 'delivery_summary_table',
)
const macroFooterHint = computed(() => {
  const fromPres = String(gatePresentation.value?.body?.footer_hint ?? '').trim()
  if (fromPres) return fromPres
  if (!awaitingMacroSchemeSelect.value || macroSelections.value.length < 2) return ''
  const expectedCount = gatePresentation.value?.body?.expected_delivery_count ?? null
  return buildMacroAbFooterHint(macroSelections.value.length, expectedCount)
})
const deliveryGroupsForUi = computed(() => {
  const fromPres = gatePresentation.value?.body?.groups
  if (fromPres?.length) return fromPres
  if (!awaitingDeliveryConfirm.value || !productVisualSchemeV2.value) return []
  return buildClientDeliveryGroups(
    shotManifest.value,
    deliveryGenByKey.value,
    userRequestLabels.value,
    deliverySelections.value,
  )
})
const deliveryPresentationForUi = computed((): AgentPresentationEnvelope | null => {
  if (!awaitingDeliveryConfirm.value) return null
  if (gatePresentation.value?.kind === 'delivery_cards' && deliveryGroupsForUi.value.length) {
    return {
      ...gatePresentation.value,
      body: {
        ...gatePresentation.value.body,
        groups: deliveryGroupsForUi.value,
        footer_hint:
          gatePresentation.value.body?.footer_hint
          ?? (deliveryGroupsForUi.value.length
            ? `确认后将交付 ${deliveryGroupsForUi.value.length} 张定稿图`
            : undefined),
      },
    }
  }
  if (!productVisualSchemeV2.value || !deliveryGroupsForUi.value.length) return null
  return {
    kind: 'delivery_cards',
    stepper: { current: 'delivery', completed: ['image_qa', 'scheme_draft', 'macro_select', 'generating'] },
    body: {
      hint: '按场景切换定稿图；切换候选不会重新生成。',
      groups: deliveryGroupsForUi.value,
      footer_hint: `确认后将交付 ${deliveryGroupsForUi.value.length} 张定稿图`,
    },
    primary_action: { label: '确认全部定稿', message: '确认全部定稿' },
  }
})
const gatePrimaryActionLabel = computed(() =>
  resolveGatePrimaryActionLabel(gatePresentation.value, interruptGate.value?.phase ?? null),
)
const showGatePresentation = computed(
  () =>
    Boolean(gatePresentation.value?.primary_action) &&
    (awaitingShotConfirm.value || (awaitingTopoConfirm.value && !awaitingShotConfirm.value)),
)
const showDeliveryPresentation = computed(
  () => awaitingDeliveryConfirm.value && Boolean(deliveryPresentationForUi.value),
)
/** 底部 dock 含门控/定稿卡片时，需限高以免挤占聊天滚动区 */
const hasDockPresentation = computed(
  () =>
    showDeliveryPresentation.value
    || showGatePresentation.value
    || awaitingMacroSchemeSelect.value
    || awaitingImageQa.value
    || (awaitingSchemeSelect.value && Boolean(productVisualPlan.value))
    || (awaitingDeliveryConfirm.value && Boolean(productVisualPlan.value) && !productVisualSchemeV2.value)
    || awaitingShotConfirm.value
    || (awaitingTopoConfirm.value && !awaitingShotConfirm.value)
    || isRetakePending.value
    || showCancelledCallout.value,
)
const awaitingDeliveryConfirm = computed(() => chipSet.value === 'delivery_confirm')
const userRequestLabels = ref<string[]>([])
const productVisualPlan = ref<ProductVisualPlan | null>(null)
const macroSchemes = ref<ProductVisualMacroScheme[]>([])
const macroSelections = ref<string[]>([])
const shotManifest = ref<ProductVisualShot[]>([])
const productVisualSchemeV2 = ref(false)
const imageQaReason = ref<string | null>(null)
const imageQaMetrics = ref<ImageQaMetrics | null>(null)
const retakePending = ref(false)
const effectiveUtterance = ref<string | null>(null)
const schemeSelections = ref<Record<string, string[]>>({})
const deliverySelections = ref<Record<string, string>>({})

/** ask_user 阻塞卡（B-6）：生命周期绑定 pending 状态，不再随新 user message 清空（提交/取消才清）。
 * callId 是卡片级提交依据（Task 2 payload），同卡多问题共享同一 callId，逐元素携带便于恢复/拦截取用。 */
const pendingAskUser = ref<Array<{ callId: string; id: string; question: string; options: { label: string; value: string }[]; multiSelect?: boolean; allowOther?: boolean }>>([])
/** 卡片只挂在最后一轮 assistant 回复之后（对话流内，不在消息列表顶部）；用户发新消息后自动隐藏。 */
const lastMessageIsAssistant = computed(() => {
  const msgs = agent.messages
  const last = msgs[msgs.length - 1]
  return !!last && last.role === 'assistant'
})

/** 组件侧回答回传：answerId / payload 组装收敛在 agentAnswers 模块（含明文 HTTP 降级）。 */
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
const deliveryGenByKey = ref<Record<string, { node_id?: string | null; url?: string | null; title?: string | null }>>({})
const deliveryRefineDraft = ref<Record<string, string>>({})
const schemeSelectTypes = computed(() => selectableImageTypes(productVisualPlan.value))
const visualIntentSummary = computed(() => buildVisualIntentSummary(productVisualPlan.value))

function syncSchemeSelectionsFromPlan(plan: ProductVisualPlan | null | undefined) {
  productVisualPlan.value = plan ?? null
  schemeSelections.value = defaultSchemeSelections(plan)
}

function syncMacroSchemes(schemes: ProductVisualMacroScheme[] | null | undefined) {
  macroSchemes.value = schemes ?? []
  macroSelections.value = defaultMacroSchemeSelection(schemes)
}

function syncShotManifest(shots: ProductVisualShot[] | null | undefined) {
  shotManifest.value = shots ?? []
}

function toggleMacroSelection(schemeId: string, checked: boolean) {
  macroSelections.value = toggleMacroSchemeSelection(
    macroSelections.value,
    schemeId,
    checked,
    macroSchemes.value,
  )
}

async function sendMacroSchemeConfirm() {
  const message = buildMacroSchemeConfirmMessage(macroSelections.value)
  await sendMessage(message)
}

async function sendMacroSchemeRevise() {
  await sendMessage('需要调整方案')
}

async function sendShotConfirm() {
  const msg = gatePresentation.value?.primary_action?.message ?? '确认出图'
  await sendPreset(msg)
}

async function onGatePrimaryAction(message: string) {
  await sendPreset(message)
}

function syncCompletionPresentation(
  phase: string | null | undefined,
  presentation: AgentPresentationEnvelope | null | undefined,
) {
  if (phase === 'done' && presentation?.kind === 'delivery_summary_table') {
    completionPresentation.value = presentation
    return
  }
  if (phase !== 'done') {
    completionPresentation.value = null
  }
}

function historyPresentation(msg: AgentStreamMessage): AgentPresentationEnvelope | null {
  if (msg.role !== 'assistant' || msg.streaming || !msg.presentation) return null
  return msg.presentation
}

function historyMacroSelectedIds(presentation: AgentPresentationEnvelope): string[] {
  const schemes = presentation.body?.schemes ?? []
  const recommended = schemes.filter((s) => s.recommended).map((s) => String(s.id))
  if (recommended.length) return recommended
  const maxSelect = presentation.body?.max_select ?? 2
  return schemes.slice(0, maxSelect).map((s) => String(s.id))
}

function syncRetakeFromPayload(data: {
  retakePending?: boolean | null
  effectiveUtterance?: string | null
  phase?: string | null
  presentation?: AgentPresentationEnvelope | null
} | null | undefined) {
  if (!data) return
  const wasRetake = retakePending.value
  if (data.retakePending != null) {
    retakePending.value = Boolean(data.retakePending)
  } else if (isRetakePendingPhase({ phase: data.phase })) {
    retakePending.value = true
  } else if (data.phase != null && !isRetakePendingPhase({ phase: data.phase })) {
    retakePending.value = false
  }
  if (data.effectiveUtterance != null) {
    effectiveUtterance.value = data.effectiveUtterance
  }
  if (retakePending.value && !wasRetake) {
    ElMessage.info(PRODUCT_VISUAL_GUIDANCE.retakeToast)
  }
}

async function sendRetakeContinue() {
  const utterance =
    effectiveUtterance.value?.trim()
    || gatePresentation.value?.secondary_actions?.[0]?.message?.trim()
  if (!utterance) return
  await sendMessage(buildRetakeContinueMessage(utterance))
}

async function sendShotRevise() {
  await sendMessage('调整构图')
}

function syncDeliveryCheckpoint(
  plan: ProductVisualPlan | null | undefined,
  selections: Record<string, string> | null | undefined,
  genByKey: Record<string, { node_id?: string | null; url?: string | null; title?: string | null }> | null | undefined,
) {
  if (plan) productVisualPlan.value = plan
  const merged = productVisualSchemeV2.value && shotManifest.value.length
    ? {
        ...defaultShotDeliverySelections(shotManifest.value, genByKey),
        ...(selections ?? {}),
      }
    : {
        ...defaultDeliverySelections(plan ?? productVisualPlan.value, genByKey),
        ...(selections ?? {}),
      }
  deliverySelections.value = merged
  deliveryGenByKey.value = genByKey ?? deliveryGenByKey.value
}

function toggleSchemeSelection(typeId: string, schemeId: string, checked: boolean) {
  const current = new Set(schemeSelections.value[typeId] ?? [])
  if (checked) current.add(schemeId)
  else current.delete(schemeId)
  schemeSelections.value = { ...schemeSelections.value, [typeId]: [...current] }
}

async function sendSchemeConfirm() {
  const message = buildSchemeConfirmMessage(schemeSelections.value)
  await sendMessage(message)
}

async function sendSchemeRevisePreset() {
  await sendMessage('需要调整方案')
}

async function sendDeliverySwitch(typeId: string, schemeId: string) {
  deliverySelections.value = { ...deliverySelections.value, [typeId]: schemeId }
  await sendMessage(buildDeliverySwitchMessage(typeId, schemeId))
}

async function sendDeliveryRefine(typeId: string, feedback: string) {
  const schemeId = deliverySelections.value[typeId]
  if (!schemeId) return
  await sendMessage(buildDeliveryRefineMessage(typeId, schemeId, feedback))
}

async function sendDeliveryConfirmAll() {
  await sendMessage(buildDeliveryConfirmMessage(deliverySelections.value))
}

async function onDeliveryPrimaryAction(_message: string) {
  if (productVisualSchemeV2.value) {
    await sendMessage(buildShotDeliveryConfirmMessage(deliverySelections.value))
  } else {
    await sendDeliveryConfirmAll()
  }
}

async function sendDeliveryVariantSwitch(shotId: string, variantKey: string) {
  deliverySelections.value = { ...deliverySelections.value, [shotId]: variantKey }
  await sendMessage(buildShotDeliverySwitchMessage(shotId, variantKey))
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

function pickCanvasFromMenu() {
  attachMenuOpen.value = false
  onStartCanvasPick()
}

function onCanvasRefPickToggle() {
  emit('canvasRefPickToggle')
}

function onStartCanvasPick() {
  if (!pickMode.active.value) emit('canvasRefPickToggle')
}

function onInputDockPointerDown(event: PointerEvent) {
  if (!pickMode.active.value) return
  const target = event.target as Element
  if (target.closest('.composer-canvas-pick-btn')) return
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

watch(isMobileLayout, (mobile) => {
  if (mobile) floating.value = false
})

watch(
  () => pickMode.active.value,
  (active) => {
    if (active && isMobileLayout.value && open.value) closePanel()
  },
)

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

/* ---- 技能选择（显式 Skill；默认自动 / 平台路由） ---- */
const activeSkillId = ref<string | null>(null)
const activeSkill = computed(() => getAgentSkill(activeSkillId.value))
const isProductVisualSkill = computed(() => activeSkillId.value === 'product-visual')
const skillButtonLabel = computed(() => activeSkill.value?.label ?? '技能')
const inputPlaceholder = computed(() => agentInputPlaceholder(activeSkill.value))
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
  interruptGate.value = null
  runCancelled.value = false
  threadRunState.value = null
  cancelledPresentation.value = null
  cancelledProgressText.value = null
  hasAtomicCheckpoint.value = false
  atomicNodeId.value = null
  retakePending.value = false
  effectiveUtterance.value = null
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
  scrollToBottom()
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
    interruptGate.value = null
    runCancelled.value = false
    threadRunState.value = null
    cancelledPresentation.value = null
    cancelledProgressText.value = null
    hasAtomicCheckpoint.value = false
    atomicNodeId.value = null
    retakePending.value = false
    effectiveUtterance.value = null
    recoveredPhaseHint.value = null
    void bootstrapThread()
  },
)

function openPanel() {
  if (props.canOpen && !props.canOpen()) return
  if (isMobileLayout.value) floating.value = false
  open.value = true
  emit('expandedChange', true)
  scrollToBottom()
}

function closePanel() {
  open.value = false
  emit('expandedChange', false)
}

function onFocusNode(nodeId: string) {
  emit('focusNode', nodeId)
  if (isMobileLayout.value) closePanel()
}

function onFocusAll(nodeIds: string[]) {
  emit('focusAll', nodeIds)
  if (isMobileLayout.value) closePanel()
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
  interruptGate.value = null
  runCancelled.value = false
  threadRunState.value = null
  cancelledPresentation.value = null
  cancelledProgressText.value = null
  hasAtomicCheckpoint.value = false
  atomicNodeId.value = null
  retakePending.value = false
  effectiveUtterance.value = null
  recoveredPhaseHint.value = null
  agentThreadId.value = createAgentThreadId(props.sessionId)
  persistActiveThreadId(props.sessionId, agentThreadId.value)
  ElMessage.info('已新建对话')
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

async function refreshThreadCheckpoint() {
  try {
    const token = localStorage.getItem('token')
    const res = await fetch(
      apiUrl(`/api/agent/thread-state?threadId=${encodeURIComponent(agentThreadId.value)}`),
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const json = (await res.json()) as {
      data?: {
        hasAtomicCheckpoint?: boolean
        atomicNodeId?: string | null
        interrupted?: boolean
        phase?: string | null
        runCancelled?: boolean | null
        productVisualPlan?: ProductVisualPlan | null
        macroSchemes?: ProductVisualMacroScheme[] | null
        shotManifest?: ProductVisualShot[] | null
        visualIntent?: Record<string, unknown> | null
        productVisualSchemeV2?: boolean | null
        deliverySelections?: Record<string, string> | null
        deliveryGenByKey?: Record<string, { node_id?: string | null; url?: string | null; title?: string | null }> | null
        imageQaReason?: string | null
        imageQaMetrics?: ImageQaMetrics | null
        visionUsed?: boolean | null
        userRequestLabels?: string[] | null
        retakePending?: boolean | null
        effectiveUtterance?: string | null
        presentation?: AgentPresentationEnvelope | null
        selectedMacroSchemeIds?: string[] | null
      }
    }
    hasAtomicCheckpoint.value = Boolean(json.data?.hasAtomicCheckpoint)
    atomicNodeId.value = json.data?.atomicNodeId ? String(json.data.atomicNodeId) : null
    imageQaReason.value = json.data?.imageQaReason ?? null
    imageQaMetrics.value = json.data?.imageQaMetrics ?? null
    syncRetakeFromPayload(json.data)
    syncCompletionPresentation(json.data?.phase, json.data?.presentation)
    if (json.data?.productVisualSchemeV2 != null) {
      productVisualSchemeV2.value = Boolean(json.data.productVisualSchemeV2)
    }
    if (json.data?.macroSchemes) {
      syncMacroSchemes(json.data.macroSchemes)
    }
    if (json.data?.selectedMacroSchemeIds?.length) {
      macroSelections.value = [...json.data.selectedMacroSchemeIds]
    }
    if (json.data?.shotManifest) {
      syncShotManifest(json.data.shotManifest)
    }
    if (json.data?.userRequestLabels) {
      userRequestLabels.value = json.data.userRequestLabels
    }
    if (json.data?.productVisualPlan) {
      syncSchemeSelectionsFromPlan(json.data.productVisualPlan)
    }
    if (json.data?.productVisualPlan || json.data?.deliverySelections || json.data?.deliveryGenByKey) {
      syncDeliveryCheckpoint(
        json.data?.productVisualPlan,
        json.data?.deliverySelections,
        json.data?.deliveryGenByKey,
      )
    }
    syncCancelledFromThreadState(json.data)
    // A cancelled run can still hold a pending gate; chips stay under the callout.
    interruptGate.value = interruptPayloadFromThreadState(json.data)
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
  scrollToBottom()
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
 * 输入框回车提交。流式中不取消当前轮，而是把内容移入待发气泡（排队）；
 * 非流式中走正常发送。底部「停止」按钮走 `send()`，二者分离以匹配 WorkBuddy 行为。
 */
async function onComposerSubmit() {
  if (agent.isStreaming) {
    const text = input.value
    if (text.trim()) {
      queuedMessage.value = text
      input.value = ''
      await nextTick()
      scrollToBottom()
    }
    return
  }
  await send()
}

async function flushQueuedMessage() {
  const text = queuedMessage.value.trim()
  if (!text) return
  queuedMessage.value = ''
  await sendMessage(text)
}

/** ⚡ 打断并发送：立即中止当前轮，把待发消息作为新请求发出 */
async function interruptAndSend() {
  const text = queuedMessage.value.trim()
  if (!text) return
  queuedMessage.value = ''
  await cancelActiveStream()
  await sendMessage(text)
}

/** ✎ 编辑待发：把内容退回输入框（不另开卡片），清空排队 */
function editQueuedMessage() {
  input.value = queuedMessage.value
  queuedMessage.value = ''
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

/** Phase 2c.3: unwind await_atomic_confirm without running atomic gen. */
async function unwindAtomicInterrupt() {
  interruptGate.value = null
  // Fire-and-forget resume revise/cancel so LangGraph leaves the gate; dock owns billing gen.
  void sendPreset('取消')
}

/** Phase 2c.3: atomic chip confirm → dock when node resolvable. */
function confirmAtomicChip() {
  if (agent.isStreaming) return
  const nodeId = resolveAtomicConfirmNodeId({
    canvasNodes: props.canvasNodes,
    selectedNodeId: props.selectedNodeId,
    atomicNodeId: atomicNodeId.value,
    selectedNodeType: props.selectedNode?.type ?? null,
  })
  void runConfirmAtomicGeneration(nodeId, {
    generateForNode: (id) => emit('generateNode', id),
    sendPreset,
    unwindAtomicInterrupt,
  })
}

/** Phase 2c.3: atomic cancel — clear pending if any, else interrupt cancel. */
function cancelAtomicChip() {
  if (agent.isStreaming) return
  const pendingId = resolvePendingConfirmNodeId(props.canvasNodes, props.selectedNodeId)
  if (pendingId) {
    emit('clearProposeGeneration', pendingId)
    interruptGate.value = null
    return
  }
  void sendPreset('取消')
}

async function sendPreset(text: string) {
  if (agent.isStreaming || isUploading.value || !text.trim()) return
  if (!auth.isLoggedIn) {
    auth.openLogin()
    return
  }
  input.value = ''
  await sendMessage(text.trim())
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
  const userMessageExtras = attachments.length
    ? { attachments, attachmentRefKeys }
    : undefined

  if (props.readOnly) {
    agent.addUserMessage(message, userMessageExtras)
    sidebar.clear()
    agent.startAssistantMessage()
    agent.appendText(
      '⚠️ 此画布不属于当前账号，无法写入。请返回工作台新建画布，或使用画布所有者账号登录。',
    )
    agent.finishStreaming()
    await nextTick()
    scrollToBottom()
    return
  }
  agent.addUserMessage(message, userMessageExtras)
  sidebar.clear()
  agent.isStreaming = true
  agent.startAssistantMessage()
  await nextTick()
  scrollToBottom()

  // Generate idempotency key for this request
  const idempotencyKey = buildIdempotencyKey(agentThreadId.value)
  // Track whether SSE stream ended normally (received [DONE])
  let streamEndedNormally = false
  recoveredPhaseHint.value = null
  interruptGate.value = null
  retakePending.value = false
  effectiveUtterance.value = null
  completionPresentation.value = null
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
        focusNodeId: props.selectedNodeId || undefined,
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
        interrupted?: boolean
        finished?: boolean
        nextNodes?: string[]
        hasAtomicCheckpoint?: boolean
        atomicNodeId?: string | null
        productVisualPlan?: ProductVisualPlan | null
        macroSchemes?: ProductVisualMacroScheme[] | null
        shotManifest?: ProductVisualShot[] | null
        visualIntent?: Record<string, unknown> | null
        productVisualSchemeV2?: boolean | null
        deliverySelections?: Record<string, string> | null
        deliveryGenByKey?: Record<string, { node_id?: string | null; url?: string | null; title?: string | null }> | null
        userRequestLabels?: string[] | null
        presentation?: AgentPresentationEnvelope | null
        selectedMacroSchemeIds?: string[] | null
      } | null
    }
    const phase = json.data?.phase ?? null
    syncCompletionPresentation(phase, json.data?.presentation)
    hasAtomicCheckpoint.value = Boolean(json.data?.hasAtomicCheckpoint)
    atomicNodeId.value = json.data?.atomicNodeId ? String(json.data.atomicNodeId) : null
    if (json.data?.productVisualSchemeV2 != null) {
      productVisualSchemeV2.value = Boolean(json.data.productVisualSchemeV2)
    }
    if (json.data?.macroSchemes) {
      syncMacroSchemes(json.data.macroSchemes)
    }
    if (json.data?.selectedMacroSchemeIds?.length) {
      macroSelections.value = [...json.data.selectedMacroSchemeIds]
    }
    if (json.data?.shotManifest) {
      syncShotManifest(json.data.shotManifest)
    }
    if (json.data?.userRequestLabels) {
      userRequestLabels.value = json.data.userRequestLabels
    }
    if (json.data?.productVisualPlan) {
      syncSchemeSelectionsFromPlan(json.data.productVisualPlan)
    }
    if (json.data?.productVisualPlan || json.data?.deliverySelections || json.data?.deliveryGenByKey) {
      syncDeliveryCheckpoint(
        json.data?.productVisualPlan,
        json.data?.deliverySelections,
        json.data?.deliveryGenByKey,
      )
    }
    const cancelled = syncCancelledFromThreadState(json.data)
    interruptGate.value = interruptPayloadFromThreadState(json.data)

    const hint = phaseHintFromInterrupt(interruptGate.value)
    if (hint) {
      agent.trackPhaseHint({ phase: interruptGate.value?.phase ?? undefined, label: hint })
    }

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
    scrollToBottom()
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

/**
 * 当前轮正常结束（isStreaming 由 true → false）时，若有待发消息则自动发出。
 * 这覆盖了「排队态」：流式中回车入队 → 当前轮 done 后自动续发（抄 WorkBuddy）。
 * 中止（cancelActiveStream）也会把 isStreaming 置 false，同样触发此处，无需在 send() 内重复 flush。
 */
watch(
  () => agent.isStreaming,
  (now, prev) => {
    if (prev && !now && queuedMessage.value.trim()) {
      void flushQueuedMessage()
    }
  },
)

function handleEvent(event: { type: string; data: unknown }) {
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
      const d = event.data as { name: string; toolCallId?: string; args?: unknown }
      agent.beginToolCall({ toolCallId: d.toolCallId, name: d.name, args: d.args })
      break
    }
    case 'waiting_user': {
      // 阻塞等待可见化（2026-10-01）：后端在等待**开始**/结束各发一次。
      // waiting → 状态行收口为「等待你在画布上确认生成 / 等待你确认」；resolved → 清位。
      const d = event.data as {
        status?: string
        toolName?: string
        callId?: string
        nodeId?: string
        timeoutMs?: number
      }
      if (d.status === 'resolved' || !d.toolName) {
        agent.setBlockingWait(null)
      } else {
        // timeoutMs 是等待总时长（线上 300000）：以收到事件的时刻为起点算取消时刻，前端倒计时才有可比性
        agent.setBlockingWait({
          toolName: d.toolName,
          callId: d.callId,
          nodeId: d.nodeId,
          timeoutMs: d.timeoutMs,
        })
      }
      break
    }
    case 'activity': {
      // 「正在做什么」（决策 8）：runtime 在工具起手时下发，比 tool_call 更早到。
      // 中文在组件层查 TOOL_PRESENTATION 出（决策 7：runtime 只声明意图、不塞文案）。
      const d = event.data as { toolName?: string; done?: number; total?: number };
      agent.setActivity({ toolName: d.toolName, done: d.done, total: d.total });
      break;
    }
    case 'tool_result': {
      const d = event.data as { name: string; toolCallId?: string; result: unknown; isError?: boolean }
      agent.endToolCall(d.toolCallId, d.name, d.result, d.isError === true)
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
      break
    case 'phase_hint':
      agent.trackPhaseHint(event.data as { phase?: string; label: string })
      break
    case 'thinking':
      agent.trackThinking(event.data as { status: string; summary?: string })
      break
    case 'turn_usage':
      agent.trackTurnUsage(event.data as { inputTokens: number; outputTokens: number })
      break
    case 'explore':
      agent.trackExplore(event.data as Parameters<typeof agent.trackExplore>[0])
      break
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
      }
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
    case 'interrupt': {
      const data = event.data as AgentInterruptPayload & {
        imageQaReason?: string | null
        imageQaMetrics?: ImageQaMetrics | null
        visionUsed?: boolean | null
        retakePending?: boolean | null
        effectiveUtterance?: string | null
        presentation?: AgentInterruptPayload['presentation']
      }
      interruptGate.value = {
        interrupted: data.interrupted ?? true,
        phase: data.phase ?? null,
        node: data.node ?? null,
        imageQaReason: data.imageQaReason ?? null,
        imageQaMetrics: data.imageQaMetrics ?? null,
        visionUsed: data.visionUsed ?? null,
        retakePending: data.retakePending ?? null,
        effectiveUtterance: data.effectiveUtterance ?? null,
        presentation: data.presentation ?? null,
      }
      if (data.imageQaReason) imageQaReason.value = data.imageQaReason
      if (data.imageQaMetrics) imageQaMetrics.value = data.imageQaMetrics
      syncRetakeFromPayload(data)
      if (
        data.phase === 'await_image_qa' ||
        data.node === 'await_image_qa' ||
        data.phase === 'await_retake_upload' ||
        data.retakePending ||
        data.phase === 'await_scheme_select' ||
        data.node === 'await_scheme_select' ||
        data.phase === 'await_macro_scheme_select' ||
        data.node === 'await_macro_scheme_select' ||
        data.phase === 'await_shot_confirm' ||
        data.node === 'await_shot_confirm' ||
        data.phase === 'await_shot_topo_confirm' ||
        data.node === 'await_shot_topo_confirm' ||
        data.phase === 'await_delivery_confirm' ||
        data.node === 'await_delivery_confirm'
      ) {
        void refreshThreadCheckpoint()
      }
      break
    }
    case 'done': {
      const data = event.data as {
        retakePending?: boolean
        effectiveUtterance?: string | null
        phase?: string | null
        presentation?: AgentPresentationEnvelope | null
      }
      syncRetakeFromPayload(data)
      syncCompletionPresentation(data.phase ?? null, data.presentation)
      if (data.retakePending && data.presentation) {
        interruptGate.value = {
          interrupted: true,
          phase: 'await_retake_upload',
          retakePending: true,
          effectiveUtterance: data.effectiveUtterance ?? null,
          presentation: data.presentation,
        }
      }
      break
    }
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

function scrollToBottom() {
  nextTick(() => {
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight
    }
  })
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
      <!-- 收缩态：右下角 agent logo 悬浮按钮 -->
      <Teleport to="body">
        <button
          v-if="!open && !pickModeActive"
          type="button"
          class="agent-fab"
          :class="{ 'agent-fab-mobile': isMobileLayout }"
          title="打开 AI 助手"
          @click="openPanel"
        >
          <NeoAgentLogo size="sm" />
        </button>
      </Teleport>

      <!-- 移动端遮罩：点按退回画布 -->
      <Teleport to="body">
        <div
          v-if="open && isMobileLayout"
          class="agent-mobile-backdrop"
          aria-hidden="true"
          @click="closePanel"
        />
      </Teleport>

      <!-- 面板：侧栏内嵌 or 浮动窗口 or 移动端全屏 sheet（Teleport 到 body） -->
      <Teleport to="body" :disabled="!panelTeleported">
        <div
          v-show="open"
          class="agent-panel-shell flex min-h-0 h-full min-w-0 flex-col overflow-hidden"
          :class="[
            isMobileLayout ? 'agent-panel-mobile-sheet' : floating ? 'agent-panel-floating' : 'agent-panel-inline flex-1',
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

          <!-- 顶栏：logo + 新建 / 历史 / 浮窗切换 / 收起（浮窗模式可按住拖动） -->
          <div
            class="agent-panel-header flex items-center justify-between px-3 py-2"
            :class="floating && !isMobileLayout ? 'cursor-move' : ''"
            @mousedown="startDrag"
          >
            <div class="flex min-w-0 items-center gap-2">
              <NeoAgentLogo size="xs" active />
              <p class="agent-subtitle truncate text-[11px]">lnk·π agent</p>
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
                  <p class="px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--neo-text-muted)]">对话历史</p>
                  <button
                    v-for="thread in threads"
                    :key="thread.id"
                    type="button"
                    class="neo-popover-item block w-full px-3 py-2 text-left text-xs"
                    :class="thread.id === agentThreadId ? '!bg-[var(--neo-hi-bg)] !text-[var(--neo-hi-text)] shadow-[var(--neo-hi-shadow)]' : ''"
                    :title="thread.title"
                    @click="selectThread(thread.id)"
                  >
                    <span class="block truncate font-medium">{{ thread.title }}</span>
                    <span class="block text-[10px] opacity-60">{{ formatSessionTime(thread.updatedAt) }}</span>
                  </button>
                  <p v-if="!threads.length" class="px-3 py-4 text-center text-[11px] text-[var(--neo-text-muted)]">
                    暂无对话记录
                  </p>
                </div>
              </div>

              <!-- 移动端：退回画布，露出下方 VueFlow -->
              <button
                v-if="isMobileLayout"
                type="button"
                class="agent-view-canvas-btn flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium"
                title="看画布"
                @click="closePanel"
              >
                <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path stroke-linecap="round" d="M3 9h18M9 3v18" opacity="0.45" />
                </svg>
                看画布
              </button>

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

              <!-- 收起：回到右下角 logo -->
              <button type="button" class="agent-head-btn" title="收起助手" @click="closePanel">
                <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
          </div>

          <div
            v-if="readOnly"
            class="agent-readonly-banner mx-3 mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-100"
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

          <!-- 消息列表 -->
          <div ref="chatContainer" class="agent-chat-scroll min-h-0 flex-1 overflow-y-auto py-3">
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
            <div v-else-if="!agent.messages.length" class="agent-empty px-3 py-10 text-center">
              <p class="text-sm">描述你的创意</p>
              <p class="mt-1 text-[11px] opacity-70">我会驱动画布创建节点、连线与生成任务</p>
            </div>
            <div
              v-for="msg in agent.messages"
              :key="msg.id"
              class="agent-turn"
              :class="msg.role === 'user' ? 'agent-turn--user' : 'agent-turn--assistant'"
            >
              <div
                v-if="shouldShowMessageBubbleText(msg)"
                class="agent-bubble text-[13px] leading-relaxed"
                :class="msg.role === 'user' ? 'agent-bubble-user' : 'agent-bubble-assistant'"
              >
                <AgentProseBlock
                  v-if="shouldRenderSchemeDraftProse(msg)"
                  :content="msg.content"
                />
                <!-- 已发送用户消息的就地二次编辑（抄 WorkBuddy：默认只显编辑/复制，点编辑才出发送/取消） -->
                <p
                  v-else-if="msg.role === 'user' && editingMessageId === msg.id"
                  class="agent-edit-card whitespace-pre-wrap"
                >
                  <textarea
                    v-model="editingDraft"
                    class="agent-edit-textarea w-full resize-y rounded-md border border-[var(--neo-border)] bg-[var(--neo-surface-card)] p-2 text-[13px] leading-relaxed text-[var(--neo-text)] outline-none focus:border-[var(--neo-accent)]"
                    rows="3"
                    @keydown.meta.enter.prevent="sendEditedUserMessage(msg)"
                    @keydown.ctrl.enter.prevent="sendEditedUserMessage(msg)"
                  />
                  <span class="mt-1 block text-[10px] text-[var(--neo-text-muted)]">
                    ⓘ 编辑后将从此处重新开始对话，已有产物不会被删除
                  </span>
                  <span class="mt-1.5 flex justify-end gap-2">
                    <button type="button" class="agent-edit-btn" @click="cancelEditUserMessage">取消</button>
                    <button type="button" class="agent-edit-btn agent-edit-btn--primary" @click="sendEditedUserMessage(msg)">发送</button>
                  </span>
                </p>
                <p v-if="hasBubbleText(msg)" class="whitespace-pre-wrap">
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
                <div
                  v-if="!readOnly && canReuseTurn(msg)"
                  class="agent-bubble-reuse mt-1.5 flex justify-end"
                >
                  <button
                    type="button"
                    class="agent-bubble-reuse-btn"
                    @click="reattachTurnFromHistory(msg)"
                  >
                    ↺ 复用本轮（提示词 + 引用）
                  </button>
                </div>
                <AgentCanvasOutputs
                  v-if="msg.role === 'assistant' && (assistantOutputsById.get(msg.id)?.length ?? 0) > 0"
                  :outputs="assistantOutputsById.get(msg.id) ?? []"
                  :resolve-node-url="resolveCanvasNodeUrl"
                  @focus-node="onFocusNode($event)"
                  @focus-all="onFocusAll($event)"
                />
                <AgentExecutionTrace
                  v-if="msg.role === 'assistant' && msg.executionTrace && !liveTrace"
                  :trace="msg.executionTrace"
                  :streaming="Boolean(msg.streaming)"
                  @focus-node="onFocusNode($event)"
                />
                <AgentPresentationHost
                  v-if="historyPresentation(msg)"
                  :presentation="historyPresentation(msg)!"
                  disabled
                  :macro-selected-ids="historyMacroSelectedIds(historyPresentation(msg)!)"
                  @focus-node="onFocusNode($event)"
                  @focus-all="onFocusAll($event)"
                />
                <div v-if="msg.toolCalls?.length" class="agent-tools mt-1 space-y-0.5 pt-1">
                  <ToolCallCard
                    v-for="(cc, i) in collapseToolCalls(msg.toolCalls)"
                    :key="i"
                    :call="cc"
                  />
                </div>
                <div
                  v-if="canShowMessageActions(msg) || canShowUserMessageActions(msg)"
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
                  </template>
                </div>
              </div>
            </div>
            <AskUserCard
              v-if="pendingAskUser.length && lastMessageIsAssistant"
              class="mx-3"
              :questions="pendingAskUser"
              @submit="onAskSubmit"
              @cancel="onAskCancel"
            />
            <!-- 阻塞等待 propose_generation：确认入口在画布节点上，聊天侧明示去哪点（2026-10-01） -->
            <div
              v-if="proposeWait"
              class="mx-3 mb-1 rounded-xl border border-amber-200 bg-amber-50/90 px-3 py-2 text-[12px] text-amber-900"
              data-testid="propose-wait-hint"
            >
              <div class="flex items-start gap-2">
                <span class="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"></span>
                <p class="flex-1 leading-relaxed">
                  已提议生成，等你确认：请到画布上对应节点点「生成」，确认后本轮会自动继续。
                </p>
              </div>
              <div class="mt-1.5 flex items-center gap-1.5">
                <button
                  v-if="proposeWait.nodeId"
                  type="button"
                  class="rounded-lg border border-amber-300 bg-white px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
                  data-testid="propose-wait-locate"
                  @click="locateProposeNode"
                >
                  定位该节点
                </button>
                <button
                  v-if="proposeWait.nodeId"
                  type="button"
                  class="rounded-lg border border-amber-300 bg-white px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
                  data-testid="propose-wait-cancel"
                  @click="cancelBlockingPropose"
                >
                  取消
                </button>
              </div>
            </div>
            <AgentTaskProgressCard
              v-if="showTaskCardAtComposer"
              class="mx-3"
              :progress="taskProgress"
              @focus-node="onFocusNode($event)"
            />
            <!-- 完成后交付摘要随聊天历史一起滚动，避免底部 dock 占满侧栏 -->
            <div
              v-if="showCompletionPresentation && completionPresentation"
              class="px-3 pb-2"
            >
              <AgentPresentationHost
                :presentation="completionPresentation"
                :disabled="agent.isStreaming"
                @focus-node="onFocusNode($event)"
                @focus-all="onFocusAll($event)"
                @export-pack="onExportPack($event)"
              />
            </div>
          </div>

          <!-- 底部输入 dock：与节点 dock-studio 同款毛玻璃 -->
          <div
            class="agent-input-area shrink-0 px-2.5 pb-2.5 pt-1"
            :class="{ 'agent-input-area--scrollable': hasDockPresentation }"
          >
            <!-- 活体过程卡：钉在 composer 上方（P0 决策 1）；回合收束后由上面的气泡内 trace 接管 -->
            <AgentExecutionTrace
              v-if="liveTrace"
              class="agent-live-trace mb-1"
              :trace="liveTrace"
              :streaming="agent.isStreaming"
              dense
              @focus-node="onFocusNode($event)"
            />
            <p
              v-if="turnStatus"
              class="agent-turn-status mx-0.5 mb-1 text-[11px]"
              :class="`agent-turn-status--${turnStatus.mode}`"
              data-testid="turn-status-line"
            >
              {{ turnStatus.text }}
              <span v-if="turnStatus.hint" class="ml-1 opacity-70">{{ turnStatus.hint }}</span>
            </p>
            <div
              v-if="showCancelledCallout"
              class="mb-2 px-0.5"
              data-testid="run-cancelled-callout"
            >
              <p
                class="mb-2 rounded-lg border border-[var(--neo-border)] bg-[var(--neo-panel)] px-2 py-1.5 text-xs leading-relaxed text-[var(--neo-text-secondary)]"
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
            <div v-else-if="isRetakePending" class="mb-2 px-0.5" data-testid="retake-pending-callout">
              <p
                class="mb-2 rounded-lg border border-[var(--neo-border)] bg-[var(--neo-panel)] px-2 py-1.5 text-xs leading-relaxed text-[var(--neo-text-secondary)]"
              >
                {{ retakeCalloutText }}
              </p>
              <button
                v-if="showRetakeContinueChip"
                type="button"
                class="neo-ctl agent-preset-primary rounded-lg px-3 py-1.5 text-xs font-medium"
                data-testid="retake-continue-chip"
                :disabled="agent.isStreaming"
                @click="sendRetakeContinue()"
              >
                {{ retakeContinueLabel }}
              </button>
            </div>
            <div v-else-if="awaitingImageQa" class="mb-2 px-0.5" data-testid="image-qa-gate">
              <div
                v-if="imageQaTitle || imageQaBodyText || imageQaChecks.length"
                class="mb-2 rounded-lg border border-[var(--neo-border)] bg-[var(--neo-surface)] p-2 text-xs text-[var(--neo-text-secondary)]"
              >
                <p v-if="imageQaTitle" class="mb-1 font-medium leading-relaxed">
                  {{ imageQaTitle }}
                </p>
                <p v-if="imageQaBodyText" class="mb-1.5 leading-relaxed">
                  {{ imageQaBodyText }}
                </p>
                <ul v-if="imageQaChecks.length" class="space-y-0.5 text-[var(--neo-muted)]">
                  <li v-for="(check, idx) in imageQaChecks" :key="idx">
                    {{ check.label }}：{{ check.ok ? '✓ 通过' : '✗ 需处理' }}
                  </li>
                </ul>
              </div>
            </div>
            <div v-else-if="awaitingMacroSchemeSelect && macroSchemes.length" class="mb-2 px-0.5">
              <p
                v-if="gatePresentation?.body?.callout"
                class="mb-2 rounded-lg border border-[var(--neo-border)] bg-[var(--neo-panel)] px-2 py-1.5 text-xs text-[var(--neo-muted)]"
                data-testid="macro-style-callout"
              >
                {{ gatePresentation.body.callout }}
              </p>
              <p
                v-if="gatePresentation?.body?.callout_conflict"
                class="mb-2 rounded-lg border border-[var(--neo-border)] bg-[var(--neo-panel)] px-2 py-1.5 text-xs text-[var(--neo-muted)]"
                data-testid="macro-conflict-callout"
              >
                {{ gatePresentation.body.callout_conflict }}
              </p>
              <AgentMacroSchemeCards
                :schemes="macroSchemes"
                :selected-ids="macroSelections"
                :disabled="agent.isStreaming"
                @toggle="toggleMacroSelection"
              />
              <p
                v-if="macroFooterHint"
                class="mt-2 text-xs text-[var(--neo-muted)]"
                data-testid="macro-footer-hint"
              >
                {{ macroFooterHint }}
              </p>
            </div>
            <div v-else-if="awaitingSchemeSelect && productVisualPlan" class="mb-2 px-0.5">
              <p v-if="visualIntentSummary" class="mb-2 text-xs text-[var(--neo-muted)]">
                系统理解：{{ visualIntentSummary }}
              </p>
              <div class="space-y-2">
                <div
                  v-for="imageType in schemeSelectTypes"
                  :key="imageType.type_id"
                  class="rounded-lg border border-[var(--neo-border)] p-2"
                >
                  <div class="mb-1.5 text-xs font-medium">{{ imageType.type_label }}</div>
                  <div class="flex flex-col gap-1.5">
                    <label
                      v-for="scheme in imageType.schemes"
                      :key="scheme.scheme_id"
                      class="flex cursor-pointer items-start gap-2 text-xs"
                    >
                      <input
                        type="checkbox"
                        class="mt-0.5"
                        :checked="(schemeSelections[imageType.type_id] ?? []).includes(scheme.scheme_id)"
                        :disabled="agent.isStreaming"
                        @change="toggleSchemeSelection(imageType.type_id, scheme.scheme_id, ($event.target as HTMLInputElement).checked)"
                      />
                      <span>
                        <span class="font-medium">{{ scheme.name || scheme.scheme_id }}</span>
                        <span v-if="scheme.recommended" class="ml-1 text-[var(--neo-accent)]">推荐</span>
                        <span class="mt-0.5 block text-[var(--neo-muted)]">{{ scheme.prompt.slice(0, 80) }}{{ scheme.prompt.length > 80 ? '…' : '' }}</span>
                      </span>
                    </label>
                  </div>
                </div>
              </div>
            </div>
            <ProductVisualDeliveryCard
              v-else-if="awaitingDeliveryConfirm && productVisualPlan && !productVisualSchemeV2"
              class="mb-2 px-0.5"
              :plan="productVisualPlan"
              :gen-by-key="deliveryGenByKey"
              :selections="deliverySelections"
              :request-labels="userRequestLabels"
              :disabled="agent.isStreaming"
              v-model:refine-draft="deliveryRefineDraft"
              @switch-scheme="sendDeliverySwitch"
              @refine-type="sendDeliveryRefine"
              @confirm-all="sendDeliveryConfirmAll"
            />
            <div
              v-else-if="showDeliveryPresentation && deliveryPresentationForUi"
              class="mb-2"
            >
              <AgentPresentationHost
                :presentation="deliveryPresentationForUi"
                :delivery-selections="deliverySelections"
                :disabled="agent.isStreaming"
                @primary-action="onDeliveryPrimaryAction"
                @delivery-switch="sendDeliveryVariantSwitch"
                @focus-node="onFocusNode($event)"
                @focus-all="onFocusAll($event)"
              />
            </div>
            <div v-else-if="showGatePresentation && gatePresentation" class="mb-2">
              <AgentPresentationHost
                :presentation="gatePresentation"
                :disabled="agent.isStreaming"
                @primary-action="onGatePrimaryAction"
                @focus-node="onFocusNode($event)"
                @focus-all="onFocusAll($event)"
              />
              <div v-if="awaitingShotConfirm" class="mt-2 flex flex-wrap gap-2 px-0.5">
                <div v-if="shotManifest.length" class="mb-1 w-full space-y-1 text-xs text-[var(--neo-muted)]">
                  <div v-for="shot in shotManifest" :key="shot.shot_id">
                    · {{ shot.label || shot.shot_id }}
                    <span v-if="shot.macro_scheme_id">（方案{{ shot.macro_scheme_id }}）</span>
                  </div>
                </div>
                <button
                  type="button"
                  class="neo-ctl rounded-lg px-3 py-1.5 text-xs"
                  :disabled="agent.isStreaming"
                  @click="sendShotRevise()"
                >
                  调整构图
                </button>
              </div>
              <div
                v-else-if="awaitingTopoConfirm && !awaitingShotConfirm"
                class="mt-2 flex flex-wrap gap-2 px-0.5"
              >
                <button
                  type="button"
                  class="neo-ctl rounded-lg px-3 py-1.5 text-xs"
                  :disabled="agent.isStreaming"
                  @click="sendPreset('写入主文案')"
                >
                  写入主文案
                </button>
                <button
                  type="button"
                  class="neo-ctl rounded-lg px-3 py-1.5 text-xs"
                  :disabled="agent.isStreaming"
                  @click="sendPreset('要改拓扑：')"
                >
                  要改拓扑
                </button>
              </div>
            </div>
            <div v-else-if="awaitingShotConfirm" class="mb-2 px-0.5">
              <div v-if="shotManifest.length" class="mb-2 space-y-1 text-xs text-[var(--neo-muted)]">
                <div v-for="shot in shotManifest" :key="shot.shot_id">
                  · {{ shot.label || shot.shot_id }}
                  <span v-if="shot.macro_scheme_id">（方案{{ shot.macro_scheme_id }}）</span>
                </div>
              </div>
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  class="neo-ctl agent-preset-primary rounded-lg px-3 py-1.5 text-xs font-medium"
                  :disabled="agent.isStreaming"
                  @click="sendShotConfirm()"
                >
                  {{ gatePrimaryActionLabel }}
                </button>
                <button
                  type="button"
                  class="neo-ctl rounded-lg px-3 py-1.5 text-xs"
                  :disabled="agent.isStreaming"
                  @click="sendShotRevise()"
                >
                  调整构图
                </button>
              </div>
            </div>
            <div v-else-if="awaitingTopoConfirm && !awaitingShotConfirm" class="mb-2 flex flex-wrap gap-2 px-0.5">
              <button
                type="button"
                class="neo-ctl agent-preset-primary rounded-lg px-3 py-1.5 text-xs font-medium"
                :disabled="agent.isStreaming"
                @click="sendPreset(gatePresentation?.primary_action?.message ?? '确认出图')"
              >
                {{ gatePrimaryActionLabel }}
              </button>
              <button
                type="button"
                class="neo-ctl rounded-lg px-3 py-1.5 text-xs"
                :disabled="agent.isStreaming"
                @click="sendPreset('写入主文案')"
              >
                写入主文案
              </button>
              <button
                type="button"
                class="neo-ctl rounded-lg px-3 py-1.5 text-xs"
                :disabled="agent.isStreaming"
                @click="sendPreset('要改拓扑：')"
              >
                要改拓扑
              </button>
            </div>
            <div v-else-if="awaitingCopyConfirm" class="mb-2 flex flex-wrap gap-2 px-0.5">
              <button
                type="button"
                class="neo-ctl agent-preset-primary rounded-lg px-3 py-1.5 text-xs font-medium"
                :disabled="agent.isStreaming"
                @click="sendPreset('写入主文案')"
              >
                写入主文案
              </button>
              <button
                type="button"
                class="neo-ctl rounded-lg px-3 py-1.5 text-xs"
                :disabled="agent.isStreaming"
                @click="sendPreset('文案要修改：')"
              >
                要修改
              </button>
            </div>
            <!-- 下一步动作（决策 4）：白名单单点定义，恒 ≤2；未知 chipSet 不渲染任何按钮 -->
            <div v-if="dockChips.length" class="mb-2 flex flex-wrap gap-2 px-0.5" data-testid="next-chips">
              <button
                v-for="chip in dockChips"
                :key="chip.key"
                type="button"
                class="neo-ctl rounded-lg px-3 py-1.5 text-xs"
                :class="chip.primary ? 'agent-preset-primary font-medium' : ''"
                :data-testid="chip.testId ?? `next-chip-${chip.key}`"
                :disabled="agent.isStreaming || Boolean(chip.disabled)"
                @click="runNextChip(chip.action)"
              >
                {{ chip.label }}
              </button>
            </div>
            <div
              class="agent-input-dock"
              :class="{
                'is-drop-target': isDragOver,
                'is-retake-highlight': isRetakePending,
              }"
              @dragover.prevent="onDragOver"
              @dragleave.prevent="onDragLeave"
              @drop.prevent="onDrop"
              @pointerdown="onInputDockPointerDown"
            >
              <div
                v-if="showHistoryReattachCoachmark"
                class="agent-history-coachmark mx-0.5 mb-2 flex items-start gap-2 rounded-xl border px-3 py-2 text-[11px] leading-snug"
                role="status"
              >
                <span class="min-w-0 flex-1 text-[var(--neo-text-secondary)]">
                  点击历史消息中的 ↺ 引用可再次加入输入框；也可点「复用本轮」一键带回提示词与全部引用。
                </span>
                <button
                  type="button"
                  class="agent-history-coachmark__dismiss shrink-0 rounded-md px-2 py-0.5 text-[10px] font-medium"
                  @click="dismissHistoryReattachCoachmark"
                >
                  知道了
                </button>
              </div>
              <!-- 流式中的待发消息气泡（排队，抄 WorkBuddy）：不打断当前轮，可打断并发送 / 编辑回输入框 / 删除 -->
              <div
                v-if="queuedMessage"
                class="agent-queued-bubble mx-3 mb-2 rounded-lg border border-[var(--neo-accent)]/40 bg-[var(--neo-accent)]/10 px-3 py-2"
              >
                <div class="flex items-start gap-2">
                  <span class="mt-0.5 shrink-0 rounded bg-[var(--neo-accent)]/20 px-1.5 py-0.5 text-[10px] font-medium text-[var(--neo-accent)]">待发</span>
                  <p class="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--neo-text)]">{{ queuedMessage }}</p>
                </div>
                <div class="mt-1.5 flex flex-wrap items-center gap-2">
                  <button type="button" class="queued-act queued-act--primary" @click="interruptAndSend">⚡ 打断并发送</button>
                  <button type="button" class="queued-act" @click="editQueuedMessage">✎ 编辑</button>
                  <button type="button" class="queued-act" @click="queuedMessage = ''">🗑 删除</button>
                </div>
              </div>
              <div class="agent-composer">
                <p
                  v-if="showComposerReattachHint"
                  class="agent-composer-reattach-hint mb-1.5 px-0.5 text-[10px] leading-snug text-[var(--neo-text-muted)]"
                >
                  点击上方历史消息中的 ↺ 引用，或「复用本轮」，可再次加入本次对话
                </p>
                <p
                  v-if="showProductVisualAttachmentHint && !pendingAttachmentItems.length"
                  class="agent-composer-attachment-hint mb-1.5 px-0.5 text-[10px] leading-snug text-[var(--neo-text-muted)]"
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
                <div class="agent-composer__input-wrap">
                <MentionInput
                  ref="composerRef"
                  v-model="input"
                  class="agent-composer__mention w-full"
                  :mentions="mentionOptions"
                  :placeholder="agent.isStreaming ? '输入消息，回车加入待发队列…' : inputPlaceholder"
                  :disabled="readOnly || isUploading"
                  :leading-inset="readOnly ? 0 : COMPOSER_PICK_INSET"
                  submit-on-enter
                  @submit="onComposerSubmit"
                />
                  <button
                    v-if="!readOnly"
                    type="button"
                    class="composer-canvas-pick-btn"
                    :class="{ 'is-active': pickMode.active.value, 'is-hint': showPickHint }"
                    :disabled="isUploading"
                    aria-label="从画布选节点作引用"
                    @click.stop="onCanvasRefPickToggle"
                  >
                    <span class="composer-canvas-pick-btn__halo" aria-hidden="true" />
                    <span class="composer-canvas-pick-btn__lens" aria-hidden="true" />
                    <CanvasRefTargetIcon :size="14" :filled="pickMode.active.value" class="composer-canvas-pick-btn__icon" />
                    <span class="composer-canvas-pick-tip">从画布选节点作引用</span>
                  </button>
                </div>
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
                <div class="agent-dock-params">
                  <div ref="attachMenuRef" class="agent-attach-menu relative">
                    <button
                      type="button"
                      class="dock-ghost-ctl flex h-8 w-8 items-center justify-center rounded-lg"
                      :class="{ 'is-open': attachMenuOpen }"
                      :disabled="readOnly || isUploading"
                      :title="readOnly ? '只读画布不能添加参考素材' : '添加引用素材'"
                      @click="toggleAttachMenu"
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
                      <button
                        type="button"
                        class="neo-popover-item flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs"
                        @click="pickCanvasFromMenu"
                      >
                        <span class="agent-attach-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-full">
                          <CanvasRefTargetIcon :size="14" />
                        </span>
                        <span>从画布选节点</span>
                      </button>
                    </div>
                  </div>

                  <UniversalModelSelector v-model="planningModel" type="text" ghost />

                  <div
                    v-if="showPlanningThinkingControls"
                    class="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1"
                  >
                    <button
                      type="button"
                      class="dock-seg-btn rounded-md px-1.5 py-1"
                      :class="{ 'is-on': planningThinking }"
                      :disabled="props.readOnly"
                      title="深度思考（DeepSeek V4）"
                      @click="setPlanningThinking(!planningThinking)"
                    >
                      深度思考 {{ planningThinking ? '开' : '关' }}
                    </button>
                    <template v-if="planningThinking">
                      <button
                        type="button"
                        class="dock-seg-btn"
                        :class="{ 'is-on': planningThinkingEffort === 'high' }"
                        :disabled="props.readOnly"
                        @click="setPlanningThinkingEffort('high')"
                      >
                        high
                      </button>
                      <button
                        type="button"
                        class="dock-seg-btn"
                        :class="{ 'is-on': planningThinkingEffort === 'max' }"
                        :disabled="props.readOnly"
                        @click="setPlanningThinkingEffort('max')"
                      >
                        max
                      </button>
                    </template>
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
                    <div class="mx-3 my-1 border-t border-[var(--neo-border)] opacity-40" />
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
  background: var(--neo-bg);
  transition: width 0.3s ease, background 0.25s ease;
}

.agent-side-rail.is-docked-open {
  border-left: 1px solid var(--neo-border);
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

.agent-fab-mobile {
  right: 16px;
  bottom: calc(72px + env(safe-area-inset-bottom, 0px));
}

.agent-mobile-backdrop {
  position: fixed;
  inset: 0;
  z-index: 64;
  background: rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}

/* ---- 面板外壳 ---- */
.agent-panel-inline {
  position: relative;
  background: var(--neo-bg);
}

.agent-panel-floating {
  position: fixed;
  z-index: 60;
  height: min(680px, calc(100vh - 72px));
  max-width: calc(100vw - 32px);
  border: 1px solid var(--neo-glass-border);
  border-radius: 20px;
  background: var(--neo-popover-bg);
  box-shadow: var(--neo-popover-shadow);
  backdrop-filter: blur(28px) saturate(1.4);
  -webkit-backdrop-filter: blur(28px) saturate(1.4);
  overflow: hidden;
}

.agent-panel-floating.is-dragging {
  user-select: none;
}

.agent-panel-mobile-sheet {
  position: fixed;
  z-index: 70;
  top: max(44px, env(safe-area-inset-top, 0px));
  right: 0;
  bottom: 0;
  left: 0;
  height: auto;
  max-height: none;
  border: 1px solid var(--neo-glass-border);
  border-bottom: none;
  border-radius: 20px 20px 0 0;
  background: var(--neo-popover-bg);
  box-shadow: var(--neo-popover-shadow);
  backdrop-filter: blur(28px) saturate(1.4);
  -webkit-backdrop-filter: blur(28px) saturate(1.4);
  overflow: hidden;
}

.agent-view-canvas-btn {
  color: var(--neo-hi-text);
  background: color-mix(in srgb, var(--neo-hi-bg) 72%, transparent);
  transition: background 0.15s ease;
}

.agent-view-canvas-btn:hover {
  background: var(--neo-hi-bg);
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
  background: color-mix(in srgb, var(--neo-hi-text) 35%, transparent);
}

.agent-panel-floating .agent-resize-handle {
  left: 0;
}

.agent-panel-header {
  border-bottom: 1px solid var(--neo-border);
}

.agent-subtitle {
  color: var(--neo-text-muted);
}

.agent-head-btn {
  display: flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: var(--neo-text-muted);
  transition: background 0.15s ease, color 0.15s ease;
}

.agent-head-btn:hover {
  background: var(--neo-hover-bg);
  color: var(--neo-text-primary);
}

.agent-head-btn.is-active {
  background: var(--neo-hi-bg);
  color: var(--neo-hi-text);
  box-shadow: var(--neo-hi-shadow);
}

.agent-readonly-btn {
  border-radius: 8px;
  border: 1px solid rgba(251, 191, 36, 0.35);
  background: rgba(0, 0, 0, 0.15);
  padding: 4px 10px;
  font-size: 11px;
  line-height: 1.4;
  color: rgb(254, 243, 199);
  transition: background 0.15s ease, border-color 0.15s ease;
}

.agent-readonly-btn:hover {
  background: rgba(251, 191, 36, 0.12);
  border-color: rgba(251, 191, 36, 0.55);
}

.agent-readonly-btn-primary {
  border-color: rgba(251, 191, 36, 0.55);
  background: rgba(251, 191, 36, 0.18);
  color: rgb(255, 251, 235);
}

.agent-readonly-btn-primary:hover {
  background: rgba(251, 191, 36, 0.28);
}

/* ---- 消息列表 ---- */
.agent-chat-scroll {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1 1 45%;
  min-height: min(360px, 52%);
}

.agent-input-area--scrollable {
  max-height: min(42vh, 400px);
  overflow-y: auto;
  overscroll-behavior: contain;
}

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
  color: var(--neo-text-muted);
}

.agent-pv-example-btn {
  border-color: var(--neo-border);
  background: var(--neo-panel);
  color: var(--neo-text-secondary);
  transition: border-color 0.15s ease, background 0.15s ease;
}

.agent-pv-example-btn:hover {
  border-color: var(--neo-accent, var(--neo-border));
  background: color-mix(in srgb, var(--neo-panel) 92%, var(--neo-accent, #888) 8%);
}

.agent-composer-attachment-hint {
  border-left: 2px solid var(--neo-border);
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
  background: var(--neo-hover-bg);
  color: var(--neo-text-primary);
}

.agent-msg-action-btn.is-active {
  background: var(--neo-active-bg);
  color: var(--neo-text-primary);
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
    0 1px 3px rgba(0, 0, 0, 0.14);
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

.agent-bubble-reuse-btn {
  border: 1px dashed color-mix(in srgb, var(--agent-user-text) 22%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--agent-user-text) 6%, transparent);
  padding: 2px 8px;
  font-size: 10px;
  line-height: 1.4;
  color: color-mix(in srgb, var(--agent-user-text) 78%, transparent);
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.agent-bubble-reuse-btn:hover {
  border-color: color-mix(in srgb, var(--agent-user-text) 35%, transparent);
  background: color-mix(in srgb, var(--agent-user-text) 12%, transparent);
  color: var(--agent-user-text);
}

.agent-history-coachmark {
  border-color: color-mix(in srgb, var(--neo-hi-text) 14%, var(--neo-border));
  background: color-mix(in srgb, var(--neo-hi-bg) 8%, var(--neo-hover-bg));
}

.agent-history-coachmark__dismiss {
  border: 1px solid var(--neo-border);
  background: var(--neo-hi-bg);
  color: var(--neo-hi-text);
  box-shadow: var(--neo-hi-shadow);
}

.agent-composer-reattach-hint {
  border-left: 2px solid color-mix(in srgb, var(--neo-hi-text) 18%, transparent);
  padding-left: 8px;
}

.agent-tools {
  border-top: 1px solid var(--neo-border);
}

/* ---- 流式中待发消息气泡（排队，抄 WorkBuddy） ---- */
.agent-queued-bubble {
  animation: agent-queued-in 0.18s ease;
}

@keyframes agent-queued-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ⚠️ 别用 --neo-hi-bg 配 --neo-text：--neo-hi-bg 深主题是纯白 #ffffff、浅主题是深色 #17181d，
   而 --neo-text 深主题近白、浅主题近黑 —— 「底色与字色同向」，两个主题都会把字吞掉。
   中性高亮控件的正确配对是 --neo-hi-bg 配 --neo-hi-text；这里次级动作不用高亮块，
   改用 surface 底 + 主文字色（两个主题都保证对比度）。 */
.queued-act {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--neo-border-strong);
  border-radius: 999px;
  background: var(--neo-surface-elevated);
  padding: 2px 9px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--neo-text-primary);
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.queued-act:hover {
  background: color-mix(in srgb, var(--neo-text-primary) 12%, var(--neo-surface-elevated));
  border-color: color-mix(in srgb, var(--neo-text-primary) 28%, transparent);
}

.queued-act--primary {
  border-color: color-mix(in srgb, var(--neo-accent) 45%, transparent);
  /* --neo-accent 是固定紫 #6d5dfc，深底上对比度不够；--neo-accent-text 深底亮紫 / 浅底深紫 */
  color: var(--neo-accent-text);
  background: color-mix(in srgb, var(--neo-accent) 10%, transparent);
}

.queued-act--primary:hover {
  background: color-mix(in srgb, var(--neo-accent) 18%, transparent);
}

/* ---- 已发送用户消息就地二次编辑卡（抄 WorkBuddy） ---- */
.agent-edit-card {
  display: block;
}

.agent-edit-textarea {
  font-family: inherit;
}

/* 同上：次级按钮不能用 --neo-hi-bg + --neo-text 的同向配色（白底白字 / 深底深字） */
.agent-edit-btn {
  border: 1px solid var(--neo-border-strong);
  border-radius: 999px;
  background: var(--neo-surface-elevated);
  padding: 2px 12px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--neo-text-primary);
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.agent-edit-btn:hover {
  background: color-mix(in srgb, var(--neo-text-primary) 12%, var(--neo-surface-elevated));
}

.agent-edit-btn--primary {
  border-color: color-mix(in srgb, var(--neo-accent) 45%, transparent);
  color: var(--neo-accent-text);
  background: color-mix(in srgb, var(--neo-accent) 12%, transparent);
}

.agent-edit-btn--primary:hover {
  background: color-mix(in srgb, var(--neo-accent) 20%, transparent);
}

.agent-turn--user:hover .agent-msg-actions,
.agent-bubble-user:hover ~ .agent-msg-actions {
  opacity: 1;
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
  border: 1px solid var(--neo-glass-border);
  border-radius: 18px;
  background: var(--neo-glass-bg);
  backdrop-filter: blur(var(--neo-glass-blur)) saturate(1.5);
  -webkit-backdrop-filter: blur(var(--neo-glass-blur)) saturate(1.5);
  box-shadow:
    0 20px 44px rgba(0, 0, 0, 0.42),
    0 2px 6px rgba(0, 0, 0, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.14),
    inset 0 -1px 0 rgba(0, 0, 0, 0.3);
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
  background: linear-gradient(90deg, transparent, var(--neo-glass-topline), transparent);
}

.agent-input-dock:focus-within {
  border-color: color-mix(in srgb, var(--neo-hi-text) 28%, var(--neo-glass-border));
  box-shadow:
    0 20px 44px rgba(0, 0, 0, 0.42),
    0 2px 6px rgba(0, 0, 0, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.14),
    inset 0 -1px 0 rgba(0, 0, 0, 0.3),
    0 0 0 2px color-mix(in srgb, var(--neo-hi-text) 14%, transparent);
}

.agent-input-dock.is-drop-target {
  border-color: color-mix(in srgb, var(--neo-hi-text) 35%, var(--neo-border));
  background: var(--neo-hover-bg);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--neo-hi-text) 18%, transparent);
}

.agent-input-dock.is-retake-highlight {
  border-color: color-mix(in srgb, var(--neo-accent, #888) 55%, var(--neo-glass-border));
  box-shadow:
    0 20px 44px rgba(0, 0, 0, 0.42),
    0 0 0 2px color-mix(in srgb, var(--neo-accent, #888) 28%, transparent);
}

.agent-prompt-field {
  width: 100%;
  min-height: 76px;
  max-height: 180px;
  resize: none;
  border: none;
  background: transparent;
  outline: none;
  font-size: 13px;
  line-height: 1.55;
  color: var(--neo-text-primary);
}

.agent-prompt-field::placeholder {
  color: var(--neo-text-muted);
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
  background: var(--neo-hover-bg);
  color: var(--neo-text-secondary);
  transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
}

.agent-skill-trigger__icon {
  display: inline-flex;
  color: var(--neo-text-secondary);
  transition: color 0.15s ease;
}

.agent-skill-trigger:hover .agent-skill-trigger__icon,
.agent-skill-trigger.is-open .agent-skill-trigger__icon {
  color: var(--neo-text-primary);
}

.agent-skill-trigger.has-value {
  border-color: color-mix(in srgb, var(--neo-hi-text) 12%, var(--neo-border));
  background: color-mix(in srgb, var(--neo-hi-bg) 10%, var(--neo-hover-bg));
}

.agent-skill-trigger.has-value .agent-skill-trigger__icon {
  color: var(--neo-text-primary);
}

.agent-popover-skill-item.is-selected {
  background: var(--neo-hi-bg) !important;
  color: var(--neo-hi-text) !important;
  box-shadow: var(--neo-hi-shadow);
}

.agent-popover-skill-item.is-selected .agent-skill-icon {
  background: color-mix(in srgb, var(--neo-hi-text) 10%, transparent);
  color: var(--neo-hi-text);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--neo-hi-text) 12%, transparent);
}

.agent-preset-primary {
  background: var(--neo-hi-bg) !important;
  color: var(--neo-hi-text) !important;
  border-color: transparent !important;
  box-shadow: var(--neo-hi-shadow);
}

.agent-preset-primary:hover:not(:disabled) {
  filter: brightness(1.04);
}

/* ---- P1 回合状态行 ---- */
.agent-turn-status {
  color: var(--neo-text-muted);
}

.agent-turn-status--failed {
  color: #fca5a5;
}

.agent-turn-status--waiting {
  color: var(--neo-text-secondary);
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

.composer-canvas-pick-btn {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 5;
  isolation: isolate;
  overflow: visible;
  display: flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--neo-glass-border);
  border-radius: 999px;
  background:
    radial-gradient(circle at 28% 22%, rgba(255, 255, 255, 0.24) 0%, transparent 46%),
    var(--neo-glass-lite-bg);
  color: rgba(255, 255, 255, 0.88);
  backdrop-filter: blur(var(--neo-glass-lite-blur)) saturate(1.4);
  -webkit-backdrop-filter: blur(var(--neo-glass-lite-blur)) saturate(1.4);
  box-shadow:
    var(--neo-glass-lite-shadow),
    0 4px 12px rgba(0, 0, 0, 0.18);
  transform: translate(-50%, -50%);
  transition:
    background 0.22s ease,
    border-color 0.22s ease,
    color 0.22s ease,
    box-shadow 0.22s ease,
    transform 0.14s cubic-bezier(0.34, 1.2, 0.64, 1);
}

.composer-canvas-pick-btn__halo {
  position: absolute;
  inset: -4px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: inherit;
  pointer-events: none;
  opacity: 0.55;
  transition: opacity 0.22s ease, border-color 0.22s ease, box-shadow 0.22s ease;
}

.composer-canvas-pick-btn__lens {
  position: absolute;
  inset: 1px;
  border-radius: inherit;
  pointer-events: none;
  background:
    radial-gradient(ellipse 90% 70% at 24% 18%, rgba(255, 255, 255, 0.16) 0%, transparent 52%),
    radial-gradient(ellipse 55% 45% at 78% 88%, rgba(255, 255, 255, 0.05) 0%, transparent 48%);
  opacity: 0.9;
  transition: opacity 0.22s ease, background 0.22s ease;
}

.composer-canvas-pick-btn__icon {
  position: relative;
  z-index: 1;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.35));
  transition: filter 0.22s ease, transform 0.14s ease;
}

.composer-canvas-pick-btn:hover:not(:disabled):not(.is-active) {
  border-color: var(--neo-glass-border-hover);
  color: #fff;
  transform: translate(-50%, -50%) scale(1.05);
  box-shadow:
    var(--neo-glass-lite-shadow),
    0 6px 16px rgba(0, 0, 0, 0.22);
}

.composer-canvas-pick-btn:hover:not(:disabled):not(.is-active) .composer-canvas-pick-btn__halo {
  opacity: 0.85;
  border-color: rgba(255, 255, 255, 0.12);
}

.composer-canvas-pick-btn:active:not(:disabled):not(.is-active) {
  transform: translate(-50%, -50%) scale(0.94);
}

.composer-canvas-pick-btn.is-active {
  border-color: rgba(255, 255, 255, 0.92);
  background:
    radial-gradient(circle at 30% 24%, rgba(255, 255, 255, 0.95) 0%, transparent 46%),
    linear-gradient(165deg, #ffffff 0%, #f3f3f6 48%, #e6e6ec 100%);
  color: var(--neo-hi-text);
  box-shadow:
    var(--neo-hi-shadow),
    0 0 0 1px rgba(255, 255, 255, 0.55),
    0 8px 20px rgba(0, 0, 0, 0.34);
}

.composer-canvas-pick-btn.is-active .composer-canvas-pick-btn__halo {
  inset: -5px;
  border-color: rgba(255, 255, 255, 0.42);
  opacity: 1;
  animation: composer-pick-target-ring 1.75s ease-out infinite;
}

.composer-canvas-pick-btn.is-active .composer-canvas-pick-btn__lens {
  background:
    radial-gradient(ellipse 85% 65% at 28% 22%, rgba(255, 255, 255, 0.72) 0%, transparent 54%),
    radial-gradient(ellipse 50% 40% at 72% 82%, rgba(255, 255, 255, 0.18) 0%, transparent 50%);
  opacity: 1;
}

.composer-canvas-pick-btn.is-active .composer-canvas-pick-btn__icon {
  filter: none;
}

.composer-canvas-pick-btn.is-active:active:not(:disabled) {
  transform: translate(-50%, -50%) scale(0.96);
  box-shadow:
    var(--neo-hi-shadow),
    0 0 0 2px rgba(255, 255, 255, 0.45),
    0 6px 16px rgba(0, 0, 0, 0.3);
}

.composer-canvas-pick-btn.is-hint:not(.is-active) .composer-canvas-pick-btn__halo {
  animation: composer-pick-halo-breathe 2.6s ease-in-out infinite;
}

:global(:root[data-canvas-theme='light']) .composer-canvas-pick-btn:not(.is-active) {
  color: var(--neo-text-secondary);
}

:global(:root[data-canvas-theme='light']) .composer-canvas-pick-btn.is-active {
  color: var(--neo-hi-text);
}

.composer-canvas-pick-tip {
  position: absolute;
  bottom: calc(100% + 7px);
  left: 50%;
  z-index: 5;
  padding: 4px 8px;
  border: 1px solid var(--neo-border);
  border-radius: 8px;
  background: var(--neo-surface-elevated);
  font-size: 10px;
  line-height: 1.3;
  white-space: nowrap;
  color: var(--neo-text-secondary);
  pointer-events: none;
  opacity: 0;
  transform: translateX(-50%) translateY(2px);
  transition: opacity 0.15s ease, transform 0.15s ease;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
}

.composer-canvas-pick-btn:hover:not(:disabled) .composer-canvas-pick-tip,
.composer-canvas-pick-btn:focus-visible .composer-canvas-pick-tip {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.agent-attach-icon {
  background: var(--neo-hover-bg);
  color: var(--neo-text-secondary);
}

@keyframes composer-pick-halo-breathe {
  0%, 100% {
    opacity: 0.42;
    transform: scale(1);
  }
  50% {
    opacity: 0.92;
    transform: scale(1.06);
  }
}

@keyframes composer-pick-target-ring {
  0% {
    opacity: 0.85;
    transform: scale(1);
  }
  100% {
    opacity: 0;
    transform: scale(1.42);
  }
}
</style>
