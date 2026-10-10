<script setup lang="ts">
/**
 * 主题切换按钮（应用级）。
 *
 * ## 为什么抽成组件
 *
 * 主题切换此前**只存在于画布页**（`CanvasPage.vue` 内联按钮）。主题在 P0 已升级为
 * 应用级能力（引导脚本写在 `index.html`，首屏前同步落地），但**用户只能在画布页切**
 * —— 其余 16 条路由进不去，等于「能用但够不着」。
 *
 * 抽组件后两处共用同一份实现：`AppHeader`（全站，除沉浸画布）与
 * `CanvasPage` 的浮动 chrome（沉浸画布没有 header）。
 *
 * ## 设计约束
 *
 * - **无 props**：尺寸/圆角由调用方用 `class` 透传（Vue 自动合并到根节点），
 *   避免为一个按钮造出 `size`/`variant` 之类的 API 面。
 * - **状态只读 DOM**：当前主题从 `<html data-theme>` 读回，与 `useCanvasTheme`
 *   一致 —— 不引入第二个真相源。
 * - **图标必须带 aria-label**：纯图标按钮没有可读名称，读屏软件只能念「按钮」。
 */
import { computed } from 'vue'
import { useCanvasTheme } from '@/composables/useCanvasTheme'

const { theme, toggleTheme } = useCanvasTheme()

const isDark = computed(() => theme.value === 'dark')

/** 说的是「点下去会发生什么」，不是「现在是什么」—— 行动导向的标签对读屏更友好。 */
const label = computed(() => (isDark.value ? '切换到白天模式' : '切换到黑夜模式'))
</script>

<template>
  <button
    type="button"
    class="theme-toggle inline-flex items-center justify-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
    :aria-label="label"
    :title="label"
    @click="toggleTheme"
  >
    <!-- 太阳（当前深色 ⇒ 提示可切到白天） -->
    <svg
      v-if="isDark"
      class="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      stroke-width="1.75"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path
        stroke-linecap="round"
        d="M12 3v2m0 14v2M5.64 5.64l1.41 1.41m9.9 9.9 1.41 1.41M3 12h2m14 0h2M5.64 18.36l1.41-1.41m9.9-9.9 1.41-1.41"
      />
    </svg>
    <!-- 月亮（当前浅色 ⇒ 提示可切到黑夜） -->
    <svg
      v-else
      class="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      stroke-width="1.75"
      aria-hidden="true"
    >
      <path stroke-linecap="round" stroke-linejoin="round" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  </button>
</template>
