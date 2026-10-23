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
import { onUnmounted, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { studioApi } from '@/services/studio-api'
import type { GenerationRecord } from '@/services/studio-api'
import type { MobileAppTab } from './MobileTabBar.vue'
import type { DockNodeType } from '@/components/canvas/NodePanelDock.vue'
import type { CanvasAssetItem } from '@/components/canvas/CanvasAssetPanel.vue'

import MobileTopBar from './MobileTopBar.vue'
import MobileTabBar from './MobileTabBar.vue'
import MobileSaveStatus from './MobileSaveStatus.vue'
import DiscoverPane from './DiscoverPane.vue'
import ProfilePane from './ProfilePane.vue'
import MobileCanvasCreateFab from './MobileCanvasCreateFab.vue'
import MobileCreateSheet from './MobileCreateSheet.vue'
import MobileTaskSheet from './MobileTaskSheet.vue'
import MobileMultiSelectBar from './MobileMultiSelectBar.vue'
import AccountPanel from '@/components/account/AccountPanel.vue'
import PointsPanel from '@/components/points/PointsPanel.vue'
import UsagePanel from '@/components/usage/UsagePanel.vue'
import SubscriptionPanel from '@/components/membership/SubscriptionPanel.vue'
import TopupModal from '@/components/membership/TopupModal.vue'
import MembershipModal from '@/components/membership/MembershipModal.vue'

export interface MobileShellAgentActions {
  openDrawer: () => void
  newChat: () => void
  openHistory: () => void
  /** IA v4（2026-10-23）：顶栏品牌字标 → 回工作台 hero（项目页回前门） */
  goHome: () => void
}

export interface MobileShellBatchActions {
  done: () => void
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
  /** 任务轮询 */
  sessionId: string
  /** ＋FAB 隐藏（沉浸画布） */
  canvasChromeHidden: boolean
  /** 移动端 studio dock 已展开（用户 tap 把手）——dock 面板占满画布底部，
   *  ＋FAB 让位（否则压在面板左下角） */
  dockExpanded: boolean
  /** 画布视图的「窗态」：composer 空闲条与 FAB 同一基线（见 MobileCanvasCreateFab
   *  的尺寸计算——48=48 无内缩余量，窗态下 ＋FAB 直接不渲染，由 composer 盖住这一带） */
  composerVisible: boolean
  /** ── 共享动作（CanvasPage 核心逻辑）── */
  onTabChange: (tab: MobileAppTab) => void
  onSave: () => void
  onPublish: () => void
  onImportWorkflow: () => void
  onExportPack: (ids: string[], mode: 'full_package' | 'lightweight') => void
  agentActions: MobileShellAgentActions
  dockAdd: (type: DockNodeType) => void
  assetApply: (asset: CanvasAssetItem) => void
  assetAddToAgent: (asset: CanvasAssetItem) => void
  openMembership: () => void
  openModelSettings: () => void
  historyLocate: (payload: { recordId: string; nodeId?: string | null }) => void
  historyRetry: (nodeId: string) => void
  batchActions: MobileShellBatchActions
}>()

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

/** 任务轮询（顶栏 ⋯ 动态项徽标）：进入画布页签启动、离开停止 */
const TASK_ACTIVE_STATUSES = new Set([
  'pending',
  'generating',
  'fallback_pending',
  'processing',
  'running',
])
const mobileTaskActiveCount = ref(0)
const mobileTaskHasHistory = ref(false)
let mobileTaskPollTimer: ReturnType<typeof setInterval> | null = null

async function loadMobileTaskCount() {
  if (!props.sessionId) {
    mobileTaskActiveCount.value = 0
    mobileTaskHasHistory.value = false
    return
  }
  try {
    const { data } = await studioApi.listGenerations({ sessionId: props.sessionId })
    const records: GenerationRecord[] = data.data ?? []
    mobileTaskActiveCount.value = records.filter((r) => TASK_ACTIVE_STATUSES.has(r.status)).length
    mobileTaskHasHistory.value = records.length > 0
  } catch {
    /* 计数失败不打扰画布：保持旧值，下个轮询周期重试 */
  }
}
function startMobileTaskPolling() {
  stopMobileTaskPolling()
  void loadMobileTaskCount()
  mobileTaskPollTimer = setInterval(() => void loadMobileTaskCount(), 15_000)
}
function stopMobileTaskPolling() {
  if (mobileTaskPollTimer) {
    clearInterval(mobileTaskPollTimer)
    mobileTaskPollTimer = null
  }
}

watch(
  [() => props.mobileAppTab, () => props.sessionId],
  ([tab]) => {
    if (tab === 'canvas') startMobileTaskPolling()
    else stopMobileTaskPolling()
  },
  { immediate: true },
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

onUnmounted(() => stopMobileTaskPolling())
</script>

<template>
  <!-- 移动端应用骨架（IA v3）：顶栏三区 + 底部四页签 + 发现/我的两页 + 账号二级面板
       + 自动保存状态行 + ＋FAB + 新建/任务 sheet + 多选动作条。
       本壳层由 CanvasPage 的 `v-if="isMobileLayout"` 包裹，内部不再判断断点。 -->
  <MobileTopBar
    :tab="mobileAppTab"
    :task-active-count="mobileTaskActiveCount"
    :has-task-history="mobileTaskHasHistory"
    @open-drawer="agentActions.openDrawer"
    @new-chat="agentActions.newChat"
    @open-history="agentActions.openHistory"
    @go-home="agentActions.goHome"
    @publish="onPublish"
    @import-workflow="onImportWorkflow"
    @export-workflow="onExportPack([], 'full_package')"
    @export-workflow-light="onExportPack([], 'lightweight')"
    @open-tasks="showMobileTaskSheet = true"
  />
  <!-- 2026-10-21：自动保存状态行——静默成功只报异常（失败红胶囊可点重试，保存中仅呼吸点）；
       多选态不出（与动作条抢位） -->
  <MobileSaveStatus
    v-if="mobileAppTab === 'canvas' && !multiSelectActive"
    :saving="saving"
    :failed="saveFailed"
    @save="onSave"
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
        ×
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
  width: 32px;
  height: 32px;
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
