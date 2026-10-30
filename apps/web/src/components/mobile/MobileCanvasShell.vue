<script setup lang="ts">
/**
 * 移动端画布应用壳层（2026-10-20 PR5 / D-9）。
 *
 * 职责：移动端「全局导航 + 面板 + 状态 + 入口」的唯一所有者。把 CanvasPage 模板里
 * 散落的 isMobileLayout 分支（顶栏 / 页签 / 自动保存状态行 / 发现 / 我的 / 账号二级面板
 * / ＋FAB / 新建 sheet / 任务 sheet / 多选动作条）收敛到本壳层一处。
 *
 * 边界：
 * - 画布世界（VueFlow + 胶囊 MobileCanvasTopControls + 空态 mobile-canvas-empty）仍由
 *   CanvasPage 承载——胶囊包在 VueFlow 的 <Panel> 内、空态 absolute 在 canvasArea 内，
 *   依赖 VueFlow 内部定位，不能搬出。这两处 isMobileLayout 残留留待后续定位重构
 *   （已在 PR 描述标注）。
 * - 共享状态真源留在 CanvasPage（mobileAppTab / mobileCanvasView / mobileCanvasImm 被
 *   AgentSideRail、mobileStudioDockOpen、focusNodeById、pickMode watch 共用），壳层只
 *   接收并渲染；壳层通过 actions 函数 prop 触发 CanvasPage 核心逻辑，不回写共享状态。
 *   壳层只订阅它真正用到的状态（mobileAppTab）；view/imm 仍是 CanvasPage 内部状态。
 *
 * 本壳层自身只在 CanvasPage 的 `v-if="isMobileLayout"` 下渲染，内部不再判断断点。
 */
import { computed, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import type { MobileAppTab } from './MobileTabBar.vue'
import type { DockNodeType } from '@/components/canvas/NodePanelDock.vue'
import type { CanvasAssetItem } from '@/components/canvas/CanvasAssetPanel.vue'
// SP-F Q1：移动端连线可见性兜底（仅 ≤767px media query 内生效，桌面零影响）
import './MobileCanvasEdge.css'

import MobileTopBar from './MobileTopBar.vue'
import MobileTabBar from './MobileTabBar.vue'
import MobileSaveStatus from './MobileSaveStatus.vue'
import MobileNodeStatusBar from './MobileNodeStatusBar.vue'
import type { MobilePendingNode } from '@/composables/mobileNodeTaskSummary'
import DiscoverPane from './DiscoverPane.vue'
import ProfilePane from './ProfilePane.vue'
import MobileCanvasCreateFab from './MobileCanvasCreateFab.vue'
import MobileCreateSheet from './MobileCreateSheet.vue'
import MobileTaskSheet from './MobileTaskSheet.vue'
import MobileMultiSelectBar from './MobileMultiSelectBar.vue'
import MobileNodeActionSheet, { type MobileNodeActionNode } from './MobileNodeActionSheet.vue'
import MobileNodeEditorSheet from './MobileNodeEditorSheet.vue'
import MobileNodeViewer from './MobileNodeViewer.vue'
import MobileNodeCoachMark from './MobileNodeCoachMark.vue'
import type { EditableFlowNode } from '@/composables/useSelectedNodeEditor'
import type { UpstreamNodeContext } from '@/composables/useUpstreamNodeContext'
import type { NodeRef } from '@/composables/useNodeRefs'
import type { MentionOption } from '@/components/canvas/MentionInput.vue'
import AccountPanel from '@/components/account/AccountPanel.vue'
import PointsPanel from '@/components/points/PointsPanel.vue'
import UsagePanel from '@/components/usage/UsagePanel.vue'
import SubscriptionPanel from '@/components/membership/SubscriptionPanel.vue'
import TopupModal from '@/components/membership/TopupModal.vue'
import MembershipModal from '@/components/membership/MembershipModal.vue'

export interface MobileShellAgentActions {
  /** 规格 §6.2/§6.3：‹ 返回创作空间（/canvases） */
  goGallery: () => void
  /** 规格 §6.3：⤢ 适应画布（桥接到 VueFlow fitView） */
  fitView: () => void
}

export interface MobileShellBatchActions {
  done: () => void
  /** D4 / H1（§4.9 选择模式）：全选当前画布所有节点 */
  selectAll: () => void
  generate: () => void
  regenerate: () => void
  stop: () => void
  blockedHint: (reason: 'pending_confirm' | 'limit_24' | 'missing_prompt') => void
  group: () => void
  ungroup: () => void
  groupColor: (key: string) => void
  duplicate: () => void
  duplicateUpstream: () => void
  addAgentRef: () => void
  layout: (mode: 'along_edges' | 'grid') => void
  /**
   * SP-B 对齐/分布载荷（判别联合）：kind 决定走六向对齐还是两轴等距，
   * alignMode / axis 必须原样透传（缺了会让「对齐」静默退化成网格重排）。
   */
  align: (payload:
    | { kind: 'align'; alignMode: 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom' }
    | { kind: 'distribute'; axis: 'x' | 'y' }) => void
  /**
   * 导出模式载荷必须透传（'full_package' | 'lightweight' | 'media_list_only'）。
   * ⚠️ 早先版本把它写成 `() => void`，@download 的 $event 被吞掉 ⇒ 移动端「轻量包 /
   * 媒体清单」静默退化成默认 full_package（与 master 的 `@download="handlePackageDownload"`
   * 语义不一致：后者是透传 $event 给 mode 形参的）。
   */
  download: (mode: 'full_package' | 'lightweight' | 'media_list_only') => void
  delete: () => void
}

const props = defineProps<{
  /** 页签——共享真源在 CanvasPage，壳层只接收渲染 */
  mobileAppTab: MobileAppTab
  /** 当前项目名（规格 §6.4：次级灰、15px、超长截断） */
  projectName: string
  /** 自动保存状态行（2026-10-21 改版：静默成功只报异常） */
  saving: boolean
  saveFailed: boolean
  /** 空画布呼吸引导用 */
  hasNodes: boolean
  /** 多选动作条 */
  multiSelectActive: boolean
  multiSelectCount: number
  selectionBatch: unknown
  multiSelectCanUngroup: boolean
  multiSelectGroupColorKey: string | null
  /** ＋FAB 隐藏（沉浸画布） */
  canvasChromeHidden: boolean
  /** 移动端 studio dock 已展开（用户 tap 把手）——dock 面板占满画布底部，
   *  ＋FAB 让位（否则压在面板左下角） */
  dockExpanded: boolean
  /** 画布视图的「窗态」：composer 空闲条与 FAB 同一基线（见 MobileCanvasCreateFab
   *  的尺寸计算——48=48 无内缩余量，窗态下 ＋FAB 直接不渲染，由 composer 盖住这一带） */
  composerVisible: boolean
  /** 画布视图可见（跨形态真相源：窗态 / 沉浸满屏 / 画布页签门态三形态共用，§16-②）。
   *  节点状态栏与保存状态行的门控判据——有画布在眼前，待确认/生成中就该看见（真机走查
   *  2026-10-27 实证：定位切画布=窗态看不到确认/取消，点节点进 viewer 才有决策按钮）。 */
  canvasViewVisible: boolean
  /** ── 共享动作（CanvasPage 核心逻辑）── */
  onTabChange: (tab: MobileAppTab) => void
  onSave: () => void
  agentActions: MobileShellAgentActions
  dockAdd: (type: DockNodeType) => void
  assetApply: (asset: CanvasAssetItem) => void
  assetAddToAgent: (asset: CanvasAssetItem) => void
  openMembership: () => void
  openModelSettings: () => void
  historyLocate: (payload: { recordId: string; nodeId?: string | null }) => void
  historyRetry: (nodeId: string) => void
  batchActions: MobileShellBatchActions
  /** 移动端长按动作 sheet 状态（R1-T5）：由 CanvasPage 经 provide 触发，壳层仅渲染 */
  mobileActionNode: MobileNodeActionNode | null
  /** 移动端编辑 sheet 上下文（复用桌面 resolve 逻辑）：null = 未打开 */
  mobileEditor: MobileEditorContext | null
  onNodeAction: (key: string, nodeId: string) => void
  /** R4-T3：移动端重命名（动作 sheet 内联输入提交） */
  onNodeRename: (nodeId: string, title: string) => void
  onNodeActionClose: () => void
  onNodeEditorClose: () => void
  onNodeEditorPatch: (patch: Record<string, unknown>) => void
  /**
   * D8 / J1 / K1（2026-10-25）：移动端**轻量编辑器**的「发给 agent 修改」出口
   * —— ⛔ 不再有本地提交（生成权归 agent）与删除引用 emit（PC dock 专用契约已移除）。
   */
  onNodeEditorSendToAgent: (payload: { prompt: string; opinion: string }) => void
  /** 移动端全屏查看器（R1-T4/T6）：图灯箱/视频播放/音频波形/文本阅读器；null = 未打开 */
  viewerNode: { id?: string; type: 'image' | 'video' | 'audio' | 'text'; data?: any } | null
  onViewerClose: () => void
  /** 右上「⋯」= 打开与长按同一个 Menu（同源同容器，§4.6） */
  onViewerMore: () => void
  /** 查看器底部主栏动作（如文本节点「编辑」、媒体节点「改词」，§4.11.6 高频下沉；音频 edit 携带 meta.mediaTime——v1.5 Q） */
  onViewerBottomAction: (key: string, meta?: { mediaTime?: number }) => void
  /** D8/L1/M1 + §17 v2：查看器标注锚带回（带标记整图 blob 或降级 + 胶囊意见） */
  onViewerAnnotate: (payload: { imageBlob?: Blob; degraded: boolean; text?: string }) => void
  /** §17-④（拍板②）：编辑态保存 ⇒ 页面层覆盖磁贴提示词（不触发生成、不带回 composer） */
  onViewerEditSave: (nodeId: string, prompt: string) => void
  /** 问题③ v2：文本内容就地编辑保存（viewer 内消化）⇒ 页面层 patchNodeData({content}) */
  onViewerContentSave: (nodeId: string, content: string) => void
  /** ── R3-T4 壳层聚合状态栏（D-C 状态机的壳层聚合）── */
  /** 正在生成的节点数（0 = 无） */
  nodeGeneratingCount: number
  /** 待确认节点（id + 标题）——空数组 = 无 */
  nodePendingNodes: MobilePendingNode[]
  /** 生成已耗时（无则不显示） */
  nodeGeneratingElapsed?: string
  /** 确认 = 走桌面同一套 propose confirm 语义 */
  onNodePendingConfirm: (nodeId: string) => void
  /** 拒绝 = 走桌面同一套 propose cancel 语义 */
  onNodePendingCancel: (nodeId: string) => void
}>()

/**
 * 查看器底部主栏动作（§4.11.6 可达性：高频操作放下方拇指区）。
 * §17 v2（拍板①，2026-10-27）：pending 审核层 =【批注】【编辑】两键 ——
 *   「拒绝/改词/确认」三键退役：无条件确认=编辑→保存→回画布再确认；
 *   无条件拒绝=批注→⚓（锚下即标拒绝，经 /answers decline 结算 §17.8）。
 *   画布状态胶囊的确认/拒绝入口不受影响（§17.2，MobileNodeStatusBar 原样）。
 * confirmed / 其它有产物节点：仅「改词」（改词 sheet 原路径）。
 */
const viewerBottomActions = computed(() => {
  const node = props.viewerNode
  if (!node) return []
  const data = (node.data ?? {}) as Record<string, unknown>
  const status = String(data.status ?? '')
  const isPending = status === 'pending_confirm' || status === 'pending'
  const isText = node.type === 'text'
  const hasContent =
    isText
      ? Boolean(String(data.content ?? '').trim())
      : Boolean(String(data.url ?? '').trim())
  // ⭐ 问题③ v2（2026-10-31 真机裁决）：文本节点「编辑」在 viewer 内就地消化
  //   （阅读面变编辑面，无盒无边框无标题；plain/markdown 才可就地编辑）。
  //   #636 边界：format:'html' 产物是结构化文档，裸编辑源码既伤阅读又易破坏
  //   sandbox 渲染 ⇒ 保留 agent 改词流；媒体节点「改词」= 改提示词重生成。
  const isEditableText = isText && String(data.format ?? 'plain') !== 'html'
  const editLabel = isEditableText ? '编辑' : '改词'
  const editIcon: 'pencil' | undefined = isEditableText ? 'pencil' : undefined
  const actions: Array<{
    key: string
    label: string
    variant?: 'primary' | 'danger'
    icon?: 'pencil' | 'speaker' | 'stop'
  }> = []
  if (isPending) {
    // §17 v2（拍板①，2026-10-27）：审核层底栏收敛为【批注】【编辑】两键 ——
    // 「拒绝/改词/确认」三键退役：无条件确认=编辑→保存→确认生成；无条件拒绝=
    // 批注→⚓（锚下即标拒绝，经 /answers decline 结算 §17.8）。画布状态胶囊
    // 的确认/拒绝入口不受影响（§17.2，MobileNodeStatusBar 原样）。
    actions.push({ key: 'annotate', label: '批注', variant: 'primary' })
    actions.push({ key: 'edit', label: '编辑' })
    return actions
  }
  if (hasContent) {
    actions.push({ key: 'edit', label: editLabel, icon: editIcon, variant: 'primary' })
  }
  return actions
})

/** 移动端编辑 sheet 上下文：节点 + 上游/引用/提及（与桌面 DockStudioToolbar 同源） */
export interface MobileEditorContext {
  node: EditableFlowNode
  upstream: UpstreamNodeContext
  refs: NodeRef[]
  mentions: MentionOption[]
  generating: boolean
  /** 意见预填（v1.5 Q：音频改词 meta.mediaTime ⇒「at mm:ss」） */
  initialOpinion?: string
}

const auth = useAuthStore()

/**
 * 移动端「我的积分 / 我的订阅」二级面板状态（内容复用与 PC 路由页同一份面板组件，
 * 这里只管移动端外壳与打开/关闭）。
 */
type MobileAccountPane = '' | 'points' | 'subscription' | 'account' | 'usage'
const mobileAccountPane = ref<MobileAccountPane>('')
const showMobileTopup = ref(false)
const showMobilePlans = ref(false)

const MOBILE_ACCOUNT_TITLES: Record<Exclude<MobileAccountPane, ''>, string> = {
  points: '我的积分',
  subscription: '我的订阅',
  account: '账号信息',
  usage: '用量明细',
}

function openMobileAccountPane(pane: Exclude<MobileAccountPane, ''>) {
  mobileAccountPane.value = pane
}
function closeMobileAccountPane() {
  mobileAccountPane.value = ''
  showMobileTopup.value = false
  showMobilePlans.value = false
}
function openMobilePlans() {
  showMobilePlans.value = true
}

/** ＋FAB 新建 sheet / 任务 sheet —— 纯移动端入口承载（D-2） */
const showMobileCreateSheet = ref(false)
const showMobileTaskSheet = ref(false)

function onMobileCreate(type: DockNodeType) {
  props.dockAdd(type)
  showMobileCreateSheet.value = false
}
function onMobileAssetApply(asset: CanvasAssetItem) {
  props.assetApply(asset)
  showMobileCreateSheet.value = false
}
function onMobileAssetAddToAgent(asset: CanvasAssetItem) {
  props.assetAddToAgent(asset)
  showMobileCreateSheet.value = false
}
function onMobileTaskLocate(payload: { recordId: string; nodeId?: string | null }) {
  props.historyLocate(payload)
  showMobileTaskSheet.value = false
}
function onMobileTaskRetry(nodeId: string) {
  props.historyRetry(nodeId)
  showMobileTaskSheet.value = false
}

/** 任务轮询（原顶栏 ⋯ 动态项徽标）：2026-10-30 ⋯ 菜单整体移除后徽标失去消费方，
 *  轮询随之退役——任务进展经 MobileNodeStatusBar 聚合状态栏常驻可见（真源仍在页面层）。 */

/**
 * R3-T4：底部带互斥判据——有节点任务状态（生成中 / 待确认）时，
 * 让位给 `MobileNodeStatusBar`（与 `MobileSaveStatus` 同带，不能重叠）。
 * ⚠️ 保存失败的优先级更高（丢数据比任务态更急）——那条在模板里单独判。
 */
const hasNodeTaskState = computed(
  () => props.nodeGeneratingCount > 0 || props.nodePendingNodes.length > 0,
)

/** 登录态变化：未登录收回到对话页签并关账号面板（移动端落点纪律） */
watch(
  () => auth.isLoggedIn,
  (loggedIn) => {
    if (!loggedIn) {
      closeMobileAccountPane()
      if (props.mobileAppTab === 'mine') props.onTabChange('chat')
    }
  },
)
</script>

<template>
  <!-- 移动端应用骨架（IA v3）：顶栏三区 + 底部四页签 + 发现/我的两页 + 账号二级面板
       + 自动保存状态行 + ＋FAB + 新建/任务 sheet + 多选动作条。
       本壳层由 CanvasPage 的 `v-if="isMobileLayout"` 包裹，内部不再判断断点。 -->
  <!-- 移动端顶栏（对话 + 画布 共用，规格 §6.2/§6.3）：‹ 返回创作空间 + 项目名；
       画布分支额外带 ⤢ 适应画布。⚠️ 2026-10-30：⋯ 项目菜单整体移除（发布/导出/导入/
       任务 入口后续统一重规划），顶栏不再挂任务徽标轮询。⭐ 取代生命周期规格
       §16-①「画布页签不渲染顶栏卡片」：§16-① 让画布页签完全不渲染顶栏 ⇒ 用户实测
       「进画布即迷路」（缺项目名/返回），本规格（2026-10-27 三页顶栏统一重构，后裁）
       改与 chat 同构常驻渲染。 -->
  <MobileTopBar
    :tab="mobileAppTab"
    :project-name="projectName"
    @go-gallery="agentActions.goGallery"
    @fit-view="agentActions.fitView"
  />
  <!-- 2026-10-21：自动保存状态行——静默成功只报异常（失败红胶囊可点重试，保存中仅呼吸点）；
       多选态不出（与动作条抢位）。
       ⚠️ 与 R3-T4 的节点状态栏**互斥**：保存失败优先（丢数据比任务态更急），
       否则有节点任务时让位给状态栏（两者同在底部带，会重叠）。 -->
  <MobileSaveStatus
    v-if="canvasViewVisible && !multiSelectActive && (saveFailed || !hasNodeTaskState)"
    :saving="saving"
    :failed="saveFailed"
    @save="onSave"
  />
  <!-- R3-T4：壳层聚合状态栏——把画布各节点的「生成中 / 待确认」收敛成一条。
       门控（§16-② 修订，2026-10-27 真机实证）：**画布视图可见即常驻**——
       窗态（定位切画布、页签停对话）/ 沉浸满屏 / 画布页签门态三形态都在眼前；
       原门控 `mobileAppTab==='canvas'` 漏掉窗态 ⇒ 定位落地后确认/取消不可见。 -->
  <MobileNodeStatusBar
    v-if="canvasViewVisible && !multiSelectActive && hasNodeTaskState"
    :generating-count="nodeGeneratingCount"
    :pending-nodes="nodePendingNodes"
    :elapsed-text="nodeGeneratingElapsed"
    @confirm="onNodePendingConfirm"
    @cancel="onNodePendingCancel"
    @open-tasks="showMobileTaskSheet = true"
  />
  <DiscoverPane v-if="mobileAppTab === 'discover'" />
  <ProfilePane
    v-if="mobileAppTab === 'mine'"
    @open-membership="openMembership"
    @open-model-settings="openModelSettings"
    @open-points="openMobileAccountPane('points')"
    @open-subscription="openMobileAccountPane('subscription')"
    @open-account="openMobileAccountPane('account')"
  />
  <!-- 移动端「我的积分 / 我的订阅」二级 pane：内容复用与 PC 路由页同一份面板组件 -->
  <div v-if="mobileAccountPane" class="mobile-account-pane">
    <div class="mobile-account-head">
      <button type="button" class="mobile-account-back" @click="closeMobileAccountPane">
        返回
      </button>
      <h2 class="mobile-account-title">{{ MOBILE_ACCOUNT_TITLES[mobileAccountPane] }}</h2>
      <button
        type="button"
        class="mobile-account-close"
        aria-label="关闭"
        @click="closeMobileAccountPane"
      >
                <!-- ⛔ 禁文本字符当图标（§4.11.5）⇒ 内联 SVG（与 MobileSheet 关闭钮同款） -->
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" stroke-linecap="round" />
                </svg>
      </button>
    </div>
    <div class="mobile-account-body">
      <AccountPanel v-if="mobileAccountPane === 'account'" />
      <PointsPanel
        v-else-if="mobileAccountPane === 'points'"
        @open-topup="showMobileTopup = true"
        @open-usage="openMobileAccountPane('usage')"
      />
      <UsagePanel v-else-if="mobileAccountPane === 'usage'" />
      <SubscriptionPanel v-else @open-plans="openMobilePlans" />
    </div>
    <TopupModal v-model="showMobileTopup" />
    <MembershipModal v-model="showMobilePlans" />
  </div>
  <MobileTabBar :active="mobileAppTab" @change="onTabChange" />
  <!-- 移动端多选态动作条（S3 / D-4，PR3 完整版）：处理器与 PC 工具条同源 -->
  <MobileMultiSelectBar
    v-if="multiSelectActive"
    :count="multiSelectCount"
    :selection-batch="(selectionBatch as any)"
    :can-ungroup="multiSelectCanUngroup"
    :group-color-key="multiSelectGroupColorKey"
    @select-all="batchActions.selectAll"
    @done="batchActions.done"
    @generate="batchActions.generate"
    @regenerate="batchActions.regenerate"
    @stop="batchActions.stop"
    @blocked-hint="batchActions.blockedHint($event)"
    @group="batchActions.group"
    @ungroup="batchActions.ungroup"
    @group-color="batchActions.groupColor($event)"
    @duplicate="batchActions.duplicate"
    @duplicate-upstream="batchActions.duplicateUpstream"
    @add-agent-ref="batchActions.addAgentRef"
    @layout="batchActions.layout($event)"
    @align="batchActions.align($event)"
    @download="batchActions.download($event)"
    @delete="batchActions.delete"
  />
  <!-- PR2 新建收敛（D-2）：＋FAB（空画布呼吸引导）→ 全宽新建 sheet。
       多选态不出：多选动作条接管同一条底部清位（与自动保存状态行同一规则），
       否则 FAB 与动作条同位互压。
       窗态不出（2026-10-21 真机走查）：composer 空闲条与 FAB 同一基线、矩形重合，
       48=48 无内缩余量 ⇒ 位移微调盖不干净；窗态里 FAB 本就不可用（输入会切对话页），
       由 composer 盖住这一带。纯画布态（composer 收起）才出现。 -->
  <MobileCanvasCreateFab
    v-if="
      mobileAppTab === 'canvas' &&
      !canvasChromeHidden &&
      !multiSelectActive &&
      !dockExpanded &&
      !composerVisible
    "
    :breathe="!hasNodes"
    @click="showMobileCreateSheet = true"
  />
  <MobileCreateSheet
    v-if="showMobileCreateSheet"
    @create="onMobileCreate"
    @asset-apply="onMobileAssetApply"
    @asset-add-to-agent="onMobileAssetAddToAgent"
    @close="showMobileCreateSheet = false"
  />
  <MobileTaskSheet
    v-if="showMobileTaskSheet"
    @locate="onMobileTaskLocate"
    @retry="onMobileTaskRetry"
    @close="showMobileTaskSheet = false"
  />
  <!-- R1-T5：移动端长按动作 sheet（重命名/引用/副本/多选/编辑/删除） -->
  <MobileNodeActionSheet
    v-if="mobileActionNode"
    :node="mobileActionNode"
    @action="(key: string) => props.onNodeAction(key, (mobileActionNode as MobileNodeActionNode).id)"
    @close="props.onNodeActionClose"
    @rename="(title: string) => props.onNodeRename((mobileActionNode as MobileNodeActionNode).id, title)"
  />
  <!-- R1-T5：移动端编辑 sheet（复用 DockStudioRouter，删 Dock 后编辑不丢链） -->
  <MobileNodeEditorSheet
    v-if="mobileEditor"
    :node="mobileEditor.node"
    :upstream="mobileEditor.upstream"
    :refs="mobileEditor.refs"
    :mentions="mobileEditor.mentions"
    :generating="mobileEditor.generating"
    :initial-opinion="mobileEditor.initialOpinion"
    @close="props.onNodeEditorClose"
    @patch="props.onNodeEditorPatch"
    @send-to-agent="props.onNodeEditorSendToAgent"
  />
  <!-- 问题③ sheet 已退役（2026-10-31 v2：编辑改由 MobileNodeViewer 就地消化——
       阅读面变编辑面，无盒无边框无标题；过度设计清理） -->
  <!-- R1-T4/T6：移动端全屏查看器（tap 图/视频/短文文本经注入键在此承接）。
       §17 v2：批注/编辑都在 viewer 内完成（胶囊意见框 + 就地改字）——
       ⚓ 直接经 onViewerAnnotate 带回（标注浮层 sheet 退役，§16-⑦ 修订）。 -->
  <MobileNodeViewer
    v-if="viewerNode"
    :type="viewerNode.type"
    :data="viewerNode.data"
    :bottom-actions="viewerBottomActions"
    :menu-open="mobileActionNode?.context === 'viewer'"
    @close="props.onViewerClose"
    @annotate="props.onViewerAnnotate"
    @edit-save="
      (prompt: string) => {
        if (!viewerNode) return
        props.onViewerEditSave(viewerNode.id ?? '', prompt)
      }
    "
    @more="props.onViewerMore"
    @content-save="
      (content: string) => {
        if (!viewerNode) return
        props.onViewerContentSave(viewerNode.id ?? '', content)
      }
    "
    @bottom-action="props.onViewerBottomAction"
  />
  <!-- R1-T7：节点交互范式反转一次性引导（点按播放 · 长按编辑），仅画布页签首进一次 -->
  <MobileNodeCoachMark v-if="mobileAppTab === 'canvas'" />
</template>

<style scoped>
/* 移动端「我的积分 / 我的订阅」二级 pane 外壳（内容由共享面板渲染） */
.mobile-account-pane {
  position: fixed;
  inset: 0;
  width: 100%;
  max-width: 100vw;
  box-sizing: border-box;
  overflow-x: hidden;
  z-index: 90;
  display: flex;
  flex-direction: column;
  background: var(--lnk-surface-canvas);
  padding: calc(var(--lnk-space-4) + env(safe-area-inset-top)) var(--lnk-pad-card)
    calc(var(--lnk-space-6) + env(safe-area-inset-bottom));
  overflow-y: auto;
}

.mobile-account-head {
  display: flex;
  align-items: center;
  gap: var(--lnk-space-2);
  min-height: var(--lnk-touch-target);
}

.mobile-account-back,
.mobile-account-close {
  flex: none;
  /* ⭐ 命中区提到 44px（--lnk-touch-target）：原为 32×32，违反 §4.11.6
     触控目标铁律（V-5 断言在 2026-10-26 对账中抓出）。
     视觉 glyph 仍是 16px 内联 SVG（只放大命中区，不放大图形）。 */
  min-width: var(--lnk-touch-target);
  min-height: var(--lnk-touch-target);
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-md);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.mobile-account-close {
  font-size: 22px;
  line-height: 1;
}

.mobile-account-title {
  flex: 1;
  margin: 0;
  font-size: var(--lnk-text-md);
  font-weight: var(--lnk-weight-semibold);
  color: var(--lnk-text-primary);
  text-align: center;
}

.mobile-account-body {
  flex: 1;
  min-height: 0;
  margin-top: var(--lnk-space-4);
}
</style>
