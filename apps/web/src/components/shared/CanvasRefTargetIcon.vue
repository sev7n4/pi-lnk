<script setup lang="ts">
import anchorBadge from '@/assets/icons/anchor-badge.png'
/** 加入 Agent 引用 — 与 composer 定位锚（anchor-locate.png 品牌 glyph）保持一致的图标。
 * 资产库 hover / 画布节点右上 / 多选工具栏 共用，确保「加入 Agent 引用」图标样式统一。 */
withDefaults(
  defineProps<{
    /** 图标边长（px） */
    size?: number
  }>(),
  { size: 16 },
)
</script>

<template>
  <img
    class="canvas-ref-anchor"
    :src="anchorBadge"
    :style="{ width: `${size}px`, height: `${size}px` }"
    alt=""
    aria-hidden="true"
  />
</template>

<style scoped>
.canvas-ref-anchor {
  display: inline-block;
  object-fit: contain;
}
</style>
