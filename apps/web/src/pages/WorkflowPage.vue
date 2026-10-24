<script setup lang="ts">
import { ref, onMounted, watch, computed, defineAsyncComponent } from 'vue'
import { useRouter } from 'vue-router'
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
/**
 * 发布弹窗改为**异步组件**（2026-10-24 性能修复·二次）。
 *
 * ## 为什么必须异步
 *
 * `PublishNeoTVDialog` 的依赖链是**整条画布链**：
 *   PublishNeoTVDialog
 *     ├─ stores/canvasEditor        → services/studio-api + components/canvas/refine/*
 *     └─ CanvasLocateButton         → AgentTurnTimeline → UniversalModelSelector → …
 *
 * 而它在本页的位置是 `hidden lg:block` 容器内 ⇒
 * **窄屏（= 移动端，用户主要场景）完全用不到**，
 * 桌面端也只有点「发布作品」才用得到。
 *
 * 静态 import 的代价（生产实测）：
 *   品牌页首屏 **51 个同域请求 / 1.3MB**，其中 20+ 个是画布页的 chunk
 *   （studio-api / refine 链 / AgentTurnTimeline / UniversalModelSelector /
 *     el-drawer / UsagePanel / SubscriptionPanel / PointsPanel / char …）。
 *   ⇒ 6 个 HTTP/1.1 连接被占满 9 轮往返 ⇒ **535KB 的品牌 logo 从 2.1 秒拖到 8 秒**，
 *     **API 请求排到 10 秒后才发出**（= 用户说的「登录出问题」）。
 *
 * ✅ 异步化后这条链彻底脱离品牌页首屏 ⇒ 请求数与字节数大降，
 *    首屏连接槽空出来 ⇒ logo 与 API 都不用排队。
 *    弹窗本身在用户点「发布作品」时才加载（那一下晚几百 ms，可接受）。
 */
const PublishNeoTVDialog = defineAsyncComponent(() => import('@/components/works/PublishNeoTVDialog.vue'))
import SignatureHero from '@/components/workflow/SignatureHero.vue'
import type { Session } from '@lnkpi/shared'
import { ElMessage } from 'element-plus'

const router = useRouter()
const auth = useAuthStore()
useSessionRedirect()

/** IA v4（2026-10-23 用户裁决）：移动端入口 = hero（品牌）优先、最近项目（效率）其次。
 *  已登录回访：有项目 → 整页进最近项目（list 按 updatedAt desc）；
 *  未登录 / 登录后 / 登出重登 / 已登录但无项目：留在 hero——品牌叙事 + 锚是唯一
 *  创作入口（点按即新建项目）。IA v3.1 的「无项目静默新建」分支已撤：项目是用户
 *  意图，不是入口的副作用（静默建出来的空项目进列表还得兜底编号）。
 *  ⚠️ 一次性分发语义：本标签页会话内只跳一次——首次进 /workflow 跳最近项目后，
 *  顶栏字标/回退再进 /workflow 落在 hero（否则「回 hero」按钮会被立刻弹走）。
 *  登录态对话内完成（openLogin 是模态，不换页）⇒ 登录后用户本就在 hero 上。
 *  持久化走 sessionStorage（新开标签页重新分发、刷新不重跳）；隐私模式等写入
 *  失败时静默降级为模块级一次性（同一语义的窄化版）。 */
const MOBILE_ENTRY_KEY = 'lnk.mobileEntry.dispatched'
let mobileEntryDispatchedFallback = false

function mobileEntryDispatched(): boolean {
  try {
    return sessionStorage.getItem(MOBILE_ENTRY_KEY) === '1'
  } catch {
    // 隐私模式等读取失败：回落模块级一次性（同一语义的窄化版）
    return mobileEntryDispatchedFallback
  }
}

function markMobileEntryDispatched(): void {
  try {
    sessionStorage.setItem(MOBILE_ENTRY_KEY, '1')
  } catch {
    // 隐私模式等写入失败：仅本次页面生命周期内不重复分发，功能不坏
    mobileEntryDispatchedFallback = true
  }
}

const { isMobileLayout } = useAgentMobileLayout()
/** 最近项目 id（移动端点锚用）：入口分发时顺手记下最近的那一个。 */
const recentProjectId = ref<string | null>(null)
watch(
  isMobileLayout,
  (mobile) => {
    if (!mobile || mobileEntryDispatched()) return
    markMobileEntryDispatched()
    void (async () => {
      try {
        const res = await canvasApi.list()
        const list = (res.data?.data ?? []) as Array<{ id: string }>
        if (list.length) {
          recentProjectId.value = list[0].id
          // ⚠️ 用 router.replace 而非 window.location.assign（2026-10-24 性能修复）：
          // assign = 整页刷新 ⇒ 丢弃当前 DOM，重下 index.html + 入口 JS(455KB gzip)
          // + 入口 CSS(94KB gzip)，再叠加画布页自己的 ~798KB ⇒ 移动端首屏总传输 ~2MB。
          // replace 走 SPA 路由 ⇒ 入口资源复用缓存，只付画布页那一份。
          // ⚠️ 必须 replace 不是 push：这是「自动分发」，不该在浏览器历史里留一条
          // 返回即回品牌页的记录（push 会让用户按返回键又弹回品牌页）。
          await router.replace(`/workflow/${list[0].id}`)
        }
        // 无项目 ⇒ 留 hero（IA v4：不再静默新建）
      } catch {
        /* 未登录/网络失败：留在主站 hero */
      }
    })()
  },
  { immediate: true },
)

const works = ref<Work[]>([])
// 2026-10-21 P1：主页只留一行精选（4 张），完整作品流移至 /community。
// 分类筛选（activeCategory）随之撤出——分类维度由 type 决定，属社区页职责。
const FEATURED_WORKS_COUNT = 4
const loading = ref(false)
const showPublish = ref(false)
const userSessions = ref<Session[]>([])

/**
 * 创作进行中（2026-10-24 性能修复）：点击创作到画布页就绪之间的加载态。
 *
 * ⛔ 为什么状态在**本页**而不是 SignatureHero 内部：
 *    加载的终点是「画布页挂载完成」，只有本页知道创建会话 + 路由跳转的完成时刻。
 *    放在 hero 内部的话，加载环会在盖章动画（600ms）后就撤掉，
 *    而真实等待还在继续 ⇒ 反馈提前消失 = 没改。
 *
 * 置 false 的时机：路由跳转已发起（画布页接管后续）即可——
 * 画布页有自己的挂载反馈，不该让品牌页的环一直悬着。
 */
const creating = ref(false)

// 2026-10-21 P1：会话管理逻辑整体迁到 composables/useMySessions.ts，
// 主页只消费 compact 视图（COMPACT_SESSIONS_COUNT 个 + 「查看全部」→ /canvases）。
const sessions = useMySessions()
const COMPACT_SESSIONS_COUNT = 5

// 精选行：只取最新 4 条。「去发现 →」把完整作品流交给 /community。
const featuredWorks = computed(() => works.value.slice(0, FEATURED_WORKS_COUNT))

function handlePublishLocateNode(payload: { sessionId: string; nodeId: string }) {
  showPublish.value = false
  void router.push({
    name: 'canvas',
    params: { sessionId: payload.sessionId },
    query: { focusNode: payload.nodeId },
  })
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
  // 加载态：置位后由 finally 复位（防重入 + 保证异常路径也复位）
  if (creating.value) return
  creating.value = true
  try {
    // 移动端品牌页点「锚」= **开始创作**（2026-10-23 用户裁决）：
    //  · 有项目 ⇒ 进最近项目的【对话】页（不新建）——延续「回访进最近项目」的效率语义，
    //    也避免替用户凭空建一个空项目；
    //  · 无项目 ⇒ 新建项目并直接进它的【对话】页——用户已明确表达创作意图，
    //    此刻创建是「把意图落地」，不是入口副作用；
    //  品牌页上除锚之外没有任何其他创建入口 ⇒【新建项目】由【对话】页承载。
    // PC 端保持原语义（hero 锚 = 开一个新项目）。
    if (isMobileLayout.value && recentProjectId.value) {
      await router.push(`/workflow/${recentProjectId.value}`)
      return
    }
    // 2026-10-24 修复（fix/createcanvas-guard）：创建失败不再静默兜底到不存在的
    // demo 画布（违反 delivery-no-pseudoblock 纪律）——网络失败应让用户看到明确错误并重试，
    // 而非掉进一个僵尸会话。客户端超时 20s（默认 120s）避免弱网/连接池卡死时上百秒零反馈。
    const loading = ElMessage({ type: 'info', message: '正在创建画布…', duration: 0 })
    try {
      const { data } = await sessionsApi.create(
        { title: '未命名画布' },
        { timeout: 20_000 },
      )
      loading.close()
      await router.push({
        path: `/workflow/${data.data.id}`,
        query: {
          openAgent: '1',
        },
      })
    } catch {
      loading.close()
      ElMessage.error('创建画布失败，请检查网络后重试')
    }
  } finally {
    // 路由已切换 ⇒ 画布页接管，本页的加载态不再需要
    creating.value = false
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
  // 2026-10-24 性能修复（**二次修正**）：⛔ **不再在此立即预热**。
  //
  // 初版「品牌页挂载即预热画布页」是生产事故的元凶：它在 4166ms 拉起
  // 画布页整棵依赖树（338KB + 24 个 chunk），与首屏资源抢同域 6 个连接 ⇒
  // 535KB 的品牌 logo 被从 2.1 秒拖到 13 秒、API 排队 ⇒
  // 用户报「品牌页出不来 + 连登录都出问题」。
  //
  // ✅ 改为**用户意图触发**：指针移到锚 / 焦点进入 / 触摸滑条时才预热。
  //    此刻用户已明确表达意图，且首屏早已就绪 ⇒ 不抢任何连接。
  //    兜底那一路（首屏 load 之后预热）在 App.vue。
})

watch(
  () => auth.isLoggedIn,
  () => {
    void sessions.fetch()
  },
)
</script>

<template>
  <div>
    <!-- 2026-10-22 用户裁定「霸屏铺满」：hero 是全宽首屏（不再龟缩在 max-w-7xl 卡片里），
         滚动后才是我的项目 / 社区精选——同一个页面，不是两个页面 -->
    <SignatureHero :creating="creating" @create="createCanvas" />

    <!-- ⛔ 窄屏整块隐藏（2026-10-23 用户裁定）：移动端品牌页只有【品牌】内容，
         覆盖手机全屏 ⇒ 这里只装「我的项目 / 社区精选 / 发布弹窗」，窄屏一律不渲染
         （**连外层 padding 也要去掉**：留着 pb-20/pt-6 会凭空多出 104px 空白，
         品牌页就「覆盖不满」一屏了——实测 scrollHeight 1004 vs 视口 844）。
         发布弹窗走 el-dialog 的 teleport（挂 body）⇒ 父容器隐藏不影响它。 -->
    <div class="mx-auto hidden max-w-7xl px-4 pb-20 pt-6 sm:px-6 sm:pt-8 lg:block">
    <!-- 我的项目：compact 区（2026-10-21 P1 迁出管理器，完整能力见 /canvases）。
         IA v4（2026-10-23）：画布+对话=项目，与移动端作品带首卡同族补【新建项目】卡。
         ⛔ 移动端品牌页只有【品牌】内容（2026-10-23 用户裁定：移动端 hero = 品牌页，
         覆盖手机全屏，不需要个人项目 + 社区精选）⇒ 本区块窄屏隐藏；
         移动端的个人项目由【对话】页承载（作品带首卡 + 抽屉全量列表）。 -->
    <section v-if="auth.isLoggedIn" class="mb-12 hidden lg:block">
      <div class="mb-4 flex items-center justify-between gap-3">
        <h2 class="text-lg font-semibold text-fg">我的项目</h2>
        <div class="flex items-center gap-2">
          <button class="btn-ghost text-sm" @click="openPublish">发布作品</button>
          <RouterLink to="/canvases" class="btn-ghost text-sm">查看全部 →</RouterLink>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        <!-- 新建项目卡（IA v4 2026-10-23）：与移动端作品带首卡同族——虚线框 +
             圆盘加号 + label；卡槽尺寸对齐 SessionCard（aspect-[4/3]），
             视觉语言与移动端 tile 一致（一把完成：两端同一语义）。 -->
        <button
          data-testid="workflow-create-project"
          type="button"
          class="group flex aspect-[4/3] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line-subtle transition hover:bg-hover"
          @click="createCanvas"
        >
          <span
            class="flex h-10 w-10 items-center justify-center rounded-full bg-accent-subtle text-fg-accent transition group-hover:scale-105"
          >
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" aria-hidden="true">
              <path stroke-linecap="round" d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <span class="text-sm text-fg-3 transition group-hover:text-fg">新建项目</span>
        </button>
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
        还没有项目，去创建一个吧
      </p>
    </section>

    <!-- 社区精选：窄屏隐藏（2026-10-23 用户裁定：社区由移动端【发现】页承载，
         品牌页只讲品牌；PC 端此处仍是社区精选入口）。 -->
    <section class="hidden lg:block">
      <div class="mb-4 flex items-center justify-between gap-4">
        <h2 class="text-lg font-semibold text-fg">社区精选</h2>
        <RouterLink to="/community" class="btn-ghost text-sm">去发现 →</RouterLink>
      </div>

      <div
        v-if="loading"
        data-testid="home-featured-row"
        class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
      >
        <div v-for="i in 4" :key="i" class="aspect-video animate-pulse rounded-2xl bg-surface-base" />
      </div>

      <div v-else-if="featuredWorks.length" data-testid="home-featured-row" class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
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
    </section>

    <!-- ⚠️ v-if="showPublish" 是**必需**的，不是保险（2026-10-24 性能修复·二次）：
         `defineAsyncComponent` 会在组件**被渲染时**就发起 chunk 加载，
         与组件内部是否可见无关。父容器虽然是 `hidden lg:block`，
         但组件照样在模板里 ⇒ 照样渲染 ⇒ 照样加载
         ⇒ 实测品牌页首屏在 5213ms 又来一批（PublishNeoTVDialog + 11 个 element-plus chunk）。
         ⇒ 必须让它**在真的要开的时候才挂载**。 -->
    <PublishNeoTVDialog
      v-if="showPublish"
      v-model="showPublish"
      :sessions="userSessions"
      :default-title="userSessions[0]?.title"
      @published="fetchWorks"
      @locate-node="handlePublishLocateNode"
    />
    </div>
  </div>
</template>
