import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import CanvasesPage from './CanvasesPage.vue'
import { useProjectWorkspace } from '@/composables/useProjectWorkspace'

const { sessionsList, sessionsCreate, sessionsRemoveMany, canvasList, canvasCreate, authState, authBridge, pushMock, elMessage } =
  vi.hoisted(() => ({
    sessionsList: vi.fn(),
    sessionsCreate: vi.fn(),
    sessionsRemoveMany: vi.fn(),
    canvasList: vi.fn(),
    canvasCreate: vi.fn(),
    pushMock: vi.fn(),
    authState: { isLoggedIn: true },
    // 2026-10-27 v2.3：auth 竞态测试需要「运行中切换并触发 watch」——必须经 reactive
    // proxy 的 set 通道（直接改原始对象绕过 trap，只改读值不触发依赖）。由 mock factory 注入。
    authBridge: { setLoggedIn: null as null | ((v: boolean) => void) },
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
    list: canvasList,
    create: canvasCreate,
    update: vi.fn(),
  },
}))

vi.mock('element-plus', () => ({
  ElMessage: elMessage,
  ElMessageBox: { confirm: vi.fn(async () => true), prompt: vi.fn() },
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushMock }) }))

// 2026-10-27 v2.3：auth 竞态测试需要响应式——reactive 代理同一对象，
// 运行中切换必须走 setLoggedIn（proxy set）；挂载前的静态改值仍可直改 authState。
vi.mock('@/stores/auth', async () => {
  const { reactive } = await import('vue')
  const state = reactive(authState)
  authBridge.setLoggedIn = (v: boolean) => { state.isLoggedIn = v }
  return {
    useAuthStore: () => ({ get isLoggedIn() { return state.isLoggedIn }, openLogin: vi.fn() }),
  }
})

// 2026-10-26 规格收敛 v2：SessionCard 退役，页面直渲染微信式行卡（.session-card-menu-anchor）。
const stubs = {}

function makeSessions(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: `画布${i}` }))
}

async function mountPage() {
  setActivePinia(createPinia())
  const wrapper = mount(CanvasesPage, { global: { stubs } })
  await flushPromises()
  return wrapper
}

/** 清掉 useProjectWorkspace 模块级单例的新鲜缓存（projects/loadedAt 跨用例共享）。
 *  拉一次空清单后 mockClear 只清调用计数——此后 projects=[]、fresh 判定必不命中。 */
async function resetWorkspaceCache() {
  canvasList.mockResolvedValueOnce({ data: { data: [] } })
  await useProjectWorkspace().list()
  await flushPromises()
  canvasList.mockClear()
}

describe('CanvasesPage 项目管理器（P1；IA v4 画布+对话=项目）', () => {
  beforeEach(() => {
    sessionsList.mockReset()
    sessionsCreate.mockReset()
    sessionsRemoveMany.mockReset()
    pushMock.mockReset()
    authState.isLoggedIn = true
    // 2026-10-26 规格收敛 v2（INV-10）：列表唯一真身 = useProjectWorkspace ⇒ canvasApi.list。
    canvasList.mockReset()
    canvasList.mockResolvedValue({ data: { data: makeSessions(6) } })
  })

  it('渲染全部画布（不截断到5个——管理器是完整列表）', async () => {
    const wrapper = await mountPage()
    expect(wrapper.findAll('.session-card-menu-anchor')).toHaveLength(6)
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
    expect(wrapper.findAll('.session-card-menu-anchor')).toHaveLength(1)
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
    expect(canvasList).not.toHaveBeenCalled()
    expect(sessionsList, '列表不得再走 sessionsApi（INV-10 单源）').not.toHaveBeenCalled()
    expect(wrapper.findAll('.session-card-menu-anchor')).toHaveLength(0)
    expect(wrapper.find('[data-testid="canvases-login"]').exists()).toBe(true)
  })

  it('页面标题为「创作首页」（规格收敛 v2：本页即项目唯一列表，无需返回主页链接）', async () => {
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('创作首页')
    expect(wrapper.text()).not.toContain('我的项目')
  })

  it('auth 异步恢复竞态（v2.3 真机回归）：挂载时未登录不发请求，恢复为 true 后补发并渲染列表', async () => {
    // 生产实证（nginx 日志 16:10:31 /canvases 刷新）：挂载瞬间 isLoggedIn=false 跳过请求，
    // token 恢复完成后无人补发 ⇒ 「已登录视图 + 零数据」⇒ 误报「还没有项目」。
    authState.isLoggedIn = false
    await resetWorkspaceCache()
    const wrapper = await mountPage()
    expect(canvasList, '挂载时未登录：零请求').not.toHaveBeenCalled()

    authBridge.setLoggedIn!(true) // 模拟 auth store 异步恢复完成（经 proxy set 触发 watch）
    await flushPromises()
    expect(canvasList, '恢复为已登录后必须补发 list').toHaveBeenCalledTimes(1)
    await flushPromises()
    expect(wrapper.find('[data-testid="canvases-empty"]').exists()).toBe(false)
    expect(wrapper.findAll('.session-card-menu-anchor')).toHaveLength(6)
  })

  it('加载中不得同时显示空态（v2.3 双链缺陷回归）', async () => {
    // 此前错误态用独立 v-if 与骨架/列表链并行 ⇒ loading 中「还没有项目」空态同时渲染。
    // ⚠️ 用可控 resolve（不能永不 resolve：list 的 single-flight inflight 是模块级
    //    单例，挂起不清理会毒化后续用例的 seedProjects）。
    let resolveList!: (v: unknown) => void
    await resetWorkspaceCache()
    canvasList.mockImplementation(() => new Promise((r) => { resolveList = r }))
    const wrapper = await mountPage()
    expect(wrapper.find('[data-testid="canvases-empty"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('还没有项目')
    // 收尾：放掉挂起请求，恢复单例干净（resolve 空数组后出现「还没有项目」是合法真无项目态，不断言）
    resolveList({ data: { data: makeSessions(0) } })
    await flushPromises()
  })
})

/**
 * 2026-10-27 v2.2（D12 / bug④）：空态三态 —— 加载失败-重试 / 真无项目-引导。
 * ⚠️ `useProjectWorkspace` 是模块级单例（projects/error/loadedAt 跨用例共享），
 *    故每个用例先用 `seedProjects` 把内存清单复位到已知值，避免上一用例的新鲜缓存泄漏。
 */
describe('CanvasesPage 空态三态（D12 / bug④）', () => {
  const ws = useProjectWorkspace()

  async function seedProjects(list: { id: string; title: string }[]) {
    canvasList.mockResolvedValue({ data: { data: list } })
    await ws.list()
    await flushPromises()
  }

  beforeEach(() => {
    canvasList.mockReset()
    authState.isLoggedIn = true
  })

  it('加载失败（连接饥饿）：显示「项目加载失败 · 重试」，不误报「还没有项目」', async () => {
    // 先把内存清单复位为空，确保 mount 的 loadIfStale 会真正发起（注定失败的）请求
    await seedProjects([])
    canvasList.mockRejectedValue(new Error('timeout'))
    const wrapper = await mountPage()
    await flushPromises()
    expect(wrapper.find('[data-testid="canvases-load-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="canvases-retry"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('项目加载失败')
    expect(wrapper.text()).not.toContain('还没有项目')
    // 失败态不渲染卡片（不留空白报错）
    expect(wrapper.findAll('.session-card-menu-anchor')).toHaveLength(0)
  })

  it('真无项目：显示「还没有项目」，新建入口唯一（canvases-create 全仓仅顶栏一处）', async () => {
    await seedProjects([])
    canvasList.mockResolvedValue({ data: { data: [] } })
    const wrapper = await mountPage()
    await flushPromises()
    expect(wrapper.text()).toContain('还没有项目')
    expect(wrapper.find('[data-testid="canvases-empty"]').exists()).toBe(true)
    // ⛔ 空态不再内联「新建项目」按钮 ⇒ 全仓唯一
    expect(wrapper.findAll('[data-testid="canvases-create"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="canvases-retry"]').exists()).toBe(false)
  })

  it('加载失败时点击重试会重新拉取列表并渲染', async () => {
    await seedProjects([])
    canvasList.mockRejectedValue(new Error('timeout'))
    const wrapper = await mountPage()
    await flushPromises()
    expect(wrapper.find('[data-testid="canvases-retry"]').exists()).toBe(true)
    // 重试：复位 mock 使本次成功
    canvasList.mockResolvedValue({ data: { data: makeSessions(3) } })
    await wrapper.find('[data-testid="canvases-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.session-card-menu-anchor')).toHaveLength(3)
  })

  it('封面兜底陷阱（v2.4 生产回归）：兜底层必须锚定在 relative 封面按钮内', async () => {
    // ⛔ 生产事故实证（2026-10-27）：封面按钮缺 relative ⇒ CanvasCoverFallback 的
    //    absolute inset-0 锚定到 App 壳 main.relative ⇒ 每个无封面项目都拉成
    //    全屏墨点纸叠在整页上 ⇒ 创作首页黑屏（数据/控制台全部正常）。
    const wrapper = await mountPage()
    await flushPromises()
    const fallback = wrapper.find('[data-testid="canvas-cover-fallback"]')
    expect(fallback.exists()).toBe(true)
    expect(fallback.element.parentElement?.classList.contains('relative')).toBe(true)
  })

  it('音/视频封面（.wav/.mp4）走墨点兜底，不渲染裂图 <img>（v2.4）', async () => {
    // 清空单例（前一用例的 3 条会被 fresh 判定命中，本用例的 mock 不会被打）
    await resetWorkspaceCache()
    canvasList.mockResolvedValue({
      data: {
        data: [
          { id: 'av1', title: '音频封面项目', coverUrl: 'http://x/u/1-0399355e.wav' },
          { id: 'av2', title: '视频封面项目', coverUrl: 'https://x/v/task.mp4' },
          { id: 'img1', title: '图片封面项目', coverUrl: 'https://x/img/a.png' },
        ],
      },
    })
    const wrapper = await mountPage()
    await flushPromises()
    const srcs = wrapper.findAll('img').map((i) => i.attributes('src')).join('\n')
    expect(srcs).toContain('https://x/img/a.png')
    expect(srcs).not.toContain('.wav')
    expect(srcs).not.toContain('.mp4')
    expect(wrapper.findAll('[data-testid="canvas-cover-fallback"]')).toHaveLength(2)
  })
})
