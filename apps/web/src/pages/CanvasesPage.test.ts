import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import CanvasesPage from './CanvasesPage.vue'

const { sessionsList, sessionsCreate, sessionsRemoveMany, canvasCreate, authState, pushMock, elMessage } =
  vi.hoisted(() => ({
    sessionsList: vi.fn(),
    sessionsCreate: vi.fn(),
    sessionsRemoveMany: vi.fn(),
    canvasCreate: vi.fn(),
    pushMock: vi.fn(),
    authState: { isLoggedIn: true },
    elMessage: Object.assign(vi.fn(() => ({ close: vi.fn() })), {
      success: vi.fn(),
      error: vi.fn(),
    }),
  }))

vi.mock('@/services/sessions-api', () => ({
  sessionsApi: {
    list: sessionsList,
    create: sessionsCreate,
    update: vi.fn(),
    duplicate: vi.fn(),
    remove: vi.fn(),
    removeMany: sessionsRemoveMany,
  },
}))

// 2026-10-25 PR-2：新建项目改走 useProjectWorkspace（唯一 create 通道）⇒ 落到 canvasApi.create。
vi.mock('@/services/canvas-api', () => ({
  canvasApi: {
    list: vi.fn(),
    create: canvasCreate,
    update: vi.fn(),
  },
}))

vi.mock('element-plus', () => ({
  ElMessage: elMessage,
  ElMessageBox: { confirm: vi.fn(async () => true), prompt: vi.fn() },
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushMock }) }))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ get isLoggedIn() { return authState.isLoggedIn }, openLogin: vi.fn() }),
}))

const stubs = {
  SessionCard: {
    template: '<div class="session-card-stub" />',
    props: ['session', 'manageMode', 'selected', 'menuOpen'],
  },
  RouterLink: { template: '<a :href="to"><slot /></a>', props: ['to'] },
}

function makeSessions(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: `画布${i}` }))
}

async function mountPage() {
  setActivePinia(createPinia())
  const wrapper = mount(CanvasesPage, { global: { stubs } })
  await flushPromises()
  return wrapper
}

describe('CanvasesPage 项目管理器（P1；IA v4 画布+对话=项目）', () => {
  beforeEach(() => {
    sessionsList.mockReset()
    sessionsCreate.mockReset()
    sessionsRemoveMany.mockReset()
    pushMock.mockReset()
    authState.isLoggedIn = true
    sessionsList.mockResolvedValue({ data: { data: makeSessions(6) } })
  })

  it('渲染全部画布（不截断到5个——管理器是完整列表）', async () => {
    const wrapper = await mountPage()
    expect(wrapper.findAll('.session-card-stub')).toHaveLength(6)
    expect(wrapper.text()).not.toContain('查看更多')
  })

  it('完整管理器能力：搜索框 / 管理按钮 / 新建入口都在', async () => {
    const wrapper = await mountPage()
    expect(wrapper.find('[data-testid="canvases-search"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="canvases-manage"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="canvases-create"]').exists()).toBe(true)
  })

  it('搜索框过滤画布列表', async () => {
    const wrapper = await mountPage()
    await wrapper.find('[data-testid="canvases-search"]').setValue('画布1')
    await flushPromises()
    expect(wrapper.findAll('.session-card-stub')).toHaveLength(1)
  })

  it('搜索无结果时给出空态文案', async () => {
    const wrapper = await mountPage()
    await wrapper.find('[data-testid="canvases-search"]').setValue('不存在的画布')
    await flushPromises()
    expect(wrapper.text()).toContain('没有匹配的项目')
  })

  it('进入管理模式后出现批删按钮', async () => {
    const wrapper = await mountPage()
    expect(wrapper.find('[data-testid="canvases-batch-delete"]').exists()).toBe(false)
    await wrapper.find('[data-testid="canvases-manage"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="canvases-manage"]').text()).toContain('完成')
  })

  it('新建项目走 useProjectWorkspace（唯一 create 通道）并跳转', async () => {
    const wrapper = await mountPage()
    canvasCreate.mockResolvedValue({ data: { data: { id: 's_new' } } })
    await wrapper.find('[data-testid="canvases-create"]').trigger('click')
    await flushPromises()
    expect(canvasCreate).toHaveBeenCalled()
    // 旧通道不得再被调用（收敛的回归守卫）
    expect(sessionsCreate, '新建不得再走 sessionsApi.create').not.toHaveBeenCalled()
    expect(pushMock).toHaveBeenCalled()
  })

  it('未登录时不请求列表，给出登录引导', async () => {
    authState.isLoggedIn = false
    const wrapper = await mountPage()
    expect(sessionsList).not.toHaveBeenCalled()
    expect(wrapper.findAll('.session-card-stub')).toHaveLength(0)
    expect(wrapper.find('[data-testid="canvases-login"]').exists()).toBe(true)
  })

  it('页面标题为「我的项目」且有返回主页入口', async () => {
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('我的项目')
    expect(wrapper.find('a[href="/workflow"]').exists()).toBe(true)
  })
})
