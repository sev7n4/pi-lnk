<script setup lang="ts">
import { computed } from 'vue'
import { brandPattern } from '@/components/account/brand-pattern'

/**
 * 画布无封面兜底（2026-10-21 走查复盘轮）。
 *
 * 此前的兜底是 BrandPatternAvatar（紫底 + 标题首字母）——那是**用户头像位**的
 * 语言，借用到画布封面上会被读成「一个没加载出头像的用户」，且 smoke 测试画布
 * 的首字母是 "l"，信息量为零。画布位与头像位是两套语义：
 *   头像位  回答「这是谁」  → BrandPatternAvatar（契约见 avatarSlotContract.test.ts）
 *   兜底封面回答「这是一块墨流画布」→ 本组件：墨点纸纹 + 品牌印记
 *
 * 墨点走 --lnk-overlay-rgb（深=白 / 浅=黑，随主题翻转）而非 dim 恒黑通道：
 * 本兜底的底是 surface-sunken（随主题翻转），dim 黑点压在深色底上会隐身。
 * 纸纹静态不漂移——列表里五张卡同时动是噪音， hero 的粒子已经承担「活」的表达。
 */
const props = defineProps<{ seed: string }>()

const dots = computed(() =>
  brandPattern(props.seed)
    .dots.map(
      (d) =>
        `radial-gradient(circle ${d.r}% at ${d.x}% ${d.y}%, rgb(var(--lnk-overlay-rgb) / ${d.alpha}) 0%, transparent 70%)`,
    )
    .join(', '),
)
</script>

<template>
  <div class="absolute inset-0 overflow-hidden bg-surface-sunken" data-testid="canvas-cover-fallback">
    <!-- 墨点纸纹：同 seed 永远同图案，每块画布有自己的一份 -->
    <div
      class="lnk-canvas-ink-dots pointer-events-none absolute inset-0"
      :style="{ backgroundImage: dots }"
      aria-hidden="true"
    />
    <!-- 品牌印记：一枚「墨」字印，accent-subtle 底 + accent-border 描边 -->
    <div class="absolute inset-0 flex items-center justify-center">
      <span class="lnk-canvas-seal" aria-hidden="true">墨</span>
    </div>
  </div>
</template>

<style scoped>
.lnk-canvas-seal {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-accent-subtle);
  border: 1px solid var(--lnk-accent-border);
  color: var(--lnk-accent-text);
  font-family: var(--lnk-font-display);
  font-size: var(--lnk-text-md);
  font-weight: var(--lnk-weight-semibold);
  line-height: 1;
  /* 印记随卡片 hover 一起被 scrim 压住时仍保持可读：不加动画，只吃继承的过渡 */
  user-select: none;
}
</style>
