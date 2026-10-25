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
  SessionCard: { template: '<div class="session-card-stub" />', props: ['session'] },
  WorkCard: { template: '<div class="work-card-stub" />', props: ['work'] },
  PublishNeoTVDialog: { template: '<div />' },
  CategoryTabs: { template: '<div class="category-tabs-stub" />' },
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

describe('WorkflowPage 主页收拢（P1）', () => {
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

  it('作品流降级为一行精选：只渲染 4 张卡 + 「去发现」入口，无分类 tab，无大网格', async () => {
    const wrapper = await mountWorkflow()
    expect(wrapper.find('[data-testid="home-featured-row"]').exists()).toBe(true)
    expect(wrapper.findAll('.work-card-stub')).toHaveLength(4)
    expect(wrapper.text()).toContain('去发现')
    // 分类 tabs 已从主页撤出（移至 /community）
    expect(wrapper.find('.category-tabs-stub').exists()).toBe(false)
    // 大网格容器不存在
    expect(wrapper.find('[data-testid="home-works-grid"]').exists()).toBe(false)
  })

  it('发布入口在「我的项目」头部（P3-D 归位：不再挂社区精选底部；需登录态）', async () => {
    // 2026-10-21 P3-D 用户裁定「发布归位」⇒ 入口移到「我的项目」头部，
    // 该区块 v-if 登录态 ⇒ 本测试置登录态后再断言（未登录走 hero 锚创建）。
    const wrapper = await mountWorkflow({ loggedIn: true })
    expect(wrapper.text()).toContain('发布作品')
  })

  it('精选行只取前 4 条（不渲染全部作品）', async () => {
    apiGet.mockResolvedValue({ data: { data: { items: makeWorks(10), total: 10 } } })
    const wrapper = await mountWorkflow()
    expect(wrapper.findAll('.work-card-stub').length).toBeLessThanOrEqual(4)
  })

  it('横幅已移除：页面不再有营销横幅 section', async () => {
    const wrapper = await mountWorkflow()
    expect(wrapper.html()).not.toContain('CarouselBanner')
  })

  it('分享/观看入口不常驻在精选卡上（P0 已净化的封面）', async () => {
    const wrapper = await mountWorkflow()
    expect(wrapper.text()).not.toContain('立即观看')
  })

  it('主页不渲染分类 tabs（分类消费已归 /community，常量本体归 shared）', async () => {
    // 曾在此写死「WORK_CATEGORIES 收窄为 3 项」——但常量形状归 shared 自己的真相，
    // CommunityPage.test 已用动态断言覆盖；主页侧的正确锁是「不消费」（上方已有），
    // 故删除写死形状的过时断言。
    const wrapper = await mountWorkflow()
    expect(wrapper.find('.category-tabs-stub').exists()).toBe(false)
  })
})

describe('createCanvas 创建守卫与失败处理（fix/createcanvas-guard）', () => {
  beforeEach(() => {
    sessionsCreate.mockReset()
  })

  it('创建成功：携带 openAgent 跳转到画布页', async () => {
    sessionsCreate.mockResolvedValueOnce({ data: { data: { id: 's_ok' } } })
    const wrapper = await mountWorkflow({ loggedIn: true })
    await wrapper.find('.signature-hero-stub').trigger('click')
    await flushPromises()
    expect(routerMocks.push).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workflow/s_ok' }),
    )
    expect(elMessage.error).not.toHaveBeenCalled()
  })

  it('创建失败：不兜底到 demo 假画布，而是报错提示', async () => {
    sessionsCreate.mockRejectedValueOnce(new Error('network'))
    const wrapper = await mountWorkflow({ loggedIn: true })
    await wrapper.find('.signature-hero-stub').trigger('click')
    await flushPromises()
    expect(routerMocks.push).not.toHaveBeenCalledWith(
      expect.stringContaining('demo-'),
    )
    expect(elMessage.error).toHaveBeenCalled()
  })

  it('并发点击只创建一次（重入守卫 + loading 反馈）', async () => {
    let resolve!: (v: unknown) => void
    sessionsCreate.mockImplementationOnce(
      () => new Promise((r) => { resolve = r }),
    )
    const wrapper = await mountWorkflow({ loggedIn: true })
    const btn = wrapper.find('.signature-hero-stub')
    const p1 = btn.trigger('click')
    const p2 = btn.trigger('click') // 第二次并发点击
    expect(sessionsCreate).toHaveBeenCalledTimes(1)
    resolve({ data: { data: { id: 's_guard' } } })
    await Promise.all([p1, p2])
    await flushPromises()
    expect(routerMocks.push).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workflow/s_guard' }),
    )
  })
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
    expect(routerMocks.replace).toHaveBeenCalledWith('/workflow/proj-has-art')
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
    expect(routerMocks.replace).toHaveBeenCalledWith('/workflow/proj-1')
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

  it('③ 「我的项目」「社区精选」两区块窄屏隐藏（品牌页只有品牌）', () => {
    // 两个 section 都必须带 lg:block（窄屏隐藏、桌面显示）
    const sections = pageSrc.match(/<section[^>]*>/g) ?? []
    const projectSection = sections.find((s) => s.includes('auth.isLoggedIn')) ?? ''
    const communitySection = sections.find((s) => s.includes('hidden lg:block') && !projectSection.includes(s)) ?? ''
    expect(projectSection, '「我的项目」区块须窄屏隐藏').toContain('hidden lg:block')
    expect(communitySection, '「社区精选」区块须窄屏隐藏').toContain('hidden lg:block')
    // ⛔ 反向：隐藏必须是「窄屏隐藏、桌面显示」，不能写成 hidden（桌面也没了）
    expect(pageSrc).not.toMatch(/<section[^>]*class="hidden"[^>]*>/)
    // 外层容器也必须窄屏隐藏：它只装那两个区块 + 发布弹窗，留着 pb-20/pt-6
    // 会凭空多出 104px 空白 ⇒ 品牌页就「覆盖不满」一屏（实测 scrollHeight 1004 vs 844）
    expect(
      pageSrc,
      '外层容器须窄屏隐藏（否则 104px 空白，品牌页不满一屏）',
    ).toMatch(/<div class="[^"]*hidden[^"]*max-w-7xl[^"]*">/)
  })

  it('④ 点锚 = 开始创作：有项目 ⇒ 进最近项目对话页，不新建', async () => {
    mobileFlag.isMobile = true
    canvasList.mockResolvedValue({ data: { data: [{ id: 'proj-1' }] } })
    await mountWorkflow({ loggedIn: true })
    // 入口分发已把用户带去最近项目 ⇒ 品牌页上的锚不再被点
    // 2026-10-24 性能修复：分发改走 router.replace（不再整页刷新）
    expect(routerMocks.replace).toHaveBeenCalledWith('/workflow/proj-1')
    expect(canvasCreate, '有项目时点锚不得新建').not.toHaveBeenCalled()
  })

  it('④ 源码守卫：移动端分支按「有项目 ⇒ 进最近项目」分流', () => {
    // 判据落在源码（行为级已被入口分发抢跑）⇒ 钉死分流条件与两个落点
    expect(pageSrc).toContain('isMobileLayout.value && recentProjectId.value')
    expect(pageSrc).toContain('router.push(`/workflow/${recentProjectId.value}`)')
  })
})
