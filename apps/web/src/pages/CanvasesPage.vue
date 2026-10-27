<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useProjectManager } from '@/composables/useProjectManager'
import { useProjectWorkspace } from '@/composables/useProjectWorkspace'
import CanvasCoverFallback from '@/components/workflow/CanvasCoverFallback.vue'
import { projectCoverFallback } from '@/utils/projectCoverFallback'
import { displayCanvasTitle } from '@/utils/displayCanvasTitle'
import AppEmptyState from '@/components/common/AppEmptyState.vue'

/**
 * 创作首页（2026-10-21 P1 从 WorkflowPage 迁出；2026-10-23 IA v4：
 * 画布+对话=项目，本页即「我的项目」全量管理；2026-10-26 规格收敛 v2：
 * 数据面切 useProjectWorkspace 单源（INV-10），管理状态机由 useProjectManager 承载；
 * 列表形态 = 微信式单行卡（Task 5）：[封面 40px][名称][相对时间]，行内菜单管理。
 *
 * 本页承接完整能力：全量列表 / 搜索 / 多选批删 / 重命名 / 复制 / 删除 / 新建。
 */
const router = useRouter()
const auth = useAuthStore()
const mgr = useProjectManager()
// 2026-10-25 PR-2：创建通道收敛到 useProjectWorkspace（全仓唯一 create 通道）。
// 2026-10-27 v2.2：补取 `error`（模块级单例，与 mgr.projects 同源），
// 用于区分「加载失败」与「真无项目」两种空态（D12 / 修 bug④）。
const { list: listProjects, loadIfStale, error: wsError, gallerySearchOpen } = useProjectWorkspace()

/** 打开项目：封面节点存在时带 focusNode 深链（CanvasPage:1962 消费 query）。 */
function openCanvas(p: { id: string; coverNodeId: string | null }) {
  router.push({
    path: `/workflow/${p.id}`,
    query: p.coverNodeId ? { focusNode: p.coverNodeId } : {},
  })
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / M 月 N 日（承作品带口径）。 */
function relativeTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = Math.max(0, Date.now() - t)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const d = new Date(t)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/** 长按项目卡进入多选态（规格 §7：原「管理」常驻按钮退役，改为长按进入）。
 * 仅在已有项目时；短按（<450ms）不触发，不干扰点击开画布。 */
let longPressTimer: ReturnType<typeof setTimeout> | null = null
function startCardLongPress(id: string) {
  if (!mgr.projects.value.length) return
  cancelCardLongPress()
  longPressTimer = setTimeout(() => {
    if (!mgr.manageMode.value) mgr.toggleManage()
    if (!mgr.selectedIds.value.includes(id)) mgr.toggleSelect(id)
  }, 450)
}
function cancelCardLongPress() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

// 2026-10-27 v2.3（真机复测实证）：auth 是异步恢复的——刷新 /canvases 时挂载瞬间
// isLoggedIn 还是 false，若用 onMounted 静态快照判断，恢复完成后无人补发请求
// ⇒ 「已登录视图 + 零数据 + 零请求」⇒ 误报「还没有项目」（生产 nginx 日志实证：
// /canvases 刷新后零条 /api/agent/canvas/list，而 list 服务端 200 返回 22KB 全量数据）。
// 改为响应式 watch：挂载时已登录立即拉；恢复完成 false→true 时补拉。
// loadIfStale 的 fresh 判定 + single-flight 保证不会重复打接口。
watch(
  () => auth.isLoggedIn,
  (loggedIn) => {
    if (!loggedIn) return
    // 2026-10-27 v2.2（bug③ 加固）：优先复用已在内存的清单（loadIfStale），
    // 避免在「连接被画布 SSE 占满」的画布页返回时，再排队一次注定 15s 超时的请求
    // ⇒ 返回秒开、不再闪空白；数据新鲜期内不重复打接口，过期才真拉。
    void loadIfStale()
  },
  { immediate: true },
)

/** 行卡视图：预解析封面三态（模板内两次独立调用无法做类型窄化）。 */
const rows = computed(() =>
  mgr.filtered.value.map((p) => ({ ...p, cover: projectCoverFallback(p) })),
)
</script>

<template>
  <div class="mx-auto max-w-7xl px-6 pb-20 pt-8">
    <!-- 标题行：创作空间 · N 个（顶栏职责已移交 AppHeader 裸栏；规格 §6.1） -->
    <div class="mb-4 flex items-center gap-3">
      <h2 class="text-base font-medium text-fg-2">
        创作空间<span v-if="mgr.projects.value.length" class="ml-1 text-sm font-normal text-fg-3">· {{ mgr.projects.value.length }} 个</span>
      </h2>
      <span class="flex-1" />
      <button
        v-if="gallerySearchOpen"
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-fg-3 transition hover:bg-hover hover:text-fg"
        data-testid="canvases-search-close"
        aria-label="关闭搜索"
        @click="gallerySearchOpen = false"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>

    <!-- 搜索输入：仅在 AppHeader 🔍 展开时出现（共享 gallerySearchOpen，规格 §7） -->
    <input
      v-if="gallerySearchOpen"
      data-testid="canvases-search"
      :value="mgr.search.value"
      type="search"
      class="input-field mb-4 w-full text-xs"
      placeholder="搜索项目..."
      @input="mgr.search.value = ($event.target as HTMLInputElement).value"
    />

    <div v-if="!auth.isLoggedIn" class="py-20 text-center">
      <p class="mb-4 text-sm text-fg-3">登录后查看你的项目</p>
      <button data-testid="canvases-login" type="button" class="btn-primary" @click="auth.openLogin()">
        登录
      </button>
    </div>

    <template v-else>
      <!-- 多选态动作条：仅 manageMode 时出现（替代原常驻「管理」按钮；规格 §7） -->
      <div v-if="mgr.manageMode.value" class="mb-3 flex items-center gap-3">
        <span class="text-xs text-fg-3">已选 {{ mgr.selectedIds.value.length }} 项</span>
        <span class="flex-1" />
        <button
          v-if="mgr.selectedIds.value.length"
          data-testid="canvases-batch-delete"
          type="button"
          class="rounded-lg bg-danger-bg px-2.5 py-1.5 text-xs text-danger transition hover:bg-danger-bg-hover"
          @click="mgr.batchDelete()"
        >
          删除选中 ({{ mgr.selectedIds.value.length }})
        </button>
        <button
          data-testid="canvases-manage-done"
          type="button"
          class="rounded-lg px-2.5 py-1.5 text-xs transition"
          :class="mgr.manageMode.value ? 'bg-accent-subtle text-fg-accent' : 'text-fg-3 hover:bg-hover'"
          @click="mgr.toggleManage()"
        >
          完成
        </button>
      </div>

      <div
        v-if="mgr.loading.value"
        class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
      >
        <div
          v-for="i in 6"
          :key="i"
          class="aspect-[4/3] animate-pulse rounded-2xl bg-surface-base"
        />
      </div>

      <div
        v-else-if="mgr.filtered.value.length"
        class="flex flex-col gap-2"
      >
        <div
          v-for="p in rows"
          :key="p.id"
          class="session-card-menu-anchor flex items-center gap-3 rounded-xl border border-line bg-surface-base px-3 py-2 transition hover:bg-hover"
          @pointerdown="startCardLongPress(p.id)"
          @pointerup="cancelCardLongPress"
          @pointerleave="cancelCardLongPress"
          @pointercancel="cancelCardLongPress"
        >
          <!-- 管理模式：选择框占据行首 -->
          <button
            v-if="mgr.manageMode.value"
            data-testid="canvases-row-select"
            type="button"
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs transition"
            :class="
              mgr.selectedIds.value.includes(p.id)
                ? 'border-transparent bg-accent-subtle text-fg-accent'
                : 'border-line text-transparent hover:bg-hover'
            "
            :aria-pressed="mgr.selectedIds.value.includes(p.id)"
            @click="mgr.toggleSelect(p.id)"
          >
            ✓
          </button>
          <!-- 封面 40px：coverUrl 三态（image / CanvasCoverFallback 兜底）。
               ⛔ `relative` 不是装饰：CanvasCoverFallback 根元素是 `absolute inset-0`，
               缺它时兜底层会锚定到 App 壳的 main.relative ⇒ 被拉成全屏墨点纸，
               把整个创作首页盖成黑屏（2026-10-27 生产取证实证，v2.4 修复）。 -->
          <button
            type="button"
            class="relative flex h-10 w-10 shrink-0 items-center overflow-hidden rounded-lg bg-surface-sunken"
            @click="mgr.manageMode.value ? mgr.toggleSelect(p.id) : openCanvas(p)"
          >
            <img
              v-if="p.cover.type === 'image'"
              :src="p.cover.value"
              class="h-full w-full object-cover"
              alt=""
            />
            <CanvasCoverFallback v-else :seed="p.id" />
          </button>
          <!-- 名称 -->
          <button
            type="button"
            class="min-w-0 flex-1 truncate text-left text-sm text-fg"
            @click="mgr.manageMode.value ? mgr.toggleSelect(p.id) : openCanvas(p)"
          >
            {{ displayCanvasTitle(p.title) }}
          </button>
          <!-- 相对时间 -->
          <span class="shrink-0 text-xs text-fg-3">{{ relativeTime(p.updatedAt) }}</span>
          <!-- 行内菜单（管理模式下隐藏，选择语义优先） -->
          <div v-if="!mgr.manageMode.value" class="relative">
            <button
              data-testid="canvases-row-menu"
              type="button"
              class="flex h-7 w-7 items-center justify-center rounded-lg text-fg-3 transition hover:bg-hover hover:text-fg"
              aria-label="项目操作"
              @click.stop="mgr.toggleMenu(p.id)"
            >
              ⋯
            </button>
            <div
              v-if="mgr.openMenuId.value === p.id"
              class="absolute right-0 top-8 z-10 w-28 overflow-hidden rounded-xl border border-line bg-surface-base py-1 shadow-lg"
            >
              <button
                type="button"
                class="block w-full px-3 py-1.5 text-left text-xs text-fg transition hover:bg-hover"
                @click="mgr.renameProject(p)"
              >
                重命名
              </button>
              <button
                type="button"
                class="block w-full px-3 py-1.5 text-left text-xs text-fg transition hover:bg-hover"
                @click="mgr.duplicateProject(p.id)"
              >
                创建副本
              </button>
              <button
                type="button"
                class="block w-full px-3 py-1.5 text-left text-xs text-danger transition hover:bg-hover"
                @click="mgr.removeProject(p)"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      </div>

      <AppEmptyState
        v-else-if="mgr.search.value"
        data-testid="canvases-empty-search"
        desc="换个关键词试试，或清空搜索条件"
      >
        没有匹配的项目
      </AppEmptyState>

      <!-- 加载失败（v2.3：并入主链，与骨架/列表/空态互斥。此前独立 v-if 与主链并行，
           loading 中空态 v-else 会同时渲染「还没有项目」（双链缺陷）。
           单链走到这里时 filtered 空且非 search 态：wsError=true ⇒ 失败；否则真无项目。 -->
      <AppEmptyState
        v-else-if="wsError"
        data-testid="canvases-load-error"
        desc="网络异常，项目加载失败"
      >
        项目加载失败
        <template #action>
          <button
            data-testid="canvases-retry"
            type="button"
            class="btn-primary text-sm"
            @click="() => void listProjects()"
          >
            重试
          </button>
        </template>
      </AppEmptyState>

      <!-- 真无项目：仅此处提示，新建入口统一在 AppHeader 裸栏（data-testid="gallery-create" 全局唯一） -->
      <AppEmptyState
        v-else
        data-testid="canvases-empty"
        desc="创建第一个项目，开始创作"
      >
        还没有项目
      </AppEmptyState>
    </template>
  </div>
</template>
