<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BrandLogo from '@/components/brand/BrandLogo.vue'
import AccountChrome from '@/components/account/AccountChrome.vue'
import ThemeToggle from '@/components/layout/ThemeToggle.vue'

const route = useRoute()
const router = useRouter()

const tabs = [
  { label: '画布', path: '/workflow' },
  { label: '超创站', path: '/community' },
  { label: '短片', path: '/stories' },
  { label: '工作室', path: '/image-studio' },
]

const activeTab = computed(() => {
  if (route.path.startsWith('/community')) return '/community'
  if (route.path.startsWith('/stories')) return '/stories'
  if (route.path.startsWith('/text-studio') || route.path.startsWith('/image-studio')
    || route.path.startsWith('/video-studio') || route.path.startsWith('/audio-studio')
    || route.path.startsWith('/video-editor') || route.path.startsWith('/generation-records')) {
    return '/image-studio'
  }
  return '/workflow'
})

function navigate(path: string) {
  router.push(path)
}
</script>

<template>
  <!-- ⛔ 这里曾经是 `border-white/5 bg-[#141414]/95`：深色的**死值**，
       浅色主题上线后 header 会继续保持近黑 —— 而 header 正是全站唯一常驻的 chrome。
       改指语义 token 后，深色取值基本不变（canvas #131318 ≈ 旧 #141414）。
       ⚠️ `bg-surface/95` 不生效：CSS 变量类无法做 alpha 合成（见 tailwind.config.js 注释），
       故用不透明底色 + backdrop-blur 保留层次。 -->
  <header
    class="sticky top-0 z-50 border-b border-line-subtle bg-surface backdrop-blur-xl"
    style="height: var(--neo-header-height)"
  >
    <div class="mx-auto flex h-full max-w-7xl items-center justify-between px-4 sm:px-6">
      <div class="flex min-w-0 items-center gap-4 sm:gap-8">
        <button class="flex items-center gap-2" @click="navigate('/workflow')">
          <BrandLogo size="sm" show-name />
        </button>

        <nav class="hidden items-center gap-1 md:flex">
          <button
            v-for="tab in tabs"
            :key="tab.path"
            class="rounded-lg px-4 py-2 text-sm font-medium transition"
            :class="activeTab === tab.path ? 'bg-surface-elevated text-fg' : 'text-fg-2 hover:text-fg'"
            @click="navigate(tab.path)"
          >
            {{ tab.label }}
          </button>
        </nav>
      </div>

      <div class="flex shrink-0 items-center gap-2 sm:gap-3">
        <!-- 主题切换提到全站：此前只有画布页有入口，其余 16 条路由进不去 -->
        <ThemeToggle class="h-8 w-8 rounded-lg text-fg-2 hover:bg-surface-elevated hover:text-fg" />
        <AccountChrome />
      </div>
    </div>
  </header>
</template>
