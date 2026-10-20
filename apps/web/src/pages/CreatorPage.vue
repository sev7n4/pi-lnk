<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { Work } from '@lnkpi/shared'
import { usersApi } from '@/services/users-api'
import { useAuthStore } from '@/stores/auth'
import BrandPatternAvatar from '@/components/account/BrandPatternAvatar.vue'
import WorkCard from '@/components/works/WorkCard.vue'
import AppEmptyState from '@/components/common/AppEmptyState.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const creatorId = computed(() => route.params.id as string)

type CreatorUser = {
  id: string
  nickname: string
  avatar?: string
  workCount: number
  followersCount: number
  followingCount: number
  pinnedWorkIds: string[]
  createdAt: string
}

const profile = ref<{ user: CreatorUser; works: Work[] } | null>(null)
const loading = ref(true)

// ---------------------------------------------------------------- 关注态
const following = ref(false)
const followersCount = ref(0)
const followPending = ref(false)

const isMe = computed(() => auth.isLoggedIn && auth.user?.id === creatorId.value)

onMounted(async () => {
  try {
    const { data } = await usersApi.getCreator(creatorId.value)
    profile.value = data.data
    followersCount.value = data.data.user.followersCount
    // 本人访问不查relation（既没关注按钮可点，查了纯浪费一次请求）
    if (auth.isLoggedIn && !isMe.value) {
      try {
        const rel = await usersApi.relation(creatorId.value)
        following.value = rel.data.data.following
      } catch {
        following.value = false
      }
    }
  } finally {
    loading.value = false
  }
})

async function toggleFollow() {
  if (!auth.isLoggedIn) {
    // 双闸的客户端侧：游客点关注走登录引导，不发请求（避免裸 401 弹错）
    auth.openLogin()
    return
  }
  if (followPending.value) return
  followPending.value = true
  const prevFollowing = following.value
  const prevCount = followersCount.value
  // 乐观更新，失败回滚——等待往返会让按钮像卡住
  following.value = !prevFollowing
  followersCount.value = prevCount + (prevFollowing ? -1 : 1)
  try {
    const { data } = prevFollowing
      ? await usersApi.unfollow(creatorId.value)
      : await usersApi.follow(creatorId.value)
    following.value = data.data.following
    followersCount.value = data.data.followersCount
  } catch {
    following.value = prevFollowing
    followersCount.value = prevCount
    ElMessage.error('操作失败，请稍后重试')
  } finally {
    followPending.value = false
  }
}

// ------------------------------------------------------- 置顶 + 分组（P2）
type WorkTab = '全部' | '短片' | '画布' | '系列'
const WORK_TABS: WorkTab[] = ['全部', '短片', '画布', '系列']
const activeTab = ref<WorkTab>('全部')

const worksById = computed(() => new Map((profile.value?.works ?? []).map((w) => [w.id, w])))

/** 置顶作品（按作者选择顺序；已下架/不在前48 条里的静默跳过）。 */
const pinnedWorks = computed(() =>
  (profile.value?.user.pinnedWorkIds ?? [])
    .map((id) => worksById.value.get(id))
    .filter((w): w is Work => Boolean(w)),
)

const pinnedIds = computed(() => new Set(pinnedWorks.value.map((w) => w.id)))

/** 网格作品：置顶的已提升到置顶区，不在网格里重复出现。 */
const gridWorks = computed(() => {
  const all = (profile.value?.works ?? []).filter((w) => !pinnedIds.value.has(w.id))
  switch (activeTab.value) {
    case '短片':
      return all.filter((w) => w.type === 'shortfilm')
    case '画布':
      return all.filter((w) => w.type === 'canvas')
    case '系列':
      return all.filter((w) => Boolean(w.category))
    default:
      return all
  }
})

async function togglePin(workId: string) {
  if (!isMe.value || profile.value === null) return
  const current = profile.value.user.pinnedWorkIds
  const next = current.includes(workId)
    ? current.filter((id) => id !== workId)
    : [...current, workId]
  try {
    const { data } = await usersApi.setPinnedWorks(next)
    // 以服务端回读为准：上限/归属校验只有服务端能真正保证
    profile.value.user.pinnedWorkIds = data.data.pinnedWorkIds
    ElMessage.success(data.data.pinnedWorkIds.includes(workId) ? '已置顶' : '已取消置顶')
  } catch {
    // 失败不动本地态：置顶区宁可少一张，也不能显示服务端没接受的位置
    ElMessage.error('置顶失败，请稍后重试')
  }
}

// ------------------------------------------------------------------ 既有
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
            {{ profile.user.workCount }} 作品 · {{ stats.likes }} 获赞 · {{ stats.views }} 浏览 · {{ followersCount }} 粉丝 · 加入 {{ joinedDays }} 天
          </p>
        </div>
        <span class="flex-1" />
        <!-- 本人：去编辑资料；他人：关注 CTA（游客点击走登录引导） -->
        <RouterLink
          v-if="isMe"
          data-testid="edit-profile"
          to="/profile"
          class="btn-ghost text-sm"
        >
          编辑资料
        </RouterLink>
        <button
          v-else
          data-testid="follow-btn"
          type="button"
          class="text-sm"
          :class="following ? 'btn-ghost' : 'btn-primary'"
          :disabled="followPending"
          @click="toggleFollow"
        >
          {{ following ? '已关注' : '关注' }}
        </button>
      </div>

      <!-- 置顶精选：非作者只读；作者有取消置顶控件 -->
      <section v-if="pinnedWorks.length" data-testid="pinned-section" class="mb-10">
        <h2 class="mb-4 text-lg font-medium">置顶精选</h2>
        <div class="grid gap-4">
          <div
            v-for="work in pinnedWorks"
            :key="work.id"
            class="group relative overflow-hidden rounded-2xl border border-line-subtle"
            style="aspect-ratio: 2.35 / 1"
          >
            <button type="button" class="block h-full w-full" @click="viewWork(work.id)">
              <img
                v-if="work.coverUrl"
                :src="work.coverUrl"
                :alt="work.title"
                class="h-full w-full object-cover"
              >
              <span
                class="absolute bottom-3 left-4 text-right text-base font-semibold"
                style="color: var(--lnk-text-on-signature)"
              >
                {{ work.title }}
              </span>
            </button>
            <button
              v-if="isMe"
              data-testid="pin-toggle"
              type="button"
              class="absolute right-3 top-3 rounded-lg px-2.5 py-1 text-xs"
              style="background: var(--lnk-surface-overlay)"
              @click.stop="togglePin(work.id)"
            >
              取消置顶
            </button>
          </div>
        </div>
      </section>

      <!-- 分组 Tab -->
      <div class="mb-6 flex gap-2" role="tablist" aria-label="作品分组">
        <button
          v-for="tab in WORK_TABS"
          :key="tab"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab"
          class="rounded-full px-3 py-1 text-xs transition"
          :class="activeTab === tab ? 'bg-accent-subtle text-fg-accent' : 'text-fg-3 hover:bg-hover'"
          @click="activeTab = tab"
        >
          {{ tab }}
        </button>
      </div>

      <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <div v-for="work in gridWorks" :key="work.id" class="group relative">
          <WorkCard
            :work="{ ...work, authorId: profile.user.id, authorName: profile.user.nickname }"
            @view-work="viewWork"
            @view-watch="viewWatch"
            @view-process="viewProcess"
            @view-author="viewAuthor"
            @view-share="viewShare"
          />
          <!-- 置顶控件仅作者本人可见（双闸的客户端侧） -->
          <button
            v-if="isMe"
            data-testid="pin-toggle"
            type="button"
            class="absolute right-3 top-3 rounded-lg px-2.5 py-1 text-xs opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
            style="background: var(--lnk-surface-overlay)"
            @click.stop="togglePin(work.id)"
          >
            置顶
          </button>
        </div>
      </div>

      <AppEmptyState v-if="!gridWorks.length" data-testid="creator-empty">
        {{ activeTab === '全部' ? '这片海域还没有作品' : '该分组下还没有作品' }}
        <template #desc>
          {{ activeTab === '全部' ? '成为首位发布作品的访客' : '换个分组看看，或发布你的第一件作品' }}
        </template>
        <template #action>
          <RouterLink to="/community" class="btn-ghost text-sm">去社区看看</RouterLink>
        </template>
      </AppEmptyState>
    </template>

    <p v-else class="py-16 text-center text-sm text-fg-3">创作者不存在</p>
  </div>
</template>
