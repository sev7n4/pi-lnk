<script setup lang="ts">
import { computed, ref, reactive, onMounted, nextTick, watch } from 'vue'
import { useAgentMobileLayout } from '@/composables/useAgentMobileLayout'
import { useMobileComposerFocus } from '@/composables/useMobileComposerFocus'
import { useMobileKeyboardInset } from '@/composables/useMobileKeyboardInset'
import { useRouter } from 'vue-router'
import { useAgentStore } from '@/stores/agent'
import { useDockNoticeStore } from '@/stores/dockNotice'
import { useAuthStore } from '@/stores/auth'
import type { SidebarAttachment, CreditTxEvent } from '@lnkpi/shared'
import { normalizeMentionedKeys, SIDEBAR_ATTACHMENT_MAX } from '@lnkpi/shared'
import { apiUrl } from '@/services/api-base'
import { membershipApi } from '@/services/users-api'
import NeoAgentLogo from '@/components/agent/NeoAgentLogo.vue'
import { applyPiUserMessageEvent } from '@/components/agent/queueBubbleSync'
import AgentRefStrip from '@/components/agent/AgentRefStrip.vue'
import AgentSelectionBindingChip from '@/components/agent/AgentSelectionBindingChip.vue'
import AgentAssetPicker from '@/components/agent/AgentAssetPicker.vue'
import AgentTaskProgressCard from '@/components/agent/AgentTaskProgressCard.vue'
import AgentCanvasOutputs from '@/components/agent/AgentCanvasOutputs.vue'
import AgentExecutionTrace from '@/components/agent/AgentExecutionTrace.vue'
import AgentTurnTimeline from '@/components/agent/AgentTurnTimeline.vue'
import { locatableNodeIds, canvasOutputsForMessage as deriveCanvasOutputs } from '@/components/agent/agentCanvasOutputs'
import { canvasDigestEntry, digestEntryForTurn } from '@/components/agent/deliverySummary'
// 双色品牌徽标（黑盘 + 白锚 + 外环）：2026-10-26 用户裁定「composer 定位锚用双色徽标」，
// 与画布落点标记 CanvasRefTargetIcon 同源同资产 ⇒「锚」在全产品统一成一支。
import anchorBadge from '@/assets/icons/anchor-badge.png'
// 分组色键白名单（2026-10-21 下沉到 @lnkpi/shared，这里走前端 re-export）。
// 用在 canvas_command 的 set_group_color 分支做最后一道防线。
// ⛔ `GROUP_COLOR_KEYS` 的元素类型是字面量联合，`includes` 不接受任意 string ⇒
// 收窄用 `as GroupColorKey`（与 groupColors.ts 的 normalizeGroupColorKey 同范式；
// 运行时仍由 includes 真正把关，as 只为过类型系统）。
import { GROUP_COLOR_KEYS, type GroupColorKey } from '@/components/canvas/groupColors'
import { buildTurnReceipt } from './composer/turnReceipt'
import type { AgentStreamMessage } from '@/stores/agent'
import ConversationShareSheet from '@/components/agent/ConversationShareSheet.vue'
import { toShareTurn } from '@/lib/share/toShareTurn'
import type { ShareTurn } from '@lnkpi/shared/shareTemplate'
import type { PersistedAgentMessage } from '@/stores/agent'
import {
  cancelAgentRun,
  cancelledCalloutTextFromProgress,
  recoveredQueueText,
} from '@/components/agent/cancelAgentRun'
import {
  postCancelRun,
  postConversation,
  postPersistEntryId,
} from '@/agent/command/agentCommandClient'
import {
  applyTaskEvent,
  applyPollRecordToTask,
  emptyTaskProgress,
  mapRecordStatusToTaskStatus,
  seedTaskProgressFromEvents,
  type AgentTaskProgressState,
} from '@/components/agent/agentTaskProgress'
import {
  parseRecordUrl,
  useGenerationPolling,
  type GenerationPollTask,
} from '@/composables/useGenerationPolling'
import { useAgentStream } from '@/composables/useAgentStream'
import {
  collectBackfillOwnableNodeIds,
  mapNodeStatus,
  reconcileTaskProgress,
  shouldFinishTaskCard,
  synthesizeSummary,
  type CanvasNodeLike,
} from '@/components/agent/taskProgressReconcile'
import {
  pickAssistantForLatestUserTurn,
  pickTrailingOutOfTurnRow,
  shouldApplyReconciledAssistant,
} from '@/components/agent/assistantReconcile'
import AgentPresentationHost from '@/components/agent/presentation/AgentPresentationHost.vue'
import AgentSvgCard from '@/components/agent/presentation/AgentSvgCard.vue'
import AgentNodeGraph from '@/components/agent/presentation/AgentNodeGraph.vue'
import AgentProseBlock from '@/components/agent/presentation/AgentProseBlock.vue'
import type { AgentPresentationEnvelope, NodeGraphBodyPayload } from '@/components/agent/presentation/types'
import { useAgentPropose } from '@/components/agent/useAgentPropose'
import { useAgentComposer } from '@/components/agent/useAgentComposer'
import { useAgentQueue, type QueuedSlot } from '@/components/agent/useAgentQueue'
import { useAgentThread, type AgentThreadRow } from '@/components/agent/useAgentThread'
import { useAgentObserver } from '@/components/agent/useAgentObserver'
import { useAgentMessageActions } from '@/components/agent/useAgentMessageActions'
import { isRunCancelledState } from '@/components/agent/agentInterruptGate'
import {
  buildIdempotencyKey,
  createAgentThreadId,
  persistActiveThreadId,
  persistForkedThreadId,
  checkRuntimeHealthViaNest,
  RUNTIME_UNREACHABLE_SNIPPET,
  RECONCILE_MAX_POLLS,
  shouldKeepReconciling,
  fetchRuntimeReconcile,
} from '@/components/agent/streamRecovery'
// 注：shouldPollRuntimeHealth（streamRecovery.ts）已无 SideRail 调用方——P1#11 重连改造后
// 旧 reconcile 唯一消费点被轮询终态判定替代（该状态读取又随 H1-c 退役，现为按上限兜底）。
// 函数 + 测试保留以备未来手动重连或别处复用；本期只删 SideRail 死 import（I-3 fix）。
import ForceChoiceDialog, { type ForceChoiceKind } from '@/components/agent/ForceChoiceDialog.vue'
import { classifyRequestError, isNetworkError } from '@/components/agent/networkFault'
import { useNetworkNotice } from '@/composables/useNetworkNotice'
import DockGenerateButton from '@/components/canvas/dock-studio/shared/DockGenerateButton.vue'
import { useSidebarAttachments, assignRefKeysFor, type FocusNodeLike, type CanvasRefAddResult } from '@/composables/useSidebarAttachments'
import { parseRefMentions } from '@/composables/useRefMentions'
import MentionInput from '@/components/canvas/MentionInput.vue'
import { isConversationAckResponse, parseConversationAck } from './main-turn-ack'
import { turnLiveStatus } from './activityLine'
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
  pickUtteranceContext,
  selectExampleUtterances,
  type CanvasPhase,
  type UtterancePhase,
  type UtterancePool,
} from './composer/exampleUtterances'
import { levelLabel, THINKING_LEVELS, type ThinkingLevel } from './composer/thinkingLevels'
import { useProjectWorkspace } from '@/composables/useProjectWorkspace'
import { useUtteranceRotation } from '@/composables/useUtteranceRotation'
import { shouldShowModelChip } from './composer/modelSkillDedup'
import { barShape } from './composer/mobileBarLayout'
import { useAgentDock } from './useAgentDock'
import { sanitizeHistoryMessages } from './historySanitize'
import { classifyGesture } from './composer/holdGesture'
import { visibleAssistantContent, visibleUserContent, isUserSystemEvent, hasRenderableSvgCard, hasRenderableNodeGraph, nodeGraphPayload, shouldShowMessageBubbleText, isPreparingPlaceholder, shouldRenderSchemeDraftProse, canReuseTurn, useTimeline, bubbleSummaryLine, historyPresentation, historyMacroSelectedIds, parseMessageMetadataSafe } from './agentMessageRender'
import UniversalModelSelector from '@/components/canvas/UniversalModelSelector.vue'
import { useCanvasRefPickMode } from '@/composables/useCanvasRefPickMode'
import { formatDuration as formatTraceDuration } from '@/components/agent/executionStepLabels'
import { formatSessionTime } from '@/utils/formatSessionTime'
import { randomId } from '@/utils/randomId'
import { submitAnswers } from '@/components/agent/agentAnswers'
import { hasBubbleText } from '@/components/agent/bubbleVisibility'
import { ElMessage } from 'element-plus'


const props = defineProps<{
  sessionId: string
  /** 对话所属项目名称（用于分享页标题「对话·项目名称」）。 */
  projectName?: string
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
  /** 移动端画布视图（2026-10-18 信息架构裁决）：false = 对话视图（整页 SSE 对话流 + composer，
   *  画布隐藏）；true = 画布视图（现状贴底裸条浮在画布上）。由 CanvasPage 持有真相，
   *  进入画布 = 对话流点定位 / composer ◎ 定位锚；退出 = 引用拾取结束或画布上的返回按钮。 */
  mobileCanvasView?: boolean
  /** 移动端纯画布满屏态（2026-10-18 用户裁决）：经传送门进入——画布独占整屏，composer/SSE/顶栏全隐；
   *  经定位/◎拾取进入的画布态（composer+SSE 同屏）此值为 false。由 CanvasPage 持有真相。 */
  mobileCanvasImm?: boolean
  /** 移动端画布视图 + studio dock 展开（画布选中了可编辑节点）：SSE 对话流收起让位，
   *  并经 --lnk-agent-dock-h 把容器实测高度发布给 DockStudioToolbar 抬高避让。 */
  studioDockOpen?: boolean
  /** IA v3：当前页签（chat/canvas/discover/mine）。页签是全局导航——抽屉遮罩避开页签区，
   *  页签变化时自动关抽屉（2026-10-19 真机反馈：抽屉开着点页签「失灵」，实为遮罩吞点击）。 */
  mobileAppTab?: string
  /** 2026-11-05 真机走查：会话级 ☐ 勾选列退役。对话页不再进入任何分享选择态，
   *  范围切换收进分享卡片；本组件只保留回合级分享（单选本轮直开面板）。 */
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
  /** 移动端「门」：对话视图 → 画布视图一键切换（纯看画布，不进拾取——拾取是 ◎ 定位锚那扇「窗」） */
  openCanvasView: []
  /** 全局传送门（画布侧浮动实例）点击：回对话视图。门穿越两模式，是同一颗组件的两个锚位 */
  openConversationView: []
  /** IA v3：会话抽屉「新建会话」——通知宿主回落【对话】页签（新建 = 全新对话，不留在画布） */
  sessionCreated: []
  /** Phase 2b: confirm propose_generation → dock generateForNode(nodeId) */
  generateNode: [nodeId: string]
  /** Phase 2b: cancel propose → clear pending_confirm on canvas node */
  clearProposeGeneration: [nodeId: string]
  /** arrange_nodes 工具：agent 触发自动排列（grid / along_edges / align / distribute），CanvasPage 应用布局 */
  arrangeNodes: [payload: {
    nodeIds: string[]
    mode: 'grid' | 'along_edges' | 'align' | 'distribute'
    gap: number
    edges?: { source: string; target: string }[]
    /** align 的六向口径（left|centerH|right|top|centerV|bottom）。 */
    alignMode?: 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom'
    /** distribute 的轴（x=水平等距 / y=垂直等距）。 */
    axis?: 'x' | 'y'
  }]
  /**
   * 分组工具组（2026-10-21）：Agent 自主打组 / 解组 / 改分组色。
   *
   * ⛔ 这三个事件与 `arrangeNodes` 同理，**必须由 CanvasPage 执行**（不能只落库）：
   * 分组在 vue-flow 活动态是真实节点（parentNode + extent:'parent'），只有页面把
   * nodes.value 改掉再 persistUserEdit() 才能既进 undo 栈又让用户立刻看见框。
   * 走服务端端点会让前端内存态与库里分组分叉，用户下一次保存就把分组抹掉。
   */
  groupNodes: [payload: { nodeIds: string[]; title?: string; groupId?: string }]
  ungroupGroup: [groupId: string]
  setGroupColor: [payload: { groupId: string; colorKey: string | null }]
  /** 「导入到画布」：建成结构化节点组（由 CanvasPage 写 SSOT）。 */
  importNodeGraph: [payload: import('@/components/agent/presentation/AgentNodeGraph.vue').GraphPayload]
}>()

const pickMode = useCanvasRefPickMode()
const pickModeActive = pickMode.active
const { isMobileLayout } = useAgentMobileLayout()
/** PC dock 语义派生：模板 7 处否定读取的单一真源（路线 ③ 第一批）。 */
const isDesktopDock = computed(() => !isMobileLayout.value)

/* dock/panel 定位、桌面浮窗拖拽/调宽、移动端裸条高度发布 —— 已抽到 useAgentDock（见下方调用） */

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
const queuedSlots = ref<QueuedSlot[]>([])
/**
 * 前端**自己**提交插话时拿到的队列 entryId 集合（2026-10-21）。
 *
 * 用途：pi 侧消费插话时会发 `message_end`，事件里的 entryId 与这里登记的**同一把钥匙**
 * （vendor 边界提交队列条目写的是 `{ id: item.entryId }`）⇒ 命中即「这是插话」，
 * 本地没有气泡、需要补建；否则是本轮初始 prompt，挂到本地已有气泡上。
 *
 * ⚠️ 登记后**不清除**：「放弃」只收本地气泡，服务端那条仍会被消费，那时仍要补建气泡。
 * 体积无界增长的风险可忽略（一条插话一个 id，会话级）。
 */
const queuedEntryIds = new Set<string>()
/**
 * 「agent 已经接住」的确定性事件（2026-10-02）。
 *
 * 作用是替掉原先那段 system prompt 约定（"你必须先复述…再动工具"）——那段每轮常驻、是概率行为、
 * 而且模型照样可能一声不吭直接跳工具。这里只要这四种事件任一到达，就说明 agent 已经在这条消息上
 * 产出内容了，气泡从「已入队」推进到「已接住」。收到第一个 text_delta 之前那段空白期（20~40s，
 * 中间还在跑工具）正是用户最需要「它没丢」的时候。
 */
const QUEUE_APPLIED_EVENTS = new Set(['thinking', 'text_delta', 'tool_call', 'activity'])
/** 已发送用户消息的就地二次编辑：正在编辑的消息 id */
const editingMessageId = ref<string | null>(null)
const editingDraft = ref('')
const composerRef = ref<InstanceType<typeof MentionInput> | null>(null)

/** P2-1.1 输入预测上下文：近期可见 user/assistant 文本（cap 20），供 MentionInput ghost 建议 */
const predictionHistory = computed(() =>
  agent.messages
    .slice(-20)
    .map((msg) =>
      msg.role === 'assistant' ? visibleAssistantContent(msg) : visibleUserContent(msg),
    )
    .map((text) => text.trim())
    .filter(Boolean),
)

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
/** 拍照瓦片专用：capture 直调相机（移动端）， accept 限图片 */
const cameraInputRef = ref<HTMLInputElement | null>(null)
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

const composer = reactive(useAgentComposer({
  input,
  sidebar,
  composerRef,
  fileInputRef,
  cameraInputRef,
  isUploading,
  isDragOver,
  assetPickerOpen,
  attachMenuOpen,
  readOnly: () => props.readOnly,
  makeAttachmentItems,
}))

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
  if (keys[idx]) composer.insertRefMention(keys[idx])
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

const shareOpen = ref(false)
const shareTurns = ref<ShareTurn[]>([])

function openShare(msg: AgentStreamMessage) {
  shareTurns.value = [toShareTurn(msg, props.sessionId)]
  shareOpen.value = true
}





/**
 * 2026-11-03 WorkBuddy 同款轮次抬头判定：assistant turn 起点 = 首条消息，
 * 或前一条消息不是 assistant（连续 assistant 消息属同一轮，不重复抬头）。
 */
function isTurnHead(msg: AgentStreamMessage, index: number): boolean {
  if (msg.role !== 'assistant') return false
  if (index === 0) return true
  return agent.messages[index - 1]?.role !== 'assistant'
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

const messageActions = useAgentMessageActions({
  agent,
  isLiveTurnMessage,
  getShowTaskCard: () => showTaskCard.value,
  getAssistantOutputsById: () => assistantOutputsById.value,
  getIsMobileLayout: () => isMobileLayout.value,
  getReadOnly: () => props.readOnly,
  editingMessageId,
  editingDraft,
  sendMessage,
})

const {
  messageFeedback,
  copiedMessageId,
  mobileUserActionsOpen,
  canShowMessageActions,
  toggleMessageFeedback,
  copyAssistantMessage,
  canShowUserMessageActions,
  onUserBubbleClick,
  copyUserMessage,
  editUserMessage,
  cancelEditUserMessage,
  isMessageUnderEdit,
  sendEditedUserMessage,
} = messageActions

const threadHasReattachableHistory = computed(() =>
  agent.messages.some((msg) => canReuseTurn(msg)),
)

const showHistoryReattachCoachmark = computed(
  () => !props.readOnly && !historyReattachHintSeen.value && threadHasReattachableHistory.value,
)

// P1-7.1 引导收敛：composer 区唯一可见引导 = 上方 coachmark（localStorage 首次门控，
// 移动端/桌面共享）；reattach 提示行与 attachment 提示行已删除（与 coachmark 重复，
// 控件自解释），pick-tip 已随 Task 6 移除。


/** 输入框左上角 🎯 圆心重合时的文字起始内边距（半径 + 小间距） */
const COMPOSER_PICK_INSET = 18

/** ◎ 可见性门控（2026-10-18 终版）：只要可交互就常驻可见——灰幽灵是 composer 的
 * 常驻工具（用户裁决「幽灵态灰色效果没出来」＝空态看不到图标，门控放开）；
 * readOnly 隐藏。激活高亮由 is-active 承担。 */
const canvasRefEntryVisible = computed(() => !props.readOnly)


/** Runtime LangGraph thread；与画布 sessionId 解耦，新建对话时重置 */
const agentThreadId = ref(createAgentThreadId(props.sessionId))
const propose = useAgentPropose({
  agentThreadId,
  sessionId: props.sessionId,
  emit,
  sendMessage,
  answersPost,
})
const taskProgress = ref<AgentTaskProgressState>(emptyTaskProgress())
const showTaskCard = computed(() => taskProgress.value.items.length > 0)

/**
 * composer 上沿同一时刻只允许挂一层：有待发气泡时任务卡让位，排队发出后自动回来。
 * ⚠️ 这里只管「卡片是否渲染」；`showTaskCard`（本轮是否有任务）仍被 isLiveTurnMessage /
 * canShowMessageActions 用来判定「本轮是否活跃」，不能被排队状态带偏，否则会在排队期间
 * 把本轮消息的操作按钮提前放出来。
 */
const showTaskCardAtComposer = computed(() => showTaskCard.value && queuedSlots.value.length === 0)

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
 * （历史注）2026-11-03 流式归一后 liveTrace 退役：live 消息自始至终在消息流内联渲染，
 * 钉底/沉降双轨判定与桌面钉底块、移动端系统层镜像块一并退役——它们是移动端三象
 * （信封割裂/中间空白/刷新前后两套渲染）与 PC 二轮回显缺口的共同根源。
 */

function canvasOutputsForMessage(msg: AgentStreamMessage) {
  return deriveCanvasOutputs(msg, {
    isLiveTurn: isLiveTurnMessage(msg),
    taskItems: taskProgress.value.items,
  })
}



/**
 * （历史注）P2-2 的 liveTimeline / liveTrace / liveTimelineMessageId / onLiveTimelineRetry
 * 已随 2026-11-03 流式归一整体退役：live 消息自始至终在消息流内联渲染（与历史同构），
 * 不再有「钉底 + 气泡互斥 + 收束接管」的双轨判定面。
 * ⭐ 2026-10-31 大章鱼回合实证仍有效并已由 creditsLineVisible 承接：挂起回合
 * （turn_suspended 后）isStreaming/last.streaming 双双翻 false，但等待仍在进行——
 * 「回合进行中基座」判定必须并入 mainTurnSuspended。
 */

/**
 * 2026-11-03 会话积分常驻条显隐（对齐 WorkBuddy「已消耗 ◇N」）：仅 turn 活跃期显示
 * （判定 = 回合进行中基座 isStreaming ∪ mainTurnSuspended，与原 liveTimeline 同一口径
 * ——挂起回合等待确认时也在消耗挂账期，用户须看到累计在涨）。空闲时不渲染（不盯死）。
 */
const creditsLineVisible = computed(() => agent.isStreaming || mainTurnSuspended.value)

/**
 * 2026-11-03 WorkBuddy 同款回合实时状态灰字（移动端复测追加需求）：钉在积分常驻条上沿，
 * 实时播报「等待模型响应 / 深度思考中 / 生成回复中 / 正在<工具人话> / 等待你确认」。
 * 数据源 = 时间线单一真相（activityLine.turnLiveStatus，与对话流内联卡同源，结构性防抢跑）；
 * 显隐与积分条同口径（turn 活跃期 isStreaming ∪ mainTurnSuspended，空闲不盯死）。
 */
const turnLiveStatusText = computed(() => {
  if (!creditsLineVisible.value) return null
  const last = [...agent.messages].reverse().find((m) => m.role === 'assistant')
  return turnLiveStatus(last?.timeline?.parts)
})

/** 根治规格（2026-10-28）：对话流内联 proposal 卡的确认 / 取消——复用既有确认面语义，
 *  不再走对话流外浮卡。confirmProposeWait / cancelProposeForNode 已 defineExpose 给画布节点。 */
function onInlineConfirmProposal(nodeId: string) {
  void propose.confirmProposeWait(nodeId)
}
function onInlineCancelProposal(nodeId: string) {
  void propose.cancelProposeForNode(nodeId)
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

/**
 * P1a（2026-11-07）：「画布总览」是当前画布态的会话级投影，不是某一轮的产物。
 * 旧实现把它塞进每轮 turnDeliveryItems ⇒ 零产物回合虚报 1 个产物、历史回合被
 * 注入当时还不存在的总览。现在只在最后一个 timeline 回合渲染独立入口。
 */
const sessionDigestEntry = computed(() => canvasDigestEntry(props.canvasNodes))
const lastTimelineAssistantId = computed(() => {
  for (let i = agent.messages.length - 1; i >= 0; i -= 1) {
    const m = agent.messages[i]
    if (m?.role === 'assistant' && m.timeline) return m.id
  }
  return null
})

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
    // 回填时间线（2026-10-17 产物体验补全）：`node_status` SSE 无生产者，回合流关闭后
    // 才完成的生成只有轮询能拿到权威终态 ⇒ 经此喂回 artifact part（翻 done/failed）。
    // 产物行不再永远「待确认/生成中」，定位按钮（done/failed 才出）与缩略图随之出现；
    // done 且有媒体地址时直存 part.url（回填判定按产物归属回合，不污染新回合）。
    const mapped = mapRecordStatusToTaskStatus(record.status)
    agent.backfillTimelineNodeStatus({
      nodeId: task.nodeId,
      status: mapped === 'needs_user' ? 'pending' : mapped,
      url: mapped === 'done' ? parseRecordUrl(record) || undefined : undefined,
    })
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
/**
 * turn_suspended（2026-10-31 皮皮虾回合生产实证）：主流在阻塞等待边界被 pi lane 挂起
 * 收尾（服务端 streamFromPiRuntime 在「waiting{waiting} 且无权威收束」时于流末尾下发）。
 * 挂起 ≠ 断链：等待条/回合呈现须在整个等待期存活（isStreaming 并集），finally 的
 * 「本轮无文本回复」兜底也不得把挂起回合当空回合补文案。复位点：新一轮发送 /
 * run_cancelled / 旁听流 turn_end 收口。
 */
const mainTurnSuspended = ref(false)
const threadRunState = ref<{ phase?: string | null; runCancelled?: boolean | null } | null>(null)
const cancelledPresentation = ref<AgentPresentationEnvelope | null>(null)
/** Progress line built from the cancel API response, before the checkpoint refresh lands. */
const cancelledProgressText = ref<string | null>(null)
const reconnecting = ref(false)
const recoveredPhaseHint = ref<string | null>(null)

const agentStream = useAgentStream({
  onStale: () => {
    // ⭐ 2026-10-31 大章鱼回合实证：阻塞等待期（propose/ask 挂起）主流**本就无事件**，
    // 30s 静默阈值会把「正常等待」误判成「流卡死」而 abort——AbortError 走「用户主动
    // 取消」静默分支，用户侧表现即「连接无故断开」。等待期沉默是预期行为：流的收口
    // 由服务端 turn_suspended / 等待超时保证，真正的网络死亡由旁听流与恢复链路兜底。
    if (agent.pendingProposal || agent.pendingQuestion || mainTurnSuspended.value) return
    streamAbortController?.abort()
  },
})

/**
 * IA v3.2（2026-10-20 修复）：发现/我的页签与对话回合无关——移动端整条 dock（含状态行）
 * 必须彻底隐藏。否则 Teleport 到 body 的容器（z 高于 App.vue 的 `main.z-10`）会盖住发现/我的页：
 * 从对话页切过去会整页覆盖、从画布页切过去只剩裸露的状态行漂浮。
 * 注意：CanvasPage 给 `<aside>` 加的 hidden 类对 Teleport 内容无效，这里由容器自身收口。
 */
const railHiddenByTab = computed(
  () => isMobileLayout.value && (props.mobileAppTab === 'discover' || props.mobileAppTab === 'mine'),
)

/**
 * 阻塞等待 propose_generation（2026-10-01）：确认动作只存在于画布节点，
 * 聊天侧必须明示「去哪确认 + 一键定位」，否则用户只看到转圈无从下手。
 * 根治 2026-10-29：等待态单一真相 = 时间线 proposal part（见 store.pendingProposal），
 * 不再用 `blockingWait`/`proposeWait` 这类并行 store 态，故无 watch / 死 emit。
 */

/**
 * 琥珀卡取消（2026-10-01；2026-10-06 接显式 decline）：只拒绝该节点的生成提议
 * （clear-propose → 节点回 draft，run 恢复继续对话）；绝不是中止整个 run —— 那是
 * composer「停止」的语义。等待期流式守卫刻意不设（定位/取消入口语义一致）。
 *
 * 2026-10-06 加的这半根线（生产事故 cmus6ha64001dk601lzsymqfa 第二处）：取消此前**只**
 * 写 Nest SSOT，工具侧靠 SSOT 时序推断「用户拒绝」；把文案中性化以后用户真按了取消，
 * 模型反而不知道，回「请你在画布节点上点一下确认」。现在先显式 `decline`
 * （registry → aborted ⇒ tool result reason=aborted），再清画布 SSOT；
 * 前者失败不阻断后者（轮询兜底仍在，且画布状态必须收敛）。
 *
 * ADR-0011 T1（2026-10-19）：泛化为**节点级**入口——画布节点内联确认面
 * （ProposeConfirmOverlay）与时间线内联卡共用本函数、同一语义。
 * nodeId 缺省 = 当前阻塞等待所属节点；
 * 传入 nodeId = 画布节点语义，与当前等待的 nodeId 不一致时**安全 no-op**
 * （浮层竞态残留防护：宁可不发，也不把 decline 发到别的节点上）。
 */
/**
 * ⭐ 2026-10-31 大章鱼回合生产实证（cmvvaw8ar000moe01fdolrugb，nginx 17:01:25-27）：
 * 同一等待被连发 4×answers + 1×decline + 1×clear-propose——画布确认面 / 聚合状态条 /
 * 时间线内联卡多入口同显且**无单飞去重**，首发的 resolved 事件又经旁听流迟到/缺席
 * ⇒ 各入口在窗口期内持续可点。修复两层：
 *   ① 单飞：同一 callId 首个成功提交后记入 settled 集合，后续 confirm/decline 一律
 *      no-op（端点幂等只是兜底，客户端必须自己收敛）；
 *   ② 乐观翻态：提交成功即刻本地翻 proposal part 终态（waiting_user resolved 回喂
 *      时间线），pendingProposal 立即清位 ⇒ 所有确认 UI 同帧收口，stale 等待不再
 *      污染下一轮（画布锚点 / 状态条倒计时 / composer 形态）。
 */





const showCancelledCallout = computed(
  () => isRunCancelledState(threadRunState.value) || runCancelled.value,
)
const cancelledCalloutText = computed(() => {
  const text =
    String(cancelledPresentation.value?.body?.text ?? '').trim() ||
    (cancelledProgressText.value ?? '')
  return text || '当前任务已停止，你可以发起新任务或直接输入新的需求。'
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


/** 面板是否展开（收缩态只保留右下角 logo FAB） */
const open = ref(false)
/** 浮动窗口模式：面板脱离侧栏，悬浮在画布上，可拖拽 */
const floating = ref(false)
/** 浮窗/裸条 DOM 锚（传给 useAgentDock 做移动端高度测量） */
const panelShellRef = ref<HTMLElement | null>(null)
const bareBarRef = ref<HTMLElement | null>(null)

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
const PANEL_DEFAULT_W = 500
const panelWidth = ref(PANEL_DEFAULT_W)
const resizing = ref(false)

/* ---- 浮窗位置 / 尺寸 ---- */
const floatPos = ref({ x: 0, y: 0 })
const floatWidth = ref(PANEL_DEFAULT_W)
const dragging = ref(false)

// Phase 3 拆解：dock/panel 定位 + 桌面浮窗拖拽/调宽 + 移动端裸条高度发布，抽到 useAgentDock。
const { panelTeleported, asidePanelWidth, toggleFloating, startDrag, startResize } = useAgentDock({
  open, floating, panelWidth, floatWidth, floatPos, dragging, resizing,
  bareBarRef, panelShellRef, isMobileLayout,
})

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

// 第八刀（strangler-fig）：Queue-Draft 簇（queueDraftAsPending / deliverQueued / withdrawQueued /
// dismissQueued / requeueQueued / markQueueApplied）已迁入 useAgentQueue。
// queuedSlots / queuedEntryIds 仍由本组件持有所有权，仅注入 composable 消费（与第七刀同口径）。
const queue = useAgentQueue({
  queuedSlots,
  queuedEntryIds,
  input,
  sidebar,
  agentThreadId,
  composerRef,
  planningModel,
  scrollToBottom,
  getSessionId: () => props.sessionId,
  getSelectedNodeIds: () => props.selectedNodeIds,
  getPendingQuestion: () => agent.pendingQuestion,
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

/* ---- 技能选择（显式 Skill；默认自动 / 平台路由）----
 * 2026-10-18：技能入口收敛为「＋」一级菜单（技能父项），展开下一级才列出 自动/已安装技能；
 * 选中即关闭菜单并写回 activeSkillId。原 composer 独立 chip（P2-5.1 skillMenuMode）已退役。 */
const activeSkillId = ref<string | null>(null)
const skillSubmenuOpen = ref(false)
const activeSkill = computed(() => getAgentSkill(activeSkillId.value))
const isProductVisualSkill = computed(() => activeSkillId.value === 'product-visual')
const inputPlaceholder = computed(() =>
  agentInputPlaceholder(activeSkill.value),
)
const showProductVisualEmptyState = computed(
  () =>
    isProductVisualSkill.value
    && !props.readOnly
    && !agent.messages.some((m) => m.role === 'user'),
)

/* ---- 对话 thread 列表 ---- */
const threads = ref<AgentThreadRow[]>([])

async function fetchThreads(): Promise<AgentThreadRow[] | null> {
  try {
    const res = await fetch(
      apiUrl(`/api/agent/chat/threads?sessionId=${encodeURIComponent(props.sessionId)}`),
      // 禁缓存（2026-10-28 生产取证）：端点带 ETag 无 Cache-Control，刷新/切回时浏览器
      // 带条件头重校验 ⇒ 304 空体 ⇒ 本函数把「读取失败」如实上报成空列表 ⇒ 对话抽屉「暂无对话记录」。
      { cache: 'no-store' },
    )
    if (!res.ok) return null
    const json = await res.json()
    const rows = (json.data ?? []) as AgentThreadRow[]
    threads.value = rows
    return rows
  } catch {
    return null // fail-open（K3/D3）：null ≠ 空数组，bootstrap 不得清 fork key（H0-d 重试卡兜底展示）
  }
}




onMounted(() => {
  void threadApi.bootstrapThread()
  // A3：回访作品带数据 —— 挂载即拉（断点中立：PC 左栏与移动端对话框顶部都展示，
  // 不再是移动端专属）。projects 来自 useProjectWorkspace 单一数据源，作品带与抽屉共用。
  void loadProjects()
  // A1 二期：金句定时轮换（empty 相 7 条 > 4 位 ⇒ 长尾要能露出来）。
  utteranceRotationCtl.start()
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
    void threadApi.bootstrapThread()
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

function onFocusAll(nodeIds: string[]) {
  emit('focusAll', nodeIds)
}

function onExportPack(
  nodeIds: string[],
  exportMode: 'full_package' | 'lightweight' = 'full_package',
) {
  emit('exportPack', nodeIds, exportMode)
}

/* toggleFloating / startDrag / startResize 已移到 useAgentDock（见上方调用） */





/** P1#6 缩略图 url 源：canvasNodes 按 nodeId 查 url。 */
function resolveCanvasNodeUrl(nodeId: string): string | undefined {
  const node = props.canvasNodes?.find((n) => n.id === nodeId)
  const url = (node?.data as { url?: string } | undefined)?.url
  return typeof url === 'string' && url ? url : undefined
}

/** H0-d（规格 §2/K3）：历史加载失败必须 fail-visible + 可重入，禁止 toast+空白（验收 S1）。 */
type HistoryLoadState = 'idle' | 'loading' | 'failed'
const historyLoadState = ref<HistoryLoadState>('idle')
// H1-d（规格 §8）：历史行 metadata 畸形被 sanitize 降级保留时显式标注（D15：与「本来就没有过程」可区分）
const degradedHistory = ref(false)

// H1-a（规格 §5.2）：历史分页游标状态。historyRows 是「已加载全量窗口」（asc，最早在前），
// 翻页只 prepend 更早行、不整体重建（整体重建会抹掉窗口外的尾部轮次）。
const historyRows = ref<PersistedAgentMessage[]>([])
const historyCursor = ref<string | null>(null)
const historyHasMore = ref(false)
const historyLoadingOlder = ref(false)

async function loadHistory() {
  agent.clear()
  taskProgress.value = emptyTaskProgress()
  // H1-a 修复轮（审查 Minor-2）：起点**同步**清零分页游标状态——跨线程残留会在
  // 「切线程 + 首载失败 + 点翻页」时拿 A 线程游标查 B 线程；同步清零还关闭了
  // 首载在途期点翻页的竞态窗口（成功路径随后回填，失败路径保持 null/false）。
  historyRows.value = []
  historyCursor.value = null
  historyHasMore.value = false
  // H1-d 终审修复（#2）：降级横幅同步清零——否则 A 线程降级标注残留到
  // 后续空历史/加载失败线程，构成用户可见误报。
  degradedHistory.value = false
  historyLoadState.value = 'loading'
  try {
    const res = await fetch(
      apiUrl(
        `/api/agent/chat/user/messages?sessionId=${encodeURIComponent(props.sessionId)}&threadId=${encodeURIComponent(agentThreadId.value)}`,
      ),
      // ⛔ 禁缓存（2026-10-28 生产事故）：端点带 ETag 无 Cache-Control ⇒ 刷新/切回画布时
      // 浏览器带 If-None-Match 重校验 ⇒ 304 空体 ⇒ `res.ok` false（或 json() 抛错）⇒
      // 走到告警分支，`agent.clear()` 之后历史不再回填 ⇒ **对话页整页空白**。
      // 同文件 `reconcileLatestAssistant` 有同款修复。
      { cache: 'no-store' },
    )
    if (!res.ok) {
      ElMessage.warning('对话历史加载失败，请检查网络后刷新')
      historyLoadState.value = 'failed'
      return
    }
    const json = await res.json()
    // H1-a（规格 §5.2）：服务端权威分页字段（K5）
    historyRows.value = (json.data ?? []) as PersistedAgentMessage[]
    historyHasMore.value = json.hasMore === true
    historyCursor.value = json.nextCursor ?? null
    if (json.data?.length) {
      // H1-d（规格 §2）：渲染前净化；hasUserAfter 仍读原始 msgs（机器载荷 user 行也算「之后有用户」，防重复弹卡）
      const sanitized = sanitizeHistoryMessages(historyRows.value)
      degradedHistory.value = sanitized.degradedIds.size > 0
      agent.loadHistory(sanitized.rows)
      // P1#5：最后一回合若有 task 事件（plan 标记派生），恢复任务卡进度
      const msgs = json.data as Array<{ role: string; content?: string; metadata?: string }>
      // H1-d（§8④）：恢复锚点 = 最后一条非空 assistant（空行 metadata 会污染任务卡/ask_user 恢复）
      const lastAssistantMsg = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content?.trim())
      const meta = parseMessageMetadataSafe(lastAssistantMsg?.metadata)
      const seeded = seedTaskProgressFromEvents(meta?.executionEvents ?? [])
      if (seeded) taskProgress.value = seeded
      // P1#7 待答卡恢复：已由 `replayTimelineEvents`（上方 loadHistory 重建 timeline）从
      // `ask_user` 事件收敛出 question part 单一真相接管——无需再回填组件级 ref。
    }
    historyLoadState.value = 'idle'
    // Epic 4（2026-11-04）：历史消耗还原——credit_tx 只在飞不落 executionEvents，
    // 重开会话的「本次消耗」由 REST 流水回放（restore 模式只累计不驱动余额，
    // 余额随后 refreshPoints 拉权威值）。失败静默：常驻条从 0 起步，不影响主流程。
    void restoreSessionCreditHistory(props.sessionId)
  } catch {
    ElMessage.warning('对话历史加载失败，请检查网络后刷新')
    historyLoadState.value = 'failed'
  }
  scrollToBottom(true)
}

/**
 * Epic 4：跨会话聚合卡数据源——按会话拉积分流水喂 trackCreditTx（txId 幂等，
 * 与 SSE 实时帧天然去重）。行升序、限 200；restore 模式不动余额，末尾 refreshPoints。
 */
async function restoreSessionCreditHistory(sessionId: string) {
  try {
    // sessionPointTransactions 为 async 包装，直接返回 rows（类型显式，无泛型解构歧义）
    const rows = await membershipApi.sessionPointTransactions(sessionId)
    for (const row of rows) {
      agent.trackCreditTx(
        {
          txId: row.id,
          userId: '',
          sessionId,
          amount: row.amount,
          kind: row.kind as CreditTxEvent['data']['kind'],
          category: row.category as CreditTxEvent['data']['category'],
          reason: row.reason,
          generationId: row.generationId ?? undefined, // §14.4：restore 同写实耗 map，重开对话卡片仍翻转
          balanceAfter: row.balanceAfter ?? 0, // restore 不读余额；契约必填 number，undefined 会 TS2322
          ts: new Date(row.createdAt).getTime(),
        },
        { restore: true },
      )
    }
    if (rows.length > 0) void useAuthStore().refreshPoints()
  } catch {
    // 静默降级：历史流水还原失败不阻塞对话主流程
  }
}

/** H1-a（规格 §5.2/验收 S5）：loadOlder 向前翻页取更早消息；只 prepend、不整体重建。 */
async function loadOlder() {
  if (!historyCursor.value || historyLoadingOlder.value) return
  historyLoadingOlder.value = true
  try {
    const res = await fetch(
      apiUrl(
        `/api/agent/chat/user/messages?sessionId=${encodeURIComponent(props.sessionId)}&threadId=${encodeURIComponent(agentThreadId.value)}&before=${encodeURIComponent(historyCursor.value)}`,
      ),
      { cache: 'no-store' },
    )
    if (!res.ok) return
    const json = await res.json()
    // H1-d 修复轮（P3）：更早分页同样走净化边界——首载 loadHistory 已 sanitize，
    // 翻页若不净化会漏出 __new_task__ 机器载荷气泡 / 空 assistant 行，与首载渲染不一致。
    // 净化只改渲染视图（DB 原文不动，见 historySanitize.ts 顶部约定），prepend 安全。
    const older = sanitizeHistoryMessages((json.data ?? []) as PersistedAgentMessage[]).rows
    historyRows.value = [...older, ...historyRows.value]
    historyHasMore.value = json.hasMore === true
    historyCursor.value = json.nextCursor ?? null
    // H1-a 修复轮（审查 Important-1）：只 prepend 更早行、**不整体重建**——
    // 整体重建（loadHistory 全量替换）会把会话内新发出、未回写窗口的尾部
    // 轮次（含流式进行中）从视图抹掉（复现：长对话 → 发消息 → 点「加载更早消息」）。
    agent.prependHistory(older)
  } catch {
    // 翻页失败保持现场：按钮仍在，可再点（K3）
  } finally {
    historyLoadingOlder.value = false
  }
}


/* ---- 移动端裸条状态（P1-5，2026-10-16 三态共条重构） ----
 * 语音识别已于 2026-10-21 整体下线（移动端 + PC）：本组件不再有录音态与麦克风钮。 */
const composerExpanded = ref(false)
/* 2026-10-18 ③ ◎ 引用入口门控：聚焦即算「进入输入态」，◎ 立即可见（PC/移动通用），
 * 不再等用户敲出第一个字。
 * 2026-11-09：改为跨组件共享单例（useMobileComposerFocus）——MobileTabBar 需读取同一份
 * 状态以在聚焦态隐藏底部页签；本组件只写不另起本地 ref。 */
const composerFocused = useMobileComposerFocus()
const { isKeyboardOpen } = useMobileKeyboardInset()
const composerDockRef = ref<HTMLElement | null>(null)

// 输入框被程序填充（如待发消息取回）时自动进入伸展态
watch(input, (v) => {
  if (isMobileLayout.value && v.trim()) composerExpanded.value = true
})

function onComposerFocusIn(e?: FocusEvent) {
  // 2026-11-09 真机修复 #1：仅可编辑元素（textarea）获焦才进入输入态——
  // 点 ＋ / ◎ 等条内按钮会顺带让按钮获焦，若据此展开 composer 属误触（且会与附件卡弹出抢交互）。
  const t = e?.target as HTMLElement | null
  const tag = t?.tagName?.toLowerCase()
  const editable = tag === 'textarea' || tag === 'input' || t?.isContentEditable
  if (!editable) return
  composerFocused.value = true
  if (isMobileLayout.value) composerExpanded.value = true
}

function onComposerFocusOut(e: FocusEvent) {
  // ③ 焦点只在真正离开卡内时才清（点模型 chip 等卡内控件不算离开，否则 ◎ 闪烁熄灭）
  const next = e.relatedTarget as Node | null
  if (next && composerDockRef.value?.contains(next)) return
  composerFocused.value = false
  if (!isMobileLayout.value) return
  // 延迟收起：给「聚焦丢失但有交互意图」的场景留窗口；有内容则保持伸展
  window.setTimeout(() => {
    if (input.value.trim()) return
    // 真机兜底：点按进入输入态的短窗口内丢焦（OEM 合成事件变体），不收起、重试聚焦一次
    //（仅一次，防窗口期误抢用户后续点击；重试失败则保持展开，用户直接点 textarea 原生聚焦）
    if (Date.now() - barTapIntentAt < 400 && !barTapRefocusUsed) {
      barTapRefocusUsed = true
      void nextTick(() => composerRef.value?.focus())
      return
    }
    composerExpanded.value = false
  }, 150)
}

/* ---- P1-5 移动端裸条三态（barShape 单源路由） ----
 * idle：条内仅 ＋ + 「点按输入」提示（P1-5.3）；stacked/queued 见 mobileBarLayout.ts。
 * 伸展态（点按后）在 barShape 上仍属 idle 形态（无芯片、非生成），但渲染输入行。 */
const mobileBarShape = computed(() =>
  barShape({ hasRefs: composer.pendingAttachmentItems.length > 0, isStreaming: agent.isStreaming }),
)
const mobileBarIdle = computed(
  () =>
    isMobileLayout.value &&
    mobileBarShape.value === 'idle' &&
    !composerExpanded.value,
)

/**
 * 空闲条文案不再写死：改为轮换当前相的短金句，见下方 mobileBarIdleHint
 * （定义在 currentUtterancePhase 之后 —— 它依赖池维度，顺序不能提前）。
 * 语音识别已于 2026-10-21 整体下线（移动端 + PC），条上不再承诺语音能力。
 */

/**
 * A1：空态 chips 区固定一位「传图」引导位。
 *
 * 为什么必须有它：真实语料里一半依赖素材，而 attachment 相的触发前提是「用户
 * 已传图」——空态只给不依赖素材的短句，用户根本想不到传图 ⇒ attachment 池一条
 * 都曝不了光，加了等于白加。
 *
 * ⚠️ 它不是金句：不入池、不轮换、点击走 pickImage 而非 fillFromUtterance，
 * 因此**不计入 golden_quote_picked**（另计 entry_attachment_cta）——否则分不清
 * 点击率来自金句还是引导位。
 * 只在 empty 相出现：有素材时 attachment 池本身就是素材话术，再挂「传图」是噪音。
 */
const showAttachmentCta = computed(
  () => !props.readOnly && currentUtterancePhase.value === 'empty',
)

/* ---- 条级手势（2026-10-21 语音下线）：只保留「点按切输入态」。
 * 语音识别移除后不再有 hold / 上滑取消两种手势分支；拖动（滚动手势）不误触发展开。
 * 子控件（＋/◎/模型/发送）命中一律不触发条手势（closest 排除 + 子控件 .stop）。 */
let barGestureStartAt = 0
let barGestureStartY = 0
let barTapIntentAt = 0 // 最近一次 tap 切输入态的时间戳（丢焦兜底窗口判据）
let barTapRefocusUsed = false // 兜底重聚焦只允许一次，防止窗口期误抢用户后续点击的焦点


function onBarGestureOnChild(e: PointerEvent): boolean {
  const target = e.target as HTMLElement | null
  return !!target?.closest('button, a, [role="button"], input, textarea')
}

/** 2026-10-18 真机修复（空态点按瞬跳回）：touch 结束后浏览器合成 mousedown，
 * target 是 touchstart 命中的条面/提示 span（展开后 span 已移除 → 重定向到非焦点化 div），
 * 其默认动作会抢走 tap 刚聚焦的 textarea ⇒ focusout ⇒ 150ms 后收起 = 「展开瞬跳回」。
 * 仅对非子控件命中的合成 mousedown preventDefault（textarea/按钮直点不受影响）。 */
function onBarMouseDown(e: MouseEvent) {
  if (onBarGestureOnChild(e as unknown as PointerEvent)) return
  e.preventDefault()
}

function releaseBarCapture(e: PointerEvent) {
  try {
    ;(e.currentTarget as HTMLElement | null)?.releasePointerCapture?.(e.pointerId)
  } catch {
    /* 指针已释放等场景忽略 */
  }
}

function onBarPointerDown(e: PointerEvent) {
  if (!mobileBarIdle.value || props.readOnly) return
  if (onBarGestureOnChild(e)) return
  barGestureStartAt = Date.now()
  barGestureStartY = e.clientY
  try {
    ;(e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId)
  } catch {
    /* ignore */
  }
}

function onBarPointerUp(e: PointerEvent) {
  releaseBarCapture(e)
  if (!mobileBarIdle.value || props.readOnly) return
  if (onBarGestureOnChild(e)) return
  // 纵向位移超阈值 = 滚动手势（语音下线后不再有 hold，此处只防误触展开）
  if (Math.abs(e.clientY - barGestureStartY) > 10) return
  if (classifyGesture({ durationMs: Date.now() - barGestureStartAt, dy: 0 }) !== 'tap') return
  composerExpanded.value = true
  barTapIntentAt = Date.now()
  barTapRefocusUsed = false
  void nextTick(() => composerRef.value?.focus())
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function cancelActiveStream() {
  if (!agent.isStreaming) return
  runCancelled.value = true
  const { apiOk, completedTasks, totalTasks, recovered } = await cancelAgentRun({
    threadId: agentThreadId.value,
    sessionId: props.sessionId,
    abort: () => {
      streamAbortController?.abort()
      agentStream.stop()
      agent.finishStreaming()
    },
    postCancel: (body) =>
      postCancelRun(body).then((r) => {
        if (!r.ok) throw new Error(`cancel failed: ${r.status}`)
        return r.json()
      }),
  })
  cancelledProgressText.value = cancelledCalloutTextFromProgress(completedTasks, totalTasks)

  // ⭐ 2026-10-20：abort 可能把用户插队的消息**销毁**（vendor 的 requestOperationAbort
  // 会删 inbox 条目且不可恢复），但把内容吐回给我们 ⇒ 必须还给用户，否则就是静默的数据丢失。
  // 回灌到输入框（对齐上游 coding-agent 的 clearQueue：把队列内容放回编辑器）。
  const recoveredText = recoveredQueueText(recovered)
  if (recoveredText) {
    // 已有草稿时不覆盖：把还原内容追加在后面，两段都用分隔线隔开
    const existing = input.value.trim()
    input.value = existing ? `${existing}\n\n${recoveredText}` : recoveredText
    nextTick(() => composerRef.value?.focus())
    ElMessage.warning('你插队的补充被中断操作清掉了，已放回输入框')
  }

  ElMessage.info(apiOk ? '已停止当前任务，您可以发送新需求' : '已断开回复，后台可能仍在收尾')
  if (apiOk) await threadApi.refreshThreadCheckpoint()
}

async function send() {
  if (isUploading.value) return
  if (agent.isStreaming) {
    // 流式中若有草稿：底部按钮临时呈发送态，点按 = 与回车等价（挂待发气泡），不中断 turn；
    // 草稿为空才保留停止语义（中止即发，抄 WorkBuddy）。
    //
    // ⭐ 2026-10-21 hotfix：**只有「无草稿」（'empty'）才允许中止 turn**。
    // 此前这里写的是 `if (await queueDraftAsPending()) return`，把 boolean 的 false
    // 一律当成「没有草稿可挂」；而 queueDraftAsPending 有**两个** false 出口
    // （无草稿 / 槽位已满）⇒ 槽位排满时点按钮会顺带把用户正在跑的那一轮停掉 ——
    // 恰好是「流式中可插话」这条链路要根治的行为。
    // 现在改成三态：'full'（槽位已满）由 queueDraftAsPending 自己 warning + 保留草稿，
    // **不**落到中止分支；只有 'empty' 才中止。
    const outcome = await queue.queueDraftAsPending()
    if (outcome !== 'empty') return
    await cancelActiveStream()
    return
  }
  if (!composer.canSubmitComposer) return
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
 * 当前有**未作答**的阻塞式卡（ask_user / propose_generation pending）。
 *
 * 存在理由（2026-10-02 组合漏洞）：agent 卡在 `registry.waitForUser` 里时，pi-runtime 的
 * `prompting` 标志**恒为 true**（它只在 prompt 包住的一轮结束后才清位），所以
 * `POST /sessions/:id/steer|followup` 一律 202 + `queued:true`。消息于是躺进 lane inbox，
 * 要等 ask 落定 → tool_result → 模型跑到某个边界才可能被选中。也就是说：这一轮**根本没有
 * 在回答**，气泡却按「已并入当前回答」回话，用户据此以为自己改成了刚要选的那项。
 * 这里把那条假文案降成诚实的时序说明，并把按钮文案带上「答完这张卡后接」。
 */
/** 当前有未作答的阻塞式 ask 卡：从时间线 question part（pending_answer）派生，取代组件级 ref。 */
const pendingAskBlocking = computed(() => agent.pendingQuestion !== null)

/**
 * user 消息 entryId 回填（2026-10-21，统一身份）。
 *
 * 正常发送的 user 行是在调 pi **之前**落的，而 `pi.prompt()` 只回 `{ accepted }`
 * ⇒ entryId 只能从这里回填给服务端（见 persistEntryId 调用点），否则刷新后的历史消息
 * 没有 fork 切点、「③ 重跑」只能降级兜底。幂等由服务端唯一索引兜住。
 *
 * 为什么可以静默失败：这只影响「刷新后能否从这条历史消息重跑」，属于**增强**而非正确性，
 * 失败时退化为既有的降级兜底，不该打断对话流，也不该弹错。
 */
async function persistUserEntryId(entryId: string): Promise<void> {
  const threadId = agentThreadId.value
  if (!entryId || !threadId) return
  try {
    await postPersistEntryId({ sessionId: props.sessionId, threadId, entryId })
  } catch {
    // fail-soft：服务端 entryId 唯一索引保证重试/多页签都不会写出重复行。
  }
}

/**
 * 输入框回车提交。流式中**不自动投递**，只把消息挂进待选气泡（走 queue 簇的 queueDraftAsPending），
 * 动作权留给用户：steer（立刻接住）与 followUp（收尾接住）是两种送达时机，不能替他默认选一个。
 * 非流式中走正常发送。底部「停止」按钮走 `send()`，二者分离。
 */
async function onComposerSubmit() {
  if (agent.isStreaming) {
    await queue.queueDraftAsPending()
    return
  }
  await send()
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
 * A1：首屏金句池（短句版）—— 按池维度给出 ≤4 条。
 *
 * ⚠️ SSOT 是 outputs/移动端入口-金句文案清单.html，本池是副本：改文案先改清单，再同步这里。
 * 约束（清单 R1/R2/R4）：chips ≤16 汉字 / 裸条 ≤14 汉字 / 禁内部术语 / 禁「：+」清单式句式。
 * 旧的 40 字长句已废弃 —— 那是需求文档口吻，与本产品「你说一句就够了」的定位相悖。
 */
const EXAMPLE_UTTERANCE_POOL: UtterancePool = {
  empty: [
    '帮我做一套儿童绘本',
    '帮我创作一首民谣歌曲',
    '生成人物角色的三视图和场景图',
    '给我做一套小红书种草视频',
    '画一座会呼吸的灯塔',
    '把我的一天画成四格',
    '出一套生鲜闸蟹快递包装材料',
  ],
  selection: [
    '把它重画成扁平插画',
    '再出两张风格变体',
    '换个季节和光线',
    '把背景换成纯色',
  ],
  attachment: [
    '让模特换上这件衣服',
    '用这几张图片作为分镜生成一段视频',
    '用这个实拍图，出一套电商上架套图',
    '给这个产品做一套TVC广告视频',
    '给我这个产品做一套营销推广方案',
  ],
  artifact: [
    '再来1套，风格不一样的',
    '改成竖版海报',
    '再来一张深色版',
    '把两张拼成一组',
  ],
}

/**
 * 裸条提示位轮换池（≤14 汉字，一行放得下）—— 对应清单里标 data-bare="1" 的条目。
 * 裸条只有一行，比 chips 更窄，故不是所有 chips 条目都能上裸条。
 */
const BARE_HINT_POOL: Record<UtterancePhase, string[]> = {
  empty: [
    '画一座会呼吸的灯塔',
    '把我的一天画成四格',
    '帮我做一套儿童绘本',
    '帮我创作一首民谣歌曲',
    '出一套生鲜闸蟹快递包装材料',
  ],
  selection: ['把它重画成扁平插画', '再出两张风格变体', '换个季节和光线', '把背景换成纯色'],
  attachment: ['让模特换上这件衣服'],
  artifact: ['再来1套，风格不一样的', '改成竖版海报', '再来一张深色版', '把两张拼成一组'],
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

/**
 * A1 · B′ 决策：池维度 = 画布相 ∪ composer 素材态。
 * hasAttachments 直接取 pendingAttachmentItems（派生自 sidebar.pendingAttachments）——
 * 现成信号，零新增状态。attachment 优先级高于任何画布相。
 */
const currentUtterancePhase = computed<UtterancePhase>(() =>
  pickUtteranceContext({
    phase: currentCanvasPhase.value,
    hasAttachments: composer.pendingAttachmentItems.length > 0,
  }),
)

/**
 * 轮换偏移：池大于展示位时（empty 7 条 > 4 位）必须轮换，否则第 5 条之后永不露出。
 * 驱动 = 池维度切换（相变 / 挂素材 / 卸素材）**+ 定时轮换**（A1 二期）。
 *
 * A1 二期补上「时间」这个驱动维度：原先只靠相变推进 ⇒ 用户停在同一相时
 * 第 5~7 条永不露出，等于白写。定时轮换的守卫（reduced-motion / 聚焦暂停 /
 * 池大小 / 卸载清理）全部在 `useUtteranceRotation` 里，本处只负责接线。
 */
const utteranceRotation = ref(0)
watch(currentUtterancePhase, () => {
  utteranceRotation.value += 1
})

/** 轮换间隔：7s（够长到不被注意，够短到长尾能露出来） */
const UTTERANCE_ROTATION_INTERVAL_MS = 7_000

const utteranceRotationCtl = useUtteranceRotation({
  rotation: utteranceRotation,
  intervalMs: UTTERANCE_ROTATION_INTERVAL_MS,
  poolSize: () => (EXAMPLE_UTTERANCE_POOL[currentUtterancePhase.value] ?? []).length,
  visibleCount: 4,
  // composer 获得焦点时暂停：用户正在写字，金句在脚下跳会干扰
  paused: composerFocused,
})

const exampleUtterances = computed(() =>
  selectExampleUtterances(
    currentUtterancePhase.value,
    EXAMPLE_UTTERANCE_POOL,
    utteranceRotation.value,
  ),
)

/**
 * 空闲条文案（替代固定「点按输入」）：轮换当前相的短句，兼作灵感入口。
 * 语音识别已于 2026-10-21 整体下线，条上不再承诺语音。
 */
const mobileBarIdleHint = computed(() => {
  const items = BARE_HINT_POOL[currentUtterancePhase.value] ?? []
  if (!items.length) return '点按输入'
  const i = utteranceRotation.value % items.length
  return items[i < 0 ? i + items.length : i]
})

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
    // 2026-10-25 PR-2：通道换成 useProjectWorkspace.create（唯一 create 通道）。
    // ⚠️ 失败不再静默 goToWorkflowHome（用户零反馈：点了没反应，还被弹回品牌页），
    //    改为明确报错——与 CanvasesPage / WorkflowPage 的 10-24 修复对齐。
    const created = await createProject()
    void router.push(`/workflow/${created.id}`)
  } catch {
    ElMessage.error('新建项目失败，请重试')
  }
}

/**
 * @param branchFromEntryId ③ 重跑：pi 会话内目标消息的 entryId。提供时后端先 fork 出
 *   「截断到该消息之前」的新分支线程，再在新线程上跑本轮（真正的后端线程截断）。
 */
async function sendMessage(message: string, branchFromEntryId?: string, isRetry = false) {
  // §5.3（③ 已确认）：pending 期间对话输入一律按 answer，自由文本填充首个未答问题。
  // 简化：B-6 卡片在答满后已自动提交消失，pending 存在 = 至少一题未答 → 首个问题即目标。
  // 单一真相 = 时间线 question part（pending_answer），不再读组件级 ref。
  const pendingQ = agent.pendingQuestion
  if (pendingQ) {
    const qid = pendingQ.questions[0]?.id
    const callId = pendingQ.callId
    if (callId && qid) {
      // 乐观置位：先翻终态防双击双发
      agent.resolveQuestionPart(callId, 'answered')
      try {
        const result = await submitAnswers({
          threadId: agentThreadId.value,
          sessionId: props.sessionId,
          callId,
          answers: { [qid]: [message] },
        }, answersPost)
        if (result.deduped) {
          // 迟到回答（callId 已 settle）：spec §5.2 降级为普通 user message 走新 turn
          //（final fix I-1）；pending 已清，递归进入正常消息流程不再被拦截
          await sendMessage(message)
        }
      } catch {
        agent.resolveQuestionPart(callId, 'pending_answer') // 失败恢复卡（幂等端点保证重试安全）
        ElMessage.error('提交失败，请重试')
      }
      return
    }
    // 无 callId（blocking off 旧路径）：落回下方正常 user message 流程
  }
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
      '⚠️ 此画布不属于当前账号，无法写入。请返回工作台新建项目，或使用画布所有者账号登录。',
    )
    agent.finishStreaming()
    await nextTick()
    scrollToBottom(true)
    return
  }
  // 重试：用户原文已在气泡中，不再重复落一条 user 消息（续跑而非重发）
  if (!isRetry) {
    agent.addUserMessage(message, userMessageExtras)
  }
  sidebar.clear()
  agent.isStreaming = true
  agent.startAssistantMessage()
  await nextTick()
  scrollToBottom(true)

  // Generate idempotency key for this request
  const idempotencyKey = buildIdempotencyKey(agentThreadId.value)
  // Track whether SSE stream ended normally (received [DONE])
  let streamEndedNormally = false
  // P0：每轮重置断流对账暂态与主流游标，避免上一轮残留值泄漏
  streamBrokenUnexpectedly.value = false
  lastMainSeq.value = null
  streamBreakError = null
  recoveredPhaseHint.value = null
  // 新一轮开始：清掉上一轮失败态标记与失败卡（续跑而非重发的前提）
  lastTurnFailed.value = false
  dockNotice.dismiss(REQUEST_FAILED_ID)
  runCancelled.value = false
  mainTurnSuspended.value = false
  threadRunState.value = null
  cancelledPresentation.value = null
  cancelledProgressText.value = null
  streamAbortController = new AbortController()
  // 主流起飞前先让位：常驻订阅与主流订阅的是同一会话，两边同时挂着会把
  // 同一份 text_delta 收两遍（气泡里出现双倍文本）。
  observer.releaseObserverTurn()
  observer.followUpTail.abort()
  agentStream.start()

  // ⭐ P1（多端一致性计划 Task 5）：ack 化主流（服务端 flag on，响应为 JSON）时置位
  // —— finally 的「POST 响应体流」收尾职责整体不适用（ack 返回时回合才刚开始，
  // 终态由 finishOwnTurnViaObserver 在事件通道上收口）。
  let ackMode = false

  try {
    // 连接级错误（无 HTTP 状态）静默自动重试 1 次：移动端网络抖动多在秒级内恢复，
    // 用户无感即可续上（2026-10-21 决策）。AbortError 与业务级错误不重试。
    let res: Response | null = null
    for (let attempt = 0; attempt < CONVERSATION_FETCH_MAX_ATTEMPTS; attempt++) {
      try {
        res = await postConversation(
          {
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
          },
          { signal: streamAbortController.signal, idempotencyKey },
        )
        break
      } catch (fetchErr) {
        if ((fetchErr as Error)?.name === 'AbortError') throw fetchErr
        if (isNetworkError(fetchErr) && attempt < CONVERSATION_FETCH_MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, 1000))
          continue
        }
        throw fetchErr
      }
    }
    if (!res) return

    // ── 多端一致性 P1（计划 Task 5）：Content-Type 分派 ──────────────────────
    // 同一端点、同一请求：服务端 flag on ⇒ JSON ack（run 后台 drain，事件经
    // GET /runs/events 权威通道）；flag off ⇒ SSE 响应体流（下方既有路径逐字节不变）。
    // 前置守卫（幂等缓存 / 意图去重 / 会话鉴权）两模式都保持 SSE 形态 ⇒ 自动落回
    // 既有处理，前端无需感知服务端 flag（分派只认响应头，不猜配置）。
    if (isConversationAckResponse(res)) {
      ackMode = true
      const body: unknown = await res.json().catch(() => null)
      const ack = parseConversationAck(body)
      if (!ack?.accepted) {
        // 同步拒绝（fork 切点失效等）：run 未启动，终态失败，不做对账
        const reason = ack?.errorMessage || '发起失败，请重试'
        agent.markTurnError({ message: reason })
        agent.appendText(`\n\n⚠️ ${reason}`)
        agent.finishStreaming()
        scrollToBottom()
        return
      }
      // fork：切换订阅 / 发送 / 历史的目标线程。thread_forked 是 Nest 合成事件、
      // 不进 lane buffer（/runs/events 收不到）⇒ 新线程 id 只能从 ack 拿
      //（动作与 handleEvent thread_forked case 完全一致）。
      if (ack.threadId && ack.threadId !== agentThreadId.value) {
        agentThreadId.value = ack.threadId
        persistActiveThreadId(props.sessionId, ack.threadId)
        persistForkedThreadId(props.sessionId, ack.threadId)
      }
      // 主流并入常驻订阅通道：
      //  · **绝对游标**覆盖内部残值——隐藏页期间冻结的旧 seq 若沿用，重连会把上一轮
      //    尾包重放进取（污染新气泡）；setLastSeq（覆盖）≠ seedLastSeq（仅空播种）。
      //  · sinceSeq 缺省 ⇒ null ⇒ from=now（服务端 headSeq 已做不对称取舍）。
      observer.ownTurnViaObserver.value = true
      observer.followUpTail.setLastSeq(ack.sinceSeq ?? null)
      // ack 模式没有 POST 响应体流：staleness 监测对象不存在，停掉（off 模式照旧）
      agentStream.stop()
      // 连接此前已为 POST 让位（abort）——重挂并按游标续放，重放覆盖 ack 前空窗。
      // fork 时 listenFollowUpTail 内部会按新 agentThreadId 重建共享频道。
      void observer.listenFollowUpTail()
      return
    }

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
        // P0：捕获服务端下发的 id 游标帧，断流后供旁观流从断点续拉尾包（node_status:done 等）
        if (line.startsWith('id: ')) {
          const n = Number(line.slice(4).trim())
          if (Number.isFinite(n) && n >= 0) lastMainSeq.value = n
          continue
        }
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
    if ((err as Error)?.name === 'AbortError') {
      // 用户主动取消：不报、不弹卡
    } else {
      // ⭐ P0-5（规格 2026-10-30-propose-confirm-execution-unity §4.1 判据 3）：turn 终态
      // 判定来源 = 服务端事件，不是连接状态。等待挂起期（proposal/question part 仍
      // pending）主流断开 ≠ turn 失败——服务端 run 活着，等待态已由 timeline part 单一
      // 真相呈现，重连后 lastEventId 回放对账。2026-10-29 生产事故：用户点「定位」切画布
      // → SSE 断开 → 被标「生成失败 · 网络连接不稳定」（服务端实际 13 分钟后正常 settled）。
      // ⭐ 2026-10-31 猴子回合：已收到 turn_suspended 的挂起回合，断链是**预期形态**
      // （移动端切后台即被掐 socket）——等待卡+内联确认入口就是全部所需呈现，任何
      // 「连接已断开」文案都是噪音，一律不追加（与 finally 的挂起豁免同一裁决）。
      if (mainTurnSuspended.value) {
        // 挂起后断链：静默。等待呈现交给时间线 part。
      } else if (agent.pendingProposal || agent.pendingQuestion) {
        agent.appendText('\n\n⚠️ 连接已断开；你的确认仍在等待中，恢复网络后自动继续，无需重复操作。')
      } else {
        // ⭐ P0 verify-before-fail（根治规格 2026-11-01-red-car-... §4.1 判据 1/2）：
        // 主流在 [DONE] 前断开 ≠ 生成失败。先进入「对账中」暂态（不弹失败卡），把错误
        // 暂存，等 finally 的 reconcileLatestAssistant 拉到服务端终态后再决定：
        //   - 服务端已 settled ⇒ 自愈（清暂态、不弹卡，节点由 turnComplete→loadSession 回拉）；
        //   - 服务端确无终态 ⇒ 再补弹失败卡（showGenerationFailureCard）。
        // 直接动机：2026-11-01 生产会话 cmvwkh89b00lgp801xu2fjbrr 主流断被误报失败、
        // 诱导用户重发 ⇒ 重复生成 2 张红车（① 误报 + ② 双图的根因入口）。
        streamBrokenUnexpectedly.value = true
        streamBreakError = err
        if (!agent.messages.length || agent.messages[agent.messages.length - 1]?.role !== 'assistant') {
          agent.startAssistantMessage()
        }
        agent.appendText('\n\n⚠️ 连接中断，正在确认生成进度…')
      }
    }
  } finally {
    agentStream.stop()
    streamAbortController = null
    // ⭐ P1（计划 Task 5）：ack 化主流的回合由 GET /runs/events 通道消费，终态由
    // finishOwnTurnViaObserver 收口——下面这套「POST 响应体流」收尾职责整体不适用
    // （ack 返回时回合才刚开始；误跑会把刚起的回合 finishStreaming 掉）。
    // 安全性：catch 已吞掉全部异常（不 rethrow）⇒ 到达 finally 时必无 pending 异常，
    // 此处 return 不会吞错（仅跳过 off 模式的流收尾）。
    if (ackMode) return
    // SSE abnormal-end detection: stream broke without [DONE]
    // P0：verify-before-fail 已接管主流断流的文案（先「对账中」暂态），此处跳过以免重复提示；
    // 服务端确无终态时由下方 post-reconcile 决策统一补弹失败卡。
    if (!streamEndedNormally && !runCancelled.value && !streamBrokenUnexpectedly.value) {
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
          '\n\n⚠️ 本轮连接中断，没有收到任何回复内容。可点「重试」；若仍无响应，点「新对话」后重发。',
        )
      }
    }

    const last = agent.messages[agent.messages.length - 1]
    // turn_suspended：挂起回合（等待用户在画布确认）不是「无文本回复」——
    // 补这句会挂在等待卡下方制造噪音（等待解除后模型自会续写总结）。
    // ⭐ P0（fix/observer-refusal-exempt）：发言被拒（turnRefusal≠null，如 steer 并入在跑
    // run）时，正确的「已并入进行中任务」callout 已承载反馈，此处绝不再补误导的「无文本回复」。
    if (
      !runCancelled.value &&
      !mainTurnSuspended.value &&
      !agent.turnRefusal &&
      last?.role === 'assistant' &&
      !last.content.trim()
    ) {
      agent.appendText('（本轮无文本回复。若还需确认，可再发「确认」；或点「新对话」后重试。）')
    }
    agent.finishStreaming()
    await reconcileLatestAssistant()
    // ⭐ P0 verify-before-fail 收口：断流后「先对账、再判失败」（根治规格 §4.1 判据 1/2）。
    // reconcileLatestAssistant 已用服务端权威历史补齐终态（含 canvas 节点经 turnComplete→loadSession）。
    // 此时再决定：服务端已 settled ⇒ 自愈（清「对账中」暂态、不弹失败卡）；否则补弹失败卡。
    if (streamBrokenUnexpectedly.value) {
      streamBrokenUnexpectedly.value = false
      const last = agent.messages[agent.messages.length - 1]
      const settled = Boolean(last?.role === 'assistant' && last.content.trim())
      if (settled) {
        // 服务端已 settled：清除「正在确认进度」暂态文案，失败卡永不出现（① 误报消除点）
        if (last?.role === 'assistant') {
          last.content = last.content.replace(/\n\n⚠️ 连接中断，正在确认生成进度…$/, '')
        }
      } else {
        // 服务端历史对账未自愈。⭐ 2026-11-04 P0+P1 补强：DB 权威历史查不到 ≠ 服务端无终态
        // ——D2 缺陷（落库与 HTTP 连接耦合，规格多端一致性 Task 2）下回合可能已在
        // pi-runtime 跑完但没落库 ⇒ 只查历史会把「其实 settled」误判失败（红车①残留路径）。
        // 补查 transcript 层真相（lane buffer 流探测 + IdempotencyRecord，GET /chat/reconcile）：
        //   missing ⇒ 才允许弹失败卡；settled ⇒ 清暂态补拉历史；active ⇒ 保留暂态交旁观流续呈。
        const rt = await fetchRuntimeReconcile(agentThreadId.value, lastMainSeq.value)
        const clearTransientText = () => {
          const l = agent.messages[agent.messages.length - 1]
          if (l?.role === 'assistant') {
            l.content = l.content.replace(/\n\n⚠️ 连接中断，正在确认生成进度…$/, '')
          }
        }
        if (rt?.outcome === 'missing' || rt === null) {
          // runtime 也确认无终态（或端点异常回落）：确不会自愈，补弹失败卡
          clearTransientText()
          dismissFailureCard()
          showGenerationFailureCard(streamBreakError)
        } else if (rt.outcome === 'settled') {
          // runtime 已完结（可能尚未落库）：清暂态，延迟补拉一次历史把权威行接回来
          clearTransientText()
          await new Promise((r) => setTimeout(r, 1_500))
          await reconcileLatestAssistant(1)
        } else {
          // 仍在跑：不判失败、不弹卡；「正在确认进度」暂态保留，由下方已播种游标的
          // 常驻旁观流继续呈现尾包（done 后 reconcileLatestAssistant 兜底纠正）。
        }
      }
    }
    // T1.4 接线：主流断开后旁观流首连不再写死 from=now——按主流最后 seq 播种游标续拉，
    // 补齐「断开 → 旁观重启」之间的漏帧窗口（仅播种，内部游标已有时不回退）。
    if (streamBreakError !== null && lastMainSeq.value !== null) {
      observer.followUpTail.seedLastSeq(lastMainSeq.value)
      streamBreakError = null
    }
    await threadApi.refreshThreadCheckpoint()
    // canvas_action 已流内实时 emit（2026-10-01），无积压可 flush
    // 始终回拉：Runtime 已写 Session.canvasData；本地 save 不得用旧节点覆盖
    emit('turnComplete')
    scrollToBottom()
    // 本轮收尾后才开旁听：followUp 是**收尾边界之后**才接住、由 pi-runtime drain 派生的新一代，
    // 不在主流里（主流已 close）。挂上旁听流，人切回来才看得见「接着往下写」的那一段。
    void observer.listenFollowUpTail()
  }
}

/**
 * 旁听「本轮之后」的事件（纯订阅，不发 prompt）——multi-device Task 5 接线层。
 *
 * 循环 / 退避 / 游标逻辑在 `follow-up-tail.ts`（依赖可注入 ⇒ 重连行为可单测），
 * 这里只做接线：**挂载即订阅**（会话级常驻），会话/线程切换重启，页面可见性恢复
 * `resume()`，卸载时 `abort()`。
 *
 * ⭐⭐ 2026-10-24：订阅时机从「turn 收尾之后」改为「挂载即订阅」。原语义下，
 * 另一端正在跑的那轮本端**根本不会订阅**（唯一入口在 sendMessage 的收尾分支）
 * ⇒ 多端一致性的主诉（PC 发消息、手机不刷新能看到）在代码路径上不可能成立。
 *
 * 行为契约（详见 follow-up-tail.ts 头注释）：
 *  ① 断线按指数退避重连，且带 `lastEventId` 游标续传（Review Focus #1：只补增量不重放）；
 *  ② idle 由任何帧刷新（常驻化后不再只认业务事件）；
 *  ③ 404 = 会话已删除不重连；重连预算累计不重置（防「连上即断」死循环）；
 *  ④ 本端主流在跑时不订阅（那一份文本已由 POST 响应体送达，再收就是重复）。
 */

/** 本端是否正处于「旁观另一端的那一轮」（有自己新建的 assistant 影子）。 */
const observer = useAgentObserver({
  agentThreadId,
  getSessionId: () => props.sessionId,
  agent,
  handleEvent,
  reconcileLatestAssistant,
  mainTurnSuspended,
  runCancelled,
  scrollToBottom,
  authHeaders,
  emitCanvasActions: (parts) => emit('canvasActions', parts as never),
  emitTurnComplete: () => emit('turnComplete'),
  setPoints: (balanceAfter) => useAuthStore().setPoints(balanceAfter),
})

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

    // H1-c（规格 2026-10-28 §5.2）：thread-state 请求已随死端点退役。恒 null 下
    // `syncCancelledFromThreadState` 只可能同步「运行已停止」这一项（现状分支保留）；
    // 「已停止 / 已完成」的区分判据改为 runs/events 实时状态 + 消息 metadata 终态
    // （既有 P1#11 判据），终态判定待 H3 seq 游标窗重接 turnState（规格 §12）。
    threadApi.syncCancelledFromThreadState(null)

    if (agent.isStreaming) {
      agent.finishStreaming()
    }
    agentStream.reset()
    await reconcileLatestAssistant()
    emit('turnComplete')

    recoveredPhaseHint.value = '服务已恢复。上一轮尚未完成，请继续操作。'
    pollTasksFromProgress()
  } catch {
    recoveredPhaseHint.value = '重连失败，请稍后再试'
  } finally {
    reconnecting.value = false
    scrollToBottom(true)
  }
}

/**
 * 流结束后用 DB 历史补齐最终文案。
 *
 * H1-c（规格 2026-10-28 §5.2）：原 P1#11 的 thread-state 回合终态轮询已随死端点退役
 * （恒 null 下生产行为本就是「轮到上限」），现在按上限轮询权威历史。
 * 终态判定待 H3 seq 游标窗重接 turnState（规格 §12）——届时以 runs/events 实时状态 +
 * 消息 metadata 终态为判据。
 *
 * @param maxPolls 轮询次数上限（默认 `RECONCILE_MAX_POLLS`）。
 *   旁观端传 `0`：那一轮在**另一端**已经跑完（收到 done 才走到这里），
 *   没必要再等终态，拉一次权威历史纠正漏帧即可（多端场景下一等就是几分钟的睡循环）。
 */
async function reconcileLatestAssistant(
  maxPolls = RECONCILE_MAX_POLLS,
  outOfTurnShadow: string | null = null,
) {
  /** 本轮 pull 是否已按权威行采纳了回合外影子（true ⇒ 不再走补拉/启发式路径）。 */
  let shadowAdopted = false
  const pull = async () => {
    const res = await fetch(
      apiUrl(
        `/api/agent/chat/user/messages?sessionId=${encodeURIComponent(props.sessionId)}&threadId=${encodeURIComponent(agentThreadId.value)}`,
      ),
      // 禁缓存：避免 304 空体让 res.json() 抛错、静默中断回查
      { cache: 'no-store' },
    )
    const json = await res.json()
    // getMessages 不做 select 收窄 ⇒ 返回全标量行（含 metadata/attachments/linkedOutputs/
    // toolCalls/runId），可直接按 PersistedAgentMessage 消费（缺字段由映射器的 parse* 兜底）。
    const rows = (json.data || []) as PersistedAgentMessage[]
    // 回合外来信（2026-11-03 黄小龙虾复测）：历史页最后一条为 outOfTurn assistant
    // ⇒ 回合外简报。**优先于**下方内容启发式：旧路径挑「最后用户回合第一条 assistant」
    // = 主轮回答，其长度必超简报 ⇒ shouldApply 判替换 ⇒ 简报文字被主轮内容冲掉。
    // 服务端 metadata.outOfTurn 是分类 SSOT ⇒ 命中即按权威行采纳（影子原位替换 /
    // 无影子追加，id 去重），多端回声（无 outOfTurn 行）不受影响。
    const briefRow = pickTrailingOutOfTurnRow(rows)
    if (briefRow?.id) {
      agent.adoptPersistedRow(outOfTurnShadow, briefRow)
      if (outOfTurnShadow) shadowAdopted = true
      return briefRow.content
    }
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
    // 回合外影子的落库竞态兜底：persist（服务端 done 触发）与本 fetch 并发，单次拉取
    // 可能早于落库（简报行还没出现）⇒ 1.5s 后补拉一次。多端回声场景永远没有
    // outOfTurn 行，同样落此路径——只多等 1.5s，无语义影响。
    if (outOfTurnShadow && !shadowAdopted) {
      await new Promise((r) => setTimeout(r, 1_500))
      await pull()
    }
    for (let i = 0; i < maxPolls; i++) {
      if (!shouldKeepReconciling(null, i)) break
      await new Promise((r) => setTimeout(r, 5_000))
      await pull()
      scrollToBottom()
    }
  } catch {
    // ignore
  }
}

const dockNotice = useDockNoticeStore()

/** 故障卡片 id（请求失败分流 + 恢复时显式清掉） */
const REQUEST_FAILED_ID = 'request-failed'
/** 初始 fetch 连接级错误的最大尝试次数（含 1 次静默自动重试） */
const CONVERSATION_FETCH_MAX_ATTEMPTS = 2
/** 上一轮是否以失败告终（供「恢复后自动续跑」判定） */
const lastTurnFailed = ref(false)
/**
 * P0 verify-before-fail：主流在 [DONE] 前断开时记录最后 seq（来自 `id:` 帧）。
 * ⚠️ 当前为 T0 回填钩子：捕获已完成，但**尚未**传入旁观流首连参数——
 * P0 根治靠服务端权威对账（reconcileLatestAssistant + turnComplete→loadSession），
 * 不依赖旁观流回填；等 §11 R1 修好旁观流稳定性后，由 follow-up-tail.ts 承接此 seq 做断点续拉。
 */
const lastMainSeq = ref<number | null>(null)
/** P0 verify-before-fail：主流断≠失败，先进入「对账中」暂态，等 reconcile 拿服务端终态再判定 */
const streamBrokenUnexpectedly = ref(false)
/** P0 verify-before-fail：catch 捕获的断流错误，留给 finally 对账后补弹失败卡 */
let streamBreakError: unknown = null

/** 清掉「生成失败」dock 卡（自愈前置）。 */
function dismissFailureCard() {
  dockNotice.dismiss(REQUEST_FAILED_ID)
}

/**
 * P0 verify-before-fail：仅在 reconcile 确认服务端确无终态时才补弹失败卡。
 * 与历史「主流一断就标失败」相反——先对账、服务端 settled 则自愈（见 sendMessage finally）。
 *
 * D7 UX 翻转：主推「继续」（reconnectStream 走 reconcile 对账，**不重生成**），
 * 杜绝 re-prompt 诱导双生成；用户若确需重发可手动再发一句。
 */
function showGenerationFailureCard(err: unknown) {
  const cls = classifyRequestError(err)
  // 零事件场景：assistant 气泡不存在，appendText 会静默 no-op ⇒ 先确保有承载气泡
  if (!agent.messages.length || agent.messages[agent.messages.length - 1]?.role !== 'assistant') {
    agent.startAssistantMessage()
  }
  // 清掉 catch 里写入的「正在确认进度」暂态文案，避免与失败文案叠加
  const last = agent.messages[agent.messages.length - 1]
  if (last?.role === 'assistant') {
    last.content = last.content.replace(/\n\n⚠️ 连接中断，正在确认生成进度…$/, '')
  }
  agent.markTurnError(err)
  // 气泡只留一行人话摘要，原始技术文案（如 `TypeError: network error`）不再透出
  agent.appendText(`\n\n⚠️ 生成失败 · ${cls.human}`)
  lastTurnFailed.value = true
  // 分流进 dock 三色卡片（单一出口）：连接级=黄卡+继续，业务级=红卡+继续
  dockNotice.pushNotice({
    id: REQUEST_FAILED_ID,
    tone: cls.kind === 'network' ? 'warning' : 'error',
    title: cls.kind === 'network' ? '网络连接中断' : '生成失败',
    message:
      cls.kind === 'network'
        ? '生成进度已自动保存，可点「继续」恢复。'
        : cls.human,
    action: { label: '继续', onClick: () => void reconnectStream() },
    ttl: 0,
  })
}

/**
 * 网络恢复后自动续跑：仅在上一轮确实失败时才触发，且先清掉失败卡再静默重连。
 * reconnectStream 走 DB 历史回查（reconcile），不会重发整段 prompt。
 */
function resumeAfterRecovery() {
  if (!lastTurnFailed.value) return
  lastTurnFailed.value = false
  dockNotice.dismiss(REQUEST_FAILED_ID)
  void reconnectStream()
}

// 挂载连接级故障的主动通知（断网黄卡 / 恢复绿卡 + 自动续跑），见 useNetworkNotice
useNetworkNotice({ onRecovered: () => resumeAfterRecovery() })

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
  if (QUEUE_APPLIED_EVENTS.has(event.type)) queue.markQueueApplied()
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
      //
      // ⭐ 2026-10-21：插话（steer / followUp）被模型消费时，pi 侧也会发这条事件
      //    （vendor 边界提交队列条目 ⇒ `{ id: item.entryId }` ⇒ 事件里的 entryId
      //    就是前端入队时拿到的那个）。此前这里只把 entryId 挂到「最后一条 user 消息」
      //    上，既**不建气泡**（⇒ 对话流里看不到用户插的话），又**覆盖已有切点**
      //    （⇒ 上一条消息的「重新生成」会从插话那条分叉）。
      //    现在交给 queueBubbleSync 判定：插话 ⇒ 补建气泡；初始 prompt ⇒ 挂到本地气泡。
      applyPiUserMessageEvent(event.data, {
        messages: agent.messages,
        queuedEntryIds,
        slots: queuedSlots.value,
        insertUserMessage: (text, extras) => {
          agent.insertUserMessageBeforeAssistant(text, {
            entryId: extras.entryId,
            attachments: extras.attachments,
            selectionNodeIds: extras.selectionNodeIds,
          })
        },
        // ⭐ 2026-10-21（统一 user 消息身份）：正常发送的 user 行是在调 pi **之前**落的，
        // 而 `pi.prompt()` 只回 `{ accepted }` ⇒ entryId 只能从这里回填给服务端，
        // 否则刷新后的历史消息没有 fork 切点、「③ 重跑」只能降级兜底。
        // 幂等由服务端唯一索引兜住（多页签各报一次也 no-op）。
        persistEntryId: (entryId) => {
          void persistUserEntryId(entryId)
        },
      })
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
        // ③ 重跑分支线程写入专用 fork key：bootstrap 刷新后据此恢复，否则回落共享线程会丢重跑结果
        persistForkedThreadId(props.sessionId, nextThreadId)
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
        /** 服务端 dispatchWaitingUser 透传的标题（resolved 时一并喂给时间线层） */
        title?: string
      }
      if (d.status === 'resolved' || !d.toolName) {
        // ⭐ 2026-10-17 生产复测发现（PR #449 伴生）：resolved 只清状态行位、没喂时间线，
        // 时间线 notice 永远停在「等待…」翻不成「已继续执行」（模型层 applyTimelineEvent 的
        // resolved upsert 契约存在但没人调用）。补喂 resolved；`!d.toolName`（无状态清位）
        // 不喂——喂了会被 applyTimelineEvent 当 waiting 重新 upsert，反把 notice 复活。
        if (d.status === 'resolved') {
          // 2026-11-04 修复：resolved 必须把 callId/nodeId/reason 一并透传 —— 否则时间线层
          // 拿不到 reason，无法区分确认(answered)/取消(aborted)/超时(timeout)：既会让取消的
          // proposal 误显「已确认」，也会让「确认即建产物卡」的守卫（turnTimeline resolved 分支）
          // 在取消时误建卡。服务端 dispatchWaitingUser 本就带 reason/callId（见 pi-runtime index.ts）。
          agent.trackWaitingUser({
            status: 'resolved',
            toolName: d.toolName,
            callId: d.callId,
            nodeId: d.nodeId,
            reason: d.reason,
            title: d.title,
            timeoutMs: d.timeoutMs,
          })
        }
      } else {
        // 根治规格 2026-10-28 / 2026-10-29：waiting_user → 时间线单一真相（flag 已移除，
        // feedTimeline 恒落）。propose_generation 经此 upsert 时间线 `proposal` part（稳定
        // id = callId/nodeId），状态行 / 对话流内联卡 / 画布节点内联确认面同源读它。
        // callId/timeoutMs 透传以保 part 稳定 id 与倒计时准确（缺省回落 300_000）。
        // 不再另置 parallel store 态（blockingWait / proposeWait），亦不再发死 emit。
        agent.trackWaitingUser({
          status: d.status,
          toolName: d.toolName,
          nodeId: d.nodeId,
          callId: d.callId,
          timeoutMs: d.timeoutMs,
          reason: d.reason,
        })
      }
      break
    }
    case 'activity': {
      // 「正在做什么」（决策 8）：runtime 在工具起手时下发，比 tool_call 更早到。
      // 中文在组件层查 TOOL_PRESENTATION 出（决策 7：runtime 只声明意图、不塞文案）。
      // P2：真实活动到达 = 恢复结束（清「会话恢复中」瞬时态）。
      agent.setRecovering(false)
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
      // 压缩审计原经 runtime activity 落状态行（已随该路径移除）；其余由 metrics 观测。
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
    case 'generation_progress': {
      // 上游对齐①：run_* onUpdate 进度通道（30s 一拍 checkpoint）→ 产物行
      // 「生成中 · Xs」活体计时。不落库、单调不减（turnTimeline reducer 保证）。
      const data = event.data as { nodeId: string; elapsedMs: number }
      agent.trackGenerationProgress(data)
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
    case 'credit_tx':
      // Epic 1（2026-11-03）：积分变动单一入口 → 本会话累计（含生成费）+ 余额事件化（C2）。
      // 与 turn_settled 互斥走单口径，根治「生成费漏显 + 双计」。
      agent.trackCreditTx(event.data as CreditTxEvent['data'])
      break
    case 'turn_suspended': {
      // turn_suspended（2026-10-31 皮皮虾回合生产实证）：主流在阻塞等待边界被 pi lane
      // 挂起收尾的显式信号。run 仍活着、正等用户在画布确认/作答 —— **挂起 ≠ 断链**：
      // 不追加「连接已断开」文案、不标 turn 失败；等待呈现由 proposal/question part
      // 单一真相承载，钉底时间线存活期 = 回合进行中基座 isStreaming ∪ mainTurnSuspended。
      // 等待解除后续跑事件经旁听流（followUp tail）续传，turn_end 收口时复位。
      mainTurnSuspended.value = true
      break
    }
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
    // TURN-IDENTITY PR3：本回合发言被服务端结构化拒绝（409/LaneBusy 的语义化形态）。
    // 这是止血兜底的「最后一环」——把「已并入进行中的任务 / 当前无法插话」明确告诉用户，
    // 而不是让界面停在转圈、最后冒出一个别人的回答（这正是漂移事故下用户侧的困惑来源）。
    // 拒绝**不得**退化成新开一轮（对齐 Codex NotSubmittedReason）：不落库、不新建气泡。
    case 'turn_not_submitted': {
      const d = event.data as { reason?: 'not_idle' | 'not_steerable' }
      agent.setTurnRefusal(d.reason === 'not_steerable' ? 'not_steerable' : 'not_idle')
      break
    }
    // P3 D4：回合裁定终态（终态收口由 isTurnTerminal 统一走）。此处补 queued 徽标
    // 的实时清除：落库补齐成功时 ack 带 messageId（键不出现纪律）⇒ 按 id 精确翻牌；
    // 无 messageId（fail-soft / 老 runtime）则保留徽标，刷新后由读时派生收敛。
    case 'turn_ack': {
      const d = event.data as { mode?: string; messageId?: string }
      if (d.mode && d.mode !== 'run' && d.messageId) agent.consumeQueued(d.messageId)
      break
    }
    case 'canvas_command': {
      const cmd = event.data as {
        type: string
        nodeId?: string
        nodeIds?: string[]
        /** 分组工具组（2026-10-21）：ungroup_group / set_group_color 带 groupId。 */
        groupId?: string
        exportMode?: 'full_package' | 'lightweight'
        attachments?: SidebarAttachment[]
        mode?: 'grid' | 'along_edges' | 'align' | 'distribute'
        gap?: number
        edges?: { source: string; target: string }[]
        /** align 的六向口径（SP-B）：mode=align 时必带，CanvasPage 侧校验值域。 */
        alignMode?: 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom'
        /** distribute 的轴（SP-B）：mode=distribute 时必带，CanvasPage 侧校验值域。 */
        axis?: 'x' | 'y'
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
        // SP-B：mode **原样透传**（不再把非 along_edges 一律收窄成 grid）——
        // align/distribute 是两种独立意图，收窄会把「对齐」静默变成「网格重排」。
        // 脏 mode / 缺 alignMode / 脏 axis 的校验与用户可见提示统一放在消费端
        // （CanvasPage.handleArrangeNodes），本层只做传输。
        emit('arrangeNodes', {
          nodeIds: cmd.nodeIds,
          mode: cmd.mode ?? 'grid',
          gap: cmd.gap ?? 40,
          edges: cmd.edges?.length ? cmd.edges : undefined,
          ...(cmd.mode === 'align' && cmd.alignMode ? { alignMode: cmd.alignMode } : {}),
          ...(cmd.mode === 'distribute' && cmd.axis ? { axis: cmd.axis } : {}),
        })
      } else if (cmd.type === 'group_nodes' && cmd.nodeIds && cmd.nodeIds.length >= 2) {
        // 标题 trim 后空串按无标题处理（与 CanvasPage 的命名口径一致）
        const gTitle = typeof cmd.title === 'string' && cmd.title.trim() ? cmd.title.trim() : undefined
        // ⭐ groupId 由 Agent 侧生成并随命令下发（canvas_command 单向无回传，
        // 前端自生成的 id Agent 拿不到 ⇒ 建组→改色/解组会断链）。
        // 前端会校验撞号/空串并自行回退 ⇒ 这里原样透传即可。
        const gId = typeof cmd.groupId === 'string' && cmd.groupId.trim() ? cmd.groupId.trim() : undefined
        emit('groupNodes', { nodeIds: cmd.nodeIds, ...(gTitle ? { title: gTitle } : {}), ...(gId ? { groupId: gId } : {}) })
      } else if (cmd.type === 'ungroup_group' && cmd.groupId) {
        emit('ungroupGroup', cmd.groupId)
      } else if (cmd.type === 'set_group_color' && cmd.groupId) {
        // ⛔ 色键最后一道防线：工具侧已按 8 键白名单拒过非法值，这里再收一次。
        // 理由同 tool 侧注释——非法键若漏到这里，patchGroupNodeData 会照写，
        // 失败推迟到渲染层且**静默**（normalizeGroupColorKey 落 neutral ⇒ 用户读成
        // 「设了没反应」，这正是 2026-10-21 修掉的那个缺陷的同构版本）。
        const rawKey = (cmd as unknown as { colorKey?: string | null }).colorKey
        const key = rawKey === null || rawKey === undefined || rawKey === '' ? null : rawKey
        if (key !== null && !GROUP_COLOR_KEYS.includes(key as GroupColorKey)) {
          console.warn('[canvas_command] 丢弃非法分组色键', key, '可用：', GROUP_COLOR_KEYS.join('/'))
        } else {
          emit('setGroupColor', { groupId: cmd.groupId, colorKey: key })
        }
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
        const card = cmd as { callId?: string; questions?: Array<{ id: string; question: string; options: { label: string; value: string }[]; multiSelect?: boolean; allowOther?: boolean }> }
        if (card.questions?.length) {
          // 根治规格（2026-10-28）：题面收敛进时间线 question part 单一真相（状态行/内联卡同源）。
          // AskUserCard 与对话流内联卡都只读该 part，不再有组件级 pendingAskUser ref。
          agent.trackAskUser({ callId: card.callId, questions: card.questions as never })
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
      mainTurnSuspended.value = false
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

// 第九刀（strangler-fig）：Thread 生命周期簇已迁入 useAgentThread。
// agentThreadId / threads 仍由本组件持有所有权，仅注入 composable 消费。
const threadApi = useAgentThread({
  agentThreadId,
  threads,
  taskProgress,
  runCancelled,
  threadRunState,
  cancelledPresentation,
  cancelledProgressText,
  recoveredPhaseHint,
  followLatest,
  hasNewBelow,
  clearComposer,
  clearAgent: () => agent.clear(),
  loadHistory,
  fetchThreads,
  scrollToBottom,
  getSessionId: () => props.sessionId,
})

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
  // 画布状态 → 时间线产物回填（2026-10-17 第二通道）。
  // ⚠️ 必须在 taskProgress 早退**之前**：propose 单发等无 task 事件的流程
  // taskProgress.items 为空，但节点终态只在画布对账处可见。
  // 口径复用 mapNodeStatus（W11「有正据才动」）：无 url/内容/明确状态值的节点
  // （含未确认的 propose 节点）保持原状，不会被误翻 done。
  // 归属预筛：先收集时间线已持有的 artifact nodeId，避免对用户手建节点做全量消息回填空转。
  if (rawNodes.length) {
    // 2026-11-05 修复 Q1：归属集并入 pendingNodeMeta（文本/HTML 产物无确认点、无
    // node_status，deferred 建卡下永远没有 part；只认 part 会让对账回填永远跳过它们）。
    const owned = collectBackfillOwnableNodeIds(agent.messages)
    if (owned.size) {
      for (const n of rawNodes) {
        if (!owned.has(n.id)) continue
        const probe = mapNodeStatus(n, { id: '', title: '', status: 'pending' })
        if (probe === 'pending') continue
        const nodeUrl =
          typeof n.data?.url === 'string' && n.data.url ? n.data.url : undefined
        agent.backfillTimelineNodeStatus({
          nodeId: n.id,
          status: probe === 'needs_user' ? 'pending' : probe,
          url: probe === 'done' ? nodeUrl : undefined,
        })
      }
    }
  }
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

/** IA v3.2：移动端「对话历史」面板（🕘 唤起）——复用 threads/fetchThreads/selectThread，
 * 独立于 PC 面板头部 popover（移动端头部被 CSS 隐藏）。 */
const mobileThreadHistoryOpen = ref(false)
async function openThreadHistory() {
  mobileThreadHistoryOpen.value = true
  await fetchThreads()
}
function closeThreadHistory() {
  mobileThreadHistoryOpen.value = false
}

/** IA v3.2（2026-10-19 用户拍板）：抽屉 = 项目世界（容器层）——只放
 *  [新建项目] + 项目卡片（打开/重命名/删除）。
 * 新建对话/历史对话已升为对话页右上角常驻图标（MobileTopBar → newAgentSession /
 * openThreadHistory），抽屉不再混入对话层职责。
 * 2026-10-19 兜底：list 曾在 CVM 旧接口返回 2.4MB（165 项目×完整 canvasData），
 * 弱网/代理路径下 body 永不落地 ⇒ axios promise 不 settle ⇒ 「项目加载中」转不完。
 * 双保险：请求级 15s 超时 + 失败态重试按钮（后端 select 瘦身已随本分支修复）。 */
/**
 * A3 · 项目列表数据：**共用 `useProjectWorkspace` 单一数据源**
 * （INV-10：收敛前 `loadProjects()` 与 `loadRecentWorks()` 各调一次 `canvasApi.list`，
 * 同一接口请求两遍、存进两个 ref，纯浪费）。
 *
 * 2026-10-26 规格收敛 v2（D10）：项目抽屉已退场——本文件不再承载项目增删改查
 * （管理能力唯一收敛到创作首页行卡），仅保留列表数据供挂载期拉取。
 */
const {
  loading: projectsLoading,
  loadIfStale,
  create: createProject,
} = useProjectWorkspace()

/**
 * 挂载期拉取项目列表。委托给 useProjectWorkspace 单一数据源
 * （INV-10：本函数不再直接调 canvasApi.list），失败由 workspace 的 `error` 兜底。
 * 防重入：已有请求在途时直接返回。
 *
 * ⭐ 2026-10-25：走 `loadIfStale`（**数据还新鲜就不发请求**）。
 *    而再发一次的代价不是几十毫秒：画布页的 SSE/轮询已占满同域 HTTP/1.1 的
 *    6 个连接（见 App.vue 注释：排队可达 55 秒）⇒ 多发一次就是排一次队 ⇒
 *    15s 超时先到 ⇒ 「项目加载失败」。生产实证：抽屉里 8 个项目在报错时一起消失。
 */
async function loadProjects() {
  if (projectsLoading.value) return
  await loadIfStale()
}

/** 页签是全局导航（IA v3）：遮罩只盖到页签上沿，页签任何时候都可点；
 * tab 一变即收历史面板，避免「面板开着切了页签、面板还挂在上面」。 */
watch(
  () => props.mobileAppTab,
  (tab, prev) => {
    if (tab !== prev && mobileThreadHistoryOpen.value) closeThreadHistory()
  },
)

defineExpose({
  /** IA v3.2：MobileTopBar 右上角 + / 🕘 —— 新对话（当前项目上下文）/ 对话历史面板 */
  newAgentSession: threadApi.newAgentSession,
  openThreadHistory,
  closeThreadHistory,
  openPanel,
  closePanel,
  setComposerInput: composer.setComposerInput,
  addAttachment: composer.addAttachment,
  reconcileFromNodes,
  /** L1：画布/dock 点生成时显式确认 propose 等待（answered），不再靠 SSOT 时序推断 */
  confirmProposeWait: propose.confirmProposeWait,
  /** ADR-0011 T1：画布节点内联确认面的取消入口（与时间线内联卡同源同语义） */
  cancelProposeForNode: propose.cancelProposeForNode,
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
      'is-docked-open': open && !floating && isDesktopDock,
    }"
    :style="{ width: asidePanelWidth }"
  >
    <div class="flex h-full min-h-0">
      <!-- 收缩态：左下角 agent logo 悬浮按钮（移动端裸条常驻，fab 仅桌面收缩态）。
           2026-10-22 与画布视口工具条左右互换（侧栏翻左后整体镜像）。 -->
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

      <!-- 项目抽屉已退场（规格收敛 v2 D10，2026-10-26）：管理唯一收敛到创作首页；
           移动端顶栏 ≡ 改为返回创作首页导航（见 CanvasPage agentRailActions）。 -->

      <!-- 对话历史面板（IA v3.2）：移动端对话页右上角 🕘 唤起——当前项目下的对话切换。
           与 PC 面板头部 popover 同源（threads/fetchThreads/selectThread），移动端头部被 CSS 隐藏故独立成面层。 -->
      <Teleport to="body">
        <div
          v-if="isMobileLayout && mobileThreadHistoryOpen"
          class="thread-history-layer"
          @click.self="closeThreadHistory"
        >
          <div class="thread-history-sheet" role="dialog" aria-label="对话历史">
            <p class="session-drawer__caption">对话历史</p>
            <button
              v-for="thread in threads"
              :key="thread.id"
              type="button"
              class="thread-history-item"
              :class="{ 'is-current': thread.id === agentThreadId }"
              :disabled="threadApi.isArchivedThread(thread)"
              @click="threadApi.selectThread(thread.id); closeThreadHistory()"
            >
              <span class="block truncate text-xs font-medium">{{ thread.title }}{{ threadApi.isArchivedThread(thread) ? '（已归档 · 即将合并到主对话）' : '' }}</span>
              <span class="block text-[10px] opacity-60">{{ formatSessionTime(thread.updatedAt) }}</span>
            </button>
            <p v-if="!threads.length" class="session-drawer__empty">暂无对话记录</p>
          </div>
        </div>
      </Teleport>

      <!-- 面板：侧栏内嵌 or 浮动窗口 or 移动端贴底裸条容器（Teleport 到 body） -->
      <Teleport to="body" :disabled="!panelTeleported">
        <div
          v-show="open && !railHiddenByTab"
          ref="panelShellRef"
          class="agent-panel-shell flex min-h-0 h-full min-w-0 flex-col overflow-hidden"
          :class="[
            isMobileLayout
              ? mobileCanvasView
                ? 'agent-panel-mobile-dock is-canvas-view'
                : 'agent-panel-mobile-dock is-conversation-view'
              : floating
                ? 'agent-panel-floating'
                : 'agent-panel-inline flex-1',
            {
              'is-dragging': dragging,
              'has-studio-dock': studioDockOpen,
              'is-canvas-imm': mobileCanvasImm,
              'is-composer-focused': composerFocused,
              'is-keyboard-open': isKeyboardOpen,
            },
          ]"
          :style="floating && isDesktopDock ? {
            left: `${floatPos.x}px`,
            top: `${floatPos.y}px`,
            width: `${floatWidth}px`,
          } : undefined"
        >
          <!-- 左边缘拖拉调宽 -->
          <div
            v-if="isDesktopDock"
            class="agent-resize-handle"
            title="拖拉调整宽度"
            @mousedown="startResize"
          />

          <!-- 全局传送门已退役（2026-10-18 IA v3）：门入底部页签「画布」（章鱼+光环固定位），
               模式切换 = 页签切换；旧顶栏门/浮动锚随之删除。
               「← 对话」pill 更早退役（门职责收编）。拾取模式让位（pick bar 自带回程）。 -->
          <!-- 顶栏：logo + 新建 / 历史 / 浮窗切换 / 收起（浮窗模式可按住拖动）。
               P1-5 fix-1：移动端保留（新建对话 / 会话历史入口随贴底容器常驻，
               收起 / 浮窗为桌面专属按钮移动端隐藏；startDrag 移动端本身 no-op） -->
          <div
            class="agent-panel-header flex items-center justify-between px-3 py-2"
            :class="floating && isDesktopDock ? 'cursor-move' : ''"
            @mousedown="startDrag"
          >
            <div class="flex min-w-0 items-center gap-2">
              <!-- 顶栏传送门已退役（IA v3）：门入底部页签；移动端顶栏由 MobileTopBar 接管，
                   本 header 在移动端 CSS 隐藏（.agent-panel-mobile-dock .agent-panel-header）。
                   桌面端维持纯 logo。 -->
              <NeoAgentLogo size="xs" active />
              <!-- 移动端「传送门」（2026-10-15 移动端重构）：头像即品牌 logo，不再重复「lnk·π agent」文字 -->
              <p v-if="isDesktopDock" class="agent-subtitle truncate text-[11px]">lnk·π agent</p>
            </div>
            <div class="flex items-center gap-0.5">
              <!-- 规格 §6.8 / ADR-0015：桌面侧栏头部不再放「新对话 / 历史」入口
                   （统一单对话模型，新建/切换对话收口到创作空间列表与移动端顶栏）；
                   仅保留浮动窗口切换与「收起助手」。 -->

              <!-- 浮动窗口切换：面板脱离/停靠侧栏 -->
              <button
                v-if="isDesktopDock"
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
              <button v-if="isDesktopDock" type="button" class="agent-head-btn" title="收起助手" @click="closePanel">
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
            <p class="mt-1 opacity-80">请新建自己的项目，或使用画布所有者账号登录。</p>
            <div class="mt-2.5 flex flex-wrap gap-2">
              <button type="button" class="agent-readonly-btn" @click="goToWorkflowHome">
                返回工作台
              </button>
              <button type="button" class="agent-readonly-btn agent-readonly-btn-primary" @click="createOwnCanvas">
                新建项目
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
            <!-- A3 · 回访作品带已删（规格收敛 v2 P2-a，2026-10-26）：续作面唯一收敛到
                 创作首页（/canvases 行卡）；「全部 N 个 ›」/「项目名 ▾」触发器随 P2-b/c 收口。 -->
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
              <!-- 2026-10-23 IA v4：移动端三联叙事（对话 / 锚 / 画布）已迁到工作台 hero
                   （SignatureHero 挂 MobileTriptychRow，签名面专用令牌）。此处不再重复——
                   用户裁定「去掉对话页空态上面重复的部分（很丑）」：品牌叙事归 hero，
                   空态只留功能内容（persona / chips / 传图引导）。 -->
              <p class="agent-composer-persona hidden text-center text-[12px] leading-relaxed lg:block" data-testid="agent-persona-line">
                lnk·π 助手 · 说一句创意，我来画
              </p>
              <div class="agent-example-chips mt-3 flex flex-wrap justify-center gap-2">
                <!-- A1 传图引导位：不是金句，不计入 golden_quote_picked。
                     只在 empty 相出现——有素材时 attachment 池已承担素材话术。 -->
                <button
                  v-if="showAttachmentCta"
                  type="button"
                  class="agent-example-chip agent-example-chip--cta rounded-lg border border-dashed px-3 py-1.5 text-left text-[12px] leading-snug"
                  data-testid="agent-attachment-cta"
                  @click="composer.pickImage"
                >
                  传一张图再说话
                </button>
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
              v-if="historyLoadState === 'failed'"
              class="mx-3 my-2 flex items-center justify-between rounded-lg border px-3 py-2"
              :style="{ borderColor: 'var(--lnk-border-subtle)', background: 'var(--lnk-surface-raised)' }"
            >
              <span class="text-xs" :style="{ color: 'var(--lnk-text-muted)' }">对话历史加载失败</span>
              <button
                type="button"
                class="text-xs font-medium"
                :style="{ color: 'var(--lnk-accent)' }"
                @click="loadHistory()"
              >重试</button>
            </div>
            <!-- H1-d（D15）：历史行 metadata 畸形被降级保留时显式标注（与「本来就没有过程」可区分） -->
            <p v-if="degradedHistory" class="mx-3 my-1 text-xs" :style="{ color: 'var(--lnk-text-muted)' }">部分历史行的过程数据缺失，已降级显示</p>
            <button
              v-if="historyHasMore"
              type="button"
              class="mx-auto my-2 block rounded-full border px-3 py-1 text-xs"
              :disabled="historyLoadingOlder"
              :style="{ borderColor: 'var(--lnk-border-subtle)', color: 'var(--lnk-text-muted)' }"
              @click="loadOlder()"
            >{{ historyLoadingOlder ? '加载中…' : '加载更早消息' }}</button>
            <div
              v-for="(msg, turnIdx) in agent.messages"
              :key="msg.id"
              class="agent-turn"
              :class="msg.role === 'user' ? 'agent-turn--user' : 'agent-turn--assistant'"
            >
              <!-- 2026-11-03 WorkBuddy 同款轮次抬头（移动端复测追加需求）：每轮 agent 回复
                   开头一行「项目徽章 + lnk π」（徽章灰样式抄提议生成卡片 .chip）。
                   turn 起点 = 首条消息或前一条非 assistant（连续 assistant 消息不重复抬头）。 -->
              <div v-if="isTurnHead(msg, turnIdx)" class="agent-turn-head" data-testid="turn-head">
                <img
                  class="agent-turn-head__badge"
                  :src="anchorBadge"
                  alt=""
                  aria-hidden="true"
                  draggable="false"
                >
                <span class="agent-turn-head__name">lnk π</span>
              </div>
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
                @click="onUserBubbleClick(msg)"
              >
                <!-- D5（P3）：排队中徽标。数据源=server 读时派生的 queued
                     （无更晚 assistant 行才保持 true）；实时清除由
                     turn_ack{messageId} → consumeQueued 承载（徽标随消费消失）。 -->
                <span
                  v-if="msg.role === 'user' && msg.queued"
                  class="agent-queued-badge"
                  data-testid="queued-badge"
                >排队中</span>
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
                  v-if="msg.role === 'assistant' && msg.executionTrace && !useTimeline(msg)"
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
                <!-- 2026-11-03 流式归一：live 消息与历史走**同一条内联渲染通道**（不再钉底/镜像）。
                     此前的 `msg.id !== liveTimelineMessageId` 抑制会把流式中的助手内容从消息流里
                     抽走、挪到独立钉底/系统层镜像块，造成「用户气泡与 agent 回复割裂 / 中间空白 /
                     刷新前后两套渲染」三象（2026-11-03 移动端 SSE 显示事故复盘）。
                     现删抑制：流式中该消息照常在流内渲染 timeline，与刷新后的历史态同构。 -->
                <AgentTurnTimeline
                  v-if="useTimeline(msg)"
                  class="mt-1.5"
                  :parts="msg.timeline!.parts"
                  :streaming="Boolean(msg.streaming)"
                  :resolve-node-url="resolveCanvasNodeUrl"
                  :canvas-nodes="canvasNodes"
                  :digest-entry="digestEntryForTurn(sessionDigestEntry, msg.id === lastTimelineAssistantId)"
                  @retry-node="emit('generateNode', $event)"
                  @focus-node="onFocusNode($event)"
                  @confirm-proposal="onInlineConfirmProposal($event)"
                  @cancel-proposal="onInlineCancelProposal($event)"
                  @ask-submit="propose.onAskSubmit"
                  @ask-cancel="propose.onAskCancel"
                />
                <!-- 流式归一补位（2026-11-03 移动端复测）：钉底块退役后，「发消息 → 首个
                     timeline part（【思考】）到达」的空窗期什么都不渲染，「正在准备…」
                     兜底文案随 dense 头一起消失。按 WorkBuddy 同款补回：live 且零可渲染
                     内容时在气泡壳内显示占位，首个 part/正文到达后自然被取代（同壳换内容）。
                     P0 白块语义同步演进：不再渲染的是「空白」，占位有文案即非白块。 -->
                <p
                  v-if="isPreparingPlaceholder(msg)"
                  class="whitespace-pre-wrap opacity-60"
                >正在准备…</p>
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
                  v-if="msg.role === 'assistant' && !useTimeline(msg) && (assistantOutputsById.get(msg.id)?.length ?? 0) > 0"
                  :outputs="assistantOutputsById.get(msg.id) ?? []"
                  :resolve-node-url="resolveCanvasNodeUrl"
                  @focus-node="onFocusNode($event)"
                  @focus-all="onFocusAll($event)"
                />
                <!-- P0（agent-turn-timeline-design §5 P0-4）：回合摘要行落在产物之后（时间线最末）。
                     条件：assistant + 本回合已结束（!streaming）+ 有 trace + 行非空。
                     P1：timeline 模式下摘要由时间线末尾的 notice part 承担，这里不再重复渲染。 -->
                <p
                  v-if="msg.role === 'assistant' && !useTimeline(msg) && !msg.streaming && msg.executionTrace && bubbleSummaryLine(msg)"
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
                  :class="{ 'is-open': mobileUserActionsOpen.has(msg.id) }"
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
                    <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" :fill="messageFeedback[msg.id] === 'up' ? 'var(--lnk-accent)' : 'none'" :stroke="messageFeedback[msg.id] === 'up' ? 'var(--lnk-accent)' : 'currentColor'" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M14 9V5a3 3 0 0 0-3-3L7 11v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
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
                    <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" :fill="messageFeedback[msg.id] === 'down' ? 'var(--lnk-accent)' : 'none'" :stroke="messageFeedback[msg.id] === 'down' ? 'var(--lnk-accent)' : 'currentColor'" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.28A2 2 0 0 1 21 4v7a2 2 0 0 1-2 2h-3" />
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
                    <svg v-if="copiedMessageId !== msg.id" viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
                      <rect x="9" y="9" width="11" height="11" rx="2" />
                      <path stroke-linecap="round" d="M5 15V5a2 2 0 0 1 2-2h10" />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="agent-msg-action-btn"
                    title="分享"
                    aria-label="分享"
                    @click="openShare(msg)"
                  >
                    <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
                      <circle cx="6" cy="12" r="2.5" />
                      <circle cx="18" cy="6" r="2.5" />
                      <circle cx="18" cy="18" r="2.5" />
                      <path stroke-linecap="round" stroke-linejoin="round" d="M8.2 10.8 15.8 7.2 M8.2 13.2 15.8 16.8" />
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
                      <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
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
                      <svg v-if="copiedMessageId !== msg.id" viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
                        <rect x="9" y="9" width="11" height="11" rx="2" />
                        <path stroke-linecap="round" d="M5 15V5a2 2 0 0 1 2-2h10" />
                      </svg>
                      <svg v-else viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
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
                      <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
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
            <!-- 2026-11-03 流式归一：独立钉底块（桌面）与 agent-system-layer 镜像块（移动端）
                 一并退役——live 消息自始至终在消息流内联渲染（见上方 AgentTurnTimeline 处注释）。
                 退役的两段历史形态：① P0 决策 1 的桌面钉底（dense+默认折叠）；
                 ② 2026-10-31 移动端「live 钉系统层」（第 2 轮全盲的修复尝试）。
                 两者都是「内容脱离消息流」的双轨方案，正是移动端三象（信封割裂/中间空白/
                 刷新前后两套渲染）与 PC 二轮回显缺口的共同根源；统一内联后由滚动跟随
                 （followLatest 闩锁 + hasNewBelow）承接「实时可见」诉求。 -->
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

<!-- TURN-IDENTITY PR3：发言被服务端结构化拒绝（409/LaneBusy 语义化）时的确定性反馈。
                 不假装已受理、不新建气泡，只把原因说清，让用户知道「为什么没发出去」。 -->
            <div
              v-if="agent.turnRefusal"
              class="mx-0.5 mb-2 rounded-lg border border-warning-border bg-warning-bg px-2 py-1.5 text-xs leading-relaxed"
              data-testid="turn-refusal-callout"
            >
              <p class="font-medium text-warning">
                {{ agent.turnRefusal === 'not_steerable' ? '当前任务无法插话' : '你的消息已并入进行中的任务' }}
              </p>
              <p class="mt-0.5 opacity-80">
                {{ agent.turnRefusal === 'not_steerable' ? '请等待其完成后再试。' : '无需重复发送，进度会随当前回合继续。' }}
              </p>
              <button
                type="button"
                class="mt-1 rounded border border-warning-border bg-elevated px-2 py-0.5 text-[11px] font-medium text-warning hover:bg-warning-bg-hover"
                data-testid="turn-refusal-dismiss"
                @click="agent.setTurnRefusal(null)"
              >
                知道了
              </button>
            </div>
            

            <!--
              侧栏门控/确认卡已全量下线（2026-10-06 决策）：以下旧分支被删除 ——
              retake 提示、图片质检门、宏观方案卡、方案多选卡、定稿交付卡、shot/topo/copy
              确认行。判据是它们**没有任何生产者**：老 LangGraph runtime 2026-09-27 退役，
              checkpoint 状态端点恒返 null（后随 H1-c 整体退役），
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
               移动端 = 贴底容器内、裸条上方的系统层（阻塞交互贴条可达）。
               2026-10-21 根治（决策 C）：整层包进 .agent-system-layer 容器——画布视图默认全隐，
               白名单放行取代逐卡登记（病史：状态行 #496 / ask 卡+取消回执 #516 / 更早
               railHiddenByTab，三次漏登、每次都要真机截图才发现，失败模式静默）。
               ⚠️ 新增系统层卡片必须放进本容器：进层即默认安全（画布视图藏）；需要露头的
               显式加白名单类，漏放行 = 立刻可见的功能缺失，而非看不见的 bug。
               白名单类均已随对话流外卡下线退役：canvas-always（2026-10-28，浮卡 →
               时间线内联 proposal）/ canvas-with-composer（2026-10-29，对话流外 ask 卡
               → 时间线内联 question part，跟随 chat-wrap 可见性）。
               ⚠️ 新增常显卡须重新立白名单类 + 守卫测试。 -->
          <div class="agent-system-layer">
            <!-- 2026-11-03 会话积分常驻条（对齐 WorkBuddy 底部「已消耗 ◇N」）：仅 turn 活跃期
                 显示，钉在系统层（滚动流之外——绝不参与 SSE 内容自动滚动/跟随，不打断
                 scrollToBottom 闩锁）。口径单源 = agent.sessionConsumedCredits（已结算权威值
                 累计 + 当前回合实时预估；结算到达即被权威值替代，不重不漏）。
                 状态行 2026-10-31 整条退役，本条是用户裁决的最小复生：只播报消耗，
                 不播报等待/失败（那些仍由时间线内联卡单一真相承载）。
                 2026-11-03 复测修复：必须渲染在系统层**最末**（live 时间线之下、输入区
                 之上）——首版放在层顶，被长 pinned 时间线顶到流中部，用户实测误读为
                 「混进 SSE 滚动流」。WorkBuddy 位置 = 紧贴输入框。 -->
            <!-- 根治规格（2026-10-28）：对话流外浮卡已移除——「提议生成」决策点改为时间线内联
                 proposal part（见 AgentTurnTimeline.vue），与画布节点 ProposeConfirmOverlay
                 同读一份单一真相。桌面 = 对话流内联卡；移动端画布视图 = 节点内联面。
                 （2026-10-31：状态行退役，ambient 播报职责由时间线内联卡独自承载。） -->
            <!-- 2026-10-31 用户裁决：状态行整条退役（"等待你在画布上确认生成 还剩 N 分钟"等
                 running/waiting/failed/settled 播报全部不再显示），只保留 SSE 对话流——
                 等待呈现由钉在上方的时间线 proposal part（内联确认/取消卡）与画布确认面承载；
                 失败仍由气泡内 ⚠️ 文本 + dock 通知卡播报，无信息丢失面。
                 turnStatus computed / settledDismissed / nowSec ticker 已随之删除。 -->
            <!-- 2026-10-31 移动端 live 钉显的镜像块已随 2026-11-03 流式归一退役：
                 live 内容回消息流内联（与历史同构），实时可见由滚动跟随承接；
                 「进 agent-system-layer 即继承白名单机制」的约束对本块不再适用。 -->
            <!-- 根治规格（2026-10-28）：ask_user 卡已迁至对话流内联 question part（AgentTurnTimeline），
                 与画布确认面、状态行同读一份时间线真相；此处不再有对话流外的 composer 卡。 -->
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
            <!-- 2026-11-03 WorkBuddy 同款回合实时状态灰字（移动端复测追加需求）：
                 时间线单一真相派生（activityLine.turnLiveStatus，与对话流内联卡同源），
                 显隐与积分条同口径（turn 活跃期）；画布视图随层隐藏（同积分条）。 -->
            <div
              v-if="turnLiveStatusText"
              class="agent-live-status-line"
              data-testid="turn-live-status"
            >
              {{ turnLiveStatusText }}
            </div>
            <!-- 会话积分常驻条：系统层最末（见层顶注释——紧贴输入区，WorkBuddy 同位）。
                 Epic 3 Task 7（2026-11-04）：生成扣费落账后追加「（对话 M · 生成 K）」拆分，
                 回应「已消耗与余额对不上」的口径可读性诉求；纯文本回合无生成费不显示。 -->
            <div
              v-if="creditsLineVisible"
              class="agent-credits-line"
              data-testid="session-credits-line"
            >
              已消耗 ◇{{ agent.sessionConsumedCredits }} 积分<template v-if="agent.creditSplit.generation > 0">（对话 {{ agent.creditSplit.text }} · 生成 {{ agent.creditSplit.generation }}）</template><template v-if="agent.crossSessionSpend > 0">（其他会话消耗 {{ agent.crossSessionSpend }}）</template>
            </div>
          </div>

          <!-- 底部输入 dock：与节点 dock-studio 同款毛玻璃 -->
          <div class="agent-input-area shrink-0 px-2.5 pb-2.5 pt-1">
            <!-- 2026-10-15（治理 2/2）：dock 不再承载对话内容与滚动——
                 live 时间线 / 提示卡 / ask 卡已移回上方主滚动流；这里只剩 composer 与其周边固定件。 -->
            <div
              ref="composerDockRef"
              class="agent-input-dock"
              :class="{
                'is-drop-target': isDragOver,
              }"
              data-testid="agent-input-dock"
              @dragover.prevent="composer.onDragOver"
              @dragleave.prevent="composer.onDragLeave"
              @drop.prevent="composer.onDrop"
              @pointerdown="onInputDockPointerDown"
              @focusin="onComposerFocusIn"
              @focusout="onComposerFocusOut"
            >
              <div
                v-if="showHistoryReattachCoachmark"
                class="agent-history-coachmark mx-0.5 mb-2 flex items-start gap-2 rounded-lg border-l-[3px] px-3 py-2 text-[11px] leading-snug"
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
              <!--
                ⭐ 多槽位（2026-10-21 P2）：每条插话/尾随各一个气泡，按挂起顺序排列。
                单槽位时代连发第 2 条会把第 1 条文字**当场丢掉**（服务端那条还在、照常被消费）。
                :key 用槽位本地 id（非 entryId —— pending 态还没有 entryId）。
              -->
              <template v-for="slot in queuedSlots" :key="slot.id">
              <div
                class="agent-queued-bubble mx-3 mb-2 rounded-lg border-l-[3px] px-3 py-2"
                :class="slot.state === 'failed'
                  ? 'border-l-[var(--lnk-error)]/60 bg-[var(--lnk-error)]/10'
                  : slot.state === 'pending'
                    ? 'border-l-[var(--lnk-accent)]/60 bg-[var(--lnk-accent)]/10'
                    : 'border-l-[var(--lnk-success)]/60 bg-[var(--lnk-success)]/10'"
                :data-queue-state="slot.state"
                :data-queue-intent="slot.intent ?? ''"
              >
                <div class="flex items-start gap-2">
                  <span
                    class="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
                    :class="slot.state === 'failed'
                      ? 'bg-[var(--lnk-error)]/20 text-[var(--lnk-error)]'
                      : slot.state === 'pending'
                        ? 'bg-[var(--lnk-accent)]/20 text-[var(--lnk-accent)]'
                        : 'bg-[var(--lnk-success)]/20 text-[var(--lnk-success)]'"
                  >
                    {{
                      slot.state === 'pending'
                        ? '待发'
                        : slot.state === 'failed'
                          ? '未送达'
                          : slot.state === 'applied'
                            ? '已接住'
                            : '已入队'
                    }}
                  </span>
                  <p class="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--lnk-text-primary)]">{{ slot.text }}</p>
                </div>
                <p
                  v-if="slot.hint"
                  class="mt-1 text-[11px] leading-snug text-[var(--lnk-text-muted)]"
                  data-testid="queued-hint"
                >
                  {{ slot.hint }}
                </p>
                <div class="mt-1.5 flex flex-wrap items-center gap-2">
                  <template v-if="slot.state === 'pending'">
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
                    <button type="button" class="queued-act queued-act--primary" @click="queue.deliverQueued('steer', slot)">
                      ⏵ 立即插话{{ pendingAskBlocking ? '（答完这张卡后接）' : '' }}
                    </button>
                    <button type="button" class="queued-act" @click="queue.deliverQueued('followup', slot)">
                      🕒 等它跑完再说
                    </button>
                    <button type="button" class="queued-act" @click="queue.requeueQueued(slot)">✎ 取回内容</button>
                    <button type="button" class="queued-act" @click="queue.dismissQueued(slot)">🗑 放弃</button>
                  </template>
                  <template v-else>
                    <button v-if="slot.state === 'failed'" type="button" class="queued-act queued-act--primary" @click="queue.requeueQueued(slot)">
                      ✎ 取回内容
                    </button>
                    <!--
                      2026-10-20：已入队（accepted/applied）时「知道了」只是收起气泡，
                      另给一个**真撤回**入口 —— 此前「放弃」只清前端槽位，服务端那条仍在队列里
                      照常被消费。撤回只在拿到 entryId 时给，否则就是骗人的按钮。
                    -->
                    <button
                      v-if="slot.entryId && slot.state !== 'applied'"
                      type="button"
                      class="queued-act"
                      data-testid="queued-withdraw"
                      @click="queue.withdrawQueued(slot)"
                    >
                      ↩︎ 撤回
                    </button>
                    <button type="button" class="queued-act" @click="queue.dismissQueued(slot)">
                      {{ slot.state === 'accepted' || slot.state === 'applied' ? '知道了' : '放弃' }}
                    </button>
                  </template>
                </div>
              </div>
              </template>
              <!-- P1-5 移动端底部裸条（三态共条）：
                   本容器桌面端 display:contents（dock 内布局零改动）；移动端成为贴底裸条表面，
                   内部经 CSS 摊平为 [芯片行?][＋/文本/模型⌄/发送]。系统层（钉显 live 块 /
                   插话选项）在本条上方；文本直接落条内（无内嵌输入框）；◎ 锚条左顶点。 -->
              <div
                ref="bareBarRef"
                class="composer-bare-bar"
                role="group"
                aria-label="消息输入"
                :class="{
                  'is-stacked': mobileBarShape === 'stacked',
                  'is-idle': mobileBarIdle,                  /* 2026-10-18：空草稿（无文本且非生成中）隐藏模型 chip——用户裁决：
                     点 ＋ 加引用切入输入态后，一个字没打也不该看到模型选择器 */
                  'is-empty-draft': !input.trim() && !agent.isStreaming,
                }"
                data-testid="composer-bare-bar"
                @pointerdown="onBarPointerDown"
                @pointerup="onBarPointerUp"
                @mousedown="onBarMouseDown"
              >
                <!-- P1-5.3 判据锚：条内控件 = ＋（aria-label="更多"）/ ◎（左顶点）/ 模型⌄ / 发送，
                     均 ghost 无背景；空闲态条内仅 ＋ + 「点按输入」提示；
                     条级手势排除子控件命中（pointerdown/up closest 排除 + 子控件 @click.stop） -->
              <div class="agent-composer">
                <AgentRefStrip
                  v-if="composer.pendingAttachmentItems.length"
                  class="agent-composer__refs"
                  :items="composer.pendingAttachmentItems"
                  :removable="true"
                  @remove="sidebar.remove"
                  @mention="composer.insertRefMention"
                  @reorder="sidebar.reorder"
                />
                <!-- 2026-10-21 修回归：此处**必须无条件渲染**（不得写 v-else）。
                     #532 下线语音时删除了前面的 `<template v-if="holdActive">` 录音块，
                     原本与之配对的 v-else 静默改挂到 AgentRefStrip 的
                     v-if="pendingAttachmentItems.length" 上 ⇒ 只要有引用 chip（画布 ◎ 拾取 /
                     多选「加入 Agent 引用」），输入行（MentionInput textarea）整行不渲染，
                     裸条只剩 [芯片行][＋/模型/发送]，用户无法输入文字（stacked 三行布局
                     见下方 CSS 注释：行0 芯片 / 行1 输入文本 / 行2 控件——行1 必须常在）。
                     空闲态由 .is-idle 的 display:none 规则隐藏输入行，不依赖本处条件。 -->
                <div class="agent-composer__input-wrap">
                <!-- 2026-10-18 修 B：leading-inset 跟随 ◎ 可见性（两端统一）——
                     原 PC 恒 18px（◎ 藏着也缩进）、移动端恒 0（◎ 压住行首字符）。
                     ⑥ 画布点选模式：placeholder 承载跨容器引导（点 ◎ 后视线还在 composer，
                     不提示就不知道下一步去画布点节点；退出模式自动还原） -->
                <MentionInput
                  ref="composerRef"
                  v-model="input"
                  class="agent-composer__mention w-full"
                  :mentions="composer.mentionOptions"
                  :placeholder="pickMode.active.value
                    ? '在画布上点选要引用的节点 · 再点 ◎ 取消'
                    : agent.isStreaming
                      ? '输入消息…加入待发队列'
                      : inputPlaceholder"
                  :disabled="readOnly || isUploading"
                  :leading-inset="readOnly || isUploading || !canvasRefEntryVisible ? 0 : COMPOSER_PICK_INSET"
                  :mobile-enter-newline="isMobileLayout"
                  :prediction-history="predictionHistory"
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
                    <!-- 2026-10-26 用户裁定④：定位锚改**双色徽标**（黑盘 + 白锚 + 外环）。
                         ⛔ 徽标不能走 mask（会压成单色、丢掉双色）⇒ 必须 <img> 原样出图；
                            也因此不再吃按钮的 currentColor，高亮改由外层盘（is-active）承载。 -->
                    <img
                      class="composer-locate-glyph"
                      :src="anchorBadge"
                      alt=""
                      aria-hidden="true"
                      draggable="false"
                    >
                  </button>
                </div>
                <!-- P1-5.3 空闲态 affordance：纯 span 提示（非 placeholder）；桌面恒不渲染 -->
                <span v-if="mobileBarIdle" class="composer-bar-hint">{{ mobileBarIdleHint }}</span>
              </div>
              <input
                ref="fileInputRef"
                type="file"
                class="sr-only"
                multiple
                :disabled="readOnly || isUploading"
                @change="composer.onFileChange"
              >
              <input
                ref="cameraInputRef"
                type="file"
                class="sr-only"
                accept="image/*"
                capture="environment"
                :disabled="readOnly || isUploading"
                @change="composer.onFileChange"
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
                      @click.stop="composer.toggleAttachMenu"
                    >
                      <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75">
                        <path stroke-linecap="round" d="M12 5v14M5 12h14" />
                      </svg>
                    </button>
                    <!-- 2026-10-19 真机修复：＋卡「点空白收不拢」——卡内 padding/间隙也是
                         attachMenuRef 后代，click-outside 判内不关。移动端加全屏透明遮罩
                         （z 低于卡 30、高于裸条其余部分），点遮罩必收，时灵时不灵根除。
                         仅移动 dock 显示（桌面 floating 面板 overflow:hidden 会裁切固定遮罩）。 -->
                    <div
                      v-if="attachMenuOpen"
                      class="attach-menu-backdrop"
                      aria-hidden="true"
                      @pointerdown.stop="attachMenuOpen = false"
                      @click.stop
                    />
                    <div
                      v-if="attachMenuOpen"
                      class="neo-popover attach-card absolute bottom-full left-0 z-30 mb-1 w-[272px] rounded-2xl p-2"
                      @click.stop
                    >
                      <!-- 四瓦片（2026-10-18 照竞品卡片，用户裁决资产库升瓦片）：拍照 / 图片 / 添加文件 / 资产库 -->
                      <div class="mb-1.5 grid grid-cols-4 gap-1.5">
                        <button
                          type="button"
                          class="attach-tile flex flex-col items-center gap-1.5 rounded-xl py-3"
                          :disabled="readOnly || isUploading"
                          @click="composer.pickCamera"
                        >
                          <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.6">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M8.5 6.5 10 4.5h4l1.5 2H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17V8A1.5 1.5 0 0 1 5 6.5h3.5Z" />
                            <circle cx="12" cy="12.5" r="3.2" />
                          </svg>
                          <span class="text-[11px] font-medium leading-none">拍照</span>
                        </button>
                        <button
                          type="button"
                          class="attach-tile flex flex-col items-center gap-1.5 rounded-xl py-3"
                          :disabled="readOnly || isUploading"
                          @click="composer.pickImage"
                        >
                          <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.6">
                            <rect x="3.5" y="5" width="17" height="14" rx="2" />
                            <path stroke-linecap="round" stroke-linejoin="round" d="m6.5 16.5 4-4.5 3 3.5 2-2.5 2 3.5" />
                            <circle cx="15.3" cy="9.2" r="1.1" fill="currentColor" stroke="none" />
                          </svg>
                          <span class="text-[11px] font-medium leading-none">图片</span>
                        </button>
                        <button
                          type="button"
                          class="attach-tile flex flex-col items-center gap-1.5 rounded-xl py-3"
                          :disabled="readOnly || isUploading"
                          @click="composer.pickFile"
                        >
                          <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.6">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M20 11.5 12.6 19a4.6 4.6 0 0 1-6.5-6.5l7.6-7.6a3.07 3.07 0 0 1 4.34 4.34l-7.6 7.6a1.54 1.54 0 0 1-2.17-2.17l7.02-7.02" />
                          </svg>
                          <span class="text-[11px] font-medium leading-none">添加文件</span>
                        </button>
                        <button
                          type="button"
                          class="attach-tile flex flex-col items-center gap-1.5 rounded-xl py-3"
                          :disabled="readOnly || isUploading"
                          @click="composer.pickAssetLibrary"
                        >
                          <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.6">
                            <rect x="3" y="5" width="18" height="14" rx="2" />
                            <path stroke-linecap="round" d="M3 9h18M8 5V3m8 2V3" />
                          </svg>
                          <span class="text-[11px] font-medium leading-none">资产库</span>
                        </button>
                      </div>

                      <div class="mx-1 my-1 border-t border-[var(--lnk-border-subtle)] opacity-40" />

                      <!-- 行区（照竞品）：专家（置灰待开发）/ 技能 / 连接器（置灰待开发） -->
                      <button
                        type="button"
                        class="neo-popover-item flex w-full items-center gap-2.5 px-2.5 py-2.5 text-left text-xs opacity-40"
                        disabled
                        title="待后续开发"
                      >
                        <span class="agent-attach-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-full">
                          <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                            <circle cx="12" cy="8.5" r="3.5" />
                            <path stroke-linecap="round" d="M5 19.5c1.6-3 4-4.5 7-4.5s5.4 1.5 7 4.5" />
                          </svg>
                        </span>
                        <span class="flex-1">专家</span>
                        <svg viewBox="0 0 24 24" class="h-3 w-3 shrink-0 opacity-60" fill="none" stroke="currentColor" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        class="neo-popover-item flex w-full items-center gap-2.5 px-2.5 py-2.5 text-left text-xs"
                        :class="{ 'is-open': skillSubmenuOpen }"
                        @click="skillSubmenuOpen = !skillSubmenuOpen"
                      >
                        <span class="agent-skill-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
                          <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                          </svg>
                        </span>
                        <span class="flex-1">技能</span>
                        <span class="max-w-[92px] truncate text-[10px] opacity-60">{{ activeSkill?.label || '自动' }}</span>
                        <svg viewBox="0 0 24 24" class="h-3 w-3 shrink-0 opacity-60 transition-transform" :class="{ 'rotate-90': skillSubmenuOpen }" fill="none" stroke="currentColor" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6" />
                        </svg>
                      </button>
                      <div
                        v-if="skillSubmenuOpen"
                        class="skill-submenu ml-4 border-l border-[var(--lnk-border-subtle)] pl-1"
                      >
                        <button
                          type="button"
                          class="neo-popover-item agent-popover-skill-item flex w-full items-start gap-2 px-3 py-2 text-left"
                          :class="{ 'is-selected': activeSkillId === null }"
                          @click="activeSkillId = null; attachMenuOpen = false"
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
                        <button
                          v-for="skill in AGENT_SKILLS"
                          :key="skill.id"
                          type="button"
                          class="neo-popover-item agent-popover-skill-item flex w-full items-start gap-2 px-3 py-2 text-left"
                          :class="{ 'is-selected': skill.id === activeSkillId }"
                          @click="activeSkillId = skill.id; attachMenuOpen = false"
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
                      <button
                        type="button"
                        class="neo-popover-item flex w-full items-center gap-2.5 px-2.5 py-2.5 text-left text-xs opacity-40"
                        disabled
                        title="待后续开发"
                      >
                        <span class="agent-attach-icon flex h-6 w-6 shrink-0 items-center justify-center rounded-full">
                          <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.75">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M9.5 14.5 5.6 18.4a2.7 2.7 0 0 1-3.8-3.8l4.5-4.5M14.5 9.5l3.9-3.9a2.7 2.7 0 0 1 3.8 3.8l-4.5 4.5M8 16l8-8" />
                          </svg>
                        </span>
                        <span class="flex-1">连接器</span>
                        <svg viewBox="0 0 24 24" class="h-3 w-3 shrink-0 opacity-60" fill="none" stroke="currentColor" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="m9 6 6 6-6 6" />
                        </svg>
                      </button>
                      <!-- 2026-10-18 用户裁决：「思考档位」属于不同模型展开的二级功能，移出本卡
                           （非默认档仍有 params 行 B chip 常驻；标准档切档入口随模型二级功能后续接入） -->
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
                </div>

                <div class="agent-dock-primary">
                  <!-- P2-2.1：麦克风改 press-and-hold——press 开始、release 转写填入（不自动提交）、上滑取消 -->
                  <DockGenerateButton
                    glyph="send"
                    :generating="agent.isStreaming && !composer.composerDraftText"
                    :disabled="isUploading || (!agent.isStreaming && !composer.canSubmitComposer)"
                    :title="agent.isStreaming ? (composer.composerDraftText ? '发送插话' : '停止生成') : 'Enter 发送 · Shift+Enter 换行'"
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
      <AgentAssetPicker v-model:open="assetPickerOpen" @pick="composer.addAssetReference" />
      <ConversationShareSheet
        v-model="shareOpen"
        :turns="shareTurns"
        :session-id="props.sessionId"
        :title="`对话·${props.projectName ?? '未命名项目'}`"
        :show-scope="false"
      />
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
  /* 桌面并排时侧栏在左侧，分隔线贴着右侧（邻接画布）。 */
  border-right: 1px solid var(--lnk-border-subtle);
}

.agent-side-rail.is-resizing {
  transition: none;
}

/* ---- 收缩态左下角 logo 悬浮按钮 ---- */
.agent-fab {
  position: fixed;
  left: 20px;
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
  /* IA v3：底部页签常驻（--lnk-tabbar-h 由 MobileTabBar 发布），composer 让出页签高度 */
  bottom: calc(env(safe-area-inset-bottom, 0px) + var(--lnk-tabbar-h, 0px));
  right: 12px;
  left: 12px;
  /* §13.5（2026-10-28 真机走查四轮）根因修复：面板是页面级表面——
     main(z-10 堆叠上下文) 之上、顶栏 chrome(40) 之下。
     历史：原裸 z:70 在顶栏还是 85 时成立（面板 70 < 顶栏 85）；
     顶栏迭代 v3 收敛为 var(--lnk-z-chrome)=40 后 70 反盖顶栏 ⇒
     对话页「‹ 创作空间」回城出口与页题注整体不可见（teleport 到 body 后
     两者同层竞争，面板不透明背景全遮）。30 = (10, 40) 区间：页面内容之上、
     三顶栏与项目抽屉(95) 之下。 */
  z-index: 30;
  height: auto;
  max-height: none;
  /* 2026-10-23 溢出修复（第 3 道闸）：overflow-y 保持 visible（popover/浮层向下出），
     但横向用 clip 硬裁——此前 overflow:visible 让气泡内长 token 的溢出一路
     顶到 document，整页被推着横移（用户截图「页面可以往左滑」）。
     clip 不创建滚动容器，纵向行为不变。 */
  overflow-x: clip;
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
  /* 2026-11-09：清掉 base 的 18px 圆角——移动端裸条卡片视觉由 .composer-bare-bar 独占，
   * dock 透明容器不应再呈现圆角外形（否则聚焦环套在圆角外像是「第二张卡片」）。 */
  border-radius: 0;
}

/* 2026-11-09：清掉 base .agent-input-dock:focus-within 的 2px 聚焦环——移动端聚焦描边已由
 * .composer-bare-bar:focus-within 承载，dock 这圈套在裸条外会被读作「裸条外面的边框卡片」。 */
.agent-panel-mobile-dock .agent-input-dock:focus-within {
  box-shadow: none;
  border-color: transparent;
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

/* IA v3：移动端顶栏由 MobileTopBar（≡ / 标题 / ⋯）接管，本 header 整体隐藏——
   历史入口迁会话抽屉、门入底部页签（见 MobileTabBar） */
.agent-panel-mobile-dock .agent-panel-header {
  display: none;
}

/* P1-5 fix-1：移动端对话流限高滚动——画布始终露出上半（P1-5.1），不遮罩不加 sheet */
.agent-panel-mobile-dock .agent-chat-wrap {
  flex: 0 0 auto;
  min-height: 0;
  max-height: 40vh;
}

/* ---- 移动端对话视图（2026-10-18 信息架构裁决）----
 * 空态/输入态/生成态默认整页 = SSE 对话流 + composer，画布隐藏（CanvasPage 把画布区
 * visibility:hidden，保持挂载与视口测量，切回画布视图 fitView 立即可用）。
 * 仅两种动作进入画布视图：对话流内点定位（产物/提议生成卡）、composer ◎ 定位锚。
 * 本块只改「布局壳」：贴底容器升为整页不透明面板，composer/裸条内部样式零改动。
 * ⭐ 全屏出血（full-bleed）：基准贴底壳是 left/right:12px 的悬浮条（给窗态画布留边），
 * 对话态必须四边归零 + bottom 改 0、安全区下沉为 padding-bottom，否则面板四周
 * 透出画布 = 「对话模式页面没满屏」（2026-10-18 用户截图复现）。
 * IA v3：bottom 让出底部页签（--lnk-tabbar-h）；顶部让出 MobileTopBar（--lnk-topbar-h）。 */
.agent-panel-mobile-dock.is-conversation-view.agent-panel-shell {
  top: 0;
  right: 0;
  /* 2026-11-09：bottom 取「页签高度」与「键盘高度」之大者——键盘弹起（overlay/pan 模式）
   * 时 --mobile-kb-inset 由 useMobileKeyboardInset 实测写入，面板精确贴键盘上沿，
   * 消除「bottom:0 锚视口底边被键盘盖住」造成的 ~60px 空白；键盘未弹时回落页签高度。 */
  bottom: max(var(--lnk-tabbar-h, 0px), var(--mobile-kb-inset, 0px));
  left: 0;
  padding-top: calc(env(safe-area-inset-top, 0px) + var(--lnk-topbar-h, 44px));
  padding-bottom: env(safe-area-inset-bottom, 0px);
  background: var(--lnk-surface-canvas);
  pointer-events: auto;
}

.agent-panel-mobile-dock.is-conversation-view .agent-chat-wrap {
  flex: 1 1 auto;
  max-height: none;
}

/* 2026-11-09 用户裁定：对话态裸条距左右屏缘留 12px 对称留白（与 .agent-turn 的 px-3
 * 对齐，裸条卡片左缘 = 对话文本左缘），不顶着屏幕边缘。dock 背景仍 full-bleed 满屏、
 * 不露画布；此 padding 在 dock 内，不影响面板出血。
 * 窗态裸条已由 dock left/right:12px 提供同量留白 ⇒ 两态对称一致。
 * 锚（.composer-canvas-ref-btn，相对裸条定位）随裸条右移 12px，仍完整可见。 */
.agent-panel-mobile-dock.is-conversation-view .agent-input-dock {
  padding-left: 12px;
  padding-right: 12px;
}

/* 2026-11-09：键盘弹起（is-keyboard-open）时面板零安全区内缩——键盘已取代底部安全区，
 * 不再额外留 safe-area 造成「面板底边到键盘顶」的多余空白。面板 bottom 由上方
 * max(--lnk-tabbar-h, --mobile-kb-inset) 承担（键盘高度已计入），此处只清 padding。 */
.agent-panel-mobile-dock.is-keyboard-open.is-conversation-view.agent-panel-shell {
  padding-bottom: 0;
}

/* 2026-11-09 真机修复 #3：画布拾取窗态（◎ 定位锚进入 is-canvas-view）下 composer 被遮挡。
 * 根因：CanvasRefPickOverlay 是 position:absolute;z-45，所在画布区不建堆叠上下文，
 * 故 z-45 落在根上下文、盖在面板（z-30）之上 ⇒ composer 被遮。面板移动端为 composer 大小
 * （非全屏、height:auto），仅贴底，把它在画布视图提到 z-45 之上(50)即可让 composer 浮于
 * 拾取遮罩之上；不与顶栏(40)/页签(80)/项目抽屉(95)冲突（面板只在底部、composer 大小）。 */
.agent-panel-mobile-dock.is-canvas-view.agent-panel-shell {
  z-index: 50;
}

/* （2026-10-27 三页顶栏重构）is-conversation-view 历史 popover 向下恢复规则已随
   header 历史 popover 退役（ADR-0015 单对话）删除 */

/* ---- 画布视图 · 对话 chrome 一律不同屏（2026-10-18 二次裁决）----
 * 语义收口：顶栏（新建/历史头像）与 SSE 对话流只属于「对话模式」。画布视图两态——
 *   纯画布满屏（is-canvas-imm：传送门 / 页签点入，以及 ADR-0011 T6 的「定位到待确认节点」）
 *   窗态（◎ 定位锚与其余定位：composer 保留，供定位引图后继续输入）
 * 两条入口对 header / chat-wrap 的处理一致：display:none。
 * composer（裸条）仅在「纯画布满屏 / dock 展开」时收起。
 * 类摘除（门回对话 / 取消选中）⇒ 原样回归。
 * 系统层（propose 提示 / 状态行 / ask 卡 / 取消回执）不在此清单——由下方容器规则管辖，
 * 2026-10-21 起从逐卡登记改为「默认全隐 + 白名单放行」，漏登记不再静默。 */
.agent-panel-mobile-dock.is-canvas-view .agent-panel-header,
.agent-panel-mobile-dock.is-canvas-view .agent-chat-wrap,
.agent-panel-mobile-dock.is-canvas-view.is-canvas-imm .agent-input-dock,
.agent-panel-mobile-dock.is-canvas-view.has-studio-dock .agent-input-dock {
  display: none;
}

/* ---- 画布视图 · 系统层容器：默认全隐 + 白名单放行（2026-10-21 根治，取代逐卡登记）----
 * 病史：P1-5 把系统层移出 chat-wrap 后，往上面的清单逐卡登记漏了三次
 *（状态行 #496 → ask 卡+取消回执 #516 → 更早 railHiddenByTab），失败模式静默，
 * 每次都要真机截图才发现。现翻转默认值：
 *   容器在画布视图默认 display:none —— 新卡片进层即安全；
 *   需要露头的显式加白名单类，漏放行的代价是「立刻可见的功能缺失」。
 * 白名单类均已随对话流外卡下线退役（特异性曾压过容器规则）：
 *   canvas-always        已随对话流外浮卡下线退役（2026-10-28 根治规格：propose 决策点
 *                         = 时间线内联卡 + 画布节点内联面，画布视图无需再放行浮卡）。
 *   canvas-with-composer 已随对话流外 ask 卡下线退役（2026-10-29：ask 题面收敛进时间线
 *                         question part，跟随 chat-wrap 可见性，无需独立放行）。
 *                         ⚠️ 勿复活：往系统层加新常显卡须重新立白名单类 + 守卫测试。
 * 播报式 chrome（收口状态行 / 取消回执卡）不放行：画布视图全藏（#496/#516 行为不变）。 */
.agent-panel-mobile-dock.is-canvas-view .agent-system-layer {
  display: none;
}

/* ---- 2026-11-03 会话积分常驻条（turn 活跃期，系统层钉底；非播报卡，随层藏） ----
 * 令牌纪律：--lnk-*（neoUsageRatchet/text-token-guard：禁 px 字面量字号）；不加白名单类
 * ——移动端画布视图随层隐藏（与退役状态行同口径：播报式 chrome 不进画布视图）。 */
.agent-credits-line {
  padding: 2px 4px 4px;
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  text-align: center;
  color: var(--lnk-text-muted);
  font-variant-numeric: tabular-nums;
}

/* ---- 2026-11-03 回合实时状态灰字（WorkBuddy 同款，积分条上沿） ----
 * 令牌纪律同积分条：--lnk-*、禁 px 字面量字号、不加白名单类（随层藏）。 */
.agent-live-status-line {
  padding: 2px 4px;
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  text-align: center;
  color: var(--lnk-text-muted);
}

/* ---- 2026-11-03 轮次抬头（WorkBuddy 同款：徽章 + lnk π，每轮 agent 回复开头） ----
 * 徽章灰样式抄提议生成卡片 .chip（surface-sunken + subtle border + radius-full）；
 * 徽标必须 <img> 原样出图（⛔ mask 会压成单色，见 composer-locate-glyph 同款纪律）。 */
.agent-turn-head {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin: 0 0 4px;
  padding: 2px 8px 2px 4px;
  font-size: var(--lnk-text-xs);
  color: var(--lnk-text-secondary);
  background: var(--lnk-surface-sunken);
  border: 1px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-full);
}

.agent-turn-head__badge {
  width: 16px;
  height: 16px;
}

.agent-turn-head__name {
  font-weight: var(--lnk-weight-medium);
}

/* ---- 右边缘拖拉调宽（侧栏翻到左侧后，手柄贴其右缘邻接画布） ---- */
.agent-resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  /* 侧栏翻到左侧后，手柄贴右缘（邻接画布）。 */
  right: -3px;
  left: auto;
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
  /* 浮窗手柄仍贴左缘，独立于左侧 docks 的 right:-3px。 */
  left: 0;
  right: auto;
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

/* 项目抽屉样式已随抽屉退场而删除（规格收敛 v2 D10，2026-10-26）：
 * .session-drawer / .session-drawer-layer / .create-card* / .project-card* /
 * .session-drawer__expand* / .session-drawer__retry / .session-drawer-{enter,leave}*
 * 均已不存在。本文件仅保留对话历史面板的
 * .thread-history-*，以及项目/历史共用的 .session-drawer__caption / .session-drawer__empty。 */


.session-drawer__caption {
  padding: 6px 4px 0;
  font-size: var(--lnk-text-xs, 12px);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lnk-text-muted);
}


/* 对话历史面板（IA v3.2）：对话页右上角 🕘 唤起；与抽屉同族视觉，z 序高于抽屉。
 * 2026-10-19 真机反馈：「页签失灵」实锤场景之二——本遮罩 inset:0 盖住页签（z96>80），
 * 点页签只触发 @click.self 关面板、页签不切，第二次点才生效（抽屉遮罩同族 bug 的漏网之鱼）。
 * 遮罩 bottom 同抽屉遮罩让开页签区，页签任何时候可点。 */
.thread-history-layer {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  /* 兜底 56px = 页签基础高度：变量未发布时也不得回落成盖住页签 */
  bottom: var(--lnk-tabbar-h, 56px);
  z-index: 96;
  background: rgba(0, 0, 0, 0.35);
}

.thread-history-sheet {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 52px);
  right: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(72vw, 260px);
  max-height: 60vh;
  overflow-y: auto;
  padding: 12px;
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: 12px;
  background: var(--lnk-surface-canvas);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}

/* 同 ProjectPanel 的 .session-drawer > *：定高/限高 flex 列容器里子项一律不许收缩，
 * 防「overflow:hidden 子项被压成细线」事故家族复发（2026-10-19 抽屉事故同款机理）。 */
.thread-history-sheet > * {
  flex-shrink: 0;
}

.thread-history-item {
  display: block;
  width: 100%;
  padding: 10px 12px;
  border: 0.5px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: var(--lnk-text-primary);
  text-align: left;
  cursor: pointer;
}

.thread-history-item.is-current {
  border-color: var(--lnk-border-subtle);
  background: var(--lnk-surface-raised);
}


.session-drawer__empty {
  padding: 18px 4px;
  font-size: var(--lnk-text-xs, 12px);
  text-align: center;
  color: var(--lnk-text-muted);
}


/* 「＋」附件卡（照竞品卡片）：四瓦片 浅底/按下反馈 */
.attach-tile {
  color: var(--lnk-text-primary);
  background: var(--lnk-hover-overlay);
  transition: background 0.15s ease, opacity 0.15s ease;
}
.attach-tile:hover:not(:disabled) {
  background: color-mix(in srgb, var(--lnk-text-primary) 10%, transparent);
}
.attach-tile:disabled {
  cursor: not-allowed;
  opacity: 0.45;
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
  /* 2026-10-23 溢出修复：对话流永不横向滚动——长 token 由 overflow-wrap 折行，
     兜底裁剪（内容宽度仍可能瞬时超过容器，不能放它把外层顶出去） */
  overflow-x: hidden;
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

.agent-bubble-user {
  max-width: 88%;
  /* 2026-10-23 移动端溢出修复：flex 子项的隐式 min-width 是 min-content，
     长 URL / 宽表格 token 会把卡片撑出容器（页面整体横移的推手之一） */
  min-width: 0;
  border: 1px solid var(--agent-user-border);
  border-radius: 16px;
  background: var(--agent-user-bg);
  color: var(--agent-user-text);
  box-shadow: var(--agent-user-shadow);
  padding: 8px 12px;
}

/*
 * 2026-10-23 移动端文字溢出修复（用户截图：SSE 流里的裸 markdown 表格 + 长 URL
 * 把整页顶得横向滚动）。
 * - overflow-wrap: anywhere：超长不可断 token（URL/管道表格）在任意字符处折行，
 *   继承到气泡内所有正文节点（whitespace-pre-wrap 的正文 <p> 一并覆盖）；
 * - 气泡容器 min-width: 0：允许收缩到容器宽以内，而不是被 min-content 顶破。
 * 桌面侧栏同样受益（窄栏长 URL 同理），无视觉副作用。
 */
.agent-bubble {
  min-width: 0;
  overflow-wrap: anywhere;
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

/* D5 排队徽标：同 .agent-edit-hint 的明暗跟随理由——落在 --agent-user-bg 上，
 * 用气泡文字色做边框与文字（color-mix），不引入新 hex（令牌 SSOT 纪律）。 */
.agent-queued-badge {
  display: inline-block;
  margin-bottom: 4px;
  border: 1px solid color-mix(in srgb, var(--agent-user-text) 30%, transparent);
  border-radius: 999px;
  padding: 0 8px;
  font-size: var(--lnk-text-2xs);
  line-height: 1.6;
  color: color-mix(in srgb, var(--agent-user-text) 72%, transparent);
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

/*
 * 2026-10-23 移动端用户气泡操作行（用户反馈：三图标常驻把卡片撑得很高）：
 * 默认收起；点气泡后浮出在**卡片下方**（absolute，不占卡片高度）。
 * 只作用于移动 dock 作用域——桌面 hover 语义可用，维持常驻弱显不变。
 * is-open 由 onUserBubbleClick 按消息 id 切换（见 script）。
 */
.agent-panel-mobile-dock .agent-turn--user {
  position: relative;
}

.agent-panel-mobile-dock .agent-turn--user .agent-msg-actions {
  display: none;
}

.agent-panel-mobile-dock .agent-turn--user .agent-msg-actions.is-open {
  display: flex;
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 5;
  margin-top: 2px;
  padding: 2px 4px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--lnk-surface-raised) 94%, transparent);
  box-shadow: var(--lnk-shadow-xs);
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

/* .agent-prompt-field 死样式（含 76px 旧高度）已随 P2-3 删除：
   输入框高度唯一口径 = MentionInput 的 min-h-[96px]（B7）。 */

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

/* 2026-10-18：独立技能 chip 退役（入口收敛进「＋」菜单），.agent-skill-trigger* 规则随之删除 */

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

/* ---- 2026-10-18 composer 单卡化（对齐 WorkBuddy composer 观感）----
 * MentionInput 自带的全局 .input-field（legacy 灰底令牌 + 描边 + rounded-xl）
 * 在 dock 内形成「白卡包灰卡」双层；这里把 backdrop/field/ghost 三层摊平，
 * 视觉上只剩 .agent-input-dock 一张干净矩形（裸 DOM 感）。
 * 仅在 agent dock 作用域生效，不影响 NodeEditorToolbar / dock-studio 面板的 MentionInput。
 * 移动端 .agent-input-dock 已被摊平为透明容器（:4248），裸条 .composer-bare-bar
 * 是唯一表面，本规则同样生效 ⇒ 条内文本直接落在药丸上，无内嵌输入框。 */
.agent-input-dock :deep(.mention-input-backdrop),
.agent-input-dock :deep(.mention-input-field),
.agent-input-dock :deep(.mention-input-ghost) {
  background: transparent;
  border: none;
  border-radius: 0;
  box-shadow: none;
}

.agent-input-dock :deep(.mention-input-field):focus {
  border: none;
  box-shadow: none;
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

  /* 2026-10-18 ①：裸条两行化后，控件行紧贴输入文本行——命中区若垂直外扩 8px
   * 会侵入文本行，点输入实际点中模型 chip 的隐形命中区。改只横向外扩（44px 宽、
   * 原高 ±2px），垂直方向不越过 4px 行间距。 */
  .agent-hit-expand[data-hit='l']::after {
    inset: -2px -8px;
  }

  .agent-model-hit > :deep(button)::after {
    inset: -2px -8px;
  }
}

/* ---- P1-5 移动端底部裸条（三态共条，对齐线稿 §3） ----
 * 桌面：.composer-bare-bar 仅是 display:contents 的透明容器 —— dock 内布局零改动。
 * 移动端（.agent-panel-mobile-dock 作用域）：容器成为裸条表面，内部摊平为
 *   [ref 芯片行?] + [＋ / 文本 / 模型⌄ / 发送]（stacked 双行、idle/queued 单行）。
 * idle：条内仅 ＋ + 「点按输入」提示（P1-5.3），radius-full、min-height 48；
 * queued（生成中无引用）：占位「输入消息…加入待发队列」+ 发送槽位换停止（P1-3.2）。
 * 表面 = surface-raised + border-default + shadow-sm；文本直接落条内，无内嵌输入框；
 * ◎ absolute 锚条左顶点（.composer-canvas-ref-btn 既有 translate(-50%,-50%) 规则不变，
 *   移动端把 .agent-composer__input-wrap 改 static，让条成为 ○ 的包含块）。 */
.composer-bare-bar {
  display: contents;
}

/* 2026-10-21 真机走查（②）撤销上一轮的画布视图收敛：composer 条**保持原宽**——
 * 窗态下它就是这一带的唯一主角（＋FAB 由它盖住，见 MobileCanvasCreateFab 的落位注释），
 * 条内 ＋（加参考素材）保留在条左端，正好接替 FAB 的位置 ⇒ 画布页同一时刻只有一个 ＋。 */

/* 复合选择器压过模板上的 Tailwind 工具类；仅移动端 shell 内生效。
 * 2026-10-18：输入态/生成态对齐 PC——矩形倒角（radius-xl），胶囊(radius-full)
 * 只留给空闲态（.is-idle）；focus 描边用中性 hi-text（PC 同款），不再用品牌紫。 */
.agent-panel-mobile-dock .composer-bare-bar {
  position: relative;
  /* P2-2.2 上滑取消：条面垂直手势归应用（按住录音中浏览器不得接管为滚动） */
  touch-action: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--lnk-space-1);
  min-height: 48px;
  padding: var(--lnk-space-1) var(--lnk-space-2);
  border: 1px solid var(--lnk-border-default);
  border-radius: var(--lnk-radius-xl);
  background: var(--lnk-surface-raised);
  box-shadow: var(--lnk-shadow-sm);
  transition:
    border-color var(--lnk-duration-fast) var(--lnk-ease-standard),
    box-shadow var(--lnk-duration-fast) var(--lnk-ease-standard),
    border-radius 150ms var(--lnk-ease-standard),
    padding 150ms var(--lnk-ease-standard);
}

/* ④ reduced-motion：状态形变动画全部关闭，保留瞬切 */
@media (prefers-reduced-motion: reduce) {
  .agent-panel-mobile-dock .composer-bare-bar {
    transition: none;
  }
}

.agent-panel-mobile-dock .composer-bare-bar:focus-within {
  border-color: color-mix(in srgb, var(--lnk-hi-text) 28%, var(--lnk-border-default));
  box-shadow:
    var(--lnk-shadow-sm),
    0 0 0 2px color-mix(in srgb, var(--lnk-hi-text) 14%, transparent);
}

/* 空闲态手势面：条自身禁掉滚动手势接管，否则按住时 pointermove/up 被浏览器打断 */
.agent-panel-mobile-dock .composer-bare-bar.is-idle {
  touch-action: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
  cursor: pointer;
  border-radius: var(--lnk-radius-full);
  padding: 0 var(--lnk-space-2);
}

/* stacked：芯片行独占一行（basis 100% 强制换行），输入行 ＋/文本/模型⌄/发送
 * （圆角已随基础样式改为矩形倒角，无需再覆盖） */
.agent-panel-mobile-dock .composer-bare-bar.is-stacked {
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

/* 2026-10-18 确定性两行布局（对齐 PC 卡结构）：
 * 行0 = 引用芯片行（有芯片时，basis 100% 独占）；行1 = 输入文本（basis 100% 独占）；
 * 行2 = ＋ / 模型⌄ / 发送。修复：摊平 flex-wrap 下各控件按内容宽度自由折行，
 * 窄屏下 ＋ 被挤成独占一行、其余控件再挤一行，布局散架。 */
.agent-panel-mobile-dock .composer-bare-bar .agent-attach-menu {
  order: 1;
  flex-shrink: 0;
}

/* 附件卡移动端拉满裸条宽度 + 拉到底完全盖住 composer（2026-10-18 用户裁决）：
 * fixed 贴视口底（panel shell 无 transform，fixed 即视口系），圆角朝上、safe-area 内垫，
 * 自然高度即可整片盖住裸条。点击卡内 stopPropagation；条外点击走既有 click-outside 关闭。 */
@media (max-width: 767px) {
  .agent-panel-mobile-dock .attach-card {
    position: fixed;
    left: 12px;
    right: 12px;
    bottom: 0;
    width: auto;
    z-index: 90; /* 2026-11-09 真机修复 #1：高于页签 z-80，附件卡作为底部抽屉完整盖住页签 */
    border-radius: 16px 16px 0 0;
    padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
  }
}

/* ＋卡全屏透明遮罩（2026-10-19 真机修复「点空白收不拢」）：
 * 仅移动 dock 显示——桌面 floating 面板 overflow:hidden 会把 fixed 遮罩裁进面板。
 * z 25：低于卡（30）高于裸条其余控件；dock 整体 z-70 < 页签 z-80，页签不受遮罩影响。 */
.attach-menu-backdrop {
  display: none;
}

.agent-panel-mobile-dock .attach-menu-backdrop {
  display: block;
  position: fixed;
  inset: 0;
  z-index: 85; /* 2026-11-09 真机修复 #1：高于页签 z-80，遮罩随附件卡成为模态底部抽屉 */
  background: transparent;
}

.agent-panel-mobile-dock .composer-bare-bar .agent-composer__input-wrap {
  order: 0;
  position: static; /* 让 ◎ 的包含块上移到裸条（左顶点锚定） */
  display: flex;
  align-items: center;
  flex: 1 1 100%; /* 独占一行 */
  min-width: 0;
}

.agent-panel-mobile-dock .composer-bare-bar .agent-composer__mention {
  flex: 1 1 auto;
  min-width: 0;
}

.agent-panel-mobile-dock .composer-bare-bar .agent-dock-params {
  order: 2;
  display: flex;
  flex: 1 1 auto; /* 占满剩余宽度，把发送推到行尾 */
  flex-wrap: nowrap;
  align-items: center;
  min-width: 0;
}

.agent-panel-mobile-dock .composer-bare-bar .agent-dock-primary {
  order: 3;
  flex-shrink: 0;
  /* 不再覆盖 base 的 margin-left:auto——空草稿隐藏模型 chip 后，
     发送靠它推到行尾（有 chip 时 params flex:1 已占满，auto 无副作用） */
}

/* 2026-10-18：空草稿（无文本且非生成中）隐藏模型 chip（用户裁决，见模板 is-empty-draft） */
.agent-panel-mobile-dock .composer-bare-bar.is-empty-draft .agent-dock-params {
  display: none;
}

/* 空闲态：条内只留 ＋ + 提示（P1-5.3：不常驻模型/发送/独立 mic） */
.agent-panel-mobile-dock .composer-bare-bar.is-idle .agent-composer__input-wrap,
.agent-panel-mobile-dock .composer-bare-bar.is-idle .agent-dock-params,
.agent-panel-mobile-dock .composer-bare-bar.is-idle .agent-dock-primary {
  display: none;
}

/* 输入/生成态：条上控件 = ＋/模型/发送 3 个（spec §5.5）——思考槽位、独立 mic 隐藏
 *（技能入口已收敛进「＋」菜单，原 .agent-skill-trigger 隐藏规则随之删除） */
.agent-panel-mobile-dock .composer-bare-bar .agent-dock-thinking,
.agent-panel-mobile-dock .composer-bare-bar .dock-mic-btn {
  display: none;
}

/* 空闲 affordance：纯文本提示（非 placeholder），与条内 ＋ 同行（＋ order 1 在前） */
.agent-panel-mobile-dock .composer-bar-hint {
  order: 2;
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
.agent-panel-mobile-dock .composer-bare-bar :deep(.mention-input-field),
.agent-panel-mobile-dock .composer-bare-bar :deep(.mention-input-ghost) {
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


/* ◎ 定位锚入口（2026-10-18 用户裁决「幽灵灰盘、激活点亮」）：
 * 幽灵态 = 中灰圆盘（text-muted 与 surface-base 60% 混合，双主题自动取中灰）
 *   + hi-text glyph（深色下深锚 / 浅色下白锚，与发送键 glyph 同源反转）+ shadow-xs；
 * 激活（pick 模式 is-active）= 盘点亮成 hi-bg（glyph 仍 hi-text）+ hi-shadow 辉光。
 * 22px、translate(-65%,-65%) 约 2/3 露出卡外（「顶点长锚角」）；
 * PC 命中 32px（透明 ::after inset -5px）；≤767px 扩到 44px。 */
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
  /* 2026-11-09 用户裁定：去掉中灰盘——直接出 anchor-badge.png（与 SSE 轮次抬头 /
   * 提议卡同源裸徽标），由徽标自身黑盘 + 白环承载视觉，外环不再有冗余灰圈。 */
  background: transparent;
  color: var(--lnk-hi-text);
  box-shadow: none;
  transform: translate(-65%, -65%);
  transition:
    color var(--lnk-duration-fast) var(--lnk-ease-standard),
    background-color var(--lnk-duration-fast) var(--lnk-ease-standard);
  cursor: pointer;
}

/* 激活（pick 模式）= 点亮：徽标下垫 hi-bg 盘 + hi-shadow 辉光（黑徽标浮在彩色盘上 =
 * 与旧「灰盘+黑徽标」同款点亮观感，只是常态下盘透明）。 */
.composer-canvas-ref-btn.is-active {
  background: var(--lnk-hi-bg);
  box-shadow: var(--lnk-hi-shadow);
}

.composer-canvas-ref-btn:hover {
  filter: brightness(1.08);
}

.composer-canvas-ref-btn.is-active:hover {
  filter: brightness(1.06);
}

/* 移动端锚定位（2026-11-09 截图复现修正）：
 * 旧 left:4px + translate(-50%) 只在「窗态」成立——窗态 dock 内缩 12px（left:12px），
 * 锚圆心距屏 17px、圆左缘 6px，刚好在屏内。但「对话态」dock 已 full-bleed（left:0，见
 * .is-conversation-view 块），裸条左缘即屏缘，同一组值会把锚圆心推到屏外约 7px ⇒
 * 截图里锚被左屏缘切掉半边（用户报「左侧被遮挡」）。
 * 修正：落在裸条左内边距（--lnk-space-2=8px）内、不左溢；仅保留 translateY(-50%) 上骑缝，
 * 维持「顶点角」观感且窗态/对话态两端都完整可见。
 * ⭐ 必须排在基础规则之后：canvasRefEntry 契约测试用首个 `.{类名}{` 正则取幽灵态规则，
 *   覆盖规则在前会被误当基础规则（transform-only）而假红。 */
.agent-panel-mobile-dock .composer-canvas-ref-btn {
  left: var(--lnk-space-2);
  transform: translate(0, -50%);
}

/* 定位锚 glyph：anchor-badge.png = 裸徽标（黑盘 + 白锚 + 白环），与 SSE 轮次抬头、
 * 提议卡同源（2026-11-09 起撤销外层灰盘，见 .composer-canvas-ref-btn）。
 * ⛔ 不走 mask：mask 会把双色压成单色、白环丢失 ⇒ 必须 <img> 原样出图。
 * 20px 撑满 22px 按钮，外缘即徽标自带白环（不再有外层灰圈）。
 * 徽标是定色资产、不吃 currentColor；高亮（pick 模式）由外层 .is-active 的 hi-bg 盘垫底。 */
.composer-locate-glyph {
  display: block;
  /* 裸徽标：图本身即「黑盘 + 白锚 + 白环」，撑满 22px 按钮，外缘即徽标外环 */
  width: 20px;
  height: 20px;
  object-fit: contain;
  pointer-events: none;
}

.composer-canvas-ref-btn::after {
  content: '';
  position: absolute;
  inset: -5px;
}

.composer-canvas-ref-btn:focus-visible {
  outline: 2px solid var(--lnk-border-focus);
  outline-offset: 2px;
}

/* 提议生成卡片「定位」按钮的锚盘（2026-10-18）：保留中灰盘（卡片语境下与白底卡片更搭）；
 * composer ◎ 已改为裸徽标（2026-11-09），二者不再同款，仅激活点亮语义一致。
 * 幽灵 = 中灰盘（text-muted⊕surface-base）+ hi-text 锚 + shadow-xs；
 * hover/聚焦点亮 = hi-bg 盘（glyph 仍 hi-text）+ hi-shadow 辉光。 */
.propose-locate-disc {
  position: relative;
  display: block;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  border-radius: var(--lnk-radius-full);
  background: color-mix(in srgb, var(--lnk-text-muted) 60%, var(--lnk-surface-base));
  color: var(--lnk-hi-text);
  box-shadow: var(--lnk-shadow-xs);
  transition: background-color var(--lnk-duration-fast) var(--lnk-ease-standard);
}

/* mask 裁 border 陷阱：盘与 glyph 必须分层（::before 承载 glyph） */
.propose-locate-disc::before {
  content: '';
  position: absolute;
  inset: 0;
  margin: auto;
  width: 14px;
  height: 14px;
  background: currentColor;
  -webkit-mask: url('@/assets/icons/anchor-locate.png') center / contain no-repeat;
  mask: url('@/assets/icons/anchor-locate.png') center / contain no-repeat;
}

[data-testid='propose-wait-locate']:hover .propose-locate-disc,
[data-testid='propose-wait-locate']:focus-visible .propose-locate-disc {
  background: var(--lnk-hi-bg);
  box-shadow: var(--lnk-hi-shadow);
}

.agent-attach-icon {
  background: var(--lnk-hover-overlay);
  color: var(--lnk-text-secondary);
}

/* 2026-11-05：会话级 ☐ 勾选列样式随功能一并退役（对话页零选择态）。 */

</style>