<script setup lang="ts">
import { computed, ref } from 'vue'
import { MiniMap } from '@vue-flow/minimap'
import { useVueFlow } from '@vue-flow/core'
import { miniMapNodeColor } from '@/components/canvas/minimapNodeColors'

/** 移动端画布顶部视口控件（2026-10-19 用户裁决）：小地图 + 缩放 + 适应画布，
 *  极简胶囊挂在画布页签顶栏正下方（VueFlow Panel top-right）。
 *  与 PC 端 CanvasBottomLeftControls 同源（useVueFlow zoomTo/fitView + MiniMap），
 *  砍：连线设置、画布设置、节点列表——低频项留在 PC。小地图开关为组件本地态，
 *  不持久化（移动端无此需求）。 */
const { viewport, zoomTo, fitView } = useVueFlow()

const showMap = ref(false)

const zoomPercent = computed(() => Math.round(viewport.value.zoom * 100))

function zoomBy(delta: number) {
  const next = Math.min(200, Math.max(10, zoomPercent.value + delta))
  void zoomTo(next / 100, { duration: 120 })
}

function resetView() {
  void fitView({ padding: 0.2, duration: 200 })
}

function onMapToggle() {
  showMap.value = !showMap.value
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
        mask-color="rgba(109, 93, 252, 0.14)"
        mask-stroke-color="rgba(138, 125, 255, 0.7)"
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
        @click="onMapToggle"
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

.map-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  overflow: hidden;
  width: 132px;
  height: 88px;
  border-radius: 12px;
  border: 0.5px solid var(--neo-border);
  background: var(--neo-hover-bg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
}

:deep(.map-minimap) {
  width: 132px !important;
  height: 88px !important;
  margin: 0 !important;
  background: var(--neo-hover-bg) !important;
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
  border-radius: 999px;
  background: var(--neo-hover-bg);
  border: 0.5px solid var(--neo-border);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
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
  border-radius: 999px;
  background: transparent;
  color: var(--neo-text-muted);
  font-size: var(--lnk-text-md, 16px);
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s ease, color 0.15s ease;
}

/* 触控达标（2026-10-19 PR1，D-7）：34px 视觉 + ::after 外扩至 44px 命中 */
.pill-btn::after {
  content: '';
  position: absolute;
  inset: -5px;
  border-radius: 999px;
}

.pill-btn:active {
  background: var(--neo-active-bg);
  transform: scale(0.94);
}

.pill-btn.is-accent {
  background: var(--neo-hi-bg);
  color: var(--neo-hi-text);
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
  background: var(--neo-border);
}

.pill-zoom {
  width: 34px;
  flex-shrink: 0;
  text-align: center;
  font-size: var(--lnk-text-xs, 12px);
  font-variant-numeric: tabular-nums;
  color: var(--neo-text-muted);
}
</style>
