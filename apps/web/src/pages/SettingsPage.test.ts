/**
 * SettingsPage（独立设置页）行为守卫。
 *
 * 主题真相源来自 <html data-theme>，useCanvasTheme 在模块首次求值时读它——
 * 与 ThemeToggle.test 同理，用 vi.resetModules() + 动态 import 复现这条求值顺序，
 * 不能 mock 掉 composable（那样测的是替身）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'

const h = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  openLogin: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRouter: () => h.router,
  useRoute: () => ({ query: {} }),
}))

vi.mock('@/stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/auth')>()
  return {
    ...actual,
    useAuthStore: () => {
      const store = actual.useAuthStore()
      store.openLogin = h.openLogin
      return store
    },
  }
})

vi.mock('@/components/canvas/ProviderConfigDialog.vue', () => ({
  default: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<div data-testid="provider-config-dialog" :data-open="String(modelValue)" />',
  },
}))

async function freshPage() {
  vi.resetModules()
  const mod = await import('./SettingsPage.vue')
  setActivePinia(createPinia())
  const auth = useAuthStore()
  auth.token = 'tok'
  auth.user = { id: '1', nickname: '测' } as never
  const wrapper = mount(mod.default, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  document.documentElement.setAttribute('data-theme', 'dark')
  document.documentElement.classList.add('dark')
})

describe('SettingsPage — 独立设置页骨架与入口', () => {
  it('有唯一 h1「设置」与返回按钮', async () => {
    const wrapper = await freshPage()
    expect(wrapper.findAll('h1')).toHaveLength(1)
    expect(wrapper.get('h1').text()).toBe('设置')
    expect(wrapper.find('[data-testid="settings-back"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('有外观浅/深双选项与模型配置入口', async () => {
    const wrapper = await freshPage()
    expect(wrapper.find('[data-testid="theme-option-light"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="theme-option-dark"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="open-model-settings"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('外观')
    expect(wrapper.text()).toContain('模型配置')
    wrapper.unmount()
  })

  it('未登录时请求登录', async () => {
    vi.resetModules()
    const mod = await import('./SettingsPage.vue')
    setActivePinia(createPinia())
    // 不设 token/user ⇒ 未登录
    mount(mod.default)
    await flushPromises()
    expect(h.openLogin).toHaveBeenCalled()
  })

  it('点击模型配置打开弹层', async () => {
    const wrapper = await freshPage()
    expect(wrapper.get('[data-testid="provider-config-dialog"]').attributes('data-open')).toBe('false')
    await wrapper.get('[data-testid="open-model-settings"]').trigger('click')
    expect(wrapper.get('[data-testid="provider-config-dialog"]').attributes('data-open')).toBe('true')
    wrapper.unmount()
  })
})

describe('SettingsPage — 外观主题双选项', () => {
  it('aria-pressed 反映当前主题（深色选中）', async () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    const wrapper = await freshPage()
    expect(wrapper.get('[data-testid="theme-option-dark"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-testid="theme-option-light"]').attributes('aria-pressed')).toBe('false')
    wrapper.unmount()
  })

  it('点击浅色选项 → setTheme 落地 DOM + localStorage', async () => {
    const wrapper = await freshPage()
    await wrapper.get('[data-testid="theme-option-light"]').trigger('click')
    await flushPromises()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(localStorage.getItem('lnkpi-canvas-theme')).toBe('light')
    expect(wrapper.get('[data-testid="theme-option-light"]').attributes('aria-pressed')).toBe('true')
    wrapper.unmount()
  })

  it('两个选项带不变式预览令牌 + accent 选中态令牌', async () => {
    const wrapper = await freshPage()
    const lightEl = wrapper.get('[data-testid="theme-option-light"]')
    const darkEl = wrapper.get('[data-testid="theme-option-dark"]')
    const light = lightEl.html()
    const dark = darkEl.html()
    // 缩略预览用主题不变式 L2（恒白/恒深），不随主题翻转 —— 令牌在选项内的缩略条上
    expect(light).toContain('stamp-face-on-signature')
    expect(dark).toContain('surface-signature')
    // 选中态用主题稳定的 accent（在选项自身 class），禁用会翻转的 hi-bg/hi-text
    expect(darkEl.classes().join(' ')).toContain('accent-subtle')
    expect(light).not.toContain('hi-bg')
    expect(dark).not.toContain('hi-bg')
    wrapper.unmount()
  })
})
