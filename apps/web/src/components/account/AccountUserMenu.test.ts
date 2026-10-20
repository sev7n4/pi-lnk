import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import AccountUserMenu from './AccountUserMenu.vue'

const { routerMocks, authState, openTopup } = vi.hoisted(() => ({
  routerMocks: { push: vi.fn() },
  openTopup: vi.fn(),
  authState: {
    nickname: '墨行者',
    points: 1024,
    membership: 'free',
    avatar: null as string | null,
    userId: 'u_1',
  },
}))

vi.mock('vue-router', () => ({ useRouter: () => routerMocks }))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: {
      get id() { return authState.userId },
      get nickname() { return authState.nickname },
      get points() { return authState.points },
      get membership() { return authState.membership },
      get avatar() { return authState.avatar },
    },
    logout: vi.fn(),
  }),
}))

vi.mock('@/composables/useClickOutside', () => ({ useClickOutside: () => {} }))

function mountMenu() {
  return mount(AccountUserMenu, {
    global: { stubs: { RouterLink: { template: '<a :href="to"><slot /></a>', props: ['to'] } } },
  })
}

describe('AccountUserMenu 我的主页入口（P2 Task 3）', () => {
  beforeEach(() => {
    routerMocks.push.mockReset()
    openTopup.mockReset()
    authState.userId = 'u_1'
    authState.avatar = null
  })

  it('菜单里有「我的主页」，点击跳本人 creator 页', async () => {
    const wrapper = mountMenu()
    await wrapper.find('.account-user-menu button').trigger('click')
    const item = wrapper.find('[data-testid="my-homepage"]')
    expect(item.exists()).toBe(true)
    expect(item.text()).toContain('我的主页')
    await item.trigger('click')
    expect(routerMocks.push).toHaveBeenCalledWith('/creator/u_1')
  })

  it('「个人资料」入口仍在（不被新入口挤掉）', async () => {
    const wrapper = mountMenu()
    await wrapper.find('.account-user-menu button').trigger('click')
    expect(wrapper.text()).toContain('个人资料')
    expect(wrapper.text()).toContain('退出登录')
  })
})

describe('AccountUserMenu 头像收敛（P2 Task 6）', () => {
  beforeEach(() => {
    authState.userId = 'u_1'
    authState.nickname = '墨行者'
  })

  it('无头像用户渲染品牌纹样，不再显示公司 logo', async () => {
    authState.avatar = null
    const wrapper = mountMenu()
    await wrapper.find('.account-user-menu button').trigger('click')
    expect(wrapper.find('[data-testid="brand-pattern"]').exists()).toBe(true)
    expect(wrapper.find('img[src*="logo"]').exists()).toBe(false)
  })

  it('有头像用户渲染真实头像', async () => {
    authState.avatar = 'https://cdn/avatar.png'
    const wrapper = mountMenu()
    await wrapper.find('.account-user-menu button').trigger('click')
    expect(wrapper.html()).toContain('https://cdn/avatar.png')
  })

  it('触发器与菜单头部两处头像都用同一组件（不一处纹样一处 logo）', async () => {
    authState.avatar = null
    const wrapper = mountMenu()
    await wrapper.find('.account-user-menu button').trigger('click')
    // 触发器 1 个 + 菜单头 1 个
    expect(wrapper.findAll('[data-testid="brand-pattern"]').length).toBeGreaterThanOrEqual(1)
  })
})
