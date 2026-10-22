<script setup lang="ts">
/**
 * 拖拽智能参考线（纯展示组件，SP-B T9a）。
 *
 * - props 是 **flow 坐标**：horizontal = 水平参考线的 y，vertical = 垂直参考线的 x；
 * - 组件自身不做任何几何计算：位置由 shared 的 `computeSnapGuides` 给出，
 *   调用方（T9b 的 CanvasPage 接线）把结果透传进来；
 * - 挂在 vue-flow 的 viewport 变换容器内 ⇒ 随缩放/平移精确对齐。
 * - 可选 `bounds` = 当前视口在 flow 坐标里的可见范围。变换层的盒子是**屏幕 CSS 尺寸**
 *   再被 scale 缩放，若线只按 `left:0;right:0` 铺满变换层，缩放 <1 时线只覆盖屏幕的
 *   一小段 ⇒ 给了 bounds 就用 flow 坐标显式给出线的起止，任何缩放下都铺满可视区。
 */
import { computed } from 'vue'

const props = defineProps<{
  horizontal?: number
  vertical?: number
  bounds?: { x: number; y: number; w: number; h: number }
}>()

/** 水平线：top 恒为 flow y；给了 bounds 就用 flow 坐标显式给出横向起止。 */
const horizontalStyle = computed(() => {
  const style: Record<string, string> = { top: `${props.horizontal ?? 0}px` }
  if (props.bounds) {
    style.left = `${props.bounds.x}px`
    style.width = `${props.bounds.w}px`
    style.right = 'auto'
  }
  return style
})

/** 垂直线：left 恒为 flow x；给了 bounds 就用 flow 坐标显式给出纵向起止。 */
const verticalStyle = computed(() => {
  const style: Record<string, string> = { left: `${props.vertical ?? 0}px` }
  if (props.bounds) {
    style.top = `${props.bounds.y}px`
    style.height = `${props.bounds.h}px`
    style.bottom = 'auto'
  }
  return style
})
</script>

<template>
  <div
    v-if="horizontal != null"
    class="snap-guide snap-guide-h"
    :style="horizontalStyle"
  />
  <div
    v-if="vertical != null"
    class="snap-guide snap-guide-v"
    :style="verticalStyle"
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
