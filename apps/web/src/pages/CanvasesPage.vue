<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { sessionsApi } from '@/services/sessions-api'
import { useAuthStore } from '@/stores/auth'
import { useMySessions } from '@/composables/useMySessions'
import SessionCard from '@/components/workflow/SessionCard.vue'
import type { Session } from '@lnkpi/shared'

/**
 * 画布管理器（2026-10-21 P1 从 WorkflowPage 迁出）。
 *
 * 主页只留 compact 区（5 个 + 「查看全部」→本页）；本页承接完整能力：
 * 全量列表 / 搜索 / 多选批删 / 重命名 / 复制 / 删除 / 新建。逻辑全在
 * `useMySessions` 组合式里，与主页共用单点维护。
 */
const router = useRouter()
const auth = useAuthStore()
const sessions = useMySessions()

async function openCanvas(sessionId: string) {
  router.push(`/workflow/${sessionId}`)
}

async function createCanvas() {
  if (!auth.isLoggedIn) {
    auth.openLogin()
    return
  }
  try {
    const { data } = await sessionsApi.create({ title: '未命名画布' })
    router.push({
      path: `/workflow/${data.data.id}`,
      query: { openAgent: '1' },
    })
  } catch {
    router.push('/workflow')
  }
}

onMounted(() => {
  void sessions.fetch()
})
</script>

<template>
  <div class="mx-auto max-w-7xl px-6 pb-20 pt-8">
    <div class="mb-6 flex flex-wrap items-center gap-3">
      <div class="mr-auto">
        <h1 class="font-display text-2xl font-semibold text-fg">我的画布</h1>
        <p class="mt-1 text-sm text-fg-3">搜索、整理、批量管理你的全部画布</p>
      </div>
      <RouterLink to="/workflow" class="btn-ghost text-sm">← 返回主页</RouterLink>
      <button
        v-if="auth.isLoggedIn"
        data-testid="canvases-create"
        type="button"
        class="btn-primary text-sm"
        @click="createCanvas"
      >
        新建画布
      </button>
    </div>

    <div v-if="!auth.isLoggedIn" class="py-20 text-center">
      <p class="mb-4 text-sm text-fg-3">登录后查看你的画布</p>
      <button data-testid="canvases-login" type="button" class="btn-primary" @click="auth.openLogin()">
        登录
      </button>
    </div>

    <template v-else>
      <div class="mb-4 flex flex-wrap items-center gap-3">
        <span v-if="sessions.mySessions.value.length" class="text-xs text-fg-3">
          {{ sessions.filteredSessions.value.length }} 个
        </span>
        <span class="flex-1" />
        <input
          v-if="sessions.mySessions.value.length"
          data-testid="canvases-search"
          :value="sessions.sessionSearch.value"
          type="search"
          class="input-field w-48 text-xs"
          placeholder="搜索画布..."
          @input="sessions.sessionSearch.value = ($event.target as HTMLInputElement).value"
        />
        <button
          v-if="sessions.mySessions.value.length"
          data-testid="canvases-manage"
          type="button"
          class="rounded-lg px-2.5 py-1.5 text-xs transition"
          :class="
            sessions.manageSessions.value
              ? 'bg-accent-subtle text-fg-accent'
              : 'text-fg-3 hover:bg-hover'
          "
          @click="sessions.toggleManage()"
        >
          {{ sessions.manageSessions.value ? '完成' : '管理' }}
        </button>
        <button
          v-if="sessions.manageSessions.value && sessions.selectedSessionIds.value.length"
          data-testid="canvases-batch-delete"
          type="button"
          class="rounded-lg bg-danger-bg px-2.5 py-1.5 text-xs text-danger transition hover:bg-danger-bg-hover"
          @click="sessions.batchDelete()"
        >
          删除选中 ({{ sessions.selectedSessionIds.value.length }})
        </button>
      </div>

      <div
        v-if="sessions.loading.value"
        class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
      >
        <div
          v-for="i in 6"
          :key="i"
          class="aspect-[4/3] animate-pulse rounded-2xl bg-surface-base"
        />
      </div>

      <div
        v-else-if="sessions.visibleSessions(Number.POSITIVE_INFINITY).length"
        class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
      >
        <SessionCard
          v-for="session in sessions.visibleSessions(Number.POSITIVE_INFINITY)"
          :key="session.id"
          class="session-card-menu-anchor"
          :session="session as Session"
          :manage-mode="sessions.manageSessions.value"
          :selected="sessions.selectedSessionIds.value.includes(session.id)"
          :menu-open="sessions.openMenuId.value === session.id"
          @open="openCanvas(session.id)"
          @toggle-menu="sessions.toggleMenu(session.id)"
          @rename="sessions.rename(session as Session)"
          @duplicate="sessions.duplicate(session as Session)"
          @delete="sessions.remove(session as Session)"
          @toggle-select="sessions.toggleSelect(session.id)"
        />
      </div>

      <p
        v-else-if="sessions.sessionSearch.value"
        class="py-8 text-center text-sm text-fg-3"
      >
        没有匹配的画布
      </p>

      <p v-else class="py-20 text-center text-sm text-fg-3">
        还没有画布，去创建一个吧
      </p>
    </template>
  </div>
</template>
