<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter }  from 'vue-router'
import BrandLogo from '@/components/brand/BrandLogo.vue'
import AccountChrome from '@/components/account/AccountChrome.vue'
import ThemeToggle from '@/components/layout/ThemeToggle.vue'
import { useAuthStore } from '@/stores/auth'
import { useProjectWorkspace } from '@/composables/useProjectWorkspace'
import { ElMessage } from 'element-plus'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const { create, gallerySearchOpen } = useProjectWorkspace()

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

// 2026-10-27 规格（mobile-web-three-page-topbar-redesign §6.1/§6.7）：创作空间（画廊）
// 走**裸栏**——仅 logo + 🔍 + ＋，去掉 创作/发现/主题/账号。移动 + WEB 同一组件、同一视觉。
const isGalleryRoute = computed(() => route.path === '/canvases')

// 2026-10-28 v3 追加（规格 §13.1/A2）：scroll-edge 材质化——顶栏默认 ghost（透明、无
// 发丝线），内容滚动越过阈值才淡入材质。iOS UINavigationBar scroll-edge appearance 范式，
// 消除「常驻封条感」。AppHeader 是 sticky 文档流栏，滚动后内容会从栏下穿过 ⇒ 材质必须
// 滚动驱动而非常驻。
const scrolled = ref(false)
const SCROLL_THRESHOLD = 8
function onScroll() {
  scrolled.value = window.scrollY > SCROLL_THRESHOLD
}
onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
})

function navigate(path: string) {
  router.push(path)
}

// 🔍 切换画廊搜索开合（共享状态，CanvasesPage 消费，见 §7）
function toggleGallerySearch() {
  gallerySearchOpen.value = !gallerySearchOpen.value
}

// ＋ 新建项目（画廊裸栏；复用 useProjectWorkspace 唯一 create 通道 + 20s 超时 + 登录守卫）
async function createProject() {
  if (!auth.isLoggedIn) {
    auth.openLogin()
    return
  }
  const loading = ElMessage({ type: 'info', message: '正在创建画布…', duration: 0 })
  try {
    const created = await create({ timeoutMs: 20_000 })
    loading.close()
    router.push({
      path: `/workflow/${created.id}`,
      query: { openAgent: '1' },
    })
  } catch {
    loading.close()
    ElMessage.error('创建画布失败，请检查网络后重试')
  }
}
</script>

<template>
  <!-- ⛔ 这里曾经是 `border-overlay/5 bg-[#141414]/95`：深色的**死值**，
       浅色主题上线后 header 会继续保持近黑 —— 而 header 正是全站唯一常驻的 chrome。
       改指语义 token 后，深色取值基本不变（canvas #131318 ≈ 旧 #141414）。
       ⚠️ `bg-surface/95` 不生效：CSS 变量类无法做 alpha 合成（见 tailwind.config.js 注释），
       故用不透明底色 + backdrop-blur 保留层次。 -->
  <!-- 2026-10-28 v3（规格 §13.1/A2）：常驻材质退役——默认 ghost 透明，滚动 >8px 才
       淡入材质（is-material）。发丝线随 border-b 移除，材质态用 inset 阴影画分隔
       （阴影只在材质态出现，ghost 态零轮廓）。 -->
  <header
    class="app-header sticky top-0 z-50"
    :class="{ 'is-material': scrolled }"
    style="height: var(--neo-header-height)"
  >
    <div class="mx-auto flex h-full max-w-7xl items-center justify-between px-4 sm:px-6">
      <div class="flex min-w-0 items-center gap-4 sm:gap-8">
        <button class="flex items-center gap-2" @click="navigate('/workflow')">
          <BrandLogo size="sm" show-name />
        </button>

        <!-- 创作/发现 文字导航：画廊裸栏时隐藏（规格 §6.1/§6.7） -->
        <nav v-if="!isGalleryRoute" class="hidden items-center gap-1 md:flex">
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

      <!-- 右簇：画廊裸栏（🔍 + ＋）vs 常规（主题 + 账号） -->
      <template v-if="isGalleryRoute">
        <div class="flex shrink-0 items-center gap-2">
          <button
            type="button"
            class="gallery-icon-btn"
            data-testid="gallery-search-toggle"
            aria-label="搜索项目"
            @click="toggleGallerySearch"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path stroke-linecap="round" d="M21 21l-4.3-4.3" />
            </svg>
          </button>
          <button
            type="button"
            class="gallery-create-btn"
            data-testid="gallery-create"
            aria-label="新建项目"
            @click="createProject"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
              <path stroke-linecap="round" d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      </template>
      <div v-else class="flex shrink-0 items-center gap-2 sm:gap-3">
        <!-- 主题切换提到全站：此前只有画布页有入口，其余 16 条路由进不去。
             ⛔ 品牌页（/workflow）例外：签名画面恒为墨色，不随主题翻转 -->
        <ThemeToggle v-if="!isBrandPage" class="h-8 w-8 rounded-lg text-fg-2 hover:bg-surface-elevated hover:text-fg" />
        <AccountChrome :hide-points="isBrandPage" />
      </div>
    </div>
  </header>
</template>

<style scoped>
/* scroll-edge 材质化（§13.1/A2）：默认融入页面，滚动后内容穿栏才浮现材质。
   iOS scroll-edge appearance 范式；backdrop-filter 从 none 到 blur 的过渡
   部分浏览器不连续，故材质态直接切换 blur、透明度交给 background-color 过渡。 */
.app-header {
  background: transparent;
  transition: background-color 0.25s ease, box-shadow 0.25s ease;
}
.app-header.is-material {
  background: var(--lnk-surface);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  box-shadow: inset 0 -0.5px 0 var(--lnk-border-subtle);
}

/* 画廊裸栏图标钮：44px 命中区（触控达标），视觉 20px 图标 */
.gallery-icon-btn,
.gallery-create-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--lnk-text-primary);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.gallery-icon-btn::after,
.gallery-create-btn::after {
  content: '';
  position: absolute;
  inset: -5px;
}
.gallery-icon-btn svg {
  width: 20px;
  height: 20px;
}
/* ＋ 建项目：紫粉渐变圆盘白加号（与画布左下 FAB 同族视觉，语义=建项目） */
.gallery-create-btn {
  background: var(--lnk-accent-gradient);
  color: var(--lnk-text-on-accent);
}
.gallery-create-btn svg {
  width: 18px;
  height: 18px;
}
.gallery-icon-btn:active,
.gallery-create-btn:active {
  background: color-mix(in srgb, var(--lnk-text-primary) 8%, transparent);
}
.gallery-create-btn:active {
  background: var(--lnk-accent-gradient);
  transform: scale(0.94);
}
</style>
