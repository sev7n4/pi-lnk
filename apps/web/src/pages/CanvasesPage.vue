<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useProjectManager } from '@/composables/useProjectManager'
import { useProjectWorkspace } from '@/composables/useProjectWorkspace'
import type { ProjectCard } from '@/composables/useProjectWorkspace'
import SessionCard from '@/components/workflow/SessionCard.vue'
import AppEmptyState from '@/components/common/AppEmptyState.vue'
import type { Session } from '@lnkpi/shared'
import { ElMessage } from 'element-plus'

/**
 * 创作首页（2026-10-21 P1 从 WorkflowPage 迁出；2026-10-23 IA v4：
 * 画布+对话=项目，本页即「我的项目」全量管理；2026-10-26 规格收敛 v2：
 * 数据面切 useProjectWorkspace 单源（INV-10），管理状态机由 useProjectManager 承载。
 *
 * 本页承接完整能力：全量列表 / 搜索 / 多选批删 / 重命名 / 复制 / 删除 / 新建。
 */
const router = useRouter()
const auth = useAuthStore()
const mgr = useProjectManager()
// 2026-10-25 PR-2：创建通道收敛到 useProjectWorkspace（全仓唯一 create 通道）。
const { create: createProject, list: listProjects } = useProjectWorkspace()

async function openCanvas(sessionId: string) {
  router.push(`/workflow/${sessionId}`)
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

onMounted(() => {
  void listProjects()   // 进首页强制新鲜：管理页要可管的真数据，不走 loadIfStale
})
</script>

<template>
  <div class="mx-auto max-w-7xl px-6 pb-20 pt-8">
    <div class="mb-6 flex flex-wrap items-center gap-3">
      <div class="mr-auto">
        <h1 class="font-display text-2xl font-semibold text-fg">我的项目</h1>
        <p class="mt-1 text-sm text-fg-3">搜索、整理、批量管理你的全部项目</p>
      </div>
      <RouterLink to="/workflow" class="btn-ghost text-sm">← 返回主页</RouterLink>
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
        class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
      >
        <SessionCard
          v-for="session in mgr.filtered.value"
          :key="session.id"
          class="session-card-menu-anchor"
          :session="session as unknown as Session"
          :manage-mode="mgr.manageMode.value"
          :selected="mgr.selectedIds.value.includes(session.id)"
          :menu-open="mgr.openMenuId.value === session.id"
          @open="openCanvas(session.id)"
          @toggle-menu="mgr.toggleMenu(session.id)"
          @rename="mgr.renameProject(session as unknown as ProjectCard)"
          @duplicate="mgr.duplicateProject(session.id)"
          @delete="mgr.removeProject(session as unknown as ProjectCard)"
          @toggle-select="mgr.toggleSelect(session.id)"
        />
      </div>

      <AppEmptyState
        v-else-if="mgr.search.value"
        data-testid="canvases-empty-search"
        desc="换个关键词试试，或清空搜索条件"
      >
        没有匹配的项目
      </AppEmptyState>

      <AppEmptyState
        v-else
        data-testid="canvases-empty"
        desc="创建第一个项目，开始创作"
      >
        还没有项目
        <template #action>
          <button
            v-if="auth.isLoggedIn"
            data-testid="canvases-create"
            type="button"
            class="btn-primary text-sm"
            @click="createCanvas"
          >
            新建项目
          </button>
        </template>
      </AppEmptyState>
    </template>
  </div>
</template>
