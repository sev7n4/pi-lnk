<script setup lang="ts">
/**
 * P1 — TurnTimeline 渲染件（设计稿 §5-P1 / §10 D1-D2）。
 *
 * 渲染规则（设计 §4 规则 2/3）：无「执行过程」总折叠块，每个 part 独立渲染、按 parts 顺序
 * （= 事件到达序）。折叠粒度 = 单个 part。复用既有 presentToolStep / DockTypeIcon /
 * CanvasLocateButton，零新增设计令牌。
 *
 * - thinking：🧠 可折叠块（running 显示脉冲点）
 * - text：正文（whitespace-pre-wrap，无额外装饰）
 * - tool：icon + 动词·参数，展开看结果；failed 红色
 * - canvas：一行「🖼️ label」+ 定位
 * - artifact：紧凑卡（状态机 pending/running/done/failed），done 出缩略图，
 *   failed 出内联重试入口（D2）+ 错误文案；点击/定位复用现有画布能力
 * - notice：按 tone 着色；error 带重试按钮
 */
import { computed, inject, ref, shallowReactive, watch } from 'vue'
import DockTypeIcon from '@/components/canvas/dock-studio/shared/DockTypeIcon.vue'
import CanvasLocateButton from '@/components/shared/CanvasLocateButton.vue'
import AskUserCard from '@/components/agent/AskUserCard.vue'
import { presentToolStep } from '@/components/agent/toolPresentation'
import { useDisclosure } from '@/components/agent/useDisclosure'
import type { TimelinePart, ThinkingPart } from '@/components/agent/turnTimeline'
import {
  resolveProposalNodeData,
  proposalCreditCost,
  generationSettledCredit,
  type ProposalCanvasNode,
  type ProposalNodeData,
} from '@/composables/useProposalNodeData'
import { resolveModelDisplayName } from '@/utils/model-display'
import { tuneSheetOpen, tuneNodeId, openProposeTuneSheet } from './proposeWaitActions'
import { CANVAS_NODE_CANCEL_KEY, isViewableNodeType, MOBILE_NODE_OPEN_VIEWER_KEY } from '@/composables/canvasNodeActions'
import { deliveryCountLabel, hasRunningGeneration, turnDeliveryItems, type DeliveryItem } from '@/components/agent/deliverySummary'
import { observeDeliveryCard } from '@/components/agent/deliveryMetrics'
import ProposeTuneSheet from './ProposeTuneSheet.vue'

const props = defineProps<{
  parts: TimelinePart[]
  /** 画布节点 url 解析器（SideRail 由 canvasNodes 提供）；缺省=旧行为纯文本行 */
  resolveNodeUrl?: (nodeId: string) => string | undefined
  /**
   * 画布节点（vue-flow nodes 的结构化形状，由 SideRail 透传）：proposal 卡
   * 经 nodeId 纯解析出节点名/模型/比例/积分等决策信息。
   * 不读 store（ledger R1/R2：canvasEditor 是精修编辑器 store，不含画布节点）。
   */
  canvasNodes?: ProposalCanvasNode[] | null
  /**
   * P1a（2026-11-07）：会话级「画布总览」入口，由 SideRail 只对**最后一轮**传入。
   * 刻意不放进 deliveryItems ⇒ 不计入「查看本轮产物 · N」、不进撤销清单。
   */
  digestEntry?: DeliveryItem | null
  streaming?: boolean
  /**
   * P2-2：dense = 活体钉底（composer 上方）变体。**只调行密度与折叠默认值**，
   * 不改 parts 语义、不改顺序、不做截断——与历史气泡共用同一份渲染逻辑，
   * 消除「live dense trace vs history 气泡」两套组件导致(vii)的布局跳变（设计 §3 现象 5）。
   */
  dense?: boolean
}>()

const emit = defineEmits<{
  retryNode: [nodeId: string]
  focusNode: [nodeId: string]
  /** 根治规格（2026-10-28）：对话流内联 proposal 卡的确认 / 取消（取代对话流外浮卡）。 */
  confirmProposal: [nodeId: string]
  cancelProposal: [nodeId: string]
  /** 根治规格（2026-10-28）：对话流内联 question 卡的提交 / 取消（取代组件级 pendingAskUser ref）。 */
  askSubmit: [callId: string, payload: { answers: Record<string, string[]>; skipped?: string[] }]
  askCancel: [callId: string]
  /** D1（2026-11-11）：中断 notice 的重试入口；SideRail 复用 sendMessage(..., isRetry=true) 续跑。 */
  retryTurn: []
}>()

const VIDEO_URL_RE = /\.(mp4|webm|mov)(\?|$)/i
/** 音频扩展名：音频 url 不能塞 <img>（裂图），回退 DockTypeIcon 类型图标。 */
const AUDIO_URL_RE = /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i

function isVideoUrl(url: string): boolean {
  return VIDEO_URL_RE.test(url)
}

function isAudioUrl(url: string): boolean {
  return AUDIO_URL_RE.test(url)
}

/**
 * 2026-10-14（生产实证）：模型会在两段文本之间吐 3+ 连续换行（本例 11 个），
 * whitespace-pre-wrap 原样渲染成大块空白。渲染层折叠 3+ 换行为空行（保留段落间距语义）。
 */
function collapseBlankRuns(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n')
}

function toolLabel(p: Extract<TimelinePart, { kind: 'tool' }>): string {
  const shown = presentToolStep({
    label: p.toolName,
    kind: 'tool',
    status: p.status,
    meta: { toolName: p.toolName, args: p.args },
  })
  return shown.label
}
function toolIcon(p: Extract<TimelinePart, { kind: 'tool' }>): string {
  const shown = presentToolStep({ label: p.toolName, kind: 'tool', meta: { toolName: p.toolName, args: p.args } })
  return shown.icon
}

function artifactUrl(p: Extract<TimelinePart, { kind: 'artifact' }>): string | undefined {
  // 2026-10-17（晚到回填体验补全）：优先用事件/轮询回填**直存**的 part.url ——
  // 回合流关闭后完成的生成，画布节点可能尚未同步/已换页，resolveNodeUrl
  // （画布节点查找）拿不到；直存 url 才能让缩略图稳定出现。查找只作兜底。
  if (typeof p.url === 'string' && p.url) return p.url
  const url = props.resolveNodeUrl?.(p.nodeId)
  return typeof url === 'string' && url ? url : undefined
}

/** 生成等待时长后缀（2026-10-18 上游对齐）：progressElapsedMs 在位时出「 · Xm Ys」。
 *  进度拍 30s 一帧，分钟级生成下用户能看到活体计时而非永久的「生成中…」。 */
function elapsedLabel(p: Extract<TimelinePart, { kind: 'artifact' }>): string {
  const ms = p.progressElapsedMs
  if (p.status !== 'running' || typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '…'
  const totalSec = Math.round(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return min > 0 ? ` · ${min}m${String(sec).padStart(2, '0')}s` : ` · ${sec}s`
}

function onLocate(nodeId: string) {
  emit('focusNode', nodeId)
}
function onRetry(nodeId: string) {
  emit('retryNode', nodeId)
}
function onConfirmProposal(nodeId?: string) {
  if (nodeId) emit('confirmProposal', nodeId)
}
function onCancelProposal(nodeId?: string) {
  if (nodeId) emit('cancelProposal', nodeId)
}

/**
 * proposal 卡决策信息（2026-11-02 卡片 UX 优化）：经 canvasNodes 纯解析，
 * 无 store 依赖（ledger R1/R2）。节点找不到（换页/未同步）→ null=降级渲染，
 * 卡面仍保留标题占位与定位入口，不崩。
 */
function proposalData(nodeId?: string): ProposalNodeData | null {
  if (!nodeId) return null
  return resolveProposalNodeData(nodeId, props.canvasNodes)
}

/** 参数微调 Sheet（Task 3 在 SideRail 挂载；此处只负责开，不写回）。 */
function onOpenTune(nodeId?: string) {
  if (nodeId) openProposeTuneSheet(nodeId)
}

/**
 * 折叠判定（2026-11-02 PM 裁决）：confirmed 提议卡在同 nodeId 存在执行卡
 * （artifact running/done/failed）时塌缩为单行凭据——生成中用户只关心
 * 「生成得怎么样 / 能不能停」（执行卡承载），提议卡全量参数退为事后凭据
 * （完整参数仍可从「在画布查看节点」取得）；两卡同题同轨同屏读作渲染事故
 * （用户实测反馈「为什么会有两张卡片」）。纯呈现收敛，不改流程不变量。
 */
function proposalFolded(nodeId: string | undefined): boolean {
  if (!nodeId) return false
  return props.parts.some(
    (p) =>
      p.kind === 'artifact' &&
      p.nodeId === nodeId &&
      (p.status === 'running' || p.status === 'done' || p.status === 'failed'),
  )
}

/** 终态折叠行状态 pill 配色：confirmed=成功绿，declined/expired=中性灰。 */
function endStateClass(status?: string): string {
  return status === 'confirmed' ? 'ok' : 'cancel'
}

/** 终态文案（2026-10-31 教训：终态标签必须分流，不得一律显示「已确认」）。 */
function endStateLabel(status?: string): string {
  switch (status) {
    case 'confirmed':
      return '已落锚'
    case 'declined':
      return '已取消'
    case 'expired':
      return '已超时'
    default:
      return ''
  }
}

/**
 * artifact 卡停止生成（2026-11-02）：经 CanvasPage provide 的 cancelGeneration
 * （useNodeGeneration 同源）。SideRail 只挂在 CanvasPage 内，inject 正常可达；
 * null 兜底（独立渲染场景）= 不渲染停止钮而非报错。
 */
const cancelGeneration = inject(CANVAS_NODE_CANCEL_KEY, null)

/**
 * E2-a 回合产物幽灵摘要（规格 docs/superpowers/specs/2026-11-04-e2a-ghost-delivery-summary-design.md）：
 * 纯渲染期派生（deliverySummary.ts 纯函数），不新增 part kind、不落 executionEvents；
 * 展开态是组件本地 ref（Review Focus 1：禁写进 timeline）。
 * 显隐判据 D-b：N=0 / 存在 running artifact（回合进行中）⇒ 不渲染。
 */
const deliveryItems = computed(() => turnDeliveryItems(props.parts ?? [], props.canvasNodes))
const deliveryHidden = computed(
  () => deliveryItems.value.length === 0 || hasRunningGeneration(props.parts ?? []),
)
const deliveryExpanded = ref(false)

/** §6 打点：impression = 幽灵行首次可渲染即计（一次性，回合内不重复）。 */
const deliveryImpressionReported = ref(false)
watch(
  deliveryHidden,
  (hidden) => {
    if (!hidden && !deliveryImpressionReported.value) {
      deliveryImpressionReported.value = true
      observeDeliveryCard('impression')
    }
  },
  { immediate: true },
)

/** §6 打点：expand。 */
function onDeliveryToggle(): void {
  deliveryExpanded.value = !deliveryExpanded.value
  if (deliveryExpanded.value) observeDeliveryCard('expand')
}

/** D-c：viewer 打开经 CanvasPage provide（同 NodeRenderer 契约）；null 兜底=独立渲染场景降级定位。 */
const deliveryViewer = inject(MOBILE_NODE_OPEN_VIEWER_KEY, null)

/** 按 nodeId 从 canvasNodes 解析节点本体（data 与画布同源 ⇒ viewer 版本正确性同源）。 */
function deliveryViewerNodeOf(
  nodeId: string,
): { id: string; type: 'image' | 'video' | 'audio' | 'text'; data?: Record<string, unknown> } | undefined {
  const node = props.canvasNodes?.find((c) => c.id === nodeId)
  if (!node || !node.type || !isViewableNodeType(node.type)) return undefined
  return { id: node.id, type: node.type, data: node.data ?? undefined }
}

/** D-c 路由：viewer 解析+inject 命中 ⇒ 直开；否则（桌面/预览页/节点已删）定位兜底。
 *  D10（spec 2026-11-05-canvas-digest-design）：digest tile 命中 viewer ⇒ 追加 digest_open
 *  打点（总览价值准入判据；桌面降级 locate 不打——价值判据=viewer 消费）。 */
function onDeliveryTileOpen(item: { nodeId: string; digest?: true }): void {
  const node = deliveryViewerNodeOf(item.nodeId)
  if (node && deliveryViewer) {
    deliveryViewer(node)
    observeDeliveryCard('viewer_open', { nodeId: item.nodeId })
    if (item.digest) observeDeliveryCard('digest_open', { nodeId: item.nodeId })
  } else {
    onDeliveryLocate(item.nodeId)
  }
}

/** §6 打点：locate（tile 降级路径与定位角标共用）。 */
function onDeliveryLocate(nodeId: string): void {
  onLocate(nodeId)
  observeDeliveryCard('locate', { nodeId })
}

/** video 时长徽标（节点实况 durationMs，缺省隐藏——D-d）。 */
function deliveryDurationLabel(nodeId: string): string {
  const data = deliveryViewerNodeOf(nodeId)?.data
  const ms = data && typeof data.durationMs === 'number' ? data.durationMs : undefined
  if (!ms || ms <= 0) return ''
  const totalSec = Math.round(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return min > 0 ? `${min}:${String(sec).padStart(2, '0')}` : `0:${String(sec).padStart(2, '0')}`
}

/**
 * D-d 左下类型小字（2026-11-06 补齐）：tile 只按 nodeType 分图标时，
 * 纯文本 / HTML 产物 / 画布总览三者共用同一文档图标、点开后却分别是
 * 阅读器与沙箱预览，入口零提示。这里按 format / digest 派生可读类型名。
 * ⚠️ 纯派生自 DeliveryItem，不读节点正文、不做内容嗅探（文本节点规格 §4.2）。
 */
function deliveryTypeLabel(item: DeliveryItem): string {
  if (item.digest) return '总览'
  if (item.nodeType === 'text') return item.format === 'html' ? 'HTML' : '文本'
  if (item.nodeType === 'audio') return '音频'
  if (item.nodeType === 'video') return '视频'
  if (item.nodeType === 'image') return '图片'
  return ''
}

/** tile 缩略图地址：复用 artifactUrl（part.url 优先、resolveNodeUrl 兜底）。 */
function deliveryThumbOf(nodeId: string): string | undefined {
  const part = (props.parts ?? []).find(
    (p): p is Extract<TimelinePart, { kind: 'artifact' }> => p.kind === 'artifact' && p.nodeId === nodeId,
  )
  return part ? artifactUrl(part) : undefined
}

/**
 * 卡片积分 pill 权威取值（v2 单一真相源修复）：服务端 creditCost 优先，
 * 其余经 `GET /api/pricing/quote` 与计费同源读价目表（image:1K:1=33 而非旧常量 10）。
 * proposal 卡（预计/未扣减）与 artifact 卡（预扣/消耗）共用，杜绝两卡两口径。
 */
function proposalCredit(nodeId?: string): number | undefined {
  return proposalCreditCost(proposalData(nodeId))
}
function artifactCredit(nodeId: string): number | undefined {
  return proposalCredit(nodeId)
}

/**
 * quote→实耗 对账（规格 2026-11-03 §14.4）：credit_tx（generationId=节点
 * generationRecordId）到达后，卡片原位翻转「已结算 · 实耗 N 积分」；
 * 未到达/已退款（净额≥0）→ undefined，quote pill 照常。
 */
function settledActualCredit(nodeId?: string): number | undefined {
  return generationSettledCredit(proposalData(nodeId)?.generationRecordId)
}

/** C8：model chip 展示名映射——渠道前缀 key（platform::…）绝不原样透出。 */
function displayModelId(nodeId?: string): string {
  return resolveModelDisplayName(proposalData(nodeId)?.modelId)
}
function onAskSubmit(
  part: Extract<TimelinePart, { kind: 'question' }>,
  payload: { answers: Record<string, string[]>; skipped?: string[] },
) {
  if (part.callId) emit('askSubmit', part.callId, payload)
}
function onAskCancel(part: Extract<TimelinePart, { kind: 'question' }>) {
  if (part.callId) emit('askCancel', part.callId)
}

/** 流式中：最后一个「streaming 文本块」尾部显示光标，对齐旧正文的 ▊。 */
function isStreamingCursor(part: TimelinePart): boolean {
  if (!props.streaming) return false
  if (part.kind !== 'text' || part.status !== 'streaming') return false
  const last = props.parts[props.parts.length - 1]
  return last?.kind === 'text' && last.id === part.id
}

const toneClass = (tone: 'info' | 'warn' | 'error') =>
  tone === 'error'
    ? 'text-danger'
    : tone === 'warn'
      ? 'text-[var(--neo-text-secondary)]'
      : 'text-[var(--neo-text-muted)]'

const hasContent = computed(() => props.parts.length > 0)

/**
 * 思考块的折叠契约（2026-10-14）：用户意图优先于展示默认值。
 *
 * 每个 thinking part 持有**独立**的 disclosure 实例，按 part.id 缓存 —— 重建 parts
 * 数组（同 id）时复用同一实例，用户点过的选择因此能跨 patch 存活。
 *
 * ⚠️ 缓存键必须是 part.id 而非数组下标：parts 会随流式增长/重排，下标会错位。
 */
type Disclosure = ReturnType<typeof useDisclosure>

/**
 * 用 `shallowReactive` 而非 `reactive`：后者会**深度解包 ref**，
 * 使 Map 里存的对象变成 `{ isOpen: boolean }`（`.value` 消失、类型被改写）。
 * 这里要的就是「Map 本身可追踪、但内部实例保持原样」。
 */
const thinkingDisclosures = shallowReactive(new Map<string, Disclosure>())

/**
 * 思考块当前是否有流式快照（展示默认值的**唯一**响应式来源）。
 *
 * ⚠️ 必须从 `props.parts` 派生并保持响应式，不能在 `useDisclosure` 的回调里
 * 现查现算：那样 `getDefault` 的求值时机落在 computed 的依赖追踪之外，
 * parts 换新对象时结果不会被重算（CI 实测：running→done 后仍不自动收起）。
 * 抽成独立 computed 后，Vue 能把它记进依赖链，parts 变化即触发重算。
 */
function isRunningThinking(id: string): boolean {
  return props.parts.some((p) => p.kind === 'thinking' && p.id === id && p.status === 'running')
}

function disclosureFor(part: ThinkingPart): Disclosure {
  let d = thinkingDisclosures.get(part.id)
  if (!d) {
    // 默认值读响应式派生的 isRunningThinking —— 实时、且被 computed 正确追踪。
    // ⛔ 不可写成 `() => part.status === 'running'`：捕获首次渲染的 part 引用，
    // replay 用同 id 新对象替换旧 part 后默认值会锁死在旧 status 上（CI 实测踩过）。
    d = useDisclosure(() => isRunningThinking(part.id))
    thinkingDisclosures.set(part.id, d)
  }
  return d
}

function thinkingOpen(part: ThinkingPart): boolean {
  return disclosureFor(part).isOpen.value
}

function onThinkingToggle(part: ThinkingPart, nativeOpen: boolean): void {
  disclosureFor(part).onNativeToggle(nativeOpen)
}

/**
 * 2026-10-15（三滚动条治理 2/2）：dense 根的限高滚动**恢复**，但语境已完全不同——
 * live 态对话内容已移回 `.agent-chat-scroll` 主滚动流（dock 滚动容器整体删除），
 * 卡片自身的 `max-height + overflow-y` 现在是**唯一允许的内嵌滚动**
 * （用户口径「composer 上方只有思考消息流自带滚动条，其余是一整套页面」）。
 *
 * 历史脉络：1/2 曾删掉这道限高，因为当时它与 dock 外层 `.agent-dock-scroll--scrollable`
 * 构成两层嵌套滚动（流式回合三条竖直滚动条的第三条）；2/2 外层已不存在，
 * 卡片内滚不再嵌套，且是内容超长时的唯一防线。规则本体在 AgentSideRail.vue 的
 * `.agent-turn-timeline--dense`（限高 min(46vh,420px)），不在本组件——
 * 历史气泡内（非 dense）形态不加，跟随主滚动流。
 */

/** 容器：dense（活体钉底）收紧行距与字号；其余完全一致（同一套 parts 渲染）。 */
const rootClass = computed(() =>
  props.dense
    ? 'agent-turn-timeline agent-turn-timeline--dense flex flex-col gap-0.5 text-[10px] leading-snug'
    : 'agent-turn-timeline flex flex-col gap-1 text-[11px] leading-snug',
)
</script>

<template>
  <div v-if="hasContent" :class="rootClass">
    <template v-for="part in parts" :key="part.id">
      <!-- thinking：折叠契约（2026-10-14）——展示默认值（running 展开 / done 收起）仅在
           用户未表达意图时生效；用户点过后由 @toggle 记录意图，后续 patch 不再改写。
           ⛔ 不可写成 `<details :open="part.status === 'running'">`：那会把默认值当受控值，
           running 期间恒 true ⇒ 用户点了收起，下个 patch 就被强制弹回（生产反馈：收不回）。 -->
      <details
        v-if="part.kind === 'thinking'"
        class="group rounded border border-[var(--agent-assistant-divider)] bg-[var(--agent-assistant-bg-soft)] px-2 py-1"
        :open="thinkingOpen(part)"
        @toggle="onThinkingToggle(part, ($event.target as HTMLDetailsElement).open)"
      >
        <summary class="flex cursor-pointer items-center gap-1.5 text-[var(--neo-text-muted)]">
          <span>🧠</span>
          <span class="font-medium">{{ part.status === 'running' ? '思考中' : '思考' }}</span>
          <span
            v-if="part.status === 'running'"
            class="ml-auto inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--neo-text-muted)]"
          />
        </summary>
        <p
          class="mt-1 whitespace-pre-wrap text-[var(--neo-text-secondary)]"
        >{{ collapseBlankRuns(part.text) }}<span v-if="part.status === 'running'" class="animate-pulse">▊</span></p>
      </details>

      <!-- text：dense 不限行（2026-10-17）——原 line-clamp-3 让流式期间只看 3 行、
           收束后气泡接管才显全文，用户感知「整回合结束才一次性吐出」。dense 根本就有
           min(46vh,420px) 限高内滚（见下方 <style>），超长自行滚动，无需截断兜底。 -->
      <p
        v-else-if="part.kind === 'text'"
        class="whitespace-pre-wrap text-[var(--neo-fg)]"
      >{{ collapseBlankRuns(part.text) }}<span v-if="isStreamingCursor(part)" class="animate-pulse">▊</span></p>

      <!-- tool：有 resultSummary 才包 details（可展开看结果）；
           无摘要时渲染纯行——空 details 是「点了没内容」的死交互（2026-10-14 生产反馈） -->
      <div
        v-else-if="part.kind === 'tool'"
        class="rounded border border-[var(--agent-assistant-divider)] px-2 py-1"
        :class="part.status === 'failed' ? 'border-danger/40' : ''"
      >
        <details v-if="part.resultSummary">
          <summary class="flex cursor-pointer items-center gap-1.5">
            <span>{{ toolIcon(part) }}</span>
            <span :class="part.status === 'failed' ? 'text-danger' : 'text-[var(--neo-text-secondary)]'">{{ toolLabel(part) }}</span>
            <span
              v-if="part.status === 'running'"
              class="ml-auto inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--neo-text-muted)]"
            />
            <span v-else-if="part.status === 'done'" class="ml-auto text-[var(--neo-text-muted)]">✓</span>
            <span v-else-if="part.status === 'failed'" class="ml-auto text-danger">✗</span>
            <span v-else-if="part.status === 'interrupted'" class="ml-auto text-danger">⏹ 未收到结果</span>
          </summary>
          <p class="mt-1 whitespace-pre-wrap text-[10px] text-[var(--neo-text-muted)]">{{ part.resultSummary }}</p>
        </details>
        <div v-else class="flex items-center gap-1.5">
          <span>{{ toolIcon(part) }}</span>
          <span :class="part.status === 'failed' ? 'text-danger' : 'text-[var(--neo-text-secondary)]'">{{ toolLabel(part) }}</span>
          <span
            v-if="part.status === 'running'"
            class="ml-auto inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--neo-text-muted)]"
          />
          <span v-else-if="part.status === 'done'" class="ml-auto text-[var(--neo-text-muted)]">✓</span>
          <span v-else-if="part.status === 'failed'" class="ml-auto text-danger">✗</span>
          <span v-else-if="part.status === 'interrupted'" class="ml-auto text-danger">⏹ 未收到结果</span>
        </div>
      </div>

      <!-- canvas -->
      <div
        v-else-if="part.kind === 'canvas'"
        class="flex items-center gap-1.5 text-[var(--neo-text-muted)]"
      >
        <span>🖼️</span>
        <span>{{ part.label }}</span>
        <CanvasLocateButton
          v-if="part.nodeId"
          title="在画布中定位"
          @click="onLocate(part.nodeId!)"
        />
      </div>

      <!-- artifact（2026-11-02 卡片 UX 优化）：执行面在 artifact 卡——running 墨滴进度 +
           停止生成（CANVAS_NODE_CANCEL_KEY inject，null 兜底不渲染）+ 预扣积分 pill；
           done 查看结果↗ 回链 + 消耗积分 + 画布段点亮（end-canvas 转 success 绿）；
           failed 错误文案 + 重试（emit retryNode）+ 未扣减删除线。
           品牌三联轨道与 proposal 卡共用 <style> R-A 表（running=.55 / done=1 / failed=.5）。
           令牌纪律：一律 --lnk-*（R7：失败色 = --lnk-error，无 --lnk-danger）。 -->
      <div
        v-else-if="part.kind === 'artifact'"
        class="artifact-card rounded-md border bg-[var(--lnk-surface-raised)] px-2.5 py-2"
        :class="[
          part.status === 'failed' ? 'border-[var(--lnk-error-border)]' : 'border-[var(--lnk-border-default)]',
          `state-${part.status}`,
        ]"
        data-test="artifact-card"
      >
        <header class="flex items-center gap-1.5">
          <!-- 引领 glyph 随态变：running=锚(energy) / done=✓(success) / failed=⚠(error)；pending 回退类型图标 -->
          <span class="lead shrink-0" :class="`lead-${part.status}`" aria-hidden="true">
            <svg v-if="part.status === 'running'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/></svg>
            <svg v-else-if="part.status === 'done'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
            <svg v-else-if="part.status === 'failed'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
          </span>
          <DockTypeIcon v-if="part.status === 'pending'" :type="part.nodeType" :size="12" class="shrink-0 opacity-80" />
          <!-- 缩略图（2026-10-17 增强）：音频 url 不进 <img>/<video>（裂图），回退类型图标 -->
          <span
            v-if="part.status === 'done' && artifactUrl(part) && !isAudioUrl(artifactUrl(part)!)"
            class="relative block h-9 w-9 shrink-0 overflow-hidden rounded border border-[var(--lnk-border-subtle)]"
          >
            <video
              v-if="isVideoUrl(artifactUrl(part)!)"
              :src="`${artifactUrl(part)}#t=0.1`"
              muted
              preload="metadata"
              class="h-full w-full object-cover"
            />
            <img
              v-else
              :src="artifactUrl(part)"
              :alt="part.title"
              loading="lazy"
              class="h-full w-full object-cover"
            />
          </span>
          <span
            class="min-w-0 flex-1 truncate font-medium"
            :class="part.status === 'failed' ? 'text-[var(--lnk-error)]' : 'text-[var(--lnk-text-primary)]'"
          >{{ part.title }}</span>
          <span
            v-if="part.status === 'running' || part.status === 'pending'"
            class="shrink-0 text-[10px] text-[var(--lnk-text-muted)]"
            :class="part.status === 'running' ? 'animate-pulse' : ''"
          >{{ part.status === 'pending' ? '待确认' : `生成中${elapsedLabel(part)}` }}</span>
        </header>

        <!-- 品牌三联轨道（与 proposal 卡同构；--p 随 state-* 滑动）。
             running 态它就是唯一进度载体：不定态流光 trail + 锚作业脉冲
             （截图审查裁定：旧墨滴进度条与锚轨双进度冗余，2026-11-02 退役）。 -->
        <div class="trilink-rail" role="img" aria-label="品牌链条：对话 → 锚（滑动）→ 画布">
          <span class="end end-conv" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.4L3 21l2.1-5.5A8.5 8.5 0 1 1 21 11.5z"/></svg></span>
          <span class="track"><span class="trail"></span><span class="thumb" aria-hidden="true"></span></span>
          <span class="end end-canvas" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.8"/><rect x="14" y="14" width="7" height="7" rx="1.8"/><path d="M10 6.5h7.5V14"/></svg></span>
        </div>

        <!-- failed：错误文案 -->
        <p v-if="part.status === 'failed' && part.errorText" class="prompt-preview">{{ part.errorText }}</p>

        <div class="actions">
          <!-- running：停止生成（inject null 时不渲染）+ 预扣积分 -->
          <button
            v-if="part.status === 'running' && cancelGeneration"
            type="button"
            class="btn-stop"
            data-test="stop"
            @click="cancelGeneration(part.nodeId)"
          >停止生成</button>
          <span v-if="part.status === 'running' && artifactCredit(part.nodeId)" class="status-pill credit soft">预扣 {{ artifactCredit(part.nodeId) }} 积分</span>
          <!-- done：查看结果↗ 回链 + 消耗积分 -->
          <button
            v-if="part.status === 'done'"
            type="button"
            class="tether view-result"
            data-test="view-result"
            @click="onLocate(part.nodeId)"
          >查看结果 ↗</button>
          <span v-if="part.status === 'done' && settledActualCredit(part.nodeId)" class="status-pill credit" data-test="artifact-credit-settled">已结算 · 实耗 {{ settledActualCredit(part.nodeId) }} 积分</span>
          <span v-else-if="part.status === 'done' && artifactCredit(part.nodeId)" class="status-pill credit">消耗 {{ artifactCredit(part.nodeId) }} 积分</span>
          <!-- failed：重试 + 未扣减 -->
          <button
            v-if="part.status === 'failed'"
            type="button"
            class="btn-stop danger"
            data-test="retry"
            @click="onRetry(part.nodeId)"
          >重试生成</button>
          <span v-if="part.status === 'failed' && artifactCredit(part.nodeId)" class="status-pill credit">未扣减 <s>{{ artifactCredit(part.nodeId) }} 积分</s></span>
          <span v-else-if="part.status === 'failed'" class="status-pill credit struck">未扣减</span>
          <CanvasLocateButton
            v-if="part.status !== 'pending'"
            class="ml-auto"
            title="在画布中定位"
            @click="onLocate(part.nodeId)"
          />
        </div>
      </div>

      <!-- proposal（2026-11-02 卡片 UX 优化）：对话内决策中枢——标题取节点名、
           元信息（模型·比例·预计积分·张数）恒可见、提示词 1 行预览、
           三动作（落锚生成/调整/取消）+ 终态折叠行（未扣减删除线=积分诚实）。
           品牌三联叙事：锚 glyph + 「对话──锚(滑)──画布」轨道（--p 由根 state-* 驱动，
           一组 CSS 规则映射全部状态，见 <style> R-A 表）。
           令牌纪律：本分支为新增样式，一律 --lnk-* 语义令牌（neoUsageRatchet 全仓只减不增）。 -->
      <div
        v-else-if="part.kind === 'proposal'"
        class="proposal-card rounded-md border border-[var(--lnk-border-default)] bg-[var(--lnk-surface-raised)] px-2.5 py-2"
        :class="[`state-${part.status ?? 'pending_confirm'}`, { folded: part.status === 'confirmed' && proposalFolded(part.nodeId) }]"
        data-test="proposal-card"
      >
        <!-- 折叠单行凭据（执行卡在场时）：✓已落锚 + 节点名 + 画布回链。
             参数/轨道不重复渲染——执行卡是唯一活跃面（PM 裁决 2026-11-02）。 -->
        <div v-if="part.status === 'confirmed' && proposalFolded(part.nodeId)" class="genrow" data-test="proposal-folded">
          <span class="status-pill" :class="endStateClass(part.status)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
            {{ endStateLabel(part.status) }}
          </span>
          <span class="min-w-0 flex-1 truncate text-[11px] text-[var(--lnk-text-secondary)]">{{ proposalData(part.nodeId)?.title ?? '提议生成' }}</span>
          <button v-if="part.nodeId" type="button" class="tether" data-test="locate-link" @click="onLocate(part.nodeId)">
            <svg class="chain" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 12h6"/><path d="M11 5h5a4 4 0 0 1 0 8h-1"/><path d="M13 19H8a4 4 0 0 1 0-8h1"/></svg>
            在画布查看节点
          </button>
        </div>
        <template v-else>
        <header class="pc-head flex items-center gap-1.5">
          <!-- 锚 glyph=纯品牌装饰（定位收敛纪律 2026-11-02）：定位出口每卡一个，
               由页脚 tether 唯一承载；glyph 不再可点，避免同卡三入口。 -->
          <span v-if="part.nodeId" class="lead shrink-0">
            <!-- 2026-11-04 提议卡 4 点优化②：锚 glyph（纯装饰）→ 节点类型图标——
                 复用 artifact 卡同款 DockTypeIcon 内联 SVG（image/video/audio 24 网格
                 stroke 体系，零第三方图标库），用户一眼识别提议的产物类型。 -->
            <DockTypeIcon
              :type="proposalData(part.nodeId)?.nodeType ?? 'image'"
              :size="18"
              class="node-type-icon"
              data-test="node-type-icon"
            />
          </span>
          <div class="min-w-0 flex-1">
            <!-- 2026-11-04 4 点优化①：去掉「画布节点」眉标——卡片简化，标题只留节点名 -->
            <div class="name truncate font-medium text-[var(--lnk-text-primary)]">{{ proposalData(part.nodeId)?.title ?? '提议生成' }}</div>
          </div>
          <span
            v-if="part.status === 'pending_confirm'"
            class="ml-auto shrink-0 text-[10px] text-[var(--lnk-text-muted)]"
          >待确认</span>
        </header>

        <!-- 品牌三联轨道：对话(左端)──锚(滑)──画布(右端)；锚=进度拇指，位置由 state-* 经 --p 驱动 -->
        <div class="trilink-rail" role="img" aria-label="品牌链条：对话 → 锚（滑动）→ 画布">
          <span class="end end-conv" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.4L3 21l2.1-5.5A8.5 8.5 0 1 1 21 11.5z"/></svg></span>
          <span class="track"><span class="trail"></span><span class="thumb" aria-hidden="true"></span></span>
          <span class="end end-canvas" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.8"/><rect x="14" y="14" width="7" height="7" rx="1.8"/><path d="M10 6.5h7.5V14"/></svg></span>
        </div>

        <!-- 元信息（决策关键信息恒可见；积分 A-now 本地估算，C-later 服务端 creditCost 优先） -->
        <div v-if="proposalData(part.nodeId)" class="meta">
          <!-- §14.5-C9：模型名经展示名映射（渠道前缀 key 绝不透出） -->
          <span v-if="displayModelId(part.nodeId)" class="chip model">{{ displayModelId(part.nodeId) }}</span>
          <span v-if="proposalData(part.nodeId)!.aspectRatio" class="chip">{{ proposalData(part.nodeId)!.aspectRatio }}</span>
          <!-- 音频内联参数回执（2026-11-03 propose_inline_params）：台词段数/歌词字数/风格，
               用户确认前可见生成内容载体（与节点 data 同源，音频 dock 面板可改） -->
          <span v-if="proposalData(part.nodeId)!.audioScriptsSegments" class="chip">台词 {{ proposalData(part.nodeId)!.audioScriptsSegments }} 段</span>
          <span v-if="proposalData(part.nodeId)!.audioLyricsChars" class="chip">歌词 {{ proposalData(part.nodeId)!.audioLyricsChars }} 字</span>
          <span v-if="proposalData(part.nodeId)!.audioCaption" class="chip">{{ proposalData(part.nodeId)!.audioCaption }}</span>
          <span v-if="proposalData(part.nodeId)!.audioInstrumental" class="chip">纯音乐</span>
          <!-- 2026-11-04 4 点优化③：去「预计」字眼 →「⚡ 消耗 N 积分」+ 琥珀强调
              （--lnk-credit 唯一积分语义令牌；闪电 svg 与 DockCreditBadge 同语义）。
               金额仍走 proposalCredit（creditCost 服务端权威 → estimate* 兜底），不编造。 -->
          <!-- §14.5-C 卡片对账：credit_tx 实耗到达 → 原位翻转「已结算 · 实耗」（quote 为生成前预估） -->
          <span v-if="settledActualCredit(part.nodeId)" class="chip credit" data-test="credit-chip-settled">
            <svg class="bolt" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            已结算 · 实耗 {{ settledActualCredit(part.nodeId) }} 积分
          </span>
          <span v-else-if="proposalCredit(part.nodeId)" class="chip credit" data-test="credit-chip">
            <svg class="bolt" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            消耗 {{ proposalCredit(part.nodeId) }} 积分
          </span>
          <span v-if="proposalData(part.nodeId)!.imageCount > 1" class="chip">{{ proposalData(part.nodeId)!.imageCount }} 张</span>
        </div>

        <!-- 提示词：仅 1 行预览（证据，非决策控件） -->
        <p class="prompt-preview single-line" data-test="prompt-preview">{{ proposalData(part.nodeId)?.prompt || '—' }}</p>

        <!-- 三动作只 pending_confirm；终态折叠行（confirmed/declined/expired）
             ——declined/expired 显「未扣减」删除线（积分诚实：未发生扣费）。 -->
        <div v-if="part.status === 'pending_confirm'" class="actions">
          <button
            type="button"
            class="btn-primary"
            data-test="confirm"
            @click="onConfirmProposal(part.nodeId)"
          >落锚生成</button>
          <button
            type="button"
            class="icon-btn"
            data-test="tune"
            title="参数微调"
            aria-label="参数微调"
            @click="onOpenTune(part.nodeId)"
          ><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2.4"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="15" cy="17" r="2.4"/></svg></button>
          <button
            type="button"
            class="icon-btn"
            data-test="cancel"
            title="取消"
            aria-label="取消"
            @click="onCancelProposal(part.nodeId)"
          ><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg></button>
          <!-- 定位收敛纪律：决策行不排定位图标——出口由页脚 tether 唯一承载
               （同卡三入口治理 2026-11-02；artifact 卡不受此限，其 CanvasLocateButton 是唯一入口） -->
        </div>
        <div v-else class="genrow">
          <span class="status-pill" :class="endStateClass(part.status)">
            <!-- 图标随态分流（截图审查裁定）：confirmed=✓；declined=✕；expired=时钟——
                 超时/取消不是成功，不得复用对勾（2026-10-31 终态分流教训的图形版）。 -->
            <svg v-if="part.status === 'confirmed'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
            <svg v-else-if="part.status === 'declined'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
            {{ endStateLabel(part.status) }}
          </span>
          <!-- 积分诚实合并（截图审查裁定）：未扣减与金额一体（金额删除线），
               不再「预计 30 积分」chip 与「未扣减」pill 两处割裂；无金额时兜底纯文字。 -->
          <span v-if="part.status !== 'confirmed' && proposalCredit(part.nodeId)" class="status-pill credit">未扣减 <s>{{ proposalCredit(part.nodeId) }} 积分</s></span>
          <span v-else-if="part.status !== 'confirmed'" class="status-pill credit struck">未扣减</span>
        </div>

        <!-- 2026-11-04 4 点优化④：pending 态定位入口「显性化」——从纯弱文字升级为
             带边框/底色的次级按钮条（prominent），用户视觉上明确「这里是入口」；
             终态保持弱链接（执行卡才是活跃面，不再抢视觉）。定位出口仍每卡唯一
             （tether 承载，决策行不排定位图标——同卡三入口治理 2026-11-02 不变）。 -->
        <button
          v-if="part.nodeId"
          type="button"
          class="tether"
          :class="{ prominent: part.status === 'pending_confirm' }"
          data-test="locate-link"
          @click="onLocate(part.nodeId)"
        >
          <svg class="chain" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 12h6"/><path d="M11 5h5a4 4 0 0 1 0 8h-1"/><path d="M13 19H8a4 4 0 0 1 0-8h1"/></svg>
          在画布查看节点
        </button>
        </template>
      </div>

      <!-- question（根治规格 2026-10-28）：ask_user 等待态单一真相的内联决策点——题面 / 选项 /
           多选 / 其他 / 提交 / 取消都在对话流里（取代组件级 pendingAskUser ref 驱动的对话流外卡）。
           状态行与对话流内联卡读同一 part。令牌纪律同 proposal 分支：一律 --lnk-* 语义令牌。
           pending_answer 才出可操作卡；已作答/已跳过读只读小结，不重复渲染可点选项（与 proposal 分支同构）。 -->
      <div
        v-else-if="part.kind === 'question'"
        class="rounded border border-[var(--lnk-border-default)] px-2 py-1.5"
      >
        <AskUserCard
          v-if="part.status === 'pending_answer'"
          :questions="part.questions"
          @submit="onAskSubmit(part, $event)"
          @cancel="onAskCancel(part)"
        />
        <p
          v-else
          class="text-[10px] text-[var(--lnk-text-muted)]"
        >{{ part.status === 'answered' ? '已回答' : '已跳过' }}</p>
      </div>

      <!-- plan（P1-2 spec 2026-11-11 D4）：propose_plan 方案本体在对话流的持久存档——
           plan_proposed 事件派生（live 与 executionEvents 重放同源）。确认卡（question part
           内联 plan）是决策面；本 part 是方案存档：卡被回答/超时后仍可见，也是二期方案面板
           数据底座。令牌纪律同 question 分支：一律 --lnk-* 语义令牌（禁 hex/rgba 直引）。 -->
      <div
        v-else-if="part.kind === 'plan'"
        class="rounded border border-[var(--lnk-border-subtle)] bg-[var(--lnk-surface-sunken)] px-2.5 py-2"
        data-test="timeline-plan"
      >
        <div class="flex items-baseline gap-1.5">
          <span class="flex-none text-[10px] font-semibold uppercase tracking-wide text-[var(--lnk-text-secondary)]">方案</span>
          <span class="min-w-0 flex-1 text-xs font-semibold leading-snug text-[var(--lnk-text-primary)]">{{ part.summary }}</span>
        </div>
        <p v-if="part.explanation" class="mt-1 text-[10px] leading-relaxed text-[var(--lnk-text-secondary)]">{{ part.explanation }}</p>
        <ol class="mt-1.5 space-y-1">
          <li v-for="(step, i) in part.steps" :key="i" class="flex items-baseline gap-1.5">
            <span class="inline-flex h-4 w-4 flex-none items-center justify-center rounded-full bg-[var(--lnk-accent-subtle)] text-[10px] font-semibold tabular-nums text-[var(--lnk-accent-text)]">{{ i + 1 }}</span>
            <span class="min-w-0 flex-1 text-xs leading-snug text-[var(--lnk-text-primary)]">{{ step.content }}</span>
            <span v-if="step.activeForm" class="flex-none text-[10px] text-[var(--lnk-text-muted)]">{{ step.activeForm }}</span>
          </li>
        </ol>
      </div>

      <!-- notice -->
      <div
        v-else-if="part.kind === 'notice'"
        class="flex items-start gap-1.5"
        :class="toneClass(part.tone)"
      >
        <span class="shrink-0">{{ part.tone === 'error' ? '⚠' : part.tone === 'warn' ? '⏸' : '·' }}</span>
        <!-- 点⑤：detail 存在 ⇒ 原生 title 悬停承载详情（tokens breakdown），cursor-help 暗示可悬停 -->
        <span
          class="min-w-0 flex-1"
          :class="part.detail ? 'cursor-help' : ''"
          :title="part.detail"
        >
          {{ part.text }}
          <!-- D1：只有中断 notice（稳定 id）出可点重试；其余 notice 的 retryLabel 仍是纯文本提示，
               避免把「错误提示文案」误做成点不动/语义不明的按钮。 -->
          <button
            v-if="part.retryLabel && part.id === 'notice:turn-interrupted'"
            type="button"
            class="ml-1 underline"
            data-test="retry-turn"
            @click="emit('retryTurn')"
          >重试</button>
          <span v-else-if="part.retryLabel" class="ml-1 opacity-80">{{ part.retryLabel }}</span>
        </span>
      </div>
    </template>

    <!-- E2-a 回合产物幽灵摘要（规格 2026-11-04-e2a-ghost-delivery-summary §3）：
         收起 = tint 文本行 + chevron；展开 = 横向 64px tile 条（D-d 横滑，不推走对话流）。
         tile tap：viewer 解析+inject 命中 ⇒ 直开（一跳）；否则定位兜底（D-c）。
         定位角标独立命中区（::after 外扩 44px，E-d）。 -->
    <div v-if="!deliveryHidden" class="delivery-summary" data-test="delivery-summary">
      <button
        type="button"
        class="delivery-toggle"
        data-test="delivery-toggle"
        :aria-expanded="deliveryExpanded"
        @click="onDeliveryToggle"
      >
        查看本轮产物 · {{ deliveryCountLabel(deliveryItems.length) }}
        <svg
          class="chevron"
          :class="deliveryExpanded ? 'is-open' : ''"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        ><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <div v-if="deliveryExpanded" class="delivery-strip" data-test="delivery-strip">
        <div v-for="item in deliveryItems" :key="item.nodeId" class="delivery-tile-wrap">
          <button
            type="button"
            class="delivery-tile"
            :data-test="'delivery-tile-' + item.nodeId"
            :aria-label="'预览 ' + item.title"
            @click="onDeliveryTileOpen(item)"
          >
            <video
              v-if="deliveryThumbOf(item.nodeId) && item.nodeType === 'video'"
              :src="`${deliveryThumbOf(item.nodeId)}#t=0.1`"
              muted
              preload="metadata"
              class="tile-media"
            />
            <img
              v-else-if="deliveryThumbOf(item.nodeId)"
              :src="deliveryThumbOf(item.nodeId)"
              :alt="item.title"
              loading="lazy"
              class="tile-media"
            />
            <svg
              v-else-if="item.nodeType === 'audio'"
              class="tile-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              aria-hidden="true"
            ><path d="M4 12v0M8 8v8M12 5v14M16 9v6M20 11v2" /></svg>
            <!-- HTML 产物换网页/代码图标：与纯文本文档图标分叉（文本节点规格 §4.7 的入口提示） -->
            <svg
              v-else-if="item.nodeType === 'text' && item.format === 'html' && !item.digest"
              class="tile-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              data-testid="delivery-tile-icon-html"
            ><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" /></svg>
            <!-- 画布总览：系统产物单独一枚网格图标 -->
            <svg
              v-else-if="item.nodeType === 'text' && item.digest"
              class="tile-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              data-testid="delivery-tile-icon-digest"
            ><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
            <svg
              v-else-if="item.nodeType === 'text'"
              class="tile-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            ><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /><path d="M9 12h6M9 16h6" /></svg>
            <svg
              v-else
              class="tile-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            ><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M4.5 18.5 10 13l4 4 2.5-2.5 3 3" /></svg>
            <!-- D-d 左下类型小字：与右下时长徽标对称，补齐规格未落项 -->
            <span v-if="deliveryTypeLabel(item)" class="tile-type" data-testid="delivery-tile-type">{{ deliveryTypeLabel(item) }}</span>
            <span v-if="deliveryDurationLabel(item.nodeId)" class="duration">{{ deliveryDurationLabel(item.nodeId) }}</span>
          </button>
          <button
            type="button"
            class="delivery-locate"
            :data-test="'delivery-locate-' + item.nodeId"
            :aria-label="'在画布中定位 ' + item.title"
            @click.stop="onDeliveryLocate(item.nodeId)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- P1a（2026-11-07）画布总览：会话级单一入口，与本轮产物清单解耦。
         零产物回合也可渲染（用户仍能打开总览），但「查看本轮产物 · N」保持隐藏，
         且不由 SideRail 向历史回合传入 ⇒ 历史回合不会凭空多出一枚总览磁贴。
         复用 delivery-toggle 既有样式，零新增 token。 -->
    <button
      v-if="digestEntry"
      type="button"
      class="delivery-toggle"
      data-test="digest-entry"
      :aria-label="'打开 ' + digestEntry.title"
      @click="onDeliveryTileOpen(digestEntry)"
    >
      {{ digestEntry.title }} · 当前画布
    </button>

    <!-- R-C（2026-11-02 卡片 UX 优化）：参数微调 Sheet——挂载在 parts 循环外。
         「调整」入口（proposal 卡 data-test=tune）经 openProposeTuneSheet 置模块级 ref
         驱动显隐；「保存并确认」经本组件既有 confirmProposal emit 上行到 SideRail
         （confirmProposeWait，单执行入口不变量）；「在画布精修」经 focusNode 带向画布
         dock 既有写路径（R-B）。MobileSheet 自 teleport body，DOM 位置无关。 -->
    <ProposeTuneSheet
      :open="tuneSheetOpen"
      :node-id="tuneNodeId"
      :canvas-nodes="canvasNodes"
      @update:open="tuneSheetOpen = $event"
      @confirm-proposal="onConfirmProposal($event)"
      @refine-dock="onLocate($event)"
    />
  </div>
</template>

<style scoped>
/* 2026-10-15（三滚动条治理 2/2）：dense（live 活体）根的限高滚动——
 * 唯一允许的内嵌滚动（用户口径「composer 上方的对话内容是一整套页面，
 * 只有思考消息流自带滚动条」）。live 内容已入 .agent-chat-scroll 主滚动流，
 * 本规则是卡片内容超长时的唯一防线，不与任何外层滚动容器嵌套。
 * 历史气泡内（非 dense）不加：跟随主滚动流。规则放本组件而非父级 scoped，
 * 避免依赖「子组件根带父 scope attr」的隐式命中（换父即静默失效）。 */
.agent-turn-timeline--dense {
  max-height: min(46vh, 420px);
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* ============================================================
 * proposal 卡（2026-11-02 卡片 UX 优化）——对话内决策中枢
 * 令牌纪律：一律 --lnk-*；新增样式禁 --neo-*（neoUsageRatchet）。
 * ============================================================ */

/* 头部（2026-11-04 4 点优化①②）：眉标「画布节点」已去（卡片简化，标题=节点名）；
   锚 glyph 退役 → 节点类型图标（DockTypeIcon，随主题 currentColor） */
.node-type-icon {
  color: var(--lnk-text-secondary);
  flex: none;
}

/* —— 品牌三联轨道：对话(左端) ── 锚(滑动拇指) ── 画布(右端) —— */
.trilink-rail {
  --p: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 0 10px;
}
.trilink-rail .end {
  width: 20px;
  height: 20px;
  flex: none;
  display: grid;
  place-items: center;
  color: var(--lnk-text-muted);
  transition: color var(--lnk-duration-base) var(--lnk-ease-standard);
}
.trilink-rail .end svg {
  width: 18px;
  height: 18px;
  display: block;
}
.trilink-rail .track {
  position: relative;
  flex: 1;
  height: 20px;
  /* 锚 thumb 半宽 12px：两端各留 12px，p=0/1 时锚恰好贴住端点图标而不叠压 */
  margin: 0 12px;
}
.trilink-rail .track::before {
  content: '';
  position: absolute;
  inset: 50% 0 auto 0;
  height: 2px;
  transform: translateY(-50%);
  background: var(--lnk-border-subtle);
  border-radius: 2px;
}
.trilink-rail .trail {
  position: absolute;
  inset: 50% auto auto 0;
  height: 2px;
  width: calc(var(--p) * 100%);
  transform: translateY(-50%);
  /* 极简定稿（2026-11-02）：trail 一律中性灰，语义色只由 thumb 单点承载 */
  background: color-mix(in srgb, var(--lnk-text-primary) 32%, transparent);
  border-radius: 2px;
  transition: width 0.6s var(--lnk-ease-standard);
}
.trilink-rail .thumb {
  position: absolute;
  top: 50%;
  left: calc(var(--p) * 100%);
  width: 24px;
  height: 24px;
  transform: translate(-50%, -50%);
  /* 极简定稿：锚本体恒亮（text-primary），不用色——accent 只留给主钮与链接；
     语义色单点：done=success 绿、failed=error 红，仅此两处。 */
  color: var(--lnk-text-primary);
  /* 双层徽章（用户裁定：单色剪影丢了徽章的黑+白雕刻感）——
     底层盘 = anchor-badge-disc.png（alpha 阈值剪影）× currentColor 随态变色；
     上层雕纹 = anchor-badge-mask.png（亮度键控环+锚+翼饰）× 卡面色反向雕刻，
     合成「珐琅徽章钉在轨道」的两色实体感。两资产同出原图 256 画布，像素级对齐。 */
  background: currentColor;
  -webkit-mask: url('/brand/anchor-badge-disc.png') center / contain no-repeat;
  mask: url('/brand/anchor-badge-disc.png') center / contain no-repeat;
  transition: left 0.6s var(--lnk-ease-standard);
  filter: drop-shadow(0 1px 1px rgb(0 0 0 / 0.18));
}
.trilink-rail .thumb::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--lnk-surface-raised);
  -webkit-mask: url('/brand/anchor-badge-mask.png') center / contain no-repeat;
  mask: url('/brand/anchor-badge-mask.png') center / contain no-repeat;
}

/* R-A 状态 → 锚位置映射（proposal 段 + artifact 段共用本表，Task 2b 复用）：
 * pending_confirm 停对话端 0 → confirmed 起锚 ~18% → running 滑行 ~55%
 * → done 落定画布 100%（绿）；declined/expired 留对话端（暗）；failed 卡中途（红）。
 * 状态类挂在卡片根，无需逐卡内联。 */
.state-pending_confirm .trilink-rail { --p: 0; }
.state-confirmed .trilink-rail { --p: 0.18; }
.state-running .trilink-rail { --p: 0.55; }
.state-done .trilink-rail { --p: 1; }
.state-declined .trilink-rail,
.state-expired .trilink-rail { --p: 0; opacity: 0.5; }
.state-failed .trilink-rail { --p: 0.5; }
.state-done .end-canvas { color: var(--lnk-text-muted); }
.state-running .end-canvas { color: var(--lnk-text-secondary); }
.state-done .thumb { color: var(--lnk-success); animation: anchor-drop 0.5s var(--lnk-ease-standard); }
/* 极简定稿（2026-11-02）：语义色单点纪律——绿/红只出现在 thumb，
   trail/端点一律中性；done 不再全链点亮。终态凭据 thumb 熄灯 45%。 */
.state-confirmed .thumb,
.state-declined .thumb,
.state-expired .thumb { color: color-mix(in srgb, var(--lnk-text-primary) 45%, transparent); }
.state-failed .thumb { color: var(--lnk-error); animation: anchor-shake 0.45s var(--lnk-ease-standard); }
/* running：无真实进度数据 ⇒ 不定态诚实表达——trail 流光扫过 + 锚作业脉冲。
   墨滴进度条已退役（双进度冗余），锚轨即唯一进度载体。 */
.state-running .trilink-rail .trail {
  width: 34%;
  transition: none;
  animation: rail-flow 2.4s var(--lnk-ease-standard) infinite;
}
@keyframes rail-flow {
  0% { left: 0; opacity: 0; }
  18% { opacity: 1; }
  82% { opacity: 1; }
  100% { left: 66%; opacity: 0; }
}
.state-running .trilink-rail .thumb {
  animation: anchor-work 2.4s var(--lnk-ease-standard) infinite;
}
@keyframes anchor-work {
  0%, 100% { transform: translate(-50%, -50%) scale(1); }
  50% { transform: translate(-50%, -50%) scale(1.09); }
}
@keyframes anchor-drop {
  0% { transform: translate(-50%, -50%) scale(0.55); }
  60% { transform: translate(-50%, -50%) scale(1.18); }
  100% { transform: translate(-50%, -50%) scale(1); }
}
@keyframes anchor-shake {
  0%, 100% { margin-left: 0; }
  25% { margin-left: -3px; }
  75% { margin-left: 3px; }
}

/* —— 元信息 chips（模型·比例·积分·张数） —— */
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
}
.chip {
  font-size: var(--lnk-text-xs);
  color: var(--lnk-text-secondary);
  background: var(--lnk-surface-sunken);
  border: 1px solid var(--lnk-border-subtle);
  padding: 2px 8px;
  border-radius: var(--lnk-radius-full);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.chip.model { font-weight: var(--lnk-weight-semibold); } /* A-now 模型中性：不作成本主因强调 */
/* 2026-11-04 4 点优化③（推翻 2026-11-02「琥珀退役」极简定稿——用户裁决积分需琥珀强调）：
   pending 金额 chip 琥珀单点（--lnk-credit 唯一积分语义令牌 + 闪电 svg）；
   终态「未扣减」pill 保持中性（删除线已表达诚实语义，琥珀只标活跃成本位）。 */
.chip.credit {
  color: var(--lnk-credit);
  background: var(--lnk-surface-sunken);
  border: 1px solid var(--lnk-border-default);
}
.chip.credit .bolt {
  width: 11px;
  height: 11px;
  flex: none;
}
.status-pill.credit {
  color: var(--lnk-text-secondary);
  background: var(--lnk-surface-sunken);
  border: 1px solid var(--lnk-border-default);
}

/* —— 提示词：仅 1 行预览（证据，非决策控件） —— */
.prompt-preview {
  font-size: var(--lnk-text-xs);
  color: var(--lnk-text-secondary);
  line-height: var(--lnk-lh-sm);
  margin: 0 0 8px;
}
.prompt-preview.single-line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* —— 操作区：落锚生成（主钮）/ 调整 / 取消 ——
 * 触控纪律：钮高用 --lnk-touch-target(44px)，不用 mockup 桌面 40px（plan Task5 打磨项）。 */
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: var(--lnk-touch-target);
  padding: 0 16px;
  border-radius: var(--lnk-radius-md);
  font-size: var(--lnk-text-sm);
  font-weight: var(--lnk-weight-semibold);
  cursor: pointer;
  border: 1px solid transparent;
  background: var(--lnk-accent);
  color: var(--lnk-text-on-accent);
  /* 极简定稿：去 accent-glow，行动点靠位置与对比度表达，不靠光晕 */
  transition: all var(--lnk-duration-fast) var(--lnk-ease-standard);
}
.btn-primary:hover { background: var(--lnk-accent-hover); }
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  border-radius: var(--lnk-radius-md);
  cursor: pointer;
  border: 1px solid var(--lnk-border-default);
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-secondary);
  transition: all var(--lnk-duration-fast) var(--lnk-ease-standard);
}
.icon-btn:hover { border-color: var(--lnk-accent-border); color: var(--lnk-accent-text); }
.icon-btn svg { width: 16px; height: 16px; display: block; }
/* focus-visible 环（与 AskUserCard 同款；键盘可达性） */
.btn-primary:focus-visible,
.icon-btn:focus-visible,
.btn-stop:focus-visible,
.tether:focus-visible {
  outline: 2px solid var(--lnk-border-focus);
  outline-offset: 2px;
}

/* —— 终态折叠行（confirmed/declined/expired） —— */
.genrow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 0 6px;
}
/* 执行卡在场时 confirmed 提议卡塌缩为单行凭据：去掉 genrow 默认外距，
   让 slim 卡上下留白均衡（PM 裁决 2026-11-02）。 */
.proposal-card.folded .genrow { margin: 0; }
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--lnk-text-xs);
  font-weight: var(--lnk-weight-semibold);
  padding: 2px 9px;
  border-radius: var(--lnk-radius-full);
}
.status-pill svg { width: 12px; height: 12px; stroke: currentColor; fill: none; stroke-width: 2; }
.status-pill.ok {
  color: var(--lnk-success);
  background: var(--lnk-success-bg);
  border: 1px solid var(--lnk-success-border);
}
.status-pill.cancel {
  color: var(--lnk-text-muted);
  background: var(--lnk-surface-sunken);
  border: 1px solid var(--lnk-border-subtle);
}
.status-pill.struck { text-decoration: line-through; }

/* —— 定位弱链接（锚链拉拽微动） —— */
.tether {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  font-size: var(--lnk-text-xs);
  color: var(--lnk-text-muted);
  text-decoration: none;
}
.tether:hover { color: var(--lnk-accent-text); }
.tether svg.chain { width: 13px; height: 13px; }
.tether:hover svg.chain { animation: link-pull 0.5s var(--lnk-ease-standard); }
/* 2026-11-04 4 点优化④：pending 态显性化——弱文字 → 带边框次级按钮条，
   用户视觉上明确「这里是查看画布节点的入口」；触控目标 ≥ 32px（对话卡内非主操作，
   不强上 44px 主触控，与 icon-btn 同档）。 */
.tether.prominent {
  border: 1px solid var(--lnk-border-default);
  background: var(--lnk-surface-sunken);
  border-radius: var(--lnk-radius-full);
  padding: 5px 10px;
  color: var(--lnk-text-secondary);
  min-height: 32px;
  transition: color var(--lnk-duration-base) var(--lnk-ease-standard),
    border-color var(--lnk-duration-base) var(--lnk-ease-standard);
}
.tether.prominent:hover {
  color: var(--lnk-accent-text);
  border-color: var(--lnk-accent-border);
}
@keyframes link-pull {
  0% { transform: translateY(-2px); }
  50% { transform: translateY(1px); }
  100% { transform: translateY(0); }
}

/* —— artifact 卡（2026-11-02）：执行面 —— */
/* 引领 glyph（极简定稿：一律中性 secondary，每卡语义色只允许 thumb 单点） */
.lead { display: grid; place-items: center; width: 16px; height: 16px; color: var(--lnk-text-secondary); }
.lead svg { width: 16px; height: 16px; display: block; }

/* 停止 / 重试（次级实心钮；重试加 danger 红描边；44px 触控目标） */
.btn-stop {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: var(--lnk-touch-target);
  padding: 0 14px;
  border-radius: var(--lnk-radius-md);
  font-size: var(--lnk-text-xs);
  font-weight: var(--lnk-weight-semibold);
  cursor: pointer;
  border: 1px solid var(--lnk-border-default);
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-secondary);
  transition: all var(--lnk-duration-fast) var(--lnk-ease-standard);
}
.btn-stop:hover { border-color: var(--lnk-accent-border); color: var(--lnk-accent-text); }
.btn-stop.danger { border-color: var(--lnk-error-border); color: var(--lnk-error); }
.btn-stop.danger:hover { background: var(--lnk-error-bg); }

/* 查看结果↗（强调版锚链回链） */
.view-result { color: var(--lnk-accent-text); font-weight: var(--lnk-weight-semibold); }
.view-result:hover { color: var(--lnk-accent); }

/* 预扣积分 pill（半透明 soft 变体，与消耗 pill 区分） */
.status-pill.credit.soft { opacity: 0.75; }

/* 降低动态：锚瞬移 + 动效关闭，文字标签保真（A13） */
@media (prefers-reduced-motion: reduce) {
  .trilink-rail .trail,
  .trilink-rail .thumb,
  .trilink-rail .end { transition: none; }
  .state-done .thumb,
  .state-failed .thumb,
  .state-running .thumb { animation: none; }
  .state-running .trilink-rail .trail { animation: none; width: 55%; }
  .tether:hover svg.chain { animation: none; }
}

/* E2-A-DELIVERY-BEGIN — 回合产物幽灵摘要（E-d：仅 --lnk-* 令牌，零 hex；
   展开过渡 --lnk-duration-fast，reduced-motion 降级直切） */
.delivery-summary {
  margin-top: 6px;
}
.delivery-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: var(--lnk-touch-target);
  padding: 2px 0;
  border: none;
  background: transparent;
  font-size: 13px;
  color: var(--lnk-accent-text);
  cursor: pointer;
}
.delivery-toggle:hover {
  color: var(--lnk-accent);
}
.delivery-toggle .chevron {
  width: 12px;
  height: 12px;
  transition: transform var(--lnk-duration-fast) var(--lnk-ease-decelerate);
}
.delivery-toggle .chevron.is-open {
  transform: rotate(180deg);
}
.delivery-strip {
  display: flex;
  gap: 8px;
  /* Q3 裁切修复（2026-11-05）：overflow-x:auto 令 overflow-y 同为 auto，
     定位角标 top:-5px 上溢出 tile 会被滚动容器上沿裁掉——用头部 padding 预留
     角标空间（margin 换 padding：padding 在滚动内容盒内，不会被裁）。 */
  margin-top: 0;
  padding-top: 11px;
  padding-bottom: 2px;
  overflow-x: auto;
}
.delivery-tile-wrap {
  position: relative;
  flex-shrink: 0;
}
.delivery-tile {
  position: relative;
  display: block;
  width: 64px;
  height: 64px;
  padding: 0;
  border: 0.5px solid var(--lnk-border-default);
  border-radius: var(--lnk-control-sm);
  background: var(--lnk-surface-sunken);
  overflow: hidden;
  cursor: pointer;
}
.delivery-tile .tile-media {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.delivery-tile .tile-icon {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 26px;
  height: 26px;
  color: var(--lnk-text-muted);
}
.delivery-tile .duration {
  position: absolute;
  right: 4px;
  bottom: 3px;
  padding: 0 3px;
  border-radius: 4px;
  background: var(--lnk-hi-bg);
  font-size: 10px;
  color: var(--lnk-hi-text);
}
/* D-d 左下类型小字：与右下时长徽标对称，令牌同源（禁硬编码色） */
.delivery-tile .tile-type {
  position: absolute;
  left: 4px;
  bottom: 3px;
  padding: 0 3px;
  border-radius: 4px;
  background: var(--lnk-hi-bg);
  font-size: 10px;
  color: var(--lnk-hi-text);
}
.delivery-locate {
  position: absolute;
  top: -5px;
  right: -5px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0.5px solid var(--lnk-border-strong);
  border-radius: 50%;
  background: var(--lnk-hi-bg);
  color: var(--lnk-accent-text);
  cursor: pointer;
}
/* 命中区外扩 20px→44px（AgentSideRail mic 同款手法；只纵向收敛防压邻 tile） */
.delivery-locate::after {
  content: '';
  position: absolute;
  inset: -12px;
}
.delivery-locate svg {
  width: 11px;
  height: 11px;
}
@media (prefers-reduced-motion: reduce) {
  .delivery-toggle .chevron { transition: none; }
}
/* E2-A-DELIVERY-END */
</style>
