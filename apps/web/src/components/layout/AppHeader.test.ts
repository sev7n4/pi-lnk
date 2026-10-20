import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import AppHeader from './AppHeader.vue'

const routePath = vi.hoisted(() => ({ value: '/workflow' }))
const pushMock = vi.hoisted(() => ({ value: vi.fn() }))

vi.mock('vue-router', () => ({
  useRoute: () => ({ get path() { return routePath.value } }),
  useRouter: () => ({ push: pushMock.value }),
  RouterLink: {
    template: '<a :href="to"><slot /></a>',
    props: ['to'],
  },
}))

const stubs = {
  BrandLogo: { template: '<span class="brand-logo-stub" />' },
  AccountChrome: { template: '<span class="account-chrome-stub" />' },
  ThemeToggle: { template: '<span class="theme-toggle-stub" />' },
  RouterLink: { template: '<a :href="to"><slot /></a>', props: ['to'] },
}

function mountHeader() {
  return mount(AppHeader, { global: { stubs, attachTo: document.body } })
}

/** 导航项文案（只取 header 主导航区的按钮/链接，不含下拉面板） */
function navLabels(wrapper: ReturnType<typeof mountHeader>): string[] {
  return wrapper.findAll('header nav button, header nav a').map((el) => el.text())
}

describe('AppHeader 导航重组（P1）', () => {
  beforeEach(() => {
    routePath.value = '/workflow'
    pushMock.value = vi.fn()
  })

  it('顶栏标签为 创作 / 发现 / 工作室（画布→创作、超创站→发现、短片已移出）', () => {
    const wrapper = mountHeader()
    const labels = navLabels(wrapper)
    expect(labels).toContain('创作')
    expect(labels).toContain('发现')
    expect(labels).toContain('工作室')
    // 精确断言旧标签已消失：不能用 not.toContain('画布')——
    // 「我的画布」等文案会让该断言恒绿，等于没测
    expect(labels).not.toContain('画布')
    expect(labels).not.toContain('超创站')
    expect(labels).not.toContain('短片')
  })

  it('顶栏只有 3 个导航项（画布/超创站/短片/工作室 → 创作/发现/工作室）', () => {
    const wrapper = mountHeader()
    expect(navLabels(wrapper)).toHaveLength(3)
  })

  it('工作室是下拉按钮而非直接跳转链接', () => {
    const wrapper = mountHeader()
    const trigger = wrapper.find('[data-testid="studio-trigger"]')
    expect(trigger.exists()).toBe(true)
    expect(trigger.attributes('aria-haspopup')).toBe('true')
    expect(trigger.attributes('aria-expanded')).toBe('false')
  })

  it('点击工作室展开下拉，给出四个模态入口', async () => {
    const wrapper = mountHeader()
    await wrapper.find('[data-testid="studio-trigger"]').trigger('click')
    expect(wrapper.find('[data-testid="studio-trigger"]').attributes('aria-expanded')).toBe('true')
    const menu = wrapper.find('[data-testid="studio-menu"]')
    expect(menu.exists()).toBe(true)
    const items = menu.findAll('[role="menuitem"]').map((i) => i.text())
    expect(items).toEqual(
      expect.arrayContaining(['图像工作室', '视频工作室', '文本工作室', '音频工作室']),
    )
  })

  it('下拉默认关闭', () => {
    const wrapper = mountHeader()
    expect(wrapper.find('[data-testid="studio-menu"]').exists()).toBe(false)
  })

  it('工作室下拉每个入口都指向真实路由', async () => {
    const wrapper = mountHeader()
    await wrapper.find('[data-testid="studio-trigger"]').trigger('click')
    const hrefs = wrapper
      .findAll('[data-testid="studio-menu"] [role="menuitem"]')
      .map((i) => i.attributes('href'))
    expect(hrefs).toEqual(
      expect.arrayContaining([
        '/image-studio',
        '/video-studio',
        '/text-studio',
        '/audio-studio',
      ]),
    )
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

  it('工作室子路由激活「工作室」', async () => {
    routePath.value = '/video-studio'
    const wrapper = mountHeader()
    const current = wrapper.findAll('[aria-current="page"]')
    expect(current).toHaveLength(1)
    expect(current[0]!.text()).toBe('工作室')
  })

  it('点导航项走 router.push', async () => {
    const wrapper = mountHeader()
    await navLabels(wrapper).includes('发现')
      ? wrapper.findAll('header nav button')[1]!.trigger('click')
      : Promise.resolve()
    expect(pushMock.value).toHaveBeenCalledWith('/community')
  })
})
