<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { Work } from '@lnkpi/shared'
import { api } from '@/services/api'
import { sessionsApi } from '@/services/sessions-api'
import { useAuthStore } from '@/stores/auth'
import { useSessionRedirect } from '@/composables/useSessionRedirect'
import { useAgentMobileLayout } from '@/composables/useAgentMobileLayout'
import { useMySessions } from '@/composables/useMySessions'
import { canvasApi } from '@/services/canvas-api'
import WorkCard from '@/components/works/WorkCard.vue'
import SessionCard from '@/components/workflow/SessionCard.vue'
import PublishNeoTVDialog from '@/components/works/PublishNeoTVDialog.vue'
import SignatureHero from '@/components/workflow/SignatureHero.vue'
import type { Session } from '@lnkpi/shared'

const router = useRouter()
const auth = useAuthStore()
useSessionRedirect()

/** IA v3.1（2026-10-19 用户裁决）：移动端初始化入口 =【对话】页 + 默认项目。
 *  移动端访问主站 /workflow：有项目 → 整页进最近项目（list 按 updatedAt desc）；
 *  无项目 → 静默新建默认空白项目再进入（1 画布，CanvasPage 挂载后 bootstrapThread
 *  自动建首个对话）。未登录/网络失败留在主站不打断。 */
const { isMobileLayout } = useAgentMobileLayout()
let mobileEntryDispatched = false
watch(
  isMobileLayout,
  (mobile) => {
    if (!mobile || mobileEntryDispatched) return
    mobileEntryDispatched = true
    void (async () => {
      try {
        const res = await canvasApi.list()
        const list = (res.data?.data ?? []) as Array<{ id: string }>
        if (list.length) {
          window.location.assign(`/workflow/${list[0].id}`)
          return
        }
        const created = await canvasApi.create()
        const createdId = (created.data?.data as { id?: string } | undefined)?.id
        if (createdId) window.location.assign(`/workflow/${createdId}`)
      } catch {
        /* 留在主站 */
      }
    })()
  },
  { immediate: true },
)

const prompt = ref('')
const works = ref<Work[]>([])
// 2026-10-21 P1：主页只留一行精选（4 张），完整作品流移至 /community。
// 分类筛选（activeCategory）随之撤出——分类维度由 type 决定，属社区页职责。
const FEATURED_WORKS_COUNT = 4
const loading = ref(false)
const showPublish = ref(false)
const userSessions = ref<Session[]>([])

// 2026-10-21 P1：会话管理逻辑整体迁到 composables/useMySessions.ts，
// 主页只消费 compact 视图（COMPACT_SESSIONS_COUNT 个 + 「查看全部」→ /canvases）。
const sessions = useMySessions()
const COMPACT_SESSIONS_COUNT = 5

// 精选行：只取最新 4 条。「去发现 →」把完整作品流交给 /community。
const featuredWorks = computed(() => works.value.slice(0, FEATURED_WORKS_COUNT))

const greeting = getGreeting()

function handlePublishLocateNode(payload: { sessionId: string; nodeId: string }) {
  showPublish.value = false
  void router.push({
    name: 'canvas',
    params: { sessionId: payload.sessionId },
    query: { focusNode: payload.nodeId },
  })
}
function getGreeting() {
  const hour = new Date().getHours()
  if (hour < 12) return '上午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

function getMockWorks(): Work[] {
  const covers = [
    'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&q=80',
    'https://images.unsplash.com/photo-1635070041078-e363dbe005cb?w=800&q=80',
    'https://images.unsplash.com/photo-1620641788421-7a1c342ea42e?w=800&q=80',
    'https://images.unsplash.com/photo-1614728263932-097ed562d636?w=800&q=80',
    'https://images.unsplash.com/photo-1558591710-4b4a1ae0f04d?w=800&q=80',
    'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=800&q=80',
    'https://images.unsplash.com/photo-1557683316-973673baf926?w=800&q=80',
    'https://images.unsplash.com/photo-1614850523459-c2f4c699c52e?w=800&q=80',
  ]
  const titles = ['浮光·火星激战', '元启录', '万物生：问心', '末日乐园改编', '绝尘', '救赎：长河余烬', '断线', '风起陇西']
  const authors = ['创作者A', '创作者B', '创作者C', '创作者D', '创作者E', '创作者F', '创作者G', '创作者H']

  return titles.map((title, i) => ({
    id: String(i + 1),
    title,
    coverUrl: covers[i],
    type: (i % 3 === 0 ? 'shortfilm' : 'canvas') as Work['type'],
    authorId: String(i),
    authorName: authors[i],
    sessionId: `session-${i + 1}`,
    likes: Math.floor(Math.random() * 1000),
    views: Math.floor(Math.random() * 5000),
    createdAt: new Date().toISOString(),
  }))
}

async function fetchWorks() {
  loading.value = true
  try {
    // 2026-10-21 P1：主页不再有分类筛选（分类维度移至 /community），
    // 故category 参数整体撤掉，只拉默认最新作品供精选行取用。
    const { data } = await api.get<{ data: { items: Work[] } }>('/works')
    works.value = data.data.items
  } catch {
    works.value = getMockWorks()
  } finally {
    loading.value = false
  }
}

function openCanvas(sessionId: string) {
  router.push(`/workflow/${sessionId}`)
}

async function createCanvas() {
  if (!auth.isLoggedIn) {
    auth.openLogin()
    return
  }
  try {
    const { data } = await sessionsApi.create({
      title: prompt.value || '未命名画布',
    })
    router.push({
      path: `/workflow/${data.data.id}`,
      query: {
        openAgent: '1',
        ...(prompt.value.trim() ? { initialPrompt: prompt.value.trim() } : {}),
      },
    })
  } catch {
    router.push(`/workflow/demo-${Date.now()}`)
  }
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

async function openPublish() {
  if (!auth.isLoggedIn) {
    auth.openLogin()
    return
  }
  try {
    const { data } = await sessionsApi.list()
    userSessions.value = data.data
    if (!userSessions.value.length) {
      await createCanvas()
      return
    }
    showPublish.value = true
  } catch {
    auth.openLogin()
  }
}

onMounted(() => {
  fetchWorks()
  // 组合式内部已在 onMounted 里注册 pointerdown 监听并首fetch，此处只需首拉
  void sessions.fetch()
})

watch(
  () => auth.isLoggedIn,
  () => {
    void sessions.fetch()
  },
)
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 pb-20 pt-6 sm:px-6 sm:pt-8">
    <section class="mb-10 sm:mb-12">
      <SignatureHero
        v-model="prompt"
        :greeting="greeting"
        @create="createCanvas"
      />
    </section>

    <!-- 我的画布：compact 区（2026-10-21 P1 迁出管理器，完整能力见 /canvases） -->
    <section v-if="auth.isLoggedIn" class="mb-12">
      <div class="mb-4 flex items-center justify-between gap-3">
        <h2 class="text-lg font-semibold text-fg">我的画布</h2>
        <RouterLink to="/canvases" class="btn-ghost text-sm">查看全部 →</RouterLink>
      </div>
      <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        <SessionCard
          v-for="session in sessions.visibleSessions(COMPACT_SESSIONS_COUNT)"
          :key="session.id"
          class="session-card-menu-anchor"
          :session="session"
          :menu-open="false"
          @open="openCanvas(session.id)"
        />
      </div>
      <p
        v-if="!sessions.mySessions.value.length && !sessions.loading.value"
        class="py-8 text-center text-sm text-fg-3"
      >
        还没有画布，去创建一个吧
      </p>
    </section>

    <section>
      <div class="mb-4 flex items-center justify-between gap-4">
        <h2 class="text-lg font-semibold text-fg">社区精选</h2>
        <RouterLink to="/community" class="btn-ghost text-sm">去发现 →</RouterLink>
      </div>

      <div
        v-if="loading"
        data-testid="home-featured-row"
        class="grid grid-cols-2 gap-4 lg:grid-cols-4"
      >
        <div v-for="i in 4" :key="i" class="aspect-video animate-pulse rounded-2xl bg-surface-base" />
      </div>

      <div v-else-if="featuredWorks.length" data-testid="home-featured-row" class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <WorkCard
          v-for="work in featuredWorks"
          :key="work.id"
          :work="work"
          @view-work="viewWork"
          @view-watch="viewWatch"
          @view-process="viewProcess"
          @view-author="viewAuthor"
          @view-share="viewShare"
        />
      </div>

      <p v-else class="py-8 text-center text-sm text-fg-3">社区还没有作品，去发现看看 →</p>

      <div class="mt-4 flex justify-end">
        <button class="btn-ghost text-sm" @click="openPublish">发布作品</button>
      </div>
    </section>

    <PublishNeoTVDialog
      v-model="showPublish"
      :sessions="userSessions"
      :default-title="prompt || userSessions[0]?.title"
      @published="fetchWorks"
      @locate-node="handlePublishLocateNode"
    />
  </div>
</template>
