// PR-3 Task 9：工作室（独立工作室页面）下线后的顶栏形态。
//
// 下线理由（spec §7.1）：主页不应承载独立工作室页面；能力层（后端 StudioModule 与
// 前端 studio-api.ts）保留，被 agent 链路与 MediaInspectorDrawer 依赖，端点级清理
// 走独立后续任务。
//
// 本文件保留【创作】【发现】断言，把工作室下拉相关用例改写为「入口整体下线」。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AppHeader from './AppHeader.vue'

const routePath = vi.hoisted(() => ({ value: '/workflow' }))
const pushMock = vi.hoisted(() => ({ value: vi.fn() }))
// 2026-10-27 三页顶栏重构：AppHeader setup 新增 useAuthStore（＋ 建项目登录守卫）与
// useProjectWorkspace（create 通道 + gallerySearchOpen）⇒ 测试需提供 pinia 与 mock。
const wsMock = vi.hoisted(() => ({ searchOpen: { value: false } }))

vi.mock('vue-router', () => ({
  useRoute: () => ({ get path() { return routePath.value } }),
  useRouter: () => ({ push: pushMock.value }),
  RouterLink: {
    template: '<a :href="to"><slot /></a>',
    props: ['to'],
  },
}))

vi.mock('@/composables/useProjectWorkspace', () => ({
  useProjectWorkspace: () => ({
    create: vi.fn(),
    gallerySearchOpen: wsMock.searchOpen,
  }),
}))

const stubs = {
  BrandLogo: { template: '<span class="brand-logo-stub" />' },
  AccountChrome: { template: '<span class="account-chrome-stub" />' },
  ThemeToggle: { template: '<span class="theme-toggle-stub" />' },
  RouterLink: { template: '<a :href="to"><slot /></a>', props: ['to'] },
}

function mountHeader() {
  setActivePinia(createPinia())
  return mount(AppHeader, { attachTo: document.body, global: { plugins: [createPinia()], stubs } })
}

/** 导航项文案（只取 header 主导航区的按钮/链接，不含下拉面板） */
function navLabels(wrapper: ReturnType<typeof mountHeader>): string[] {
  return wrapper.findAll('header nav button, header nav a').map((el) => el.text())
}

describe('AppHeader 导航重组（P1）+ 工作室下线（PR-3 Task 9）', () => {
  beforeEach(() => {
    routePath.value = '/workflow'
    pushMock.value = vi.fn()
  })

  it('顶栏标签为 创作 / 发现（工作室已下线）', () => {
    const wrapper = mountHeader()
    const labels = navLabels(wrapper)
    expect(labels).toContain('创作')
    expect(labels).toContain('发现')
    expect(labels).not.toContain('工作室')
    // 精确断言旧标签已消失：不能用 not.toContain('画布')——
    // 「我的画布」等文案会让该断言恒绿，等于没测
    expect(labels).not.toContain('画布')
    expect(labels).not.toContain('超创站')
    expect(labels).not.toContain('短片')
  })

  it('顶栏只有 2 个导航项（工作室下拉下线）', () => {
    const wrapper = mountHeader()
    expect(navLabels(wrapper)).toHaveLength(2)
  })

  it('工作室下拉入口整体下线：三个 testid 都不存在', () => {
    const wrapper = mountHeader()
    expect(wrapper.find('[data-testid="studio-root"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="studio-trigger"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="studio-menu"]').exists()).toBe(false)
  })

  it('不许残留任何指向已下线工作室的链接（悬空深链会 404）', () => {
    const wrapper = mountHeader()
    const html = wrapper.html()
    for (const path of [
      '/image-studio',
      '/video-studio',
      '/text-studio',
      '/audio-studio',
      '/video-editor',
      '/generation-records',
    ]) {
      expect(html, `顶栏不得再出现 ${path}`).not.toContain(path)
    }
  })

  it('/stories 不在顶栏（深链保留，只是无入口）', () => {
    const wrapper = mountHeader()
    expect(navLabels(wrapper)).not.toContain('短片')
    expect(wrapper.html()).not.toContain('href="/stories"')
  })

  it('激活项有 aria-current="page"', async () => {
    routePath.value = '/community'
    const wrapper = mountHeader()
    const current = wrapper.findAll('[aria-current="page"]')
    expect(current).toHaveLength(1)
    expect(current[0]!.text()).toBe('发现')
  })

  it('画布内页（/workflow/:id）也算创作激活', async () => {
    routePath.value = '/workflow/abc123'
    const wrapper = mountHeader()
    const current = wrapper.findAll('[aria-current="page"]')
    expect(current).toHaveLength(1)
    expect(current[0]!.text()).toBe('创作')
  })

  it('点导航项走 router.push（发现仍可达）', async () => {
    const wrapper = mountHeader()
    await wrapper.findAll('header nav button')[1]!.trigger('click')
    expect(pushMock.value).toHaveBeenCalledWith('/community')
  })
})
