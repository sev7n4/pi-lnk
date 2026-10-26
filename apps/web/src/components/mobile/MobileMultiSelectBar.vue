<script setup lang="ts">
/**
 * 移动端多选态动作条（S3 / D-4，2026-10-20 PR3 完整版）。
 *
 * 形态：底部固定条（贴 dock/composer 之上，沿用 --lnk-agent-dock-h 清位公式），不叠 z。
 * 条内（≤4 钮 + 退出）：已选 N ｜ 批量生成 N（主操作 accent，运行中变「停止」）｜
 * 重新生成 N（有可重生成节点时）｜ 更多 ⋯（9 项 sheet）｜ 完成。
 * warning 徽章（整批阻断 / 纯缺提示词）复用 PC 同一套派生口径
 * （`useSelectionBatchActions`），点按仍走 blockedHint → CanvasPage 定位。
 */
import { computed, ref } from 'vue'
import MobileMultiSelectMoreSheet from '@/components/mobile/MobileMultiSelectMoreSheet.vue'
import {
  useSelectionBatchActions,
  type SelectionBatchState,
} from '@/composables/useSelectionBatchActions'

const props = defineProps<{
  count: number
  /** 批量计划摘要（口径与 PC MultiSelectToolbar.selectionBatch 同一份） */
  selectionBatch?: SelectionBatchState
  /** 选区恰好是一个分组节点：出「解组 / 分组色」 */
  canUngroup?: boolean
  groupColorKey?: string | null
}>()

const emit = defineEmits<{
  done: []
  generate: []
  regenerate: []
  stop: []
  blockedHint: [reason: 'pending_confirm' | 'limit_24' | 'missing_prompt']
  group: []
  ungroup: []
  groupColor: [key: string]
  duplicate: []
  duplicateUpstream: []
  addAgentRef: []
  layout: [mode: 'along_edges' | 'grid']
  /** SP-B 对齐/分布（六向 + 两轴等距）——载荷必须带 $event 透传。 */
  align: [payload:
    | { kind: 'align'; alignMode: 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom' }
    | { kind: 'distribute'; axis: 'x' | 'y' }]
  download: [mode: 'full_package' | 'lightweight' | 'media_list_only']
  delete: []
  /**
   * D4 / H1（§4.9 选择模式）：全选当前画布所有节点。
   * ⭐ 本条**只存在于选择模式**（壳层仅在 multiSelectActive 时渲染它）⇒
   *   不需要额外的 `selectionMode` prop（避免第二个真源）。
   */
  selectAll: []
}>()

const batch = useSelectionBatchActions(() => props.selectionBatch)

const moreOpen = ref(false)
const warningLabel = computed(() => {
  const reason = batch.warning.value?.reason
  if (reason === 'pending_confirm') return '待确认'
  if (reason === 'limit_24') return '超上限'
  return '缺提示词'
})

function onPrimary() {
  if (batch.primary.value === 'stop') emit('stop')
  else if (batch.primary.value === 'generate') emit('generate')
}

function onWarning() {
  if (batch.warning.value) emit('blockedHint', batch.warning.value.reason)
}
</script>

<template>
  <div class="mobile-multi-select-bar" data-testid="mobile-multi-select-bar">
    <span class="msb-count">已选 {{ count }}</span>

    <div class="msb-actions">
      <!-- 整批阻断 / 纯缺提示词：条内 warning 徽章，点按定位（PC 同语义） -->
      <button
        v-if="batch.warning.value"
        type="button"
        class="msb-warning"
        data-testid="msb-warning"
        :aria-label="`${warningLabel} ${batch.warning.value.count}`"
        :title="batch.blockedTitle.value || batch.missingTitle"
        @click="onWarning"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" />
          <path d="M8 4.5v4" stroke-linecap="round" />
          <circle cx="8" cy="11.2" r="0.9" fill="currentColor" stroke="none" />
        </svg>
        <span class="tabular-nums">{{ batch.warning.value.count }}</span>
      </button>

      <!-- 主操作：批量生成 N / 运行中「停止」 -->
      <button
        v-if="batch.primary.value"
        type="button"
        class="msb-primary"
        :class="{ 'is-stop': batch.running.value }"
        data-testid="msb-primary"
        :aria-label="batch.running.value ? '停止全部' : `批量生成 ${batch.runCount.value} 个节点`"
        @click="onPrimary"
      >
        <svg v-if="!batch.running.value" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M9 1 3 9h4l-1 6 6-8H8l1-6z" />
        </svg>
        <svg v-else viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
        </svg>
        <span v-if="!batch.running.value" class="tabular-nums">{{ batch.runCount.value }}</span>
      </button>

      <!-- 重新生成（PC 同语义：覆盖已完成节点，有消耗积分风险）。运行中不重复出
           ——PC 两个钮都会变成「停止」，移动端并排两个同义钮必然误触（语义在
           useSelectionBatchActions 里未动，只在此处做呈现取舍）。 -->
      <button
        v-if="batch.showRegenButton.value && !batch.running.value"
        type="button"
        class="msb-ghost"
        data-testid="msb-regen"
        :aria-label="`重新生成 ${batch.regenCount.value} 个已完成节点`"
        title="覆盖式重新生成，将覆盖现有产物并可能消耗积分"
        @click="emit('regenerate')"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.97" stroke-linecap="round" />
          <path d="M13.6 1.6v3h-3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="tabular-nums">{{ batch.regenCount.value }}</span>
      </button>

      <button
        type="button"
        class="msb-more"
        data-testid="msb-more"
        aria-label="更多操作"
        @click="moreOpen = true"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>

      <!--
        D4 / H1（§4.9 选择模式）：「全选」入口
        —— ⭐ 对标 iOS 照片多选（进入选择模式后可一键全选）。
        ⛔ **不加「取消」**：既有「完成」已是「退出选择模式」（`exitMultiSelectMode`
          清空选区），再加「取消」= 两个同义按钮（iOS Photos 也没有）。
      -->
      <button
        type="button"
        class="msb-select-all"
        data-testid="msb-select-all"
        @click="emit('selectAll')"
      >
        全选
      </button>

      <button
        type="button"
        class="msb-done"
        data-testid="mobile-multi-select-done"
        @click="emit('done')"
      >
        完成
      </button>
    </div>

    <MobileMultiSelectMoreSheet
      v-if="moreOpen"
      :can-ungroup="canUngroup"
      :group-color-key="groupColorKey"
      @group="emit('group')"
      @ungroup="emit('ungroup')"
      @group-color="emit('groupColor', $event)"
      @duplicate="emit('duplicate')"
      @duplicate-upstream="emit('duplicateUpstream')"
      @add-agent-ref="emit('addAgentRef')"
      @layout="emit('layout', $event)"
      @align="emit('align', $event)"
      @download="emit('download', $event)"
      @delete="emit('delete')"
      @close="moreOpen = false"
    />
  </div>
</template>

<style scoped>
.mobile-multi-select-bar {
  /* ⚠️ fixed（**不是** absolute）：同 ＋FAB / 保存状态行——absolute 贴 100vh 根容器底边，
     在带浏览器工具条的真机上整条掉出可见区（多选动作条不可见 ⇒ I-6 不可达）。 */
  position: fixed;
  left: 12px;
  right: 12px;
  bottom: calc(var(--lnk-agent-dock-h, 0px) + var(--lnk-tabbar-h, 0px) + env(safe-area-inset-bottom, 0px) + 12px);
  z-index: 55;
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: var(--lnk-space-2);
  padding: 0 6px 0 16px;
  border-radius: 9999px;
  background: var(--lnk-surface-overlay);
  border: 0.5px solid var(--lnk-border-subtle);
  box-shadow: var(--lnk-shadow-md);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}

.msb-count {
  flex: none;
  font-size: var(--lnk-text-sm);
  font-weight: 500;
  color: var(--lnk-text-secondary);
  font-variant-numeric: tabular-nums;
}

.msb-actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 2px;
}

/* 图标钮统一 44px 触控（T-6） */
.msb-primary,
.msb-ghost,
.msb-warning,
.msb-more {
  display: flex;
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  align-items: center;
  justify-content: center;
  gap: 3px;
  flex: none;
  border: none;
  border-radius: var(--lnk-radius-full);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: transform var(--lnk-duration-fast) var(--lnk-ease-standard);
}

.msb-primary:active,
.msb-ghost:active,
.msb-warning:active,
.msb-more:active {
  transform: scale(0.92);
}

.msb-primary {
  padding: 0 10px;
  background: var(--lnk-accent-gradient);
  color: var(--lnk-text-on-accent);
}

.msb-primary.is-stop {
  background: var(--lnk-surface-raised);
  border: 0.5px solid var(--lnk-border-subtle);
  color: var(--lnk-error);
}

.msb-ghost {
  padding: 0 8px;
  background: transparent;
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-2xs);
}

.msb-warning {
  padding: 0 8px;
  background: transparent;
  color: var(--lnk-warning);
  font-size: var(--lnk-text-2xs);
}

.msb-more {
  background: transparent;
  color: var(--lnk-text-secondary);
}

.msb-primary svg,
.msb-ghost svg {
  width: 15px;
  height: 15px;
}

.msb-warning svg {
  width: 14px;
  height: 14px;
}

.msb-more svg {
  width: 18px;
  height: 18px;
}

/* D4 / H1：选择模式的「全选 / 取消」（与「完成」同级的次级动作） */
.msb-select-all {
  display: flex;
  flex: none;
  align-items: center;
  min-height: 32px;
  padding: 0 var(--lnk-space-3);
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-full);
  background: transparent;
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-sm);
  font-weight: 500;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.msb-done {
  display: flex;
  min-width: 56px;
  height: 36px;
  flex: none;
  align-items: center;
  justify-content: center;
  padding: 0 14px;
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: 9999px;
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-sm);
  font-weight: 600;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: transform var(--lnk-duration-fast) var(--lnk-ease-standard);
}

.msb-done:active {
  transform: scale(0.94);
}
</style>