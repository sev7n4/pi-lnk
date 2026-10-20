<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Work } from '@lnkpi/shared'
import { usersApi } from '@/services/users-api'
import BrandPatternAvatar from '@/components/account/BrandPatternAvatar.vue'
import WorkCard from '@/components/works/WorkCard.vue'

const route = useRoute()
const router = useRouter()
const creatorId = computed(() => route.params.id as string)

const profile = ref<{
  user: { id: string; nickname: string; avatar?: string; workCount: number; createdAt: string }
  works: Work[]
} | null>(null)
const loading = ref(true)

onMounted(async () => {
  try {
    const { data } = await usersApi.getCreator(creatorId.value)
    profile.value = data.data
  } finally {
    loading.value = false
  }
})

const stats = computed(() => {
  const works = profile.value?.works ?? []
  return {
    likes: works.reduce((s, w) => s + w.likes, 0),
    views: works.reduce((s, w) => s + w.views, 0),
  }
})
const joinedDays = computed(() => {
  const createdAt = profile.value?.user.createdAt
  if (!createdAt) return 0
  return Math.max(1, Math.ceil((Date.now() - new Date(createdAt).getTime()) / 86400000))
})
const cover = computed(() => profile.value?.works[0]?.coverUrl ?? null) // works 已按 createdAt desc

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
</script>

<template>
  <div class="mx-auto max-w-7xl px-6 py-10">
    <div v-if="loading" class="animate-pulse space-y-6">
      <div class="h-24 rounded-2xl bg-surface-base" />
      <div class="grid grid-cols-4 gap-4">
        <div v-for="i in 4" :key="i" class="aspect-video rounded-2xl bg-surface-base" />
      </div>
    </div>

    <template v-else-if="profile">
      <!-- 封面区：最新作品英雄位 + scrim；无作品走纹样兜底 -->
      <header
        data-testid="creator-cover"
        class="relative mb-8 flex h-72 items-end overflow-hidden rounded-2xl p-6"
        :style="cover
          ? { backgroundImage: `linear-gradient(to top, rgb(var(--lnk-dim-rgb) / 0.55), transparent 60%), url(${cover})`, backgroundSize: 'cover', backgroundPosition: 'center' }
          : { background: 'var(--lnk-surface-signature)' }"
      />

      <!-- 身份行 -->
      <div data-testid="creator-identity" class="mb-10 flex flex-wrap items-center gap-5">
        <BrandPatternAvatar :src="profile.user.avatar" :seed="profile.user.id" :name="profile.user.nickname" size="lg" />
        <div class="min-w-0">
          <h1 class="text-2xl font-semibold">{{ profile.user.nickname }}</h1>
          <p class="mt-1 text-sm text-fg-3">
            {{ profile.user.workCount }} 作品 · {{ stats.likes }} 获赞 · {{ stats.views }} 浏览 · 加入 {{ joinedDays }} 天
          </p>
        </div>
        <!-- 关注 CTA：P2 随关注 API 交付，此处不渲染 -->
      </div>

      <h2 class="mb-4 text-lg font-medium">全部作品</h2>
      <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <WorkCard
          v-for="work in profile.works"
          :key="work.id"
          :work="{ ...work, authorId: profile.user.id, authorName: profile.user.nickname }"
          @view-work="viewWork"
          @view-watch="viewWatch"
          @view-process="viewProcess"
          @view-author="viewAuthor"
          @view-share="viewShare"
        />
      </div>
      <div v-if="!profile.works.length" class="py-16 text-center">
        <p class="text-base text-fg">这片海域还没有作品</p>
        <RouterLink to="/community" class="btn-ghost mt-3 inline-block text-sm">去社区看看</RouterLink>
      </div>
    </template>

    <p v-else class="py-16 text-center text-sm text-fg-3">创作者不存在</p>
  </div>
</template>
