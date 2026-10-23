import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import ProfilePane from './ProfilePane.vue'

/**
 * 移动端「我的」页签 · 退出登录落点守卫（2026-10-23 用户裁决第 6 点）。
 *
 * 用户原话：「点【我的】-退出登录，应直接跳转到注册登录页，无需跳到品牌页，
 * 直接回到注册登录页。」
 *
 * ⇒ 落点是**身份页** /login（不是品牌页 /workflow）：身份事件回身份入口，
 * 用户在那里重新登录；登录成功再回品牌页（品牌链路不丢）。
 * ⛔ 不得只清会话不跳转（会把用户留在「我的」页这类已无身份归属的壳层里）。
 */

const { routerPush, routerReplace } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
}))

vi.mock('element-plus', () => ({
  ElMessage: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}))

const stubs = {
  ThemeToggle: { template: '<div class="theme-toggle-stub" />' },
  TopupModal: { template: '<div />' },
  BrandPatternAvatar: { template: '<div class="avatar-stub" />' },
}

function mountPane(loggedIn = true) {
  setActivePinia(createPinia())
  const auth = useAuthStore()
  if (loggedIn) {
    auth.token = 'test-token'
    auth.user = { id: 'u_1', nickname: '小墨' } as never
  }
  return { wrapper: mount(ProfilePane, { global: { stubs } }), auth }
}

describe('ProfilePane — 退出登录回注册登录页（第 6 点）', () => {
  beforeEach(() => {
    routerPush.mockReset()
  })

  it('退出登录：清会话 + 跳 /login（身份页，不是品牌页）', async () => {
    const { wrapper, auth } = mountPane(true)
    await wrapper.find('.logout-btn').trigger('click')
    expect(auth.token).toBeNull()
    expect(auth.user).toBeNull()
    expect(routerPush).toHaveBeenCalledTimes(1)
    expect(routerPush).toHaveBeenCalledWith('/login')
  })

  it('⛔ 不得跳品牌页（用户明确：无需跳到品牌页，直接回注册登录页）', async () => {
    const { wrapper } = mountPane(true)
    await wrapper.find('.logout-btn').trigger('click')
    expect(routerPush).not.toHaveBeenCalledWith('/workflow')
  })

  it('⛔ 顺序守卫：先清会话再跳转（否则落地页仍认为已登录）', async () => {
    const { wrapper, auth } = mountPane(true)
    // 观测 push 发生那一刻的登录态：必须是已清空
    let tokenAtPush: string | null | undefined = 'not-called'
    routerPush.mockImplementation(() => {
      tokenAtPush = auth.token
    })
    await wrapper.find('.logout-btn').trigger('click')
    expect(tokenAtPush, 'push 时 token 必须已清空').toBeNull()
  })

  it('未登录态不渲染退出按钮（登录入口在账号卡上）', () => {
    const { wrapper } = mountPane(false)
    expect(wrapper.find('.logout-btn').exists()).toBe(false)
    expect(wrapper.text()).toContain('点击登录')
  })
})

/**
 * /login 页自身的行为守卫：已登录访问 ⇒ 不停在登录页（直接回品牌页）。
 * 登录成功后的落点由 LoginFormPanel 的 success 事件驱动（宿主 onAuthSuccess）。
 */
describe('LoginPage — 独立注册登录页（第 6 点）', () => {
  beforeEach(() => {
    routerPush.mockReset()
    routerReplace.mockReset()
  })

  it('已登录访问 /login ⇒ 直接回品牌页（不重复登录）', async () => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.token = 'test-token'
    auth.user = { id: 'u_1' } as never
    const { default: LoginPage } = await import('@/pages/LoginPage.vue')
    mount(LoginPage, {
      global: {
        stubs: {
          LoginFormPanel: { template: '<div />' },
          SliderCaptchaOverlay: { template: '<div />' },
        },
      },
    })
    await flushPromises()
    expect(routerReplace).toHaveBeenCalledWith('/workflow')
  })

  it('登录成功 ⇒ 回品牌页（登出→重登全程的品牌链路不丢）', async () => {
    setActivePinia(createPinia())
    const { default: LoginPage } = await import('@/pages/LoginPage.vue')
    const wrapper = mount(LoginPage, {
      global: {
        stubs: {
          // 伪造表单宿主：直接触发 success 事件（真实链路 = LoginFormPanel 登录成功后 emit）
          LoginFormPanel: {
            template: '<div class="form-stub" @click="$emit(\'success\')" />',
          },
          SliderCaptchaOverlay: { template: '<div />' },
        },
      },
    })
    await wrapper.find('.form-stub').trigger('click')
    expect(routerReplace).toHaveBeenCalledWith('/workflow')
  })
})
