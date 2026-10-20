<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import type { Work } from '@lnkpi/shared'
import { WORK_CATEGORIES } from '@lnkpi/shared'
import { api } from '@/services/api'
import WorkCard from '@/components/works/WorkCard.vue'
import AppEmptyState from '@/components/common/AppEmptyState.vue'

const router = useRouter()
const works = ref<Work[]>([])
const search = ref('')
// 2026-10-21 P1：分类维度（type）筛选从主页移到这里，成为社区页职责。
// 服务端口径已同步切到 where.type（短片→shortfilm / 画布→canvas）。
const activeCategory = ref<string>('全部')
const loading = ref(false)

async function fetchWorks() {
  loading.value = true
  try {
    const { data } = await api.get<{ data: { items: Work[] } }>('/works', {
      params: {
        search: search.value || undefined,
        // 「全部」传 undefined 而非空串：服务端按 params.category 判空，空串会漏进过滤分支
        category: activeCategory.value === '全部' ? undefined : activeCategory.value,
      },
    })
    works.value = data.data.items
  } catch {
    works.value = []
  } finally {
    loading.value = false
  }
}

function onCategoryChange(cat: string) {
  if (activeCategory.value === cat) return
  activeCategory.value = cat
  void fetchWorks()
}

function viewWork(workId: string) {
  router.push(`/share/${workId}`)
}

function viewWatch(workId: string) {
  router.push(`/share/${workId}`)
}

function viewProcess(workId: string) {
  router.push(`/share/${workId}/process`)
}

function viewAuthor(authorId: string) {
  router.push(`/creator/${authorId}`)
}

function viewShare(workId: string) {
  router.push(`/share/${workId}`)
}

onMounted(fetchWorks)
</script>

<template>
  <div class="mx-auto max-w-7xl px-6 pb-20 pt-8">
    <div class="mb-8 text-center">
      <h1 class="font-display text-3xl font-semibold">超创站</h1>
      <p class="mt-2 text-fg-2">发现社区优秀作品，探索 AI 创作无限可能</p>
    </div>

    <div class="mb-8 flex justify-center">
      <div class="flex w-full max-w-md gap-2">
        <input
          v-model="search"
          class="input-field"
          placeholder="搜索作品..."
          @keydown.enter="fetchWorks"
        />
        <button class="btn-primary" @click="fetchWorks">搜索</button>
      </div>
    </div>

    <div
      class="mb-8 flex flex-wrap justify-center gap-2"
      role="group"
      aria-label="作品分类"
    >
      <button
        v-for="cat in WORK_CATEGORIES"
        :key="cat"
        data-testid="category-chip"
        type="button"
        class="rounded-full px-3 py-1 text-xs transition"
        :class="
          activeCategory === cat
            ? 'bg-accent-subtle text-fg-accent'
            : 'text-fg-3 hover:bg-hover'
        "
        :aria-pressed="activeCategory === cat"
        @click="onCategoryChange(cat)"
      >
        {{ cat }}
      </button>
    </div>

    <div v-if="loading" class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      <div v-for="i in 8" :key="i" class="aspect-video animate-pulse rounded-2xl bg-surface-card" />
    </div>

    <div v-else-if="works.length" class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      <WorkCard
        v-for="work in works"
        :key="work.id"
        :work="work"
        @view-work="viewWork"
        @view-watch="viewWatch"
        @view-process="viewProcess"
        @view-author="viewAuthor"
        @view-share="viewShare"
      />
    </div>

    <AppEmptyState
      v-else
      data-testid="community-empty"
      :desc="search ? '换个关键词试试' : '成为第一个创作者吧'"
    >
      {{ search ? '没有找到相关作品' : '暂无作品' }}
    </AppEmptyState>
  </div>
</template>
