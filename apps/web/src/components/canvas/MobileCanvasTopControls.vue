<script setup lang="ts">
import { computed } from 'vue'
import { MiniMap } from '@vue-flow/minimap'
import { useVueFlow } from '@vue-flow/core'
import { miniMapNodeColor } from '@/components/canvas/minimapNodeColors'

/** 移动端画布顶部视口控件（2026-10-19 用户裁决）：小地图 + 缩放 + 适应画布，
 *  极简胶囊挂在画布页签顶栏正下方（VueFlow Panel top-right）。
 *  与 PC 端 CanvasBottomLeftControls 同源（useVueFlow zoomTo/fitView + MiniMap），
 *  砍：连线设置、画布设置、节点列表——低频项留在 PC。
 *
 *  PR4（2026-10-20）：① 令牌全量迁 --lnk-*（旧体系棘轮只减不增）；② 小地图开关
 *  改走画布设置的 `minimapExpanded`（与 PC 同源、跨端一致、随设置持久化），
 *  不再用组件本地态；③ 小地图浮层 132×88 → 160×104（点得准）。 */
const props = defineProps<{
  /** 画布设置里的 minimapExpanded（0 = 关；1/2 = 开，PC 三态循环） */
  minimapExpanded?: number
}>()

const emit = defineEmits<{
  'toggle-minimap': []
}>()

const { viewport, zoomTo, fitView } = useVueFlow()

const showMap = computed(() => (props.minimapExpanded ?? 0) !== 0)

const zoomPercent = computed(() => Math.round(viewport.value.zoom * 100))

function zoomBy(delta: number) {
  const next = Math.min(200, Math.max(10, zoomPercent.value + delta))
  void zoomTo(next / 100, { duration: 120 })
}

function resetView() {
  void fitView({ padding: 0.2, duration: 200 })
}
</script>

<template>
  <div class="mobile-top-controls">
    <!-- 小地图浮层（点图定位，与 PC 同交互） -->
    <div
      v-if="showMap"
      class="map-popover"
      @click.stop
    >
      <MiniMap
        :pannable="true"
        :zoomable="true"
        :node-color="miniMapNodeColor"
        mask-color="var(--lnk-accent-subtle)"
        mask-stroke-color="var(--lnk-accent)"
        :mask-stroke-width="1.5"
        class="map-minimap"
      />
    </div>

    <div class="control-pill">
      <button
        type="button"
        class="pill-btn"
        :class="{ 'is-accent': showMap }"
        aria-label="小地图"
        @click="emit('toggle-minimap')"
      >
        <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A2 2 0 013 15.382V6.618a2 2 0 011.553-1.894L9 2m0 18l6-3m-6 3V2m6 15l5.447 2.724A2 2 0 0021 18.382V9.618a2 2 0 00-1.553-1.894L15 5m0 14V5m0 0L9 2" />
        </svg>
      </button>

      <span class="pill-divider" />

      <button type="button" class="pill-btn" aria-label="缩小" @click="zoomBy(-10)">−</button>
      <span class="pill-zoom">{{ zoomPercent }}%</span>
      <button type="button" class="pill-btn" aria-label="放大" @click="zoomBy(10)">+</button>

      <span class="pill-divider" />

      <button type="button" class="pill-btn" aria-label="适应画布" @click="resetView">
        <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.mobile-top-controls {
  position: relative;
}

/* PR4：132×88 → 160×104（点得准；遮罩走 --lnk-accent-subtle 令牌） */
.map-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  overflow: hidden;
  width: 160px;
  height: 104px;
  border-radius: var(--lnk-radius-lg);
  border: 0.5px solid var(--lnk-border-subtle);
  background: var(--lnk-surface-overlay);
  box-shadow: var(--lnk-shadow-md);
}

:deep(.map-minimap) {
  width: 160px !important;
  height: 104px !important;
  margin: 0 !important;
  background: var(--lnk-surface-overlay) !important;
  border: none !important;
  border-radius: 0 !important;
}

:deep(.map-minimap .vue-flow__minimap-node) {
  fill-opacity: 1 !important;
}

.control-pill {
  display: flex;
  align-items: center;
  gap: 1px;
  height: 40px;
  padding: 0 4px;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-overlay);
  border: 0.5px solid var(--lnk-border-subtle);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: var(--lnk-shadow-sm);
  transform: translateZ(0);
}

.pill-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--lnk-radius-full);
  background: transparent;
  color: var(--lnk-text-muted);
  font-size: var(--lnk-text-md);
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background var(--lnk-duration-fast) ease, color var(--lnk-duration-fast) ease;
}

/* 触控达标（2026-10-19 PR1，D-7）：34px 视觉 + ::after 外扩至 44px 命中 */
.pill-btn::after {
  content: '';
  position: absolute;
  inset: -5px;
  border-radius: var(--lnk-radius-full);
}

.pill-btn:active {
  background: var(--lnk-pressed-overlay);
  transform: scale(0.94);
}

.pill-btn.is-accent {
  background: var(--lnk-accent-subtle);
  color: var(--lnk-accent-text);
}

.pill-btn svg {
  width: 14px;
  height: 14px;
}

.pill-divider {
  width: 1px;
  height: 14px;
  margin: 0 2px;
  flex-shrink: 0;
  background: var(--lnk-border-subtle);
}

.pill-zoom {
  width: 34px;
  flex-shrink: 0;
  text-align: center;
  font-size: var(--lnk-text-xs);
  font-variant-numeric: tabular-nums;
  color: var(--lnk-text-muted);
}
</style>
