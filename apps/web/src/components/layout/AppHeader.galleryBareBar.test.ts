// 规格 §6.1 / §6.7（mobile-web-three-page-topbar-redesign）：创作空间（画廊 /canvases）
// 走**裸栏**——仅 logo + ＋，去掉 创作/发现 文字导航、ThemeToggle、AccountChrome。
// 移动 + WEB 同一组件、同一视觉；自审 S1「双栏坑」要求本守卫与 CanvasesPage 去自写栏同时成立。
// 静态契约（jsdom 不计算样式；同 CanvasPage.mobileChromeHygiene.test.ts 模式）
// + 行为契约（create 通道：自 CanvasesPage 页内按钮迁入裸栏 ＋ 盘后，唯一通道语义不丢）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AppHeader from './AppHeader.vue'

const here = dirname(fileURLToPath(import.meta.url))
const readComp = (p: string) => readFileSync(join(here, '..', p), 'utf8')
const appHeader = readComp('layout/AppHeader.vue')

/** 剥注释后再断言「某物已移除」——迁移记录写在注释里是规范（棘轮同款教训）。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}

describe('AppHeader 画廊裸栏（/canvases）', () => {
  it('isGalleryRoute 判定 = route.path === "/canvases"', () => {
    expect(appHeader).toContain("route.path === '/canvases'")
  })

  it('画廊分支只渲染 🔍(gallery-search-toggle) + ＋(gallery-create)，不含导航/主题/账号', () => {
    const galleryBlock = appHeader.match(/<template v-if="isGalleryRoute">[\s\S]*?<\/template>/)?.[0] ?? ''
    expect(galleryBlock, '必须能定位画廊裸栏模板块').toContain('<template v-if="isGalleryRoute">')
    expect(galleryBlock).toContain('data-testid="gallery-search-toggle"')
    expect(galleryBlock).toContain('data-testid="gallery-create"')
    // 裸栏不得混入全站 chrome
    expect(galleryBlock).not.toContain('ThemeToggle')
    expect(galleryBlock).not.toContain('AccountChrome')
    expect(galleryBlock).not.toContain('tab in tabs')
  })

  it('文字导航（创作/发现）在画廊路由隐藏（v-if="!isGalleryRoute"）', () => {
    expect(stripComments(appHeader)).toContain('v-if="!isGalleryRoute"')
    // 常规右簇（主题 + 账号）在 v-else，与裸栏互斥
    expect(stripComments(appHeader)).toMatch(/<\/template>\s*<div v-else/)
    // 有效性配对：常规分支确实含主题/账号入口（防空集假绿）
    const rightBlock = appHeader.match(/<div v-else[^>]*>[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? ''
    expect(rightBlock, '必须能定位常规右簇').toContain('AccountChrome')
  })
})

/* ---- 行为契约：＋ 建项目走 useProjectWorkspace 唯一 create 通道（2026-10-27 迁入裸栏）---- */
const { canvasCreate, sessionsCreate, pushMock, authState, elMessage } = vi.hoisted(() => ({
  canvasCreate: vi.fn(),
  sessionsCreate: vi.fn(),
  pushMock: vi.fn(),
  authState: { isLoggedIn: true },
  elMessage: Object.assign(vi.fn(() => ({ close: vi.fn() })), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('@/services/canvas-api', () => ({
  canvasApi: { list: vi.fn(), create: canvasCreate, update: vi.fn() },
}))
vi.mock('@/services/sessions-api', () => ({
  sessionsApi: { list: vi.fn(), create: sessionsCreate, update: vi.fn(), duplicate: vi.fn(), remove: vi.fn(), removeMany: vi.fn() },
}))
vi.mock('element-plus', () => ({ ElMessage: elMessage, ElMessageBox: { confirm: vi.fn(), prompt: vi.fn() } }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/canvases' }),
  useRouter: () => ({ push: pushMock }),
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ get isLoggedIn() { return authState.isLoggedIn }, openLogin: vi.fn() }),
}))

function mountBareBar() {
  setActivePinia(createPinia())
  return mount(AppHeader, { global: { plugins: [createPinia()], stubs: { BrandLogo: { template: '<span />' } } } })
}

describe('AppHeader 画廊裸栏：＋ 建项目行为（唯一 create 通道迁入顶栏）', () => {
  beforeEach(() => {
    canvasCreate.mockReset()
    sessionsCreate.mockReset()
    pushMock.mockReset()
    authState.isLoggedIn = true
  })

  it('点 ＋ → canvasApi.create（经 useProjectWorkspace）→ 跳 /workflow/:id?openAgent=1', async () => {
    canvasCreate.mockResolvedValue({ data: { data: { id: 's_new' } } })
    const wrapper = mountBareBar()
    await wrapper.find('[data-testid="gallery-create"]').trigger('click')
    await flushPromises()
    expect(canvasCreate).toHaveBeenCalled()
    expect(sessionsCreate, '新建不得再走 sessionsApi.create（INV-10 单源）').not.toHaveBeenCalled()
    expect(pushMock).toHaveBeenCalledWith({ path: '/workflow/s_new', query: { openAgent: '1' } })
  })

  it('未登录点 ＋ → openLogin 引导，不发创建请求', async () => {
    authState.isLoggedIn = false
    const wrapper = mountBareBar()
    await wrapper.find('[data-testid="gallery-create"]').trigger('click')
    await flushPromises()
    expect(canvasCreate).not.toHaveBeenCalled()
  })
})
