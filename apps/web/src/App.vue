<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from '@/components/layout/AppHeader.vue'
import LoginDialog from '@/components/auth/LoginDialog.vue'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const auth = useAuthStore()
const isImmersiveCanvas = computed(() => route.name === 'canvas')

onMounted(() => {
  void auth.restoreSession()
  // ⛔⛔ 2026-10-24 **三次修正**：全局预热**彻底删掉**，一行都不留。
  //
  // 演进（三次都是生产事故逼出来的）：
  //   ① 挂载即空闲预热 ⇒ 与首屏抢连接 ⇒ 535KB 的品牌 logo 从 2.1s 拖到 13s、
  //      API 排队 ⇒ 用户报「品牌页出不来 + 登录出问题」（#581 已删）
  //   ② 改为等 `load` 事件 ⇒ `load` **只等首屏必要资源，不等懒加载 chunk**
  //      ⇒ 仍在抢（#582 改为 `load` + 3s 延迟）
  //   ③ `load` + 3s 仍不够 —— **对话页实测**：用户连点历史项目 1/2/3/4，
  //      每次都建一条 **SSE 长连接**（`/api/agent/runs/events`），
  //      同域 HTTP/1.1 只有 **6 个连接**；旧 SSE 未释放时新 SSE 又建
  //      ⇒ 连接被占满 ⇒ `threads` / `events` 排队 **55 秒**（Network 一片红）。
  //      而全局预热此时又拉起 CanvasPage 338KB + 26 个 chunk ⇒ **再抢一轮**。
  //
  // ⭐ **结论：全局预热在任何页面都是有害的** —— 它无法知道「用户接下来要去哪」，
  //    却要为此付出「与当前页面的 SSE / API 抢连接」的**确定**代价，
  //    而收益（点创作命中缓存）只在用户真的去画布时才兑现。
  //
  // ✅ 只保留**用户意图触发**（`SignatureHero` 的 `preloadOnIntent`）：
  //    指针移到锚 / 焦点进入 / 触摸滑条 ⇒ 意图明确，且此刻首屏早已就绪。
})
</script>

<template>
  <div class="min-h-[100dvh] bg-surface">
    <div v-if="!isImmersiveCanvas" class="pointer-events-none fixed inset-0 bg-hero-gradient" />
    <AppHeader v-if="!isImmersiveCanvas" />
    <main class="relative z-10" :class="isImmersiveCanvas ? 'h-[100dvh] overflow-hidden' : ''">
      <!-- ⛔ 2026-10-25：`:key="route.path"` 不是可有可无的优化，是**切项目能生效**的前提。
           同一路由只换 param（/workflow/a → /workflow/b）时，Vue Router 默认**复用组件实例**
           ⇒ onMounted 不再跑 ⇒ CanvasPage 的 `loadSession()` 不再执行 ⇒ 画布停在旧项目
           （生产实证：回访用户点【历史项目】进另一个项目，画布内容不变）。
           而 CanvasPage 的 loadSession() 是**合并**语义（mergeCanvasNodesFromServer），
           复用实例下即便补触发也会把两个项目的节点并起来 ⇒ 必须是**全新实例**。
           ⛔ key 取 **path** 而非 fullPath：focusNode 消费后会 `router.replace` 改 query，
              fullPath 随之变化 ⇒ 重挂载 ⇒ 又触发消费 ⇒ 循环。 -->
      <RouterView :key="route.path" />
    </main>
    <LoginDialog />
  </div>
</template>
