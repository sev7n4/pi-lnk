import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import WorkflowPage from './WorkflowPage.vue'

const { apiGet, apiPost, canvasList, canvasCreate, sessionsCreate, mobileFlag, locationAssign } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  canvasList: vi.fn(),
  canvasCreate: vi.fn(),
  sessionsCreate: vi.fn(),
  /** 移动端布局开关：每个用例可改（组件挂载时读快照，watch immediate 即用） */
  mobileFlag: { isMobile: false },
  /**
   * window.location.assign 的替身（jsdom 的导航未实现，调用即抛）。
   *
   * ⚠️ 2026-10-24 性能修复后，移动端入口分发**不再用** location.assign
   *    （整页刷新会让移动端首屏总传输翻倍），改走 router.replace。
   *    本替身保留：用于**断言不再调用它**（防回归到整页刷新）。
   */
  locationAssign: vi.fn(),
}))

vi.mock('@/services/api', () => ({
  api: { get: apiGet, post: apiPost },
}))

vi.mock('@/services/works-api', () => ({
  worksApi: { publish: vi.fn() },
}))

vi.mock('@/services/canvas-api', () => ({
  canvasApi: { list: canvasList, create: canvasCreate },
}))

vi.mock('@/services/sessions-api', () => ({
  sessionsApi: {
    list: vi.fn(async () => ({ data: { data: [] } })),
    create: sessionsCreate,
    rename: vi.fn(),
    duplicate: vi.fn(),
    remove: vi.fn(),
    removeMany: vi.fn(),
  },
}))

vi.mock('@/services/users-api', () => ({
  usersApi: { me: vi.fn(async () => ({ data: { data: { id: 'u_1' } } })) },
}))

vi.mock('@/router/useSessionRedirect', () => ({ useSessionRedirect: () => {} }))
vi.mock('@/composables/useAgentMobileLayout', () => ({
  useAgentMobileLayout: () => ({ isMobileLayout: ref(mobileFlag.isMobile) }),
}))
const { elMessage } = vi.hoisted(() => {
  const elMessage = Object.assign(vi.fn(() => ({ close: vi.fn() })), {
    success: vi.fn(),
    error: vi.fn(),
  }) as unknown as {
    (opts: { type?: string; message?: string; duration?: number }): { close: () => void }
    success: (msg?: string) => void
    error: (msg?: string) => void
  }
  return { elMessage }
})
vi.mock('element-plus', () => ({
  ElMessage: elMessage,
  ElMessageBox: { confirm: vi.fn(async () => true) },
}))

const routerMocks = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }))
vi.mock('vue-router', () => ({
  useRouter: () => routerMocks,
  useRoute: () => ({ params: {}, query: {} }),
}))

// 子组件全部 stub，避免拉进真实依赖链
// ⚠️ SignatureHero 的 stub 渲染 error：入口分发失败时 WorkflowPage 要把错误文案传给它，
//    这是跨组件的可见反馈契约（INV-6）。若 stub 不渲染 props，`wrapper.text()` 观测不到，
//    "用户看不到反馈"这个 bug 会被测试放过去。
const stubs = {
  SignatureHero: {
    name: 'SignatureHero',
    props: ['creating', 'error'],
    template:
      '<button class="signature-hero-stub" @click="$emit(\'create\')" />' +
      '<span v-if="error" class="hero-error-stub">{{ error }}</span>',
  },
  RouterLink: { template: '<a :href="to"><slot /></a>', props: ['to'] },
}

function makeWorks(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `w${i}`,
    title: `作品${i}`,
    coverUrl: 'https://cdn/x.jpg',
    type: 'canvas' as const,
    authorId: 'u1',
    authorName: '作者',
    likes: 0,
    views: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
  }))
}

async function mountWorkflow(opts: { loggedIn?: boolean } = {}) {
  setActivePinia(createPinia())
  // 「我的画布」区块 v-if 登录态：需要登录态断言的测试在这里置位
  // （每次 mount 都新建 pinia，故必须在该函数内置位，测试外设了会丢）
  if (opts.loggedIn) {
    const auth = useAuthStore()
    auth.token = 'test-token'
    auth.user = { id: 'u_1' } as never
  }
  const wrapper = mount(WorkflowPage, { global: { stubs } })
  await flushPromises()
  return wrapper
}

describe('WorkflowPage 主页品牌化（P3，规格收敛 v2）', () => {
  beforeEach(() => {
    apiGet.mockReset()
    canvasList.mockReset()
    canvasList.mockResolvedValue({ data: { data: [] } })
    apiGet.mockResolvedValue({ data: { data: { items: makeWorks(10), total: 10 } } })
    canvasCreate.mockReset()
    // 2026-10-24：移动端分发改走 router.replace ⇒ mock 历史必须复位，否则用例间串味
    routerMocks.push.mockReset()
    routerMocks.replace.mockReset()
    mobileFlag.isMobile = false
    sessionStorage.clear()
  })

  it('⛔ 主页纯品牌：「我的项目」「社区精选」「发布作品」一律不得回流', async () => {
    // 2026-10-26 规格收敛 v2（P3）：列表唯一真身 = 创作首页（/canvases），
    // 社区唯一入口 = /community，发布唯一入口 = 画布内 chrome + 移动端菜单。
    const wrapper = await mountWorkflow({ loggedIn: true })
    expect(wrapper.text()).not.toContain('我的项目')
    expect(wrapper.text()).not.toContain('社区精选')
    expect(wrapper.text()).not.toContain('发布作品')
    expect(wrapper.text()).not.toContain('查看全部')
    expect(wrapper.find('[data-testid="home-featured-row"]').exists()).toBe(false)
    expect(wrapper.find('.work-card-stub').exists()).toBe(false)
    expect(wrapper.find('.category-tabs-stub').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workflow-create-project"]').exists()).toBe(false)
  })

  it('主页唯一内容 = hero（品牌 + 锚 CTA），无第二内容区', async () => {
    const wrapper = await mountWorkflow({ loggedIn: true })
    expect(wrapper.find('.signature-hero-stub').exists()).toBe(true)
    // 页面根下不再有 hidden lg:block 的滚动内容容器（P3 删空壳）
    expect(wrapper.html()).not.toContain('max-w-7xl')
  })

  it('横幅已移除：页面不再有营销横幅 section', async () => {
    const wrapper = await mountWorkflow()
    expect(wrapper.html()).not.toContain('CarouselBanner')
  })

  it('主页不渲染分类 tabs（分类消费已归 /community，常量本体归 shared）', async () => {
    // 曾在此写死「WORK_CATEGORIES 收窄为 3 项」——但常量形状归 shared 自己的真相，
    // CommunityPage.test 已用动态断言覆盖；主页侧的正确锁是「不消费」（上方已有），
    // 故删除写死形状的过时断言。
    const wrapper = await mountWorkflow()
    expect(wrapper.find('.category-tabs-stub').exists()).toBe(false)
  })
})

/**
 * 2026-10-25 PR-1 Task 4：`createCanvas()` 已删除，锚/滑动改走 `enterCreation()`。
 *
 * ⛔ 本 describe **不是删掉了事** —— 它保护的行为仍然在，只是入口换了：
 *    - 「创建成功带 openAgent」 ⇒ 由 useEnterCreation 承担（见其单测）
 *    - 「失败不兜底 demo」   ⇒ 由 useEnterCreation 的 error 分支承担
 *    - 「并发点击只创建一次」⇒ 由 `entering` 防连点承担（INV-8）
 * 页面层现在只断言**接线正确**（谁调谁、不调谁），具体语义在 composable 单测里。
 */
describe('锚入口接线（Task 4：createCanvas → enterCreation）', () => {
  const pageSrc = readFileSync(resolve(__dirname, 'WorkflowPage.vue'), 'utf8')

  beforeEach(() => {
    sessionStorage.clear()
    mobileFlag.isMobile = false
    canvasList.mockReset()
    canvasCreate.mockReset()
    sessionsCreate.mockReset()
    routerMocks.push.mockReset()
    routerMocks.replace.mockReset()
  })

  it('锚/滑动入口不再直接调用 create，改走 enterCreation（静态辅助）', () => {
    expect(pageSrc).not.toMatch(/sessionsApi\.create\(/)
    expect(pageSrc).not.toMatch(/canvasApi\.create\(/)
    expect(pageSrc).toContain('enterCreation')
  })

  it('创建失败不再跳 demo- 兜底（fix/createcanvas-guard 的行为仍在）', () => {
    expect(pageSrc).not.toContain('demo-${Date.now()}')
  })

  it('PC 端不做穿透：没有「非移动端条件下自动 enterCreation」的 watch（D5=B / INV-7b）', () => {
    // ⛔ 致命回归守卫：穿透 watch 会让 PC 用户一进 /workflow 就被弹走，
    //    品牌页与其下方的项目网格永远看不见。
    expect(pageSrc).not.toMatch(/watch\(\s*showBrandHero/)
  })

  it('PC 品牌页新建卡绑定的是显式新建，不是 enterCreation（B-2 #2）', () => {
    // 那张卡 `@click="createCanvas"` 已随 createCanvas 消失；若改绑 enterCreation
    // 就错了 —— 它是显式新建，改了就成了"进最近项目"。
    expect(pageSrc).not.toMatch(/workflow-create-project[\s\S]{0,400}@click="enterCreation/)
  })

  it('recentProjectId 已随 createCanvas 一并删除（B-2 #3，不留死代码）', () => {
    expect(pageSrc).not.toContain('recentProjectId')
  })

  it('点锚（已登录、有项目）：不新建，进目标项目并带 openAgent', async () => {
    mobileFlag.isMobile = false // PC：不穿透，点锚才进
    canvasList.mockResolvedValue({
      data: { data: [{ id: 'proj-1', coverUrl: 'https://cdn/x.png' }] },
    })
    const wrapper = await mountWorkflow({ loggedIn: true })
    await wrapper.find('.signature-hero-stub').trigger('click')
    await flushPromises()
    expect(sessionsCreate, '点锚不得再走 sessionsApi.create').not.toHaveBeenCalled()
    expect(canvasCreate, '有项目时点锚不得新建').not.toHaveBeenCalled()
    expect(routerMocks.push).toHaveBeenCalledWith({
      path: '/workflow/proj-1',
      query: { openAgent: '1' },
    })
  })

  it('点锚（未登录）：弹登录，不创建、不跳转（D-1）', async () => {
    // ⚠️ 必须 mount 之后再取 auth store：`mountWorkflow()` 内部会
    //    `setActivePinia(createPinia())` 换掉 store 实例，mount 前 spy 的
    //    是**旧实例** ⇒ spy 永远等不到调用（假红）。
    const wrapper = await mountWorkflow()
    const openLogin = vi.spyOn(useAuthStore(), 'openLogin')
    await wrapper.find('.signature-hero-stub').trigger('click')
    await flushPromises()
    expect(openLogin).toHaveBeenCalled()
    expect(sessionsCreate).not.toHaveBeenCalled()
    expect(routerMocks.push).not.toHaveBeenCalled()
  })

  // 「点【新建项目】卡」用例已随 workflow-create-project 卡整体退场（2026-10-26
  // 规格收敛 v2）：显式新建入口 = 创作首页（/canvases），主页只剩锚一个入口。
})

/**
 * IA v4（2026-10-23 用户裁决）移动端入口分发：
 *   已登录回访 → 最近项目（效率）；未登录 / 登录后 / 登出重登 / 无项目 → hero（品牌）。
 * 锁的死角：IA v3.1 的「无项目静默新建」分支曾让空账号也被塞一个默认项目
 * （进列表还得兜底编号）——本组用 `canvasCreate` 零调用钉死它不许回来。
 */
describe('IA v4 移动端入口分发（hero 优先，最近项目其次）', () => {
  beforeEach(() => {
    // ⚠️ 本组是独立顶层 describe：P1 组的 beforeEach 覆盖不到 ⇒ 一次性 flag、
    // mobileFlag、mock 历史必须在这里自行复位，否则用例间串味（sessionStorage
    // 的 one-shot 会漏进下一个用例，canvasList 的调用历史会漏进断言）。
    sessionStorage.clear()
    mobileFlag.isMobile = false
    canvasList.mockReset()
    canvasCreate.mockReset()
    // 2026-10-24：移动端分发改走 router.replace ⇒ mock 历史必须复位，否则用例间串味
    routerMocks.push.mockReset()
    routerMocks.replace.mockReset()
    // jsdom 的 location.assign 是「未实现导航」（调用即抛 Not implemented）；
    // 换成可断言的 mock。spread 保留 href/origin 等其余属性，降低替换面。
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...window.location, assign: locationAssign },
    })
    locationAssign.mockReset()
  })

  it('已登录回访：优先进「最近有产物」的项目，而非 list[0]', async () => {
    mobileFlag.isMobile = true
    // list[0] 是刚建的空项目（coverUrl null，updatedAt 更新），list[1] 才有产物。
    // 旧行为跳 list[0] ⇒ 用户穿透进去看不到任何产物。
    canvasList.mockResolvedValue({
      data: {
        data: [
          { id: 'proj-empty', coverUrl: null, updatedAt: '2026-10-25T10:00:00Z' },
          { id: 'proj-has-art', coverUrl: 'https://cdn/x.png', updatedAt: '2026-10-24T10:00:00Z' },
        ],
      },
    })
    await mountWorkflow({ loggedIn: true })
    // ⚠️ 2026-10-25 Task 4：导航改由 useEnterCreation 发出，统一带 openAgent=1（INV-9）
    expect(routerMocks.replace).toHaveBeenCalledWith({
      path: '/workflow/proj-has-art',
      query: { openAgent: '1' },
    })
    expect(routerMocks.replace).toHaveBeenCalledTimes(1)
    expect(locationAssign, '移动端入口分发不得再整页刷新').not.toHaveBeenCalled()
    expect(canvasCreate).not.toHaveBeenCalled()
  })

  it('全部项目都无产物时回落 list[0]（择优不能把用户困住）', async () => {
    mobileFlag.isMobile = true
    canvasList.mockResolvedValue({
      data: { data: [{ id: 'proj-1', coverUrl: null }, { id: 'proj-2', coverUrl: null }] },
    })
    await mountWorkflow({ loggedIn: true })
    expect(routerMocks.replace).toHaveBeenCalledWith({
      path: '/workflow/proj-1',
      query: { openAgent: '1' },
    })
  })

  it('入口分发的 list 带 15s 超时（防弱网下 2 分钟零反馈，10-19 事故同形态）', async () => {
    mobileFlag.isMobile = true
    canvasList.mockResolvedValue({ data: { data: [{ id: 'proj-1' }] } })
    await mountWorkflow({ loggedIn: true })
    // ⚠️ 不带 timeout 会走 api.ts 默认 120_000ms ⇒ 连接僵死时用户等 2 分钟且无反馈。
    //    抽屉侧（AgentSideRail.loadProjects）早已用 PROJECT_LIST_TIMEOUT_MS，入口侧漏修。
    expect(canvasList).toHaveBeenCalledWith(expect.objectContaining({ timeout: 15_000 }))
  })

  it('M1：无项目 ⇒ 留 hero，绝不静默新建（IA v3.1 分支已撤）', async () => {
    mobileFlag.isMobile = true
    canvasList.mockResolvedValue({ data: { data: [] } })
    const wrapper = await mountWorkflow({ loggedIn: true })
    expect(routerMocks.replace).not.toHaveBeenCalled()
    expect(canvasCreate, '项目是用户意图，不是入口的副作用').not.toHaveBeenCalled()
    // hero 仍在场：品牌叙事 + 锚是唯一创作入口（点按即新建项目）
    expect(wrapper.find('.signature-hero-stub').exists()).toBe(true)
  })

  it('未登录（list 401）⇒ 留 hero，不打断、不新建', async () => {
    mobileFlag.isMobile = true
    canvasList.mockRejectedValue(new Error('401'))
    await mountWorkflow()
    expect(routerMocks.replace).not.toHaveBeenCalled()
    expect(canvasCreate).not.toHaveBeenCalled()
  })

  it('list 失败 ⇒ 不新建、不跳转，且**必须有可见反馈**（INV-6）', async () => {
    mobileFlag.isMobile = true
    canvasList.mockRejectedValue(new Error('boom'))
    const wrapper = await mountWorkflow({ loggedIn: true })
    expect(canvasCreate, '失败不得被当成零项目去创建').not.toHaveBeenCalled()
    expect(routerMocks.replace).not.toHaveBeenCalled()
    // ⛔ 旧实现 catch 是空注释「留在主站 hero」⇒ 用户看到的是一个毫无变化的品牌页，
    //    不知道是失败了还是在加载。这里断言错误文案真的传到了 hero（经 stub 渲染）。
    expect(wrapper.text()).toContain('加载失败')
  })

  it('一次性分发：同会话二次进 /workflow（顶栏字标回 hero）不再被弹走', async () => {
    mobileFlag.isMobile = true
    canvasList.mockResolvedValue({ data: { data: [{ id: 'proj-1' }] } })
    await mountWorkflow({ loggedIn: true })
    expect(routerMocks.replace).toHaveBeenCalledTimes(1)
    routerMocks.replace.mockReset()
    // 模拟顶栏字标 / 浏览器回退：WorkflowPage 再次挂载，flag 已在 ⇒ 落在 hero
    const second = await mountWorkflow({ loggedIn: true })
    expect(routerMocks.replace).not.toHaveBeenCalled()
    expect(second.find('.signature-hero-stub').exists()).toBe(true)
  })

  it('桌面端不触发入口分发（一次 list 都不发）', async () => {
    mobileFlag.isMobile = false
    canvasList.mockResolvedValue({ data: { data: [{ id: 'proj-1' }] } })
    await mountWorkflow({ loggedIn: true })
    expect(canvasList).not.toHaveBeenCalled()
    expect(locationAssign).not.toHaveBeenCalled()
    // 2026-10-24：桌面端也不该有任何跳转（分发只对移动端生效）
    expect(routerMocks.replace).not.toHaveBeenCalled()
  })
})

/**
 * 2026-10-23 用户裁定第 3/4 点：
 *  ③ 移动端品牌页只有【品牌】内容 ⇒「我的项目」「社区精选」窄屏隐藏（社区归发现页、
 *     个人项目归对话页）；PC 端三块全在。
 *  ④ 点锚 = 开始创作：有项目 ⇒ 进最近项目的对话页（**不新建**）；无项目才新建。
 */
describe('移动端品牌页边界（第 3/4 点）', () => {
  const pageSrc = readFileSync(resolve(__dirname, 'WorkflowPage.vue'), 'utf8')

  beforeEach(() => {
    // ⚠️ 本组是独立顶层 describe：P1 组 / IA v4 组的 beforeEach 都覆盖不到 ⇒
    // 一次性 flag（sessionStorage）、mobileFlag、mock 历史必须在这里自行复位。
    sessionStorage.clear()
    mobileFlag.isMobile = false
    canvasList.mockReset()
    canvasCreate.mockReset()
    // 2026-10-24：移动端分发改走 router.replace ⇒ mock 历史必须复位，否则用例间串味
    routerMocks.push.mockReset()
    routerMocks.replace.mockReset()
    apiGet.mockReset()
    apiGet.mockResolvedValue({ data: { data: { items: makeWorks(4), total: 4 } } })
    canvasList.mockResolvedValue({ data: { data: [] } })
  })

  it('③ 「我的项目」「社区精选」区块已整体退场（2026-10-26 规格收敛 v2）', () => {
    // 原 2026-10-23 裁定是「窄屏隐藏、桌面显示」；规格收敛 v2 升级为**整体退场**：
    // 列表唯一真身 = 创作首页（/canvases），社区唯一入口 = /community ⇒
    // 主页不得再有任何内容 section / 内容容器（纯品牌）。
    expect(pageSrc, '主页不得再有任何内容 <section>').not.toContain('<section')
    expect(pageSrc, '主页不得再保留 max-w-7xl 内容容器').not.toContain('max-w-7xl')
  })

  it('④ 点锚 = 开始创作：有项目 ⇒ 进最近项目对话页，不新建', async () => {
    mobileFlag.isMobile = true
    canvasList.mockResolvedValue({ data: { data: [{ id: 'proj-1', coverUrl: null }] } })
    await mountWorkflow({ loggedIn: true })
    // 2026-10-25 PR-1 Task 4：移动端自动进入改走 useEnterCreation()，
    //    落点解析（含「有产物优先」）与导航都在 composable 内，页面层只委托。
    // 2026-10-24 性能修复：自动分发走 router.replace（不再整页刷新）。
    expect(routerMocks.replace).toHaveBeenCalledWith({
      path: '/workflow/proj-1',
      query: { openAgent: '1' },
    })
    expect(canvasCreate, '有项目时点锚不得新建').not.toHaveBeenCalled()
  })

  it('④ 源码守卫：移动端自动进入委托给 enterCreation，且带 replace + 不隐式创建', () => {
    // ⚠️ 2026-10-25 PR-1 Task 4 改写：旧守卫钉的是页面内联分流
    //    （`isMobileLayout.value && recentProjectId.value`），该分支已随
    //    `createCanvas()` 删除而移入 `useEnterCreation()`。
    //    新守卫钉**委托本身**与两个关键参数 —— 它们各自防一种真实退化：
    //      · `allowImplicitCreate: false` ⇒ 防退回「无项目静默新建」（IA v3.1，10-23 已撤）
    //      · `replace: true`            ⇒ 防自动分发改用 push，返回键把用户弹回品牌页
    expect(pageSrc).toContain('enterCreation({ allowImplicitCreate: false, replace: true })')
  })
})
