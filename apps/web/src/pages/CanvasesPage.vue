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
import { ElMessage } from 'element-plus'

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
const { create: createProject, list: listProjects, loadIfStale, error: wsError } = useProjectWorkspace()

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

async function createCanvas() {
  if (!auth.isLoggedIn) {
    auth.openLogin()
    return
  }
  // 2026-10-24 修复（fix/createcanvas-guard）：失败不再静默回主页（用户只看到无反应），
  // 改为明确报错 + 20s 客户端超时（默认 120s）避免上百秒零反馈。
  // ⚠️ 2026-10-25 PR-2：通道换成 useProjectWorkspace.create（唯一 create 通道），
  //    但**20s 超时必须显式带过去**——收敛时最容易丢的就是它。
  const loading = ElMessage({ type: 'info', message: '正在创建画布…', duration: 0 })
  try {
    const created = await createProject({ timeoutMs: 20_000 })
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
    <div class="mb-6 flex flex-wrap items-center gap-3">
      <div class="mr-auto">
        <h1 class="font-display text-2xl font-semibold text-fg">创作首页</h1>
        <p class="mt-1 text-sm text-fg-3">继续你的创作</p>
      </div>
      <button
        v-if="auth.isLoggedIn"
        data-testid="canvases-create"
        type="button"
        class="btn-primary text-sm"
        @click="createCanvas"
      >
        新建项目
      </button>
    </div>

    <div v-if="!auth.isLoggedIn" class="py-20 text-center">
      <p class="mb-4 text-sm text-fg-3">登录后查看你的项目</p>
      <button data-testid="canvases-login" type="button" class="btn-primary" @click="auth.openLogin()">
        登录
      </button>
    </div>

    <template v-else>
      <div class="mb-4 flex flex-wrap items-center gap-3">
        <span v-if="mgr.projects.value.length" class="text-xs text-fg-3">
          {{ mgr.filtered.value.length }} 个
        </span>
        <span class="flex-1" />
        <input
          v-if="mgr.projects.value.length"
          data-testid="canvases-search"
          :value="mgr.search.value"
          type="search"
          class="input-field w-48 text-xs"
          placeholder="搜索项目..."
          @input="mgr.search.value = ($event.target as HTMLInputElement).value"
        />
        <button
          v-if="mgr.projects.value.length"
          data-testid="canvases-manage"
          type="button"
          class="rounded-lg px-2.5 py-1.5 text-xs transition"
          :class="
            mgr.manageMode.value
              ? 'bg-accent-subtle text-fg-accent'
              : 'text-fg-3 hover:bg-hover'
          "
          @click="mgr.toggleManage()"
        >
          {{ mgr.manageMode.value ? '完成' : '管理' }}
        </button>
        <button
          v-if="mgr.manageMode.value && mgr.selectedIds.value.length"
          data-testid="canvases-batch-delete"
          type="button"
          class="rounded-lg bg-danger-bg px-2.5 py-1.5 text-xs text-danger transition hover:bg-danger-bg-hover"
          @click="mgr.batchDelete()"
        >
          删除选中 ({{ mgr.selectedIds.value.length }})
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
          <!-- 封面 40px：coverUrl 三态（image / CanvasCoverFallback 兜底） -->
          <button
            type="button"
            class="flex h-10 w-10 shrink-0 items-center overflow-hidden rounded-lg bg-surface-sunken"
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

      <!-- 真无项目：仅此处提示，新建入口统一在顶栏（data-testid="canvases-create" 全局唯一） -->
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
