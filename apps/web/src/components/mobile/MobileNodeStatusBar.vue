<script setup lang="ts">
import { computed } from 'vue'
import type { MobilePendingNode } from '@/composables/mobileNodeTaskSummary'

/**
 * 移动端壳层聚合状态栏（R3-T4，D-C 状态机的「壳层状态栏聚合」）。
 *
 * ⭐ 目的：把散落在画布各节点上的**生成中 / 待确认**收敛成一条。
 *   用户不必逐个节点去看，就知道整体在干什么、还有什么等着我拍板。
 *
 * ⭐ **不显示假百分比**：全仓无生成进度字段（唯一百分比 `uploadProgress` 仅上传态）
 *   ⇒ 只显示「N 个生成中」+ 已耗时（`elapsedText` 由调用方算）。
 *
 * ⭐ 确认 / 拒绝动作**复用桌面同一套语义**（批次 2 confirm）：
 *   调用方转 `handleAgentGenerateNode` / `handleProposeConfirmCancel`，
 *   本组件只 emit，不自己发请求。
 */
const props = defineProps<{
  /** 正在生成的节点数 */
  generatingCount: number
  /** 待确认节点（id + 标题） */
  pendingNodes: MobilePendingNode[]
  /** 已耗时（由调用方按最早起始时间算）；未给出则不显示 */
  elapsedText?: string
}>()

const emit = defineEmits<{
  confirm: [nodeId: string]
  cancel: [nodeId: string]
}>()

const hasTask = computed(() => props.generatingCount > 0 || props.pendingNodes.length > 0)

/** 有多个待确认时只对第一个给动作（其余等处理完再露出——避免一排按钮挤爆底栏）。 */
const firstPending = computed(() => props.pendingNodes[0])
</script>

<template>
  <div
    v-if="hasTask"
    class="mobile-node-status-bar"
    :data-testid="'mobile-node-status-bar'"
    role="status"
    aria-live="polite"
  >
    <!-- 生成中：数量 + 已耗时（无百分比） -->
    <span v-if="generatingCount > 0" class="mobile-node-status-generating">
      <span class="mobile-node-status-spinner" aria-hidden="true" />
      <span class="mobile-node-status-text">{{ generatingCount }} 个生成中</span>
      <span v-if="elapsedText" class="mobile-node-status-elapsed">{{ elapsedText }}</span>
    </span>

    <!-- 待确认：拍板动作（复用批次 2 confirm 语义） -->
    <span v-if="firstPending" class="mobile-node-status-pending">
      <span class="mobile-node-status-text">
        待确认{{ pendingNodes.length > 1 ? ` · ${pendingNodes.length}` : '' }}
      </span>
      <button
        type="button"
        class="mobile-node-status-btn mobile-node-status-cancel"
        aria-label="拒绝该提议"
        @click="emit('cancel', firstPending.id)"
      >
        拒绝
      </button>
      <button
        type="button"
        class="mobile-node-status-btn mobile-node-status-confirm is-primary"
        aria-label="确认该提议"
        @click="emit('confirm', firstPending.id)"
      >
        确认
      </button>
    </span>
  </div>
</template>

<style scoped>
.mobile-node-status-bar {
  /* ⚠️ fixed（不是 absolute）：absolute 贴 100vh 根容器底边，在带浏览器工具条的
     真机上整颗掉出可见区。fixed 贴可见视口底，与页签栏 / ＋FAB 同一坐标系。 */
  position: fixed;
  left: 68px;
  bottom: calc(var(--lnk-agent-dock-h, 0px) + var(--lnk-tabbar-h, 0px) + env(safe-area-inset-bottom, 0px) + 12px + 10px);
  z-index: 55;
  display: inline-flex;
  max-width: calc(100vw - 84px);
  align-items: center;
  gap: var(--lnk-space-2);
  padding: var(--lnk-space-1) var(--lnk-space-2);
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-overlay);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.mobile-node-status-generating,
.mobile-node-status-pending {
  display: inline-flex;
  align-items: center;
  gap: var(--lnk-space-2);
}

.mobile-node-status-spinner {
  width: 12px;
  height: 12px;
  flex: none;
  border: 1.5px solid var(--lnk-border-strong);
  border-top-color: var(--lnk-accent);
  border-radius: var(--lnk-radius-full);
  animation: mobile-node-status-spin 0.8s linear infinite;
}

@keyframes mobile-node-status-spin {
  to {
    transform: rotate(360deg);
  }
}

.mobile-node-status-text {
  white-space: nowrap;
}

.mobile-node-status-elapsed {
  color: var(--lnk-text-muted);
  font-variant-numeric: tabular-nums;
}

/* 拍板按钮：44px 触控目标（移动端硬约束） */
.mobile-node-status-btn {
  display: inline-flex;
  min-width: var(--lnk-touch-target);
  min-height: var(--lnk-touch-target);
  align-items: center;
  justify-content: center;
  padding: 0 var(--lnk-space-2);
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  cursor: pointer;
}

.mobile-node-status-btn.is-primary {
  border-color: var(--lnk-accent-border);
  background: var(--lnk-accent-subtle);
  color: var(--lnk-accent-text);
}

.mobile-node-status-btn:active {
  transform: scale(0.96);
}
</style>
