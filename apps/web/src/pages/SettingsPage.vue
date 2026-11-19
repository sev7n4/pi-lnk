<script setup lang="ts">
/**
 * 独立设置页（2026-11-19 返工）。
 *
 * 账号级设置从「个人中心」Tab 与画布竖轨收敛到此处，由头像下拉菜单的一级「设置」项进入。
 * 外观做成浅/深双选项：缩略预览用主题不变式 L2 令牌（恒白/恒深，不随当前主题翻转），
 * 选中态用主题稳定的 accent 三件套（禁用会翻转的 hi-bg/hi-text）。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import ProviderConfigDialog from '@/components/canvas/ProviderConfigDialog.vue'
import { useAuthStore } from '@/stores/auth'
import { useCanvasTheme } from '@/composables/useCanvasTheme'

const router = useRouter()
const auth = useAuthStore()
const { theme, setTheme } = useCanvasTheme()

const showModelSettings = ref(false)

function closeSettings() {
  if (window.history.length > 1) router.back()
  else void router.replace('/workflow')
}

onMounted(() => {
  if (!auth.isLoggedIn) auth.openLogin()
})
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-10">
    <div class="mb-6 flex items-center gap-3">
      <button
        data-testid="settings-back"
        type="button"
        class="btn-ghost -ml-2 shrink-0 px-2 py-1 text-sm"
        @click="closeSettings"
      >
        ← 返回
      </button>
      <h1 class="font-display text-2xl font-semibold text-fg">设置</h1>
    </div>

    <section class="rounded-2xl border border-overlay/8 bg-surface-elevated p-6">
      <h2 class="mb-1 text-base font-medium text-fg">外观</h2>
      <p class="mb-4 text-xs text-fg-3">选择界面主题，立即生效</p>
      <div class="grid grid-cols-2 gap-3">
        <button
          data-testid="theme-option-light"
          type="button"
          :aria-pressed="theme === 'light'"
          class="theme-option rounded-xl border p-3 text-left transition"
          :class="
            theme === 'light'
              ? 'border-[var(--lnk-accent-border)] bg-[var(--lnk-accent-subtle)] text-accent-text'
              : 'border-overlay/12 text-fg-2 hover:text-fg'
          "
          @click="setTheme('light')"
        >
          <span
            class="mb-2 block h-14 rounded-lg border border-[var(--lnk-ink-300)] [background:var(--lnk-stamp-face-on-signature)] p-1.5"
          >
            <span class="block h-1.5 w-1/2 rounded-sm [background:var(--lnk-stamp-ink-on-signature)]" />
            <span class="mt-1.5 block h-1.5 w-3/4 rounded-sm [background:var(--lnk-ink-300)]" />
            <span class="mt-1.5 block h-1.5 w-2/5 rounded-sm [background:var(--lnk-ink-300)]" />
          </span>
          <span class="flex items-center justify-between text-sm">
            <span>浅色</span>
            <span v-if="theme === 'light'" class="text-xs">✓ 当前</span>
          </span>
        </button>

        <button
          data-testid="theme-option-dark"
          type="button"
          :aria-pressed="theme === 'dark'"
          class="theme-option rounded-xl border p-3 text-left transition"
          :class="
            theme === 'dark'
              ? 'border-[var(--lnk-accent-border)] bg-[var(--lnk-accent-subtle)] text-accent-text'
              : 'border-overlay/12 text-fg-2 hover:text-fg'
          "
          @click="setTheme('dark')"
        >
          <span
            class="mb-2 block h-14 rounded-lg border border-[var(--lnk-ink-700)] [background:var(--lnk-surface-signature)] p-1.5"
          >
            <span class="block h-1.5 w-1/2 rounded-sm [background:var(--lnk-text-on-signature)]" />
            <span class="mt-1.5 block h-1.5 w-3/4 rounded-sm [background:var(--lnk-ink-600)]" />
            <span class="mt-1.5 block h-1.5 w-2/5 rounded-sm [background:var(--lnk-ink-600)]" />
          </span>
          <span class="flex items-center justify-between text-sm">
            <span>深色</span>
            <span v-if="theme === 'dark'" class="text-xs">✓ 当前</span>
          </span>
        </button>
      </div>
    </section>

    <section class="mt-4 rounded-2xl border border-overlay/8 bg-surface-elevated px-6 py-1">
      <button
        type="button"
        data-testid="open-model-settings"
        class="flex w-full items-center justify-between gap-4 py-4 text-left text-sm text-fg-2 transition-colors hover:text-fg"
        @click="showModelSettings = true"
      >
        <span class="flex flex-col gap-0.5">
          <span>模型配置</span>
          <span class="text-xs text-fg-3">渠道聚合、模型选择与同步偏好</span>
        </span>
        <svg class="h-4 w-4 shrink-0 text-fg-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="m9 5 7 7-7 7" />
        </svg>
      </button>
    </section>

    <ProviderConfigDialog v-model="showModelSettings" />
  </div>
</template>
