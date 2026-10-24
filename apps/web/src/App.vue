<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from '@/components/layout/AppHeader.vue'
import LoginDialog from '@/components/auth/LoginDialog.vue'
import { useAuthStore } from '@/stores/auth'
import { schedulePreloadAfterFirstPaint } from '@/composables/useRoutePreload'

const route = useRoute()
const auth = useAuthStore()
const isImmersiveCanvas = computed(() => route.name === 'canvas')

onMounted(() => {
  void auth.restoreSession()
  // 2026-10-24 性能修复（**二次修正**）：预热改为「首屏彻底就绪之后」。
  //
  // ⛔ 初版是「挂载即空闲预热」—— 那次是生产事故的元凶：
  //    预热在 4166ms 拉起画布页整棵依赖树（338KB + 24 个 chunk），
  //    与首屏资源抢同域 6 个 HTTP/1.1 连接 ⇒ 535KB 的品牌 logo 被从
  //    2.1 秒拖到 13 秒、API 排队 ⇒ 用户报「品牌页出不来 + 登录出问题」。
  //
  // ✅ 现在等 `load` 事件（首屏资源全下完）才预热 ⇒ 不再抢任何连接。
  //    另有一路「用户意图触发」（指针移到锚上）由品牌页负责，命中率更高。
  if (!isImmersiveCanvas.value) schedulePreloadAfterFirstPaint()
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
