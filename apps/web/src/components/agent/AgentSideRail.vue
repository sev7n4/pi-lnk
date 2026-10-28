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
import NeoAgentLogo from '@/components/agent/NeoAgentLogo.vue'
import { applyPiUserMessageEvent } from '@/components/agent/queueBubbleSync'
import AgentRefStrip from '@/components/agent/AgentRefStrip.vue'
import AgentSelectionBindingChip from '@/components/agent/AgentSelectionBindingChip.vue'
import AgentAssetPicker from '@/components/agent/AgentAssetPicker.vue'
import AgentTaskProgressCard from '@/components/agent/AgentTaskProgressCard.vue'
import AgentCanvasOutputs from '@/components/agent/AgentCanvasOutputs.vue'
import AgentExecutionTrace from '@/components/agent/AgentExecutionTrace.vue'
import AgentTurnTimeline from '@/components/agent/AgentTurnTimeline.vue'
import { isFeatureOn } from '@/composables/useFeatureFlag'
import { resolveMessageOutputs, locatableNodeIds } from '@/components/agent/agentCanvasOutputs'
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
import { acceptedHint, cancelOutcomeHint, parseQueueDelivery } from '@/components/agent/queueDelivery'
import type { QueueCancelOutcome } from '@/components/agent/queueDelivery'
import type { AgentStreamMessage } from '@/stores/agent'
import {
  cancelAgentRun,
  cancelledCalloutTextFromProgress,
  recoveredQueueText,
} from '@/components/agent/cancelAgentRun'
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
  mapNodeStatus,
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
  clearForkedThreadId,
  createAgentThreadId,
  persistActiveThreadId,
  persistForkedThreadId,
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
import { classifyRequestError, isNetworkError } from '@/components/agent/networkFault'
import { useNetworkNotice } from '@/composables/useNetworkNotice'
import DockGenerateButton from '@/components/canvas/dock-studio/shared/DockGenerateButton.vue'
import { useSidebarAttachments, assignRefKeysFor, type FocusNodeLike, type CanvasRefAddResult } from '@/composables/useSidebarAttachments'
import { parseRefMentions } from '@/composables/useRefMentions'
import MentionInput, { type MentionOption } from '@/components/canvas/MentionInput.vue'
import { copyTextToClipboard } from '@/utils/copyToClipboard'
import { createFollowUpTailListener } from './follow-up-tail'
import { applyTailVisibility } from './tail-visibility'
import {
  createSharedSubscription,
  shouldOpenConnection,
  type SharedEvent,
  type SharedSubscription,
} from './shared-subscription'
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
import { classifyGesture } from './composer/holdGesture'
import UniversalModelSelector from '@/components/canvas/UniversalModelSelector.vue'
import { useCanvasRefPickMode } from '@/composables/useCanvasRefPickMode'
import { formatDuration as formatTraceDuration } from '@/components/agent/executionStepLabels'
import { turnSettledText, turnSummaryLine } from '@/components/agent/executionTraceReducer'
import { formatSessionTime, lastThreadStorageKey } from '@/utils/formatSessionTime'
import { randomId } from '@/utils/randomId'
import { submitAnswers } from '@/components/agent/agentAnswers'
import { failureReason, resolveWaitingFromTimeline, turnStatusLine } from '@/components/agent/turnStatusBar'
import { hasBubbleContent, hasBubbleText } from '@/components/agent/bubbleVisibility'
import { describeActivityFromTimeline } from '@/components/agent/activityLine'
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
  /**
   * L2（2026-10-06）：propose 等待开始，把本地画布节点同步成 pending_confirm。
   *
   * 等待期 `update_node{pending_confirm}` 还没随 tool result 下发，本地是 stale draft；
   * 任何 saveCanvas 都会用它整份覆盖 SSOT 的待确认 ⇒ runtime 误判「用户取消」。
   */
  proposeWaitStart: [nodeId: string]
  /** P0-C（2026-10-13）：propose 等待结束——CanvasPage 解除 PUT 载荷强制声明 */
  proposeWaitEnd: []
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

const panelTeleported = computed(() => floating.value || isMobileLayout.value)

/* ---- 移动端贴底裸条高度发布（studio dock / 底部锚定元素避让用）----
 * 消费者：DockStudioToolbar（移动端）、MobileCanvasCreateFab、MobileSaveStatus、
 * MobileMultiSelectBar、SelectionBatchProgressCard —— 它们要避让的是**底部那条
 * 裸条**（composer 表面），不是整个贴底容器。
 * ⚠️ 2026-10-21 真机走查：原先发布的是「贴底容器」实测高度——画布视图里容器高度
 * 不可靠（实测 0），⇒ 所有底部锚定元素集体下移，与裸条**同位互压**（＋FAB 被盖掉
 * 一半、只剩一个紫色月牙）。改为直接实测裸条本身：裸条是画布视图底部唯一真实表面，
 * 隐藏时（沉浸态 / dock 展开）高度 0 ⇒ 清位公式自动归位。 */
const panelShellRef = ref<HTMLElement | null>(null)
const bareBarRef = ref<HTMLElement | null>(null)
let mobileDockRO: ResizeObserver | null = null
function publishMobileDockHeight(height: number) {
  document.documentElement.style.setProperty(
    '--lnk-agent-dock-h',
    `${Math.max(0, Math.round(height))}px`,
  )
}
function ensureMobileDockRO() {
  if (!isMobileLayout.value || mobileDockRO) return
  mobileDockRO = new ResizeObserver((entries) => {
    const height = entries[0]?.contentRect.height ?? 0
    publishMobileDockHeight(height)
  })
  // 移动端首载时 watch(immediate) 先于模板挂载，ref 可能还是 null ⇒ onMounted 再兜底补挂
  if (bareBarRef.value) mobileDockRO.observe(bareBarRef.value)
  else if (panelShellRef.value) mobileDockRO.observe(panelShellRef.value)
}
watch(
  () => bareBarRef.value,
  (el) => {
    if (!isMobileLayout.value || !mobileDockRO || !el) return
    mobileDockRO.disconnect()
    mobileDockRO.observe(el)
    publishMobileDockHeight(el.getBoundingClientRect().height)
  },
  { immediate: true },
)
watch(isMobileLayout, (mobile) => {
  if (mobile) {
    ensureMobileDockRO()
  } else if (mobileDockRO) {
    mobileDockRO.disconnect()
    mobileDockRO = null
    document.documentElement.style.setProperty('--lnk-agent-dock-h', '0px')
  }
}, { immediate: true })
onMounted(ensureMobileDockRO)
onUnmounted(() => {
  mobileDockRO?.disconnect()
  mobileDockRO = null
  publishMobileDockHeight(0)
})

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
  /** 槽位本地 id（仅用于 v-for 的 key 与逐条操作定位，与服务端 entryId 无关）。 */
  id: string
  text: string
  intent: QueueIntent | null // pending 态尚未决定走哪条通道
  state: QueueState
  /** 成功/失败原因，直接显示在气泡上，不做 toast（流式中弹窗会打断阅读） */
  hint: string
  /**
   * vendor 队列里的条目 id = **撤回键**（2026-10-20）。
   * undefined = 尚未入队（pending/failed）或服务端没回传（老版本）⇒ 不能真撤回。
   */
  entryId?: string
  /**
   * 插话时随消息带上的**参考素材**（2026-10-20 P1-1）。
   *
   * 正常发送走 `sendMessage` 会把侧栏附件（引用芯片）冻结进 payload；插话此前**只发 text**
   * ⇒ 「指着一张图插话」时 agent 收不到图，收不到芯片的指代（I1/I2）。
   * 这里在**挂起那一刻**冻结（与正常发送同口径：发送瞬间冻结，回执与实际内容一致）。
   */
  attachments?: SidebarAttachment[]
  /** 参考素材顺序（attachment id 列表） */
  refOrder?: string[]
  /** 消息内 @ 提及的 refKey */
  mentionedKeys?: string[]
  /**
   * 画布选中态（SEL-REF 指代信号），同样在挂起时冻结。
   *
   * 「选中这个节点，再插话说一句」是最自然的组合操作；此前插话不带选中态 ⇒
   * agent 不知道「这个」指谁。
   */
  selectionNodeIds?: string[]
  /**
   * composer 当前模型（P1-2 带图通道），同样在挂起时冻结。
   * Nest 侧用它做 vision 门控（决定图片走直通还是识图兜底）；与正常发送的
   * `model` 字段同源。缺省 = 不带（Nest 回落 loadDefaultTextModel）。
   */
  model?: string
}

/**
 * 挂起草稿的**结果三态**（2026-10-21 hotfix）。
 *
 * ⭐ 此前 `queueDraftAsPending()` 返回 boolean，但有**两个** false 出口：
 * 「无草稿」与「槽位已满」。调用方（`send()`）把 false 一律当成「没有草稿可挂」，
 * 于是槽位排满时顺带执行了中止 —— 把用户正在跑的那一轮 turn 停掉，
 * 恰好是「流式中可插话」这条链路要根治的行为。
 *
 * 三态把两种「没挂上」彻底分开：
 * - `queued`：已挂起（草稿已转入气泡）
 * - `empty`：**根本没有草稿**（唯一允许中止 turn 的情形）
 * - `full`：槽位已满（草稿保留 + 如实告知，**不得**中止 turn）
 */
type QueueDraftOutcome = 'queued' | 'empty' | 'full'
/**
 * ⭐ 2026-10-21 P2：**多槽位**。服务端（`lane` inbox）本来就支持同时挂多条，
 * 此前前端只有一个槽位 ⇒ 连发第 2 条插话时**第 1 条文字当场消失且无处可寻**
 * （服务端那条还在，会照常被消费 —— 用户以为没发出去）。
 *
 * 上限不是服务端限制，是 UI 卫生：气泡堆叠太多会顶掉对话阅读区，
 * 且「想插话」的真实场景一次也就一两条。满了就拒绝挂起并如实告知（草稿保留）。
 */
const MAX_QUEUED_SLOTS = 5
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
let slotSeq = 0
function nextSlotId(): string {
  slotSeq += 1
  return `q-${slotSeq}`
}
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
  // 多槽位：只推进**最早**那条还没被接住的（FIFO，与服务端消费顺序同向）。
  // 后面几条仍停在 accepted —— 它们确实还没被处理，说「已接住」是撒谎。
  const slot = queuedSlots.value.find((s) => s.state === 'accepted')
  if (!slot) return
  slot.state = 'applied'
  slot.hint = '已接住 · agent 正在处理你的补充'
}
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

/*
 * 2026-10-23 用户反馈（移动端）：用户气泡常驻「编辑/复制/复用本轮」三个图标
 * 把卡片撑得很高，挤压对话流。移动端改为默认收起，**点气泡**浮出在卡片下方；
 * 桌面（hover 语义可用）维持原状。
 * 状态用「每消息一个 Set 快照」整体替换（Vue3 Set 响应式需替换引用才可靠触发）。
 */
const mobileUserActionsOpen = ref<Set<string>>(new Set())

function toggleUserMessageActions(id: string) {
  const next = new Set(mobileUserActionsOpen.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  mobileUserActionsOpen.value = next
}

function onUserBubbleClick(msg: AgentStreamMessage) {
  if (!isMobileLayout.value) return
  if (msg.role !== 'user' || isMessageUnderEdit(msg)) return
  if (!canShowUserMessageActions(msg)) return
  toggleUserMessageActions(msg.id)
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

// P1-7.1 引导收敛：composer 区唯一可见引导 = 上方 coachmark（localStorage 首次门控，
// 移动端/桌面共享）；reattach 提示行与 attachment 提示行已删除（与 coachmark 重复，
// 控件自解释），pick-tip 已随 Task 6 移除。

const pendingAttachmentItems = computed(() =>
  makeAttachmentItems(sidebar.pendingAttachments.value, sidebar.assignRefKeys()),
)

/** 输入框左上角 🎯 圆心重合时的文字起始内边距（半径 + 小间距） */
const COMPOSER_PICK_INSET = 18

/** ◎ 可见性门控（2026-10-18 终版）：只要可交互就常驻可见——灰幽灵是 composer 的
 * 常驻工具（用户裁决「幽灵态灰色效果没出来」＝空态看不到图标，门控放开）；
 * readOnly 隐藏。激活高亮由 is-active 承担。 */
const canvasRefEntryVisible = computed(() => !props.readOnly)

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

/** 根治规格（2026-10-28）：对话流内联 proposal 卡的确认 / 取消——复用既有确认面语义，
 *  不再走对话流外浮卡。confirmProposeWait / cancelProposeForNode 已 defineExpose 给画布节点。 */
function onInlineConfirmProposal(nodeId: string) {
  void confirmProposeWait(nodeId)
}
function onInlineCancelProposal(nodeId: string) {
  void cancelProposeForNode(nodeId)
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
  // 根治规格（2026-10-28）：等待态 + 执行态的「单一真相」= 时间线 parts。
  // 状态行与对话流内联卡读同一份——结构性消除「状态行抢跑、对话卡滞后/缺失」。
  const parts = liveTimeline.value?.parts
  const waiting = resolveWaitingFromTimeline(parts)
  const lastFailed = agent.turnError != null ? failureReason(agent.turnError) : undefined
  // 「正在做什么」：从时间线 parts 派生（与对话流内联卡同源），不再直连 executionTrace.steps。
  const traceActivity = describeActivityFromTimeline(parts)
  // 等待文案来源：proposal part（propose）/ question part（ask），与内联卡同一 part。
  const proposalPart = parts?.find(
    (p): p is Extract<typeof p, { kind: 'proposal' }> =>
      p.kind === 'proposal' && p.status === 'pending_confirm',
  )
  const questionPart = parts?.find(
    (p): p is Extract<typeof p, { kind: 'question' }> =>
      p.kind === 'question' && p.status === 'pending_answer',
  )
  const waitingTool = proposalPart ? 'propose_generation' : null
  const waitingQuestion = questionPart
    ? questionPart.questions[0]?.question ?? questionPart.title
    : null
  const waitingDeadline = proposalPart
    ? proposalPart.startedAt + (proposalPart.timeoutMs ?? 300_000)
    : questionPart
      ? questionPart.startedAt + 300_000
      : null
  return turnStatusLine({
    isStreaming: agent.isStreaming,
    turnStartedAt: lastAssistantMessage.value?.executionTrace?.turnStartedAt,
    now: nowSec.value,
    waiting,
    // P2：恢复中显示「会话恢复中」而非「上游响应超时」（waiting 优先级更高，见 turnStatusBar）
    recovering: agent.recovering,
    waitingTool,
    waitingQuestion,
    waitingDeadline,
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
 * IA v3.2（2026-10-20 修复）：发现/我的页签与对话回合无关——移动端整条 dock（含状态行）
 * 必须彻底隐藏。否则 Teleport 到 body 的容器（z 高于 App.vue 的 `main.z-10`）会盖住发现/我的页：
 * 从对话页切过去会整页覆盖、从画布页切过去只剩裸露的状态行漂浮。
 * 注意：CanvasPage 给 `<aside>` 加的 hidden 类对 Teleport 内容无效，这里由容器自身收口。
 */
const railHiddenByTab = computed(
  () => isMobileLayout.value && (props.mobileAppTab === 'discover' || props.mobileAppTab === 'mine'),
)

/**
 * P2 T7 退场设计（2026-10-20 修复）：settled 收口态是「最后一眼」，结算信息已在气泡摘要
 * 同源落点，状态行允许被 dismiss；新回合开始 / 新一轮结算自动复位，避免永久常驻。
 */
const settledDismissed = ref(false)
watch(
  () => agent.isStreaming,
  (streaming) => {
    if (streaming) settledDismissed.value = false
  },
)
watch(
  () => turnStatus.value?.mode,
  (mode, prev) => {
    if (mode === 'settled' && prev !== 'settled') settledDismissed.value = false
  },
)
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
    phase: describeActivityFromTimeline(liveTimeline.value?.parts),
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
/**
 * 根治规格（2026-10-28）：`proposeWaitInCanvas`（ADR-0011 画布上下文降权判定）与
 * `turnHasFailedStep`（dock 警示）已随对话流外浮卡一并删除——前者唯一消费点是浮卡
 * 的 canvas-always 落位，后者的警示块同属浮卡模板。
 */
// P0-C（2026-10-13 事故 cmv51vwpu0008p801hxaxcf8m）：等待结束信号。
// CanvasPage 在等待期对 PUT 载荷强制声明 pending_confirm（防 stale 全量盖写 SSOT），
// 等待结束必须解除，否则确认启动后的 generating/completed 会被倒灌回待确认。
watch(proposeWait, (w, prev) => {
  if (prev && !w) emit('proposeWaitEnd')
})

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
async function cancelProposeForNode(nodeId?: string, opts?: { note?: string }) {
  const wait = agent.blockingWait
  if (!wait || wait.toolName !== 'propose_generation') return
  const waitNodeId = resolveProposeCancelNodeId(wait)
  if (!waitNodeId) return
  if (nodeId && waitNodeId !== nodeId) return
  const callId = resolveProposeCancelCallId(wait)
  if (callId) {
    try {
      await submitAnswers(
        {
          threadId: agentThreadId.value,
          sessionId: props.sessionId,
          callId,
          answers: {},
          decision: 'decline',
          // §17.8：批注锚带回随 decline 透传批注意见（trim 后非空才发）
          ...(opts?.note?.trim() ? { note: opts.note.trim() } : {}),
        },
        answersPost,
      )
    } catch {
      // 幂等端点：失败说明网络/鉴权异常，画布侧仍要收敛（轮询兜底会判 rejected）
    }
  }
  emit('clearProposeGeneration', waitNodeId)
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

// 流式中是否存在可插话的草稿文本：决定底部按钮临时切回发送态（而非停止态）。
const composerDraftText = computed(() => Boolean(input.value.trim()))

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

/** 「＋」附件卡（2026-10-18 照竞品重构：三瓦片 拍照/图片/添加文件 + 行 专家/技能/连接器）。
 *  单一 file input 复用：图片走 accept=image/*，文件走不限类型；拍照走带 capture 的独立 input。 */
function pickImage() {
  attachMenuOpen.value = false
  if (props.readOnly || isUploading.value || !fileInputRef.value) return
  fileInputRef.value.accept = 'image/*'
  fileInputRef.value.click()
}

function pickFile() {
  attachMenuOpen.value = false
  if (props.readOnly || isUploading.value || !fileInputRef.value) return
  fileInputRef.value.accept = ''
  fileInputRef.value.click()
}

function pickCamera() {
  attachMenuOpen.value = false
  if (props.readOnly || isUploading.value) return
  cameraInputRef.value?.click()
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

async function selectThread(threadId: string) {
  // 多端共享对话（2026-10-26）：只允许切到确定式共享 threadId（= sessionId）。
  // 历史面板可能列出旧的随机 thread，切到它们会让本端与该画布其它设备发散，
  // 故直接忽略（关闭面板、不切换）。
  if (threadId !== props.sessionId) {
    historyOpen.value = false
    return
  }
  if (threadId === agentThreadId.value) {
    historyOpen.value = false
    return
  }
  clearComposer()
  agentThreadId.value = threadId
  persistActiveThreadId(props.sessionId, threadId)
  // 守卫保证此处 threadId === sessionId（共享线程）：用户显式离开重跑分支，
  // 必须同步清 fork key，否则下次刷新 resolveBootstrapThreadId 会把本端弹回分支
  // ——「返回主对话」活不过一次刷新（Phase 1 评审发现 F1）。
  clearForkedThreadId(props.sessionId)
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
      // 桌面 docks 在左侧（CanvasPage 用 flex-row-reverse 把侧栏翻到左）：
      // 侧栏左缘贴屏幕 x=0，宽度即鼠标到左缘的距离。
      panelWidth.value = clamp(ev.clientX, PANEL_MIN_W, PANEL_MAX_W)
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
  ElMessage.info('已开始新对话')
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


/* ---- 移动端裸条状态（P1-5，2026-10-16 三态共条重构） ----
 * 语音识别已于 2026-10-21 整体下线（移动端 + PC）：本组件不再有录音态与麦克风钮。 */
const composerExpanded = ref(false)
/* 2026-10-18 ③ ◎ 引用入口门控：聚焦即算「进入输入态」，◎ 立即可见（PC/移动通用），
 * 不再等用户敲出第一个字。 */
const composerFocused = ref(false)
const composerDockRef = ref<HTMLElement | null>(null)

// 输入框被程序填充（如待发消息取回）时自动进入伸展态
watch(input, (v) => {
  if (isMobileLayout.value && v.trim()) composerExpanded.value = true
})

function onComposerFocusIn() {
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
  barShape({ hasRefs: pendingAttachmentItems.value.length > 0, isStreaming: agent.isStreaming }),
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
  if (apiOk) await refreshThreadCheckpoint()
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
    const outcome = await queueDraftAsPending()
    if (outcome !== 'empty') return
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

async function deliverQueued(intent: QueueIntent, slot?: QueuedSlot): Promise<boolean> {
  const target = slot ?? queuedSlots.value.find((s) => s.state === 'pending')
  if (!target || target.text.trim() === '' || target.state !== 'pending') return false
  target.state = 'pending'
  target.hint = ''
  const endpoint = intent === 'steer' ? '/api/agent/runs/steer' : '/api/agent/runs/followup'
  try {
    const res = await fetch(apiUrl(endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        sessionId: props.sessionId,
        threadId: agentThreadId.value,
        text: target.text,
        // ⭐ 2026-10-20 P1-1：带上挂起时冻结的参考素材与画布选中态。
        // 此前插话只发 text ⇒ 「指着一张图插话」时 agent 收不到图、收不到「这个」指谁。
        // ⚠️ 缺省即不传（不是传空数组）：服务端据此区分「本条没有参考」与「老前端不会带」。
        ...(target.attachments?.length ? { attachments: target.attachments } : {}),
        ...(target.refOrder?.length ? { refOrder: target.refOrder } : {}),
        ...(target.mentionedKeys?.length ? { mentionedKeys: target.mentionedKeys } : {}),
        ...(target.selectionNodeIds?.length ? { selectedNodeIds: target.selectionNodeIds } : {}),
        // ⭐ P1-2：composer 模型随消息冻结（Nest 据此做 vision 门控组装直通图片）。
        ...(target.model?.trim() ? { model: target.model } : {}),
      }),
      signal: AbortSignal.timeout(5000),
    })
    const body: unknown = await res.json().catch(() => null)
    const verdict = parseQueueDelivery({ ok: res.ok, status: res.status, body })
    if (!verdict.delivered) {
      throw new Error(verdict.reason)
    }
    // ⭐ 收回 entryId（2026-10-20）：服务端把它当成撤回键回传。存进槽位，
    // 「放弃 / 取回内容」才可能真的从 vendor 队列里撤掉这条（此前只清前端）。
    const outer = body as { data?: { entryId?: string } } | null
    target.entryId = typeof outer?.data?.entryId === 'string' ? outer.data.entryId : undefined
    // ⭐ 2026-10-21：登记这个 entryId —— 它是「这条插话」的**权威身份**，
    // 也是 pi 侧消费它时 `message_end` 带回来的那个 entryId（vendor 边界提交队列条目
    // 时写的就是 `{ id: item.entryId }`）⇒ 两者可对上，于是能分清
    // 「这条是插话（本地没气泡，要补建）」与「这条是本轮初始 prompt（本地已有气泡，挂切点）」。
    // ⚠️ 登记后**不再移除**：用户点「放弃」只是收掉本地气泡，服务端那条仍会被消费 ——
    //    那时仍要给它补建气泡，否则模型回答了而用户那句话在对话流里凭空消失。
    if (target.entryId) queuedEntryIds.add(target.entryId)
    target.state = 'accepted'
    // 有未作答的卡时不能说「已并入当前回答」——本轮此刻正在等用户选一个答案，
    // 没有「当前回答」可言（见 pendingAskBlocking 注释）
    target.hint = acceptedHint(intent, pendingAskUser.value.length > 0)
    // ⚠️ 刻意不再自动收起（原来 2.6s 后自己消失）：agent 从入队到首字常 20~40s，
    // 期间气泡若消失，用户会误以为消息丢了。这里常驻，收到 QUEUE_APPLIED_EVENTS 再推进到
    // 「已接住」，最终由用户点「知道了」收起。
    return true
  } catch (err) {
    target.state = 'failed'
    target.hint = err instanceof Error ? err.message : '投递失败'
    return false
  }
}

/**
 * 把 pi 的 `entryId` 回填到服务端已落库的那条 user 消息上（2026-10-21）。
 *
 * ## 为什么需要
 * 正常发送（`streamConversation`）在调 pi **之前**就落了 user 行，而 `pi.prompt()` 只返回
 * `{ accepted }`（`pi-runtime/src/session-manager.ts:2370`）⇒ 正常发送的 entryId
 * **只能从 `pi_message_end` 事件拿**。不回填 ⇒ 刷新后的历史消息没有 fork 切点，
 * 「③ 重跑」只能降级兜底（这正是 `AgentSideRail` 里「若该消息还没拿到 entryId」那条兜底注释
 * 所描述的状态）。
 *
 * ## 为什么插话不走这里
 * 插话在**入队那一刻**就由服务端用 entryId 落库了（`persistQueuedUserMessage`）⇒ 无需回填。
 *
 * ## 为什么可以静默失败
 * 这只影响「刷新后能否从这条历史消息重跑」，属于**增强**而非正确性：失败时退化为既有的
 * 降级兜底，不该打断对话流，也不该弹错（用户在流式中发言，最忌干扰）。
 */
async function persistUserEntryId(entryId: string): Promise<void> {
  const threadId = agentThreadId.value
  if (!entryId || !threadId) return
  try {
    await fetch(apiUrl('/api/agent/chat/user/entry-id'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ sessionId: props.sessionId, threadId, entryId }),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // fail-soft：见上方注释。服务端 entryId 唯一索引保证重试/多页签都不会写出重复行。
  }
}

/**
 * 从 vendor 队列撤回已入队的这条（2026-10-20，对齐上游 `AgentLane.cancelQueued`）。
 *
 * ⚠️ 三态必须分开处理，不能一律当成功：
 * - `cancelled`       真撤回了；
 * - `already_consumed`已被 turn 边界取走 ⇒ 内容**已在对话历史里**，撤回已晚；
 * - `not_found`       队列里没有（进程重启 / lane 回收）。
 *
 * 后两种都收掉气泡（用户目的达成：不想让它生效），但 `already_consumed` 必须**如实告知**，
 * 否则用户以为撤回成功、下一轮却又看见它冒出来。
 *
 * 撤回失败（网络/服务不可用）时**保留气泡**：此时服务端那条还在，假装撤回是更糟的谎报。
 */
async function withdrawQueued(slot?: QueuedSlot): Promise<boolean> {
  const target = slot ?? queuedSlots.value.find((s) => s.entryId !== undefined)
  if (!target) return false
  if (!target.entryId) {
    // 没拿到 entryId（老服务端 / 入队响应缺字段）：只能收掉前端槽位，如实说明撤不干净
    if (target.state !== 'pending' && target.state !== 'failed') {
      ElMessage.info('这条已送达，收回不了 —— 撤回需要入队时拿到的凭据（当前服务端版本暂不支持）')
    }
    dismissQueued(target)
    return false
  }
  try {
    const res = await fetch(apiUrl('/api/agent/runs/queue/cancel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        sessionId: props.sessionId,
        threadId: agentThreadId.value,
        entryId: target.entryId,
      }),
      signal: AbortSignal.timeout(5000),
    })
    const body: unknown = await res.json().catch(() => null)
    if (!parseQueueDelivery({ ok: res.ok, status: res.status, body }).delivered) {
      throw new Error('撤回请求未被接受')
    }
    const outcome =
      (body as { data?: { outcome?: QueueCancelOutcome } } | null)?.data?.outcome ?? 'not_found'
    if (outcome === 'already_consumed') {
      ElMessage.info(cancelOutcomeHint('already_consumed'))
    }
    dismissQueued(target)
    return outcome === 'cancelled'
  } catch (err) {
    // 失败时**不收气泡**：服务端那条还在，假装撤回会让用户以为撤掉了
    ElMessage.error(err instanceof Error ? err.message : '撤回失败，请重试')
    return false
  }
}

/**
 * 流式中把当前草稿挂成待发气泡（不直接投递，动作权留给用户选 steer/followUp）。
 * 抽取为独立函数，供回车提交与底部按钮两处复用，避免逻辑分叉。
 *
 * ⭐ **参考素材与选中态在挂起这一刻冻结**（2026-10-20 P1-1）：与正常发送同口径
 * （「发送瞬间冻结，回执仍须与实际发出的内容一致」）。用户挂起后可能改选节点/换芯片，
 * 但那条消息的指代必须是**挂起那一刻**的指代。
 * @returns 挂起结果三态（见 {@link QueueDraftOutcome}）。
 */
async function queueDraftAsPending(): Promise<QueueDraftOutcome> {
  const text = input.value
  if (!text.trim()) return 'empty'
  // ⭐ 槽位已满 ⇒ **不吞草稿**：清空输入框却挂不上去，等于又一次「消息凭空消失」。
  if (queuedSlots.value.length >= MAX_QUEUED_SLOTS) {
    ElMessage.warning(`最多同时排 ${MAX_QUEUED_SLOTS} 条补充，先处理掉一条再发`)
    return 'full'
  }
  input.value = ''
  // 冻结参考素材（芯片）与画布选中态 —— 与 sendMessage 同一口径
  const { attachments: pendingAttachments, refOrder: pendingRefOrder } = sidebar.toPayload()
  const attachments = pendingAttachments
  const mentionedKeys = normalizeMentionedKeys(parseRefMentions(text)) ?? []
  const selectionNodeIds = props.selectedNodeIds?.length ? props.selectedNodeIds.slice() : []
  // P1-2：composer 当前模型随消息冻结（Nest 据此做 vision 门控组装直通图片）
  const model = planningModel.value?.trim() || undefined
  queuedSlots.value = [
    ...queuedSlots.value,
    {
      id: nextSlotId(),
      text,
      intent: null,
      state: 'pending',
      hint: '',
      ...(attachments.length ? { attachments, refOrder: pendingRefOrder } : {}),
      ...(mentionedKeys.length ? { mentionedKeys } : {}),
      ...(selectionNodeIds.length ? { selectionNodeIds } : {}),
      ...(model ? { model } : {}),
    },
  ]
  // 素材已随消息冻结 ⇒ 清掉侧栏的待发芯片，避免下一条消息重复带上同一批
  if (attachments.length) sidebar.clear()
  await nextTick()
  scrollToBottom(true)
  return 'queued'
}

/**
 * 输入框回车提交。流式中**不自动投递**，只把消息挂进待选气泡，动作权留给用户：
 * steer（立刻接住）与 followUp（收尾接住）是两种送达时机，不能替他默认选一个。
 * 非流式中走正常发送。底部「停止」按钮走 `send()`，二者分离。
 */
async function onComposerSubmit() {
  if (agent.isStreaming) {
    await queueDraftAsPending()
    return
  }
  await send()
}

function dismissQueued(slot?: QueuedSlot) {
  // 多槽位：给了目标就只收这一条；没给（兼容旧调用 / 键盘路径）收最早那条。
  if (!slot) {
    queuedSlots.value = queuedSlots.value.slice(1)
    return
  }
  queuedSlots.value = queuedSlots.value.filter((s) => s.id !== slot.id)
}

/**
 * ✎ 取回内容：把消息退回输入框（不另开卡片），投递未成功时这是唯一的挽回入口。
 *
 * ⚠️ 2026-10-20：已入队的槽位取回时**必须先真撤回**，否则服务端那条还在队列里，
 * 用户把同一句话改一改再发，就会同时存在两条（一条还在队列里偷偷生效）。
 * pending / failed 态本来就没入队，直接退文字即可。
 */
async function requeueQueued(slot?: QueuedSlot) {
  const target = slot ?? queuedSlots.value[0]
  if (!target) return
  const wasDelivered = target.entryId !== undefined
  const text = target.text
  if (wasDelivered) {
    await withdrawQueued(target)
  }
  // withdrawQueued 失败时它保留气泡（该槽位仍在 queuedSlots 里）⇒ 这里不再覆写，
  // 避免与失败态抢同一个槽位 / 把别人那条退回输入框。
  if (!queuedSlots.value.some((s) => s.id === target.id)) return
  // 已有草稿时不覆盖：与 abort 回灌同款语义，把取回的文字追加在后面
  input.value = input.value.trim() ? `${input.value.trim()}\n\n${text}` : text
  dismissQueued(target)
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
    hasAttachments: pendingAttachmentItems.value.length > 0,
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
  recoveredPhaseHint.value = null
  // 新一轮开始：清掉上一轮失败态标记与失败卡（续跑而非重发的前提）
  lastTurnFailed.value = false
  dockNotice.dismiss(REQUEST_FAILED_ID)
  // 记住本轮用户原文，供失败卡「重试」复用（幂等键已保证重试不重复扣积分）
  if (!isRetry) lastSentMessage.value = message
  runCancelled.value = false
  threadRunState.value = null
  cancelledPresentation.value = null
  cancelledProgressText.value = null
  streamAbortController = new AbortController()
  // 主流起飞前先让位：常驻订阅与主流订阅的是同一会话，两边同时挂着会把
  // 同一份 text_delta 收两遍（气泡里出现双倍文本）。
  releaseObserverTurn()
  followUpTail.abort()
  agentStream.start()

  try {
    const token = localStorage.getItem('token')
    // 连接级错误（无 HTTP 状态）静默自动重试 1 次：移动端网络抖动多在秒级内恢复，
    // 用户无感即可续上（2026-10-21 决策）。AbortError 与业务级错误不重试。
    let res: Response | null = null
    for (let attempt = 0; attempt < CONVERSATION_FETCH_MAX_ATTEMPTS; attempt++) {
      try {
        res = await fetch(apiUrl('/api/agent/chat/conversation'), {
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
    if ((err as Error)?.name === 'AbortError') {
      // 用户主动取消：不报、不弹卡
    } else {
      const cls = classifyRequestError(err)
      agent.markTurnError(err)
      // 气泡只留一行人话摘要，原始技术文案（如 `TypeError: network error`）不再透出
      agent.appendText(`\n\n⚠️ 生成失败 · ${cls.human}`)
      lastTurnFailed.value = true
      // 分流进 dock 三色卡片（单一出口）：连接级=黄卡+重试，业务级=红卡+重试
      dockNotice.pushNotice({
        id: REQUEST_FAILED_ID,
        tone: cls.kind === 'network' ? 'warning' : 'error',
        title: cls.kind === 'network' ? '网络连接中断' : '生成失败',
        message:
          cls.kind === 'network'
            ? '生成进度已自动保存，可点「重试」继续。'
            : cls.human,
        action: { label: '重试', onClick: () => void retryLastTurn() },
        ttl: 0,
      })
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
          '\n\n⚠️ 本轮连接中断，没有收到任何回复内容。可点「重试」；若仍无响应，点「新对话」后重发。',
        )
      }
    }

    const last = agent.messages[agent.messages.length - 1]
    if (!runCancelled.value && last?.role === 'assistant' && !last.content.trim()) {
      agent.appendText('（本轮无文本回复。若还需确认，可再发「确认」；或点「新对话」后重试。）')
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
const observerTurnActive = ref(false)

/**
 * ⭐ 2026-10-26 根治：把「语义事件的应用」从订阅回调里**抽成独立函数**。
 *
 * 为什么抽：跨标签页共享转发的是**语义事件**（文本增量 / 画布动作 / 回合收束），
 * 而订阅模块的判定逻辑（游标 / 退避 / idle 闸门 / 终态）**一行不改**（规格 G-2）
 * ⇒ 共享必须落在**宿主回调**这一层 ⇒ 「直连收到」与「共享转发收到」要**同一段代码**，
 * 否则两边语义会漂移（历史事故模式）。
 */

/** 应用文本增量（本地）——直连与跨标签页两条路径共用。 */
function applyTextDelta(text: string): void {
  // ⛔ 本端主流在跑：同一份 text_delta 已经从 POST 响应体到了，旁听再追加就是双倍文本。
  if (agent.isStreaming) return
  // 旁观另一端的那一轮：本地还没有这条 assistant 的影子 ⇒ 先起一条再追加。
  if (!observerTurnActive.value) {
    agent.startAssistantMessage()
    agent.isStreaming = true
    observerTurnActive.value = true
  }
  // 与主流的事件契约完全一致（Nest 两端共用 mapPiEventToUiEvent）。
  agent.appendText(text)
  scrollToBottom()
}

/** 应用画布动作（本地）——直连与跨标签页两条路径共用。 */
function applyCanvasAction(data: unknown): void {
  emit('canvasActions', [data as never])
}

/** 回合收束（本地）——直连与跨标签页两条路径共用。 */
function applyTurnEnd(): void {
  // 幂等：done 之后还有 turn_ack，会来第二次
  if (!observerTurnActive.value) return
  observerTurnActive.value = false
  agent.finishStreaming()
  // 旁观拿到的是增量片段，收尾必须以服务端权威历史为准纠正一次（漏帧/乱序的自愈口）。
  // 传 0：那一轮已在另一端跑完，不做终态轮询（否则旁观端会跟着睡 5s×N）。
  void reconcileLatestAssistant(0)
  emit('turnComplete')
  scrollToBottom()
}

/**
 * ⭐ 跨标签页共享（2026-10-26 根治）：同一会话的 N 个标签页 ⇒ **全局只开 1 条**订阅连接。
 *
 * 为什么必须有：常驻订阅是**每标签页一条长连接**（靠服务端心跳维持，实测 30s+ 不关闭），
 * 而 Chrome 对同源 HTTP/1.1 只有 **6 个连接** ⇒ 标签页一多，普通请求（项目列表等）
 * 全部排队饿死（2026-10-26 生产事故：品牌页点锚卡 15 秒 ⇒「项目加载失败」⇒ 重试无效）。
 *
 * 降级：无 BroadcastChannel（老浏览器）⇒ **各自订阅**（= 改动前行为），零新增故障面。
 */
let sharedSubscription: SharedSubscription | null = null
let sharedChannelName = ''

/**
 * ⭐⭐⭐ 2026-10-26 生产取证：**全局 SSE 槽位（跨标签页、跨画布）**。
 *
 * 事故形态（生产实证，2026-10-26）：
 *   用户同时开着多个画布标签页时，**每个标签页各挂一条**常驻订阅
 *   （不同 session ⇒ 上一版的「同 session 共享」合并不了）
 *   ⇒ 累计到 **6 条** = Chrome 同源 HTTP/1.1 的连接上限
 *   ⇒ 之后**所有**普通请求排队饿死（实测 50 条请求 0 字节传输）：
 *     · 画布载荷 `GET /sessions/:id` 排不上 ⇒ **画布显示为空**
 *     · 积分面板 `GET /membership/points` 排不上 ⇒ **显示「0 积分 + 加载中…」**
 *       （实测服务端 29ms 就返回 119466 ⇒ 界面上的 0 是假 0）
 *
 * ⇒ 这里用**一个与 session/thread 无关的全局频道**选举「谁持有唯一那条订阅连接」：
 *   可见页优先（隐藏页让位，见 #587 语义）⇒ **整个浏览器最多 1 条常驻订阅**
 *   ⇒ 给普通请求留出 5 条槽位。
 *
 * ⚠️ 代价（产品取舍，必须让用户知道）：
 *   多窗口同时打开不同画布时，**只有拿到全局槽位的那一个窗口**有「另一端在跑」的
 *   实时推送；其余窗口降级为「不实时」——这是同源 6 连接硬上限下的必然取舍。
 */
let sseSlotSubscription: SharedSubscription | null = null

/** 本标签页是否持有「全局唯一那条订阅连接」。 */
function holdsGlobalSseSlot(): boolean {
  const slot = sseSlotSubscription
  // 无 BroadcastChannel（老浏览器）⇒ 降级：各自订阅（= 改动前行为），零新增故障面。
  if (!slot || slot.status().degraded) return true
  return slot.isLeader()
}

/** 当前标签页是否可见（隐藏 ⇒ 不占连接、让出 leader —— #587 语义）。 */
function isTabVisible(): boolean {
  return document.visibilityState === 'visible'
}

/**
 * 连接开/关的**唯一判据**（所有触发点都调它：会话 leader 变化 / 全局槽位变化 / 可见性变化）。
 *
 * ⛔ 判定必须在**一处**：多处各判一次 ⇒ 条件漂移 ⇒ 同一时刻出现两条连接。
 */
function evaluateConnection(): void {
  const shared = sharedSubscription
  const degraded = shared?.status().degraded ?? false
  const allowed =
    shouldOpenConnection({
      degraded,
      isLeader: shared?.isLeader() ?? true,
      visible: isTabVisible(),
    }) && holdsGlobalSseSlot()
  if (allowed) {
    // ⛔ 只在真的没有连接时开：`start()` 会掐旧流重开，重复调用 ⇒ 连接抖动。
    if (followUpTail.getState() === 'idle') void followUpTail.start()
  } else {
    // 让出 leader / 槽位 / 变隐藏 ⇒ 掐掉本标签页的连接
    followUpTail.abort()
  }
}

/** 取（并启动）全局槽位订阅。 */
function ensureSseSlotSubscription(): SharedSubscription | null {
  if (sseSlotSubscription) return sseSlotSubscription
  sseSlotSubscription = createSharedSubscription({
    // ⭐ 与 session/thread **无关**的固定频道名 ⇒ 所有标签页、所有画布共用一个槽位。
    channelName: 'lnkpi:agent-sse-slot',
    onEvent: () => {},
    onLeadership: () => {
      evaluateConnection()
    },
    onDegrade: () => {
      evaluateConnection()
    },
  })
  sseSlotSubscription.start()
  sseSlotSubscription.setVisible(isTabVisible())
  return sseSlotSubscription
}

/** 取（或按会话/线程重建）共享订阅。 */
function ensureSharedSubscription(): SharedSubscription | null {
  const name = `lnkpi:agent-sub:${props.sessionId}:${agentThreadId.value}`
  if (sharedSubscription && sharedChannelName === name) return sharedSubscription
  // 会话/线程变了 ⇒ 换频道（不同 threadId 是不同的事实源）
  sharedSubscription?.stop()
  // ⭐⭐ 2026-10-26 生产取证修复：**换频道时必须掐掉旧连接**。
  //
  // 事故形态：同一画布页因 threadId 抖动（bootstrap 解析线程）先后开出 6 条
  //   `/api/agent/runs/events`，全部被服务端挂住（6 = Chrome 同源连接上限）
  //   ⇒ 画布数据请求 `GET /api/sessions/<id>` 排不上 ⇒ **画布显示为空**；
  //     首页 `canvas/list` 15s 超时 ⇒「项目加载失败 · 重试」。
  //
  // 旧代码只 `stop()` 了共享频道，**没掐订阅连接** ⇒ 旧 thread 的 SSE 一直挂着。
  // ⇒ 这里显式 abort：换事实源 ⇒ 旧事实源的连接必须立刻归零。
  followUpTail.abort()
  sharedChannelName = name
  sharedSubscription = createSharedSubscription({
    channelName: name,
    onEvent: (ev: SharedEvent) => {
      if (ev.kind === 'text_delta') applyTextDelta(ev.text)
      else if (ev.kind === 'canvas_action') applyCanvasAction(ev.data)
      else applyTurnEnd()
    },
    onLeadership: () => {
      // ⛔ 只有「该开连接的人」才开：follower / 隐藏页都不得自己开
      //   （follower 开 ⇒ 回到「N 标签页 N 条连接」的病态）。
      //   ⇒ 判定统一走 evaluateConnection()（会话 leader + 全局槽位 + 可见性 三者与）。
      evaluateConnection()
    },
    onDegrade: () => {
      // 无 BroadcastChannel ⇒ 各自订阅（= 改动前行为）
      evaluateConnection()
    },
  })
  sharedSubscription.start()
  sharedSubscription.setVisible(isTabVisible())
  return sharedSubscription
}

const followUpTail = createFollowUpTailListener({
  fetchImpl: (url, init) => fetch(url, init),
  headers: () => authHeaders(),
  // 每次连接时求值：threadId 可能在会话中途切换（重跑 fork 出新线程）
  baseUrl: () =>
    apiUrl(
      `/api/agent/runs/events?sessionId=${encodeURIComponent(props.sessionId)}&threadId=${encodeURIComponent(agentThreadId.value)}`,
    ),
  onTextDelta: (text) => {
    applyTextDelta(text)
    // 转发给其他标签页（leader 才有连接 ⇒ follower 才能看到同一段）
    sharedSubscription?.broadcast({ kind: 'text_delta', text })
  },
  onCanvasAction: (data) => {
    applyCanvasAction(data)
    sharedSubscription?.broadcast({ kind: 'canvas_action', data })
  },
  onTurnEnd: () => {
    applyTurnEnd()
    sharedSubscription?.broadcast({ kind: 'turn_end' })
  },
})

/** 订阅当前会话（幂等：内部先 abort 旧流）。 */
function listenFollowUpTail(): Promise<void> {
  // 未登录不订阅：订阅必须带鉴权头，没 token 时请求只会拿到 401，并连带一轮
  // 无意义的退避重连。守卫放在**入口**（而非各调用点）⇒ 挂载 / 切会话 / 可见性恢复全覆盖。
  if (!hasAuthToken()) return Promise.resolve()
  // ⭐ 先参与全局槽位选举（跨标签页/跨画布只允许 1 条常驻订阅）。
  ensureSseSlotSubscription()
  const shared = ensureSharedSubscription()
  // 判定统一走一处（会话 leader + 全局槽位 + 可见性）。
  evaluateConnection()
  if (shared && !shared.status().degraded) {
    // 共享可用 ⇒ follower 在这里返回即可：它要的事件由 leader 转发过来。
    return Promise.resolve()
  }
  // 降级（无 BroadcastChannel）⇒ 各自订阅（= 改动前行为）
  return Promise.resolve()
}

/** 是否持有可用 token（与 `authHeaders` 同源口径）。 */
function hasAuthToken(): boolean {
  return Boolean(localStorage.getItem('token'))
}

/** 本端要自己发一轮了：先结束旁观轮，再停订阅（避免与主流双份消费）。 */
function releaseObserverTurn(): void {
  if (!observerTurnActive.value) return
  observerTurnActive.value = false
  agent.finishStreaming()
}

/**
 * 可见性：前台恢复常驻订阅，**后台立刻释放**。
 *
 * ⭐ 2026-10-25：原实现只处理「切回前台」（resume），**从不释放后台订阅** ⇒
 *   每个后台标签页永久占着一条 SSE 长连接（常驻订阅断线 5s 封顶重连、永不放弃）。
 *   Chrome 对单个 host 只有 6 条 HTTP/1.1 连接，后台页一多、再叠加偶发的传输卡死，
 *   前台请求就全部排队饿死（项目抽屉「项目加载中」转不完的成因之一，同批取证）。
 *
 * 切回来不丢内容：`resume()` 带 `lastSeq` 游标续传，只补增量不重放（见
 * `follow-up-tail.ts`）；idle 直接挂、backoff 中跳过排队、健康流不打断。
 */
function onFollowUpTailVisibility(): void {
  const visible = isTabVisible()
  // 共享层：隐藏 ⇒ 让出 leader（不再占连接）；可见 ⇒ 重新参与选举（可能接管）。
  sharedSubscription?.setVisible(visible)
  // ⭐ 全局槽位同样要跟随可见性：隐藏页必须把唯一的订阅连接让给可见页。
  sseSlotSubscription?.setVisible(visible)
  // 策略本身在 `tail-visibility.ts`（依赖可注入 ⇒ 可单测），这里只做接线。
  applyTailVisibility({
    isVisible: () => visible,
    hasAuthToken,
    isMainStreamRunning: () => agent.isStreaming,
    resume: () => {
      // ⛔ 只有「该开连接的人」才 resume —— follower resume 会自己开一条连接 ⇒ 回到病态。
      const shared = sharedSubscription
      const shouldOpen = shared
        ? shouldOpenConnection({ degraded: shared.status().degraded, isLeader: shared.isLeader(), visible })
        : true
      if (!shouldOpen) return
      void followUpTail.resume()
    },
    abort: () => followUpTail.abort(),
  })
}

onMounted(() => {
  document.addEventListener('visibilitychange', onFollowUpTailVisibility)
  // 常驻订阅：打开会话就挂上，与「谁在说话」无关。
  // 本端正在跑主流时（`agent.isStreaming`）不挂——那份内容主流自己会给。
  // 后台标签页（例如「在新标签页打开」）不挂：看不见就不该占着连接，切回来再补。
  if (!agent.isStreaming && document.visibilityState === 'visible') void listenFollowUpTail()
})

// 会话 / 线程切换后重挂：订阅 URL 携带 threadId，线程变了旧流就在听错的对象。
watch(
  [() => props.sessionId, () => agentThreadId.value],
  () => {
    releaseObserverTurn()
    followUpTail.abort()
    if (!agent.isStreaming) void listenFollowUpTail()
  },
)

onUnmounted(() => {
  document.removeEventListener('visibilitychange', onFollowUpTailVisibility)
  // 共享层也要退（离开频道 + 释放 leader 身份）⇒ 别的标签页能立刻接管。
  sharedSubscription?.stop()
  sharedSubscription = null
  sharedChannelName = ''
  // ⭐ 退出全局槽位 ⇒ 别的标签页能立刻接管那条唯一的订阅连接。
  sseSlotSubscription?.stop()
  sseSlotSubscription = null
  followUpTail.abort()
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

/**
 * 流结束后用 DB 历史补齐最终文案。P1#11：以 thread-state 回合终态替代文本 snippet 匹配。
 *
 * @param maxPolls 终态轮询次数上限（默认 `RECONCILE_MAX_POLLS`）。
 *   旁观端传 `0`：那一轮在**另一端**已经跑完（收到 done 才走到这里），
 *   没必要再等终态，拉一次权威历史纠正漏帧即可（多端场景下一等就是几分钟的睡循环）。
 */
async function reconcileLatestAssistant(maxPolls = RECONCILE_MAX_POLLS) {
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
    for (let i = 0; i < maxPolls; i++) {
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

/** 故障卡片 id（请求失败分流 + 恢复时显式清掉） */
const REQUEST_FAILED_ID = 'request-failed'
/** 初始 fetch 连接级错误的最大尝试次数（含 1 次静默自动重试） */
const CONVERSATION_FETCH_MAX_ATTEMPTS = 2
/** 上一轮是否以失败告终（供「恢复后自动续跑」判定） */
const lastTurnFailed = ref(false)
/** 本轮用户原文（失败卡「重试」复用，避免让用户重打） */
const lastSentMessage = ref('')

/**
 * 失败卡「重试」：复用上一轮用户原文重发。幂等键已保证重试不重复扣积分；
 * isRetry 跳过重复落 user 气泡，做到「续跑而非重发」。
 */
function retryLastTurn() {
  const msg = lastSentMessage.value
  if (!msg) return
  dockNotice.dismiss(REQUEST_FAILED_ID)
  void sendMessage(msg, undefined, true)
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
      }
      if (d.status === 'resolved' || !d.toolName) {
        // ⭐ 2026-10-17 生产复测发现（PR #449 伴生）：resolved 只清状态行位、没喂时间线，
        // 时间线 notice 永远停在「等待…」翻不成「已继续执行」（模型层 applyTimelineEvent 的
        // resolved upsert 契约存在但没人调用）。补喂 resolved；`!d.toolName`（无状态清位）
        // 不喂——喂了会被 applyTimelineEvent 当 waiting 重新 upsert，反把 notice 复活。
        if (d.status === 'resolved') {
          agent.trackWaitingUser({ status: 'resolved', toolName: d.toolName })
        }
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
        // P1：waiting_user → TurnTimeline 单一真相（flag 关闭时 feedTimeline 内短路，零成本）。
        // 根治规格 2026-10-28：propose_generation 经此 upsert 时间线 `proposal` part（稳定
        // id = callId/nodeId），状态行与对话流内联卡同源读它。callId/timeoutMs 透传以保
        // part 稳定 id 与倒计时准确（缺省回落 300_000）。
        agent.trackWaitingUser({
          status: d.status,
          toolName: d.toolName,
          nodeId: d.nodeId,
          callId: d.callId,
          timeoutMs: d.timeoutMs,
          reason: d.reason,
        })
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
        const card = cmd as { callId?: string; questions?: Array<Omit<(typeof pendingAskUser.value)[number], 'callId'>> }
        if (card.questions?.length) {
          // 根治规格（2026-10-28）：题面同时进时间线 question part（单一真相，状态行/内联卡同源）
          // 与组件级 pendingAskUser ref（现有 AskUserCard 仍读它，待迁移到读 part）。
          agent.trackAskUser({ callId: card.callId, questions: card.questions as never })
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
  // 画布状态 → 时间线产物回填（2026-10-17 第二通道）。
  // ⚠️ 必须在 taskProgress 早退**之前**：propose 单发等无 task 事件的流程
  // taskProgress.items 为空，但节点终态只在画布对账处可见。
  // 口径复用 mapNodeStatus（W11「有正据才动」）：无 url/内容/明确状态值的节点
  // （含未确认的 propose 节点）保持原状，不会被误翻 done。
  // 归属预筛：先收集时间线已持有的 artifact nodeId，避免对用户手建节点做全量消息回填空转。
  if (rawNodes.length) {
    const owned = new Set<string>()
    for (const m of agent.messages) {
      if (m.role !== 'assistant' || !m.timeline) continue
      for (const p of m.timeline.parts) {
        if (p.kind === 'artifact') owned.add(p.nodeId)
      }
    }
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
  newAgentSession,
  openThreadHistory,
  closeThreadHistory,
  openPanel,
  closePanel,
  setComposerInput,
  addAttachment,
  reconcileFromNodes,
  /** L1：画布/dock 点生成时显式确认 propose 等待（answered），不再靠 SSOT 时序推断 */
  confirmProposeWait,
  /** ADR-0011 T1：画布节点内联确认面的取消入口（与时间线内联卡同源同语义） */
  cancelProposeForNode,
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
              @click="selectThread(thread.id); closeThreadHistory()"
            >
              <span class="block truncate text-xs font-medium">{{ thread.title }}</span>
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
            },
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

          <!-- 全局传送门已退役（2026-10-18 IA v3）：门入底部页签「画布」（章鱼+光环固定位），
               模式切换 = 页签切换；旧顶栏门/浮动锚随之删除。
               「← 对话」pill 更早退役（门职责收编）。拾取模式让位（pick bar 自带回程）。 -->
          <!-- 顶栏：logo + 新建 / 历史 / 浮窗切换 / 收起（浮窗模式可按住拖动）。
               P1-5 fix-1：移动端保留（新建对话 / 会话历史入口随贴底容器常驻，
               收起 / 浮窗为桌面专属按钮移动端隐藏；startDrag 移动端本身 no-op） -->
          <div
            class="agent-panel-header flex items-center justify-between px-3 py-2"
            :class="floating && !isMobileLayout ? 'cursor-move' : ''"
            @mousedown="startDrag"
          >
            <div class="flex min-w-0 items-center gap-2">
              <!-- 顶栏传送门已退役（IA v3）：门入底部页签；移动端顶栏由 MobileTopBar 接管，
                   本 header 在移动端 CSS 隐藏（.agent-panel-mobile-dock .agent-panel-header）。
                   桌面端维持纯 logo。 -->
              <NeoAgentLogo size="xs" active />
              <!-- 移动端「传送门」（2026-10-15 移动端重构）：头像即品牌 logo，不再重复「lnk·π agent」文字 -->
              <p v-if="!isMobileLayout" class="agent-subtitle truncate text-[11px]">lnk·π agent</p>
            </div>
            <div class="flex items-center gap-0.5">
              <!-- 规格 §6.8 / ADR-0015：桌面侧栏头部不再放「新对话 / 历史」入口
                   （统一单对话模型，新建/切换对话收口到创作空间列表与移动端顶栏）；
                   仅保留浮动窗口切换与「收起助手」。 -->

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
                  @click="pickImage"
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
                @click="onUserBubbleClick(msg)"
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
                  @confirm-proposal="onInlineConfirmProposal($event)"
                  @cancel-proposal="onInlineCancelProposal($event)"
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
              @confirm-proposal="onInlineConfirmProposal($event)"
              @cancel-proposal="onInlineCancelProposal($event)"
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
               移动端 = 贴底容器内、裸条上方的系统层（阻塞交互贴条可达）。
               2026-10-21 根治（决策 C）：整层包进 .agent-system-layer 容器——画布视图默认全隐，
               白名单放行取代逐卡登记（病史：状态行 #496 / ask 卡+取消回执 #516 / 更早
               railHiddenByTab，三次漏登、每次都要真机截图才发现，失败模式静默）。
               ⚠️ 新增系统层卡片必须放进本容器：进层即默认安全（画布视图藏）；需要露头的
               显式加白名单类，漏放行 = 立刻可见的功能缺失，而非看不见的 bug。
               白名单两类：
                 canvas-always        已随对话流外浮卡下线退役（2026-10-28 根治规格：
                                      propose 决策点 = 时间线内联卡 + 画布节点内联面）
                 canvas-with-composer 跟随 composer 可见性（ask_user 卡：窗态显、imm/dock 收起）
                                      ——pending 期间 composer 自由文本一律按 answer 提交
                                      （spec §5.3），输入面与阻塞问题永不分离。 -->
          <div class="agent-system-layer">
            <!-- 根治规格（2026-10-28）：对话流外浮卡已移除——「提议生成」决策点改为时间线内联
                 proposal part（见 AgentTurnTimeline.vue），与画布节点 ProposeConfirmOverlay、底部状态行
                 同读一份单一真相。桌面 = 对话流内联卡；移动端画布视图 = 节点内联面；状态行 ambient 播报。 -->
            <!-- P1-3.1 双显修复（T8 review 裁决）：流式 running 态由 composer-status-line
                 独占播报；本行只保留 waiting / failed / settled 态，避免阶段+积分双重显示 -->
            <!-- 2026-10-20：settled 收口态可 dismiss（气泡摘要保留同源落点）；dismiss 后
                 仅本轮隐藏，新回合 / 新一轮结算自动复位（见 settledDismissed watch） -->
            <p
              v-if="turnStatus && !(agent.isStreaming && turnStatus.mode === 'running') && !(turnStatus.mode === 'settled' && settledDismissed)"
              class="agent-turn-status mx-0.5 mb-1 text-[11px]"
              :class="`agent-turn-status--${turnStatus.mode}`"
              data-testid="turn-status-line"
            >
              {{ turnStatus.text }}
              <span v-if="turnStatus.hint" class="ml-1 opacity-70">{{ turnStatus.hint }}</span>
              <button
                v-if="turnStatus.mode === 'settled'"
                type="button"
                class="agent-turn-status-dismiss"
                aria-label="隐藏结算信息"
                data-testid="turn-status-dismiss"
                @click="settledDismissed = true"
              >×</button>
            </p>
            <!-- ask_user 卡片贴 composer（2026-10-14，P1-5 移出 chat-wrap）：等待态的唯一交互面贴输入框；
                 pendingAskUser 是 live-only 状态（提交/取消即清），无历史持久化诉求。
                 2026-10-21：卡片经白名单类 .canvas-with-composer 跟随 composer 可见性——窗态显
                 （与输入面同屏，杜绝「对着看不见的问题打字」），imm / studio-dock 收起。 -->
            <AskUserCard
              v-if="pendingAskUser.length && lastMessageIsAssistant"
              class="mx-0.5 mb-2 canvas-with-composer"
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
                    <button type="button" class="queued-act queued-act--primary" @click="deliverQueued('steer', slot)">
                      ⏵ 立即插话{{ pendingAskBlocking ? '（答完这张卡后接）' : '' }}
                    </button>
                    <button type="button" class="queued-act" @click="deliverQueued('followup', slot)">
                      🕒 等它跑完再说
                    </button>
                    <button type="button" class="queued-act" @click="requeueQueued(slot)">✎ 取回内容</button>
                    <button type="button" class="queued-act" @click="dismissQueued(slot)">🗑 放弃</button>
                  </template>
                  <template v-else>
                    <button v-if="slot.state === 'failed'" type="button" class="queued-act queued-act--primary" @click="requeueQueued(slot)">
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
                      @click="withdrawQueued(slot)"
                    >
                      ↩︎ 撤回
                    </button>
                    <button type="button" class="queued-act" @click="dismissQueued(slot)">
                      {{ slot.state === 'accepted' || slot.state === 'applied' ? '知道了' : '放弃' }}
                    </button>
                  </template>
                </div>
              </div>
              </template>
              <!-- P1-5 移动端底部裸条（三态共条）：
                   本容器桌面端 display:contents（dock 内布局零改动）；移动端成为贴底裸条表面，
                   内部经 CSS 摊平为 [芯片行?][＋/文本/模型⌄/发送]。系统层（composer-status-line /
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
                  v-if="pendingAttachmentItems.length"
                  class="agent-composer__refs"
                  :items="pendingAttachmentItems"
                  :removable="true"
                  @remove="sidebar.remove"
                  @mention="insertRefMention"
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
                  :mentions="mentionOptions"
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
                @change="onFileChange"
              >
              <input
                ref="cameraInputRef"
                type="file"
                class="sr-only"
                accept="image/*"
                capture="environment"
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
                          @click="pickCamera"
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
                          @click="pickImage"
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
                          @click="pickFile"
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
                          @click="pickAssetLibrary"
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
                    :generating="agent.isStreaming && !composerDraftText"
                    :disabled="isUploading || (!agent.isStreaming && !canSubmitComposer)"
                    :title="agent.isStreaming ? (composerDraftText ? '发送插话' : '停止生成') : 'Enter 发送 · Shift+Enter 换行'"
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
  bottom: var(--lnk-tabbar-h, 0px);
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
 * 白名单两类（特异性均压过容器规则）：
 *   canvas-always        已随对话流外浮卡下线退役（2026-10-28 根治规格：propose 决策点
 *                         = 时间线内联卡 + 画布节点内联面，画布视图无需再放行浮卡）。
 *                         ⚠️ 勿复活：往系统层加新常显卡须重新立白名单类 + 守卫测试。
 *   canvas-with-composer 跟随 composer：ask_user 卡（阻塞交互面）。窗态显——
 *                         pending 期间 composer 自由文本一律按 answer 提交（spec §5.3），
 *                         输入面与阻塞问题永不分离；imm / studio-dock 随 composer 收起。
 * 播报式 chrome（收口状态行 / 取消回执卡）不放行：画布视图全藏（#496/#516 行为不变）。 */
.agent-panel-mobile-dock.is-canvas-view .agent-system-layer {
  display: none;
}
.agent-panel-mobile-dock.is-canvas-view:not(.is-canvas-imm):not(.has-studio-dock) .agent-system-layer > .canvas-with-composer {
  display: block;
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

/* ---- P1 回合状态行 ---- */
.agent-turn-status {
  color: var(--lnk-text-muted);
  display: flex;
  align-items: center;
}

.agent-turn-status--failed {
  color: #fca5a5;
}

.agent-turn-status--waiting {
  color: var(--lnk-text-secondary);
}

/* 2026-10-20：settled 收口态的 dismiss 入口——结算信息已在气泡同源落点，状态行可隐藏 */
.agent-turn-status-dismiss {
  margin-left: 4px;
  padding: 0 2px;
  font-size: 14px;
  line-height: 1;
  color: var(--lnk-text-muted);
  border: none;
  background: transparent;
  cursor: pointer;
  transition: color 0.12s ease;
}

.agent-turn-status-dismiss:hover {
  color: var(--lnk-text-primary);
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
  z-index: 25;
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
  background: color-mix(in srgb, var(--lnk-text-muted) 60%, var(--lnk-surface-base));
  color: var(--lnk-hi-text);
  box-shadow: var(--lnk-shadow-xs);
  transform: translate(-65%, -65%);
  transition:
    color var(--lnk-duration-fast) var(--lnk-ease-standard),
    background-color var(--lnk-duration-fast) var(--lnk-ease-standard);
  cursor: pointer;
}

/* 激活（pick 模式）= 点亮：hi-bg 盘 + hi-text glyph + hi-shadow 辉光 */
.composer-canvas-ref-btn.is-active {
  background: var(--lnk-hi-bg);
  color: var(--lnk-hi-text);
  box-shadow: var(--lnk-hi-shadow);
}

.composer-canvas-ref-btn:hover {
  filter: brightness(1.08);
}

.composer-canvas-ref-btn.is-active:hover {
  filter: brightness(1.06);
}

/* 2026-10-18 真机反馈：移动端 -65% 偏离顶点太远——圆心与裸条左顶点重合（半露）；
 * PC 端维持 -65%（「顶点长锚角」观感）不变。
 * 2026-10-19 真机反馈②：composer full-bleed 后顶点距屏缘仅 12px，-50% 圆心让圆左缘
 * 距屏 1px——曲面屏上「溢出屏幕」观感。left:4px 把圆心内移到距屏 17px（圆左缘 6px），
 * 垂直仍骑缝在条顶边（半露进流区，dock overflow:visible 不裁切）。
 * ⭐ 必须排在基础规则之后：canvasRefEntry 契约测试用首个 `.{类名}{` 正则取幽灵态规则，
 *   覆盖规则在前会被误当基础规则（transform-only）而假红。 */
.agent-panel-mobile-dock .composer-canvas-ref-btn {
  left: 4px;
  transform: translate(-50%, -50%);
}

/* 定位锚 glyph（2026-10-26 用户裁定④）：改**双色徽标**（黑盘 + 白锚 + 外环）。
 * ⛔ 不再走 mask：mask 会把徽标压成单一 currentColor，双色全丢 ⇒ 必须 <img> 原样出图。
 * 16px 落在 22px 的幽灵盘里 ⇒ 盘还留 ~3px 中灰圈边（读作「盘的边」，不是「第二个圆」）；
 * 徽标撑到盘的 73% ⇒ 与旧 20px 纯锚线条同视觉体量，不会退回「小图标」。
 * 高亮（pick 模式）仍由外层 .composer-canvas-ref-btn.is-active 的盘色承载——
 * 徽标本身是定色资产，不吃 currentColor（这与旧实现唯一的语义差别，已写进注释防回退）。 */
.composer-locate-glyph {
  display: block;
  width: 16px;
  height: 16px;
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

/* 提议生成卡片「定位」按钮的锚盘（2026-10-18）：与 composer ◎ 同款幽灵/点亮两态。
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

</style>
