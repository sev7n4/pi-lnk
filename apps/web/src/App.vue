<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from '@/components/layout/AppHeader.vue'
import LoginDialog from '@/components/auth/LoginDialog.vue'
import { useAuthStore } from '@/stores/auth'
import { scheduleIdlePreload } from '@/composables/useRoutePreload'

const route = useRoute()
const auth = useAuthStore()
const isImmersiveCanvas = computed(() => route.name === 'canvas')

onMounted(() => {
  void auth.restoreSession()
  // 2026-10-24 性能修复：空闲时预热画布页分包。
  // 「进入项目」是全站最重的跳转（CanvasPage + 依赖 ≈ 798KB gzip），
  // 等用户点了才开始下载 ⇒ 在 ~300KB/s 出网带宽上白等 2~3 秒。
  // 已在画布页时该分包早已加载，此处预热是空操作。
  if (!isImmersiveCanvas.value) scheduleIdlePreload()
})
</script>

<template>
  <div class="min-h-[100dvh] bg-surface">
    <div v-if="!isImmersiveCanvas" class="pointer-events-none fixed inset-0 bg-hero-gradient" />
    <AppHeader v-if="!isImmersiveCanvas" />
    <main class="relative z-10" :class="isImmersiveCanvas ? 'h-[100dvh] overflow-hidden' : ''">
      <RouterView />
    </main>
    <LoginDialog />
  </div>
</template>
