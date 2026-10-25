<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BrandLogo from '@/components/brand/BrandLogo.vue'
import AccountChrome from '@/components/account/AccountChrome.vue'
import ThemeToggle from '@/components/layout/ThemeToggle.vue'

const route = useRoute()
const router = useRouter()

// 2026-10-21 P1：导航更名 + 重组。
// 「画布」→「创作」（它已经是创作入口，不只是画布列表）、「超创站」→「发现」
// （用户心智是「去发现作品」）；「短片」(/stories) 移出顶栏——路由保留，
// 深链不破，只是不再占顶栏位置。
// 2026-10-25 PR-3 Task 9：「工作室」下拉**整体下线**——主页不应承载独立工作室
// 页面（spec §7.1）⇒ 顶栏只剩【创作】【发现】两项。
// ⚠️ 下线的只是**页面与入口**；能力层保留（后端 StudioModule、前端 studio-api.ts
//    被 agent 链路与 MediaInspectorDrawer 依赖），端点级清理走独立后续任务。
const tabs = [
  { label: '创作', path: '/workflow' },
  { label: '发现', path: '/community' },
]

const activeTab = computed(() => {
  if (route.path.startsWith('/community')) return '/community'
  return '/workflow'
})

// 2026-10-23 用户裁定「品牌页只有一个墨色」：/workflow（签名画面页）不提供主题切换，
// 也不展示个人积分——品牌叙事位保持纯净；主题切换仍可用画布页右上角入口。
const isBrandPage = computed(() => route.path === '/workflow')

function navigate(path: string) {
  router.push(path)
}
</script>

<template>
  <!-- ⛔ 这里曾经是 `border-overlay/5 bg-[#141414]/95`：深色的**死值**，
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
            type="button"
            class="rounded-lg px-4 py-2 text-sm font-medium transition"
            :class="activeTab === tab.path ? 'bg-surface-elevated text-fg' : 'text-fg-2 hover:text-fg'"
            :aria-current="activeTab === tab.path ? 'page' : undefined"
            @click="navigate(tab.path)"
          >
            {{ tab.label }}
          </button>
        </nav>
      </div>

      <div class="flex shrink-0 items-center gap-2 sm:gap-3">
        <!-- 主题切换提到全站：此前只有画布页有入口，其余 16 条路由进不去。
             ⛔ 品牌页（/workflow）例外：签名画面恒为墨色，不随主题翻转 -->
        <ThemeToggle v-if="!isBrandPage" class="h-8 w-8 rounded-lg text-fg-2 hover:bg-surface-elevated hover:text-fg" />
        <AccountChrome :hide-points="isBrandPage" />
      </div>
    </div>
  </header>
</template>
