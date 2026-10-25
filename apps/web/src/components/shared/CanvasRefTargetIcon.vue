<script setup lang="ts">
import anchorBadge from '@/assets/icons/anchor-badge.png'
/** 加入 Agent 引用图标 — 双色品牌徽标（黑盘 + 白锚 + 外环 + 左侧波浪），作为独立品牌
 * 落点标记（不是套在圆形按钮里的 emblem，否则会双重同心圆）。
 * 资产库 hover / 画布节点右上 / 多选工具栏 共用，确保「加入 Agent 引用」图标样式统一。
 * 默认 20px：徽标是带描边环的细节 emblem，<16px 时锚与环会糊成一团（用户实测「太小」）。 */
withDefaults(
  defineProps<{
    /** 图标边长（px） */
    size?: number
  }>(),
  { size: 20 },
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
