import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import ProfilePane from './ProfilePane.vue'

/**
 * 移动端「我的」页签 · 退出登录的行为守卫（IA v4 M12，2026-10-23 用户裁定）。
 *
 * 用户原话：「【我的】退出后，登录跳转需要过移动端的 hero 页。加深品牌印象。」
 * ⇒ 退出登录 = 清会话 + 回 /workflow（工作台 hero）。
 *
 * 关键不变式：退出后不得把人留在壳层里（我的页/项目页都是无品牌语境的画布壳），
 * 也**不得**再被「有项目就跳最近项目」的入口分发弹走（登出态 list 必 401 ⇒ 落 hero）。
 */

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush }),
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

describe('ProfilePane — 退出登录回 hero（IA v4 M12）', () => {
  beforeEach(() => {
    routerPush.mockReset()
  })

  it('退出登录：清会话 + 回 /workflow（品牌前门）', async () => {
    const { wrapper, auth } = mountPane(true)
    await wrapper.find('.logout-btn').trigger('click')
    expect(auth.token).toBeNull()
    expect(auth.user).toBeNull()
    expect(routerPush).toHaveBeenCalledTimes(1)
    expect(routerPush).toHaveBeenCalledWith('/workflow')
  })

  it('⛔ 顺序守卫：先清会话再跳转（否则 /workflow 挂载时登录态仍在，会被入口分发弹走）', async () => {
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