<script setup lang="ts">
/**
 * 拖拽智能参考线（纯展示组件，SP-B T9a）。
 *
 * - props 是 **flow 坐标**：horizontal = 水平参考线的 y，vertical = 垂直参考线的 x；
 * - 组件自身不做任何几何计算：位置由 shared 的 `computeSnapGuides` 给出，
 *   调用方（T9b 的 CanvasPage 接线）把结果透传进来；
 * - 挂在 vue-flow 的 viewport 变换容器内 ⇒ 随缩放/平移精确对齐。
 */
defineProps<{ horizontal?: number; vertical?: number }>()
</script>

<template>
  <div
    v-if="horizontal != null"
    class="snap-guide snap-guide-h"
    :style="{ top: horizontal + 'px' }"
  />
  <div
    v-if="vertical != null"
    class="snap-guide snap-guide-v"
    :style="{ left: vertical + 'px' }"
  />
</template>

<style scoped>
/* ⛔ 只用 L2 令牌（--lnk-accent），组件层不写死任何色值。
   pointer-events: none ⇒ 参考线永不吞掉画布上的拖拽/点击交互。 */
.snap-guide {
  position: absolute;
  background: var(--lnk-accent);
  pointer-events: none;
  z-index: 60;
}
.snap-guide-h {
  left: 0;
  right: 0;
  height: 1px;
}
.snap-guide-v {
  top: 0;
  bottom: 0;
  width: 1px;
}
</style>
