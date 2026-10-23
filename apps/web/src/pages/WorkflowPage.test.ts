import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import WorkflowPage from './WorkflowPage.vue'

const { apiGet, apiPost, canvasList, canvasCreate, mobileFlag } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  canvasList: vi.fn(),
  canvasCreate: vi.fn(),
  /** 移动端布局开关：每个用例可改（组件挂载时读快照，watch immediate 即用） */
  mobileFlag: { isMobile: false },
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
    create: vi.fn(),
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
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn() },
  ElMessageBox: { confirm: vi.fn(async () => true) },
}))

const routerMocks = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }))
vi.mock('vue-router', () => ({
  useRouter: () => routerMocks,
  useRoute: () => ({ params: {}, query: {} }),
}))

// 子组件全部 stub，避免拉进真实依赖链
const stubs = {
  SignatureHero: { template: '<div class="signature-hero-stub" />' },
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

/**
 * IA v4（2026-10-23 用户裁决）移动端入口分发：
 *   已登录回访 → 最近项目（效率）；未登录 / 登录后 / 登出重登 / 无项目 → hero（品牌）。
 * 锁的死角：IA v3.1 的「无项目静默新建」分支曾让空账号也被塞一个默认项目
 * （进列表还得兜底编号）——本组用 `canvasCreate` 零调用钉死它不许回来。
 */
describe('IA v4 移动端入口分发（hero 优先，最近项目其次）', () => {
  const locationAssign = vi.hoisted(() => vi.fn())

  beforeEach(() => {
    // ⚠️ 本组是独立顶层 describe：P1 组的 beforeEach 覆盖不到 ⇒ 一次性 flag、
    // mobileFlag、mock 历史必须在这里自行复位，否则用例间串味（sessionStorage
    // 的 one-shot 会漏进下一个用例，canvasList 的调用历史会漏进断言）。
    sessionStorage.clear()
    mobileFlag.isMobile = false
    canvasList.mockReset()
    canvasCreate.mockReset()
    // jsdom 的 location.assign 是「未实现导航」（调用即抛 Not implemented）；
    // 换成可断言的 mock。spread 保留 href/origin 等其余属性，降低替换面。
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...window.location, assign: locationAssign },
    })
    locationAssign.mockReset()
  })

  it('已登录回访：有项目 ⇒ 整页跳最近项目（list[0]），且不新建', async () => {
    mobileFlag.isMobile = true
    canvasList.mockResolvedValue({
      data: { data: [{ id: 'proj-1' }, { id: 'proj-2' }] },
    })
    await mountWorkflow({ loggedIn: true })
    expect(locationAssign).toHaveBeenCalledWith('/workflow/proj-1')
    expect(locationAssign).toHaveBeenCalledTimes(1)
    expect(canvasCreate).not.toHaveBeenCalled()
  })

  it('M1：无项目 ⇒ 留 hero，绝不静默新建（IA v3.1 分支已撤）', async () => {
    mobileFlag.isMobile = true
    canvasList.mockResolvedValue({ data: { data: [] } })
    const wrapper = await mountWorkflow({ loggedIn: true })
    expect(locationAssign).not.toHaveBeenCalled()
    expect(canvasCreate, '项目是用户意图，不是入口的副作用').not.toHaveBeenCalled()
    // hero 仍在场：品牌叙事 + 锚是唯一创作入口（点按即新建项目）
    expect(wrapper.find('.signature-hero-stub').exists()).toBe(true)
  })

  it('未登录（list 401）⇒ 留 hero，不打断、不新建', async () => {
    mobileFlag.isMobile = true
    canvasList.mockRejectedValue(new Error('401'))
    await mountWorkflow()
    expect(locationAssign).not.toHaveBeenCalled()
    expect(canvasCreate).not.toHaveBeenCalled()
  })

  it('一次性分发：同会话二次进 /workflow（顶栏字标回 hero）不再被弹走', async () => {
    mobileFlag.isMobile = true
    canvasList.mockResolvedValue({ data: { data: [{ id: 'proj-1' }] } })
    await mountWorkflow({ loggedIn: true })
    expect(locationAssign).toHaveBeenCalledTimes(1)
    locationAssign.mockReset()
    // 模拟顶栏字标 / 浏览器回退：WorkflowPage 再次挂载，flag 已在 ⇒ 落在 hero
    const second = await mountWorkflow({ loggedIn: true })
    expect(locationAssign).not.toHaveBeenCalled()
    expect(second.find('.signature-hero-stub').exists()).toBe(true)
  })

  it('桌面端不触发入口分发（一次 list 都不发）', async () => {
    mobileFlag.isMobile = false
    canvasList.mockResolvedValue({ data: { data: [{ id: 'proj-1' }] } })
    await mountWorkflow({ loggedIn: true })
    expect(canvasList).not.toHaveBeenCalled()
    expect(locationAssign).not.toHaveBeenCalled()
  })
})
