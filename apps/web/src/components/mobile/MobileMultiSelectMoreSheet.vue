<script setup lang="ts">
/**
 * 移动端多选「更多」sheet（2026-10-20 PR3 / S3）。
 *
 * PC 工具条把布局/导出/分组色塞进 hover 下拉——触屏不可达，故搬进二级视图。
 * 9 项：分组 / 解组 / 分组色 / 新建副本 / 副本（含上游）/ 加入 Agent 引用 /
 *      整理布局 / 导出 / 删除（danger 恒置底）。
 * 色板 8 格 44px（PC 是 hover 横排小点），行高 44px，分组色值走 --lnk-group-* L2 令牌。
 */
import { computed, ref } from 'vue'
import MobileSheet from '@/components/mobile/MobileSheet.vue'
import { GROUP_COLOR_KEYS, normalizeGroupColorKey } from '@/components/canvas/groupColors'

const props = defineProps<{
  /** 选区恰好是一个分组节点：出「解组 / 分组色」 */
  canUngroup?: boolean
  groupColorKey?: string | null
}>()

const emit = defineEmits<{
  group: []
  ungroup: []
  groupColor: [key: string]
  duplicate: []
  duplicateUpstream: []
  addAgentRef: []
  layout: [mode: 'along_edges' | 'grid']
  /** SP-B 对齐/分布（六向 + 两轴等距）——与 PC 工具条同形状。 */
  align: [payload:
    | { kind: 'align'; alignMode: 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom' }
    | { kind: 'distribute'; axis: 'x' | 'y' }]
  download: [mode: 'full_package' | 'lightweight' | 'media_list_only']
  delete: []
  close: []
}>()

type View = 'main' | 'color' | 'layout' | 'export'
const view = ref<View>('main')

const activeColor = computed(() => normalizeGroupColorKey(props.groupColorKey))

const TITLES: Record<View, string> = {
  main: '已选节点操作',
  color: '分组背景色',
  layout: '整理布局',
  export: '导出',
}

function back() {
  view.value = 'main'
}

function onGroup() {
  emit('group')
}

function onUngroup() {
  emit('ungroup')
}

function onPickColor(key: string) {
  emit('groupColor', key)
}

function onDuplicate() {
  emit('duplicate')
}

function onDuplicateUpstream() {
  emit('duplicateUpstream')
}

function onAddAgentRef() {
  emit('addAgentRef')
}

function onLayout(mode: 'along_edges' | 'grid') {
  emit('layout', mode)
}

/** SP-B 对齐/分布：负载形状与 PC 工具条一致（判别联合 kind）。 */
function onAlign(payload:
  | { kind: 'align'; alignMode: 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom' }
  | { kind: 'distribute'; axis: 'x' | 'y' }) {
  emit('align', payload)
}

function onDownload(mode: 'full_package' | 'lightweight' | 'media_list_only') {
  emit('download', mode)
}

function onDelete() {
  emit('delete')
}

/**
 * 六向对齐项（2026-10-23 IA 重排）：3 列 × 2 行网格
 * —— 上行水平三向、下行垂直三向，语义自带分组，无需再加小标题。
 * ⚠️ `id` 决定 testid（`msms-align-<id>`），改名会打断既有守卫测试。
 */
const ALIGN_ITEMS: ReadonlyArray<{
  id: 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom'
  label: string
  alignMode: 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom'
}> = [
  { id: 'left', label: '左对齐', alignMode: 'left' },
  { id: 'centerH', label: '水平居中', alignMode: 'centerH' },
  { id: 'right', label: '右对齐', alignMode: 'right' },
  { id: 'top', label: '顶对齐', alignMode: 'top' },
  { id: 'centerV', label: '垂直居中', alignMode: 'centerV' },
  { id: 'bottom', label: '底对齐', alignMode: 'bottom' },
]
</script>

<template>
  <MobileSheet
    :title="TITLES[view]"
    :subtitle="view === 'main' ? '批量整理与导出' : undefined"
    @close="emit('close')"
  >
    <!-- 二级视图统一带返回行 -->
    <button v-if="view !== 'main'" type="button" class="msms-back" data-testid="msms-back" @click="back">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7" />
      </svg>
      <span>返回</span>
    </button>

    <!-- 分组色板：8 格 44px（PC hover 横排点 → 移动端网格） -->
    <div v-if="view === 'color'" class="msms-colors" data-testid="msms-colors">
      <button
        v-for="key in GROUP_COLOR_KEYS"
        :key="key"
        type="button"
        class="msms-color"
        :class="{ 'is-active': key === activeColor }"
        :data-color="key"
        :aria-label="`分组背景色 ${key}`"
        :aria-pressed="key === activeColor"
        :style="{ background: `var(--lnk-group-${key})` }"
        @click="onPickColor(key)"
      />
    </div>

    <!-- 整理布局（2026-10-23 IA 重排：10 平级 → 2 组卡片「重排 / 规整」）
         分组依据 = 动作语义分层（见 spec §16）：「重排」重新决定整批位置（互斥择一）、
         「规整」在现有位置上微调（可叠加）。10 项竖排会被底部裁掉 ⇒ 改卡片 + 紧凑网格。 -->
    <div v-else-if="view === 'layout'" class="msms-layout" data-testid="msms-layout-groups">
      <section class="msms-card" data-testid="msms-card-rearrange">
        <header class="msms-card__head">
          <span class="msms-card__title">重排</span>
          <span class="msms-card__hint">重新决定这批节点的整体位置</span>
        </header>
        <div class="msms-card__row">
          <button type="button" class="msms-tile" data-testid="msms-layout-along" @click="onLayout('along_edges')">
            <span class="msms-tile__label">顺着连线</span>
            <span class="msms-tile__hint">按连线分层</span>
          </button>
          <button type="button" class="msms-tile" data-testid="msms-layout-grid" @click="onLayout('grid')">
            <span class="msms-tile__label">自动网格</span>
            <span class="msms-tile__hint">等距铺排</span>
          </button>
        </div>
      </section>

      <section class="msms-card" data-testid="msms-card-tidy">
        <header class="msms-card__head">
          <span class="msms-card__title">规整</span>
          <span class="msms-card__hint">在现有位置上微调</span>
        </header>
        <!-- 六向 = 3 列 × 2 行：上行水平三向、下行垂直三向（语义自带分组，无需小标题） -->
        <div class="msms-align" data-testid="msms-align-grid">
          <button
            v-for="item in ALIGN_ITEMS"
            :key="item.id"
            type="button"
            class="msms-align__btn"
            :data-testid="`msms-align-${item.id}`"
            @click="onAlign({ kind: 'align', alignMode: item.alignMode })"
          >
            {{ item.label }}
          </button>
        </div>
        <div class="msms-card__row">
          <button type="button" class="msms-tile" data-testid="msms-distribute-x" @click="onAlign({ kind: 'distribute', axis: 'x' })">
            <span class="msms-tile__label">水平等距</span>
            <span class="msms-tile__hint">左右间隙相等</span>
          </button>
          <button type="button" class="msms-tile" data-testid="msms-distribute-y" @click="onAlign({ kind: 'distribute', axis: 'y' })">
            <span class="msms-tile__label">垂直等距</span>
            <span class="msms-tile__hint">上下间隙相等</span>
          </button>
        </div>
      </section>
    </div>

    <!-- 导出 -->
    <div v-else-if="view === 'export'" class="msms-list">
      <button type="button" class="msms-item" data-testid="msms-export-full" @click="onDownload('full_package')">
        <span class="msms-item__label">完整工作流包</span>
      </button>
      <button type="button" class="msms-item" data-testid="msms-export-light" @click="onDownload('lightweight')">
        <span class="msms-item__label">轻量包（不含媒体）</span>
      </button>
      <button type="button" class="msms-item" data-testid="msms-export-media" @click="onDownload('media_list_only')">
        <span class="msms-item__label">仅媒体清单</span>
      </button>
    </div>

    <!-- 主列表（9 项；解组与分组色仅选区为分组节点时出） -->
    <div v-else class="msms-list" data-testid="msms-list">
      <button type="button" class="msms-item" data-testid="msms-group" @click="onGroup">
        <span class="msms-item__label">分组</span>
      </button>
      <button v-if="canUngroup" type="button" class="msms-item" data-testid="msms-ungroup" @click="onUngroup">
        <span class="msms-item__label">解组</span>
      </button>
      <button
        v-if="canUngroup"
        type="button"
        class="msms-item"
        data-testid="msms-color-entry"
        @click="view = 'color'"
      >
        <span class="msms-item__label">分组背景色</span>
        <span class="msms-item__value" :style="{ background: `var(--lnk-group-${activeColor})` }" />
      </button>
      <button type="button" class="msms-item" data-testid="msms-duplicate" @click="onDuplicate">
        <span class="msms-item__label">新建副本</span>
      </button>
      <button type="button" class="msms-item" data-testid="msms-duplicate-upstream" @click="onDuplicateUpstream">
        <span class="msms-item__label">新建副本（含上游）</span>
      </button>
      <button type="button" class="msms-item" data-testid="msms-add-ref" @click="onAddAgentRef">
        <span class="msms-item__label">加入 Agent 引用</span>
      </button>
      <button type="button" class="msms-item" data-testid="msms-layout" @click="view = 'layout'">
        <span class="msms-item__label">整理布局</span>
        <svg class="msms-item__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
      <button type="button" class="msms-item" data-testid="msms-export" @click="view = 'export'">
        <span class="msms-item__label">导出</span>
        <svg class="msms-item__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
      <button
        type="button"
        class="msms-item is-danger"
        data-testid="msms-delete"
        @click="onDelete"
      >
        <span class="msms-item__label">删除所选节点</span>
      </button>
    </div>
  </MobileSheet>
</template>

<style scoped>
.msms-list {
  display: flex;
  flex-direction: column;
  padding-bottom: var(--lnk-space-1);
}

.msms-item {
  display: flex;
  width: 100%;
  min-height: var(--lnk-touch-target);
  align-items: center;
  justify-content: space-between;
  gap: var(--lnk-space-2);
  padding: 0 var(--lnk-space-3);
  border: none;
  border-radius: var(--lnk-radius-md);
  background: transparent;
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-base);
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background var(--lnk-duration-fast) ease;
}

.msms-item:active {
  background: var(--lnk-pressed-overlay);
}

.msms-item.is-danger {
  margin-top: var(--lnk-space-2);
  color: var(--lnk-error);
}

.msms-item__chevron {
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--lnk-text-muted);
}

.msms-item__value {
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: var(--lnk-radius-full);
  border: 0.5px solid var(--lnk-border-subtle);
}

/* ── 整理布局：分组卡片（2026-10-23 IA 重排）────────────────────────────
   原 10 项竖排（10 × 44px）在移动端 sheet 里被底部裁掉 ⇒ 改两张卡片
   （重排 / 规整）+ 紧凑网格，高度降到 ~5 行；语义分组见 spec §16。 */
.msms-layout {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-3);
  padding-bottom: var(--lnk-space-2);
}

.msms-card {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-2);
  padding: var(--lnk-space-3);
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-surface-raised);
  border: 0.5px solid var(--lnk-border-subtle);
}

.msms-card__head {
  display: flex;
  align-items: baseline;
  gap: var(--lnk-space-2);
}

.msms-card__title {
  font-size: var(--lnk-text-sm);
  font-weight: 600;
  color: var(--lnk-text-primary);
}

.msms-card__hint {
  font-size: var(--lnk-text-2xs);
  color: var(--lnk-text-muted);
}

.msms-card__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--lnk-space-2);
}

.msms-tile {
  display: flex;
  min-height: var(--lnk-touch-target);
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 2px;
  padding: var(--lnk-space-2) var(--lnk-space-3);
  border: none;
  border-radius: var(--lnk-radius-sm);
  background: var(--lnk-surface-sunken);
  color: var(--lnk-text-primary);
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background var(--lnk-duration-fast) ease;
}

.msms-tile:active {
  background: var(--lnk-pressed-overlay);
}

.msms-tile__label {
  font-size: var(--lnk-text-sm);
}

.msms-tile__hint {
  font-size: var(--lnk-text-2xs);
  color: var(--lnk-text-muted);
}

/* 六向 = 3 列 × 2 行：上行水平三向、下行垂直三向 */
.msms-align {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--lnk-space-2);
}

.msms-align__btn {
  min-height: var(--lnk-touch-target);
  padding: 0 var(--lnk-space-2);
  border: none;
  border-radius: var(--lnk-radius-sm);
  background: var(--lnk-surface-sunken);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-sm);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background var(--lnk-duration-fast) ease;
}

.msms-align__btn:active {
  background: var(--lnk-pressed-overlay);
}

.msms-back {
  display: inline-flex;
  min-height: var(--lnk-touch-target);
  align-items: center;
  gap: 2px;
  align-self: flex-start;
  margin-bottom: var(--lnk-space-1);
  padding: 0 var(--lnk-space-2) 0 var(--lnk-space-1);
  border: none;
  border-radius: var(--lnk-radius-md);
  background: transparent;
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-sm);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.msms-back:active {
  background: var(--lnk-pressed-overlay);
}

.msms-back svg {
  width: 16px;
  height: 16px;
}

/* 8 色网格：44px 触控格（T-6 / I-6） */
.msms-colors {
  display: grid;
  grid-template-columns: repeat(4, var(--lnk-touch-target));
  gap: var(--lnk-space-3);
  justify-content: center;
  padding: var(--lnk-space-2) 0 var(--lnk-space-4);
}

.msms-color {
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-full);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: transform var(--lnk-duration-fast) var(--lnk-ease-standard);
}

.msms-color:active {
  transform: scale(0.92);
}

.msms-color.is-active {
  border-color: var(--lnk-accent);
  box-shadow: 0 0 0 2px var(--lnk-accent-subtle);
}
</style>