<script setup lang="ts">
/** 移动端「新建」全宽 sheet（2026-10-19 D-2）：＋FAB 的展开态。
 *  结构（设计 4.2）：顶部通栏瓦片「资产库」（插入节点语义，sheet 内二级视图，
 *  面板本体复用 CanvasAssetPanel）+ 2 列宫格 10 类节点（数据与 PC 竖轨
 *  同源 CANVAS_DOCK_MENU_ITEMS，单一出处）。选中即创建并关闭。
 *  资产库「加入引用」语义与 composer＋ 区分：此处仅插入节点。 */
import { computed, ref } from 'vue'
import MobileSheet from '@/components/mobile/MobileSheet.vue'
import CanvasAssetPanel, { type CanvasAssetItem } from '@/components/canvas/CanvasAssetPanel.vue'
import DockTypeIcon from '@/components/canvas/dock-studio/shared/DockTypeIcon.vue'
import { CANVAS_DOCK_MENU_ITEMS } from '@/components/canvas/canvasDockMenu'
import type { DockNodeType } from '@/components/canvas/NodePanelDock.vue'

const emit = defineEmits<{
  create: [type: DockNodeType]
  'asset-apply': [asset: CanvasAssetItem]
  'asset-add-to-agent': [asset: CanvasAssetItem]
  close: []
}>()

/** menu = 新建宫格；assets = 资产库二级视图（插入节点语义） */
const view = ref<'menu' | 'assets'>('menu')

const sheetTitle = computed(() => (view.value === 'assets' ? '资产库' : '新建'))

function backToMenu() {
  view.value = 'menu'
}

function onCreate(type: DockNodeType) {
  emit('create', type)
}

function onAssetApply(asset: CanvasAssetItem) {
  emit('asset-apply', asset)
}

function onAssetAddToAgent(asset: CanvasAssetItem) {
  emit('asset-add-to-agent', asset)
}
</script>

<template>
  <MobileSheet :title="sheetTitle" :subtitle="view === 'menu' ? '新建节点，或从资产库插入' : '选择素材插入画布'" @close="emit('close')">
    <!-- 二级视图：资产库（面板本体复用，仅换承载容器） -->
    <div v-if="view === 'assets'" class="mcs-assets">
      <button type="button" class="mcs-back" data-testid="mcs-back" @click="backToMenu">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7" />
        </svg>
        <span>返回新建</span>
      </button>
      <div class="mcs-assets-panel">
        <CanvasAssetPanel @apply="onAssetApply" @add-to-agent="onAssetAddToAgent" />
      </div>
    </div>

    <!-- 一级视图：资产库瓦片 + 10 类节点宫格 -->
    <template v-else>
      <button
        type="button"
        class="mcs-asset-tile"
        data-testid="mcs-asset-tile"
        @click="view = 'assets'"
      >
        <span class="mcs-asset-tile__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"
            />
          </svg>
        </span>
        <span class="mcs-asset-tile__text">
          <span class="mcs-asset-tile__title">资产库</span>
          <span class="mcs-asset-tile__desc">插入已有图片 / 视频 / 音频素材</span>
        </span>
        <svg class="mcs-asset-tile__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      <p class="mcs-grid-caption">新建节点</p>
      <div class="mcs-grid" data-testid="mcs-grid">
        <button
          v-for="item in CANVAS_DOCK_MENU_ITEMS"
          :key="item.type"
          type="button"
          class="mcs-grid-item"
          :data-type="item.type"
          @click="onCreate(item.type)"
        >
          <span class="mcs-grid-item__icon" :class="item.tone">
            <DockTypeIcon :type="item.type" :size="20" />
          </span>
          <span class="mcs-grid-item__body">
            <span class="mcs-grid-item__title">
              {{ item.label }}
              <span v-if="item.badge" class="mcs-grid-item__badge">{{ item.badge }}</span>
            </span>
            <span v-if="item.desc" class="mcs-grid-item__desc">{{ item.desc }}</span>
          </span>
        </button>
      </div>
    </template>
  </MobileSheet>
</template>

<style scoped>
/* 资产库通栏瓦片（设计 4.2 顶部瓦片 = 画布内唯一资产插入入口） */
.mcs-asset-tile {
  display: flex;
  width: 100%;
  min-height: 56px;
  align-items: center;
  gap: var(--lnk-space-3);
  margin-bottom: var(--lnk-space-3);
  padding: 0 var(--lnk-space-3);
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-lg);
  background: var(--lnk-surface-overlay);
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: transform var(--lnk-duration-fast) var(--lnk-ease-standard);
}

.mcs-asset-tile:active {
  transform: scale(0.98);
  background: var(--lnk-pressed-overlay);
}

.mcs-asset-tile__icon {
  display: flex;
  width: 36px;
  height: 36px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-accent-gradient);
  color: var(--lnk-text-on-accent);
}

.mcs-asset-tile__icon svg {
  width: 18px;
  height: 18px;
}

.mcs-asset-tile__text {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.mcs-asset-tile__title {
  font-size: var(--lnk-text-sm);
  font-weight: var(--lnk-weight-semibold);
  color: var(--lnk-text-primary);
}

.mcs-asset-tile__desc {
  font-size: var(--lnk-text-2xs);
  color: var(--lnk-text-muted);
}

.mcs-asset-tile__chevron {
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--lnk-text-muted);
}

.mcs-grid-caption {
  padding: 0 var(--lnk-space-1) var(--lnk-space-2);
  font-size: var(--lnk-text-2xs);
  font-weight: var(--lnk-weight-medium);
  color: var(--lnk-text-muted);
}

/* 2 列宫格：56px 行高（设计 4.2），触控 ≥44px */
.mcs-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--lnk-space-2);
  padding-bottom: var(--lnk-space-2);
}

.mcs-grid-item {
  display: flex;
  min-height: 56px;
  align-items: center;
  gap: var(--lnk-space-2);
  padding: var(--lnk-space-2);
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-lg);
  background: var(--lnk-surface-overlay);
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: transform var(--lnk-duration-fast) var(--lnk-ease-standard);
}

.mcs-grid-item:active {
  transform: scale(0.96);
  background: var(--lnk-pressed-overlay);
}

.mcs-grid-item__icon {
  display: flex;
  width: 32px;
  height: 32px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: var(--lnk-radius-md);
}

.mcs-grid-item__body {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}

.mcs-grid-item__title {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--lnk-text-sm);
  font-weight: var(--lnk-weight-medium);
  color: var(--lnk-text-primary);
}

.mcs-grid-item__badge {
  padding: 0 4px;
  border-radius: var(--lnk-radius-xs);
  background: var(--lnk-pressed-overlay);
  font-size: 9px;
  font-weight: var(--lnk-weight-medium);
  color: var(--lnk-text-muted);
}

.mcs-grid-item__desc {
  overflow: hidden;
  font-size: var(--lnk-text-2xs);
  color: var(--lnk-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 资产库二级视图：返回行 + 面板本体（固定 312px 宽，sheet 内左对齐不拉伸） */
.mcs-assets {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-2);
}

.mcs-back {
  display: inline-flex;
  min-height: var(--lnk-touch-target);
  align-items: center;
  gap: 2px;
  align-self: flex-start;
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

.mcs-back:active {
  background: var(--lnk-pressed-overlay);
}

.mcs-back svg {
  width: 16px;
  height: 16px;
}

.mcs-assets-panel {
  display: flex;
  justify-content: center;
  padding-bottom: var(--lnk-space-2);
}
</style>
