<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BrandLogo from '@/components/brand/BrandLogo.vue'
import AccountChrome from '@/components/account/AccountChrome.vue'
import ThemeToggle from '@/components/layout/ThemeToggle.vue'

const route = useRoute()
const router = useRouter()

// 2026-10-21 P1：导航更名 + 重组。
// 「画布」→「创作」（它已经是创作入口，不只是画布列表）、「超创站」→「发现」
// （用户心智是「去发现作品」）；「短片」(/stories) 移出顶栏——路由保留，
// 深链不破，只是不再占顶栏位置。「工作室」由直接跳转改为下拉，把四个模态
// 入口（图像/视频/文本/音频）直接摊开，少一次跳转。
const tabs = [
  { label: '创作', path: '/workflow' },
  { label: '发现', path: '/community' },
]

const STUDIO_LINKS = [
  { label: '图像工作室', path: '/image-studio' },
  { label: '视频工作室', path: '/video-studio' },
  { label: '文本工作室', path: '/text-studio' },
  { label: '音频工作室', path: '/audio-studio' },
  { label: '视频编辑器', path: '/video-editor' },
  { label: '生成记录', path: '/generation-records' },
]

const studioOpen = ref(false)
const studioRoot = ref<HTMLElement | null>(null)

const activeTab = computed(() => {
  if (route.path.startsWith('/community')) return '/community'
  if (
    route.path.startsWith('/text-studio') ||
    route.path.startsWith('/image-studio') ||
    route.path.startsWith('/video-studio') ||
    route.path.startsWith('/audio-studio') ||
    route.path.startsWith('/video-editor') ||
    route.path.startsWith('/generation-records')
  ) {
    return '/studio'
  }
  return '/workflow'
})

const studioActive = computed(() => activeTab.value === '/studio')

function navigate(path: string) {
  studioOpen.value = false
  router.push(path)
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!studioOpen.value) return
  const target = event.target as HTMLElement
  if (!target.closest('[data-testid="studio-root"]')) studioOpen.value = false
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && studioOpen.value) studioOpen.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onKeydown)
})
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

          <div ref="studioRoot" data-testid="studio-root" class="relative">
            <button
              data-testid="studio-trigger"
              type="button"
              class="flex items-center gap-1 rounded-lg px-4 py-2 text-sm font-medium transition"
              :class="studioActive ? 'bg-surface-elevated text-fg' : 'text-fg-2 hover:text-fg'"
              aria-haspopup="true"
              :aria-expanded="studioOpen"
              :aria-current="studioActive ? 'page' : undefined"
              @click="studioOpen = !studioOpen"
            >
              工作室
              <svg
                class="h-3.5 w-3.5 transition-transform"
                :class="studioOpen ? 'rotate-180' : ''"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="1.75"
                  d="m6 9 6 6 6-6"
                />
              </svg>
            </button>

            <div
              v-if="studioOpen"
              data-testid="studio-menu"
              role="menu"
              class="absolute left-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-xl border border-line-subtle bg-surface-elevated py-1 shadow-lg"
            >
              <RouterLink
                v-for="link in STUDIO_LINKS"
                :key="link.path"
                :to="link.path"
                role="menuitem"
                class="block px-4 py-2 text-sm text-fg-2 transition hover:bg-hover hover:text-fg"
                @click="studioOpen = false"
              >
                {{ link.label }}
              </RouterLink>
            </div>
          </div>
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
