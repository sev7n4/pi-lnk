import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { WORK_CATEGORIES } from '@lnkpi/shared'
import WorkflowPage from './WorkflowPage.vue'

const { apiGet, apiPost, canvasList } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  canvasList: vi.fn(),
}))

vi.mock('@/services/api', () => ({
  api: { get: apiGet, post: apiPost },
}))

vi.mock('@/services/works-api', () => ({
  worksApi: { publish: vi.fn() },
}))

vi.mock('@/services/canvas-api', () => ({
  canvasApi: { list: canvasList, create: vi.fn() },
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
  useAgentMobileLayout: () => ({ isMobileLayout: ref(false) }),
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

async function mountWorkflow() {
  setActivePinia(createPinia())
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

  it('发布入口随精选行保留（不随网格消失）', async () => {
    const wrapper = await mountWorkflow()
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

  it('分类常量已收窄为全部/短片/画布', () => {
    expect([...WORK_CATEGORIES]).toEqual(['全部', '短片', '画布'])
  })
})
