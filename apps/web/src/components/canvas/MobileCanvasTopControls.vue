<script setup lang="ts">
import { useVueFlow } from '@vue-flow/core'

/** 移动端画布顶部视口控件（2026-10-19 用户裁决引入：小地图 + 缩放 + 适应画布；
 *  2026-10-21 用户裁决瘦身：**仅留一枚 ⤢ 适应画布**）。
 *
 *  减法依据：移动端双指捏合已覆盖缩放（「− 56% +」是 PC 心智）；小地图低频
 *  （PC CanvasBottomLeftControls 保留全量，移动端不再设入口）。视口常驻 chrome
 *  从三段胶囊收敛为一枚圆钮，把顶栏正下方的画布空间还给内容。
 *
 *  与 PC 端同源：useVueFlow fitView。 */
const { fitView } = useVueFlow()

function resetView() {
  void fitView({ padding: 0.2, duration: 200 })
}
</script>

<template>
  <div class="mobile-top-controls">
    <button
      type="button"
      class="fit-btn"
      aria-label="适应画布"
      @click="resetView"
    >
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.mobile-top-controls {
  position: relative;
}

.fit-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-overlay);
  border: 0.5px solid var(--lnk-border-subtle);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: var(--lnk-shadow-sm);
  color: var(--lnk-text-muted);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transform: translateZ(0);
  transition: background var(--lnk-duration-fast) ease, color var(--lnk-duration-fast) ease;
}

/* 触控达标（2026-10-19 PR1，D-7）：34px 视觉 + ::after 外扩至 44px 命中 */
.fit-btn::after {
  content: '';
  position: absolute;
  inset: -5px;
  border-radius: var(--lnk-radius-full);
}

.fit-btn:active {
  background: var(--lnk-pressed-overlay);
  transform: scale(0.94);
}

.fit-btn svg {
  width: 14px;
  height: 14px;
}
</style>
