import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const { routerMocks, getCreator, followPost, followDel, setPinned, getRelation, authState, openLogin } =
  vi.hoisted(() => ({
    routerMocks: { push: vi.fn() },
    getCreator: vi.fn(),
    followPost: vi.fn(),
    followDel: vi.fn(),
    setPinned: vi.fn(),
    getRelation: vi.fn(),
    openLogin: vi.fn(),
    authState: { isLoggedIn: true, userId: 'u_other' },
  }))

vi.mock('vue-router', () => ({
  useRouter: () => routerMocks,
  useRoute: () => ({ params: { id: 'u_1' } }),
}))

vi.mock('@/services/users-api', () => ({
  usersApi: {
    getCreator: (...args: unknown[]) => getCreator(...args),
    follow: (...args: unknown[]) => followPost(...args),
    unfollow: (...args: unknown[]) => followDel(...args),
    relation: (...args: unknown[]) => getRelation(...args),
    setPinnedWorks: (...args: unknown[]) => setPinned(...args),
  },
}))

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    get isLoggedIn() {
      return authState.isLoggedIn
    },
    get user() {
      return { id: authState.userId }
    },
    openLogin,
  }),
}))

vi.mock('@/components/works/WorkCard.vue', () => ({ default: { template: '<div class="work-card-stub" />' } }))

import CreatorPage from './CreatorPage.vue'

function creatorPayload(works: unknown[] = [], pinnedWorkIds: string[] = []) {
  return {
    data: {
      data: {
        // workCount 必须给：身份行「N 作品」直接读它，漏了会渲染 undefined
        user: {
          id: 'u_1',
          nickname: '墨行者',
          workCount: works.length,
          followersCount: 3,
          followingCount: 5,
          pinnedWorkIds,
          createdAt: '2026-04-01T00:00:00.000Z',
        },
        works,
      },
    },
  }
}

async function mountCreator(works?: unknown[], pinnedWorkIds: string[] = []) {
  setActivePinia(createPinia())
  getCreator.mockResolvedValue(creatorPayload(works, pinnedWorkIds))
  // RouterLink 在 SFC 模板里按全局组件解析，测试环境未装 router 插件，需显式注册桩
  const wrapper = mount(CreatorPage, {
    global: {
      components: {
        RouterLink: { template: '<a :href="to"><slot /></a>', props: ['to'] },
      },
    },
  })
  await flushPromises()
  return wrapper
}

// type 只能取 'canvas' | 'shortfilm'（WorkType），写 'short' 过不了类型
const oneWork = {
  id: 'w_1', title: '星海回响', coverUrl: 'https://cdn/x.jpg', type: 'shortfilm',
  likes: 12, views: 340, createdAt: '2026-10-01T00:00:00.000Z',
}

describe('CreatorPage 身份重建（P0）', () => {
  beforeEach(() => {
    routerMocks.push.mockClear()
    getCreator.mockReset()
  })

  it('封面复用创作者最新作品图', async () => {
    const wrapper = await mountCreator([oneWork])
    const cover = wrapper.find('[data-testid="creator-cover"]')
    expect(cover.exists()).toBe(true)
    expect(cover.attributes('style')).toContain('https://cdn/x.jpg')
  })

  it('身份行：头像/昵称/统计（作品·获赞·浏览）/加入天数，无会员等级', async () => {
    const wrapper = await mountCreator([oneWork])
    const text = wrapper.text()
    expect(text).toContain('墨行者')
    expect(text).toContain('1 作品')
    expect(text).toContain('12 获赞')
    expect(text).toContain('340 浏览')
    expect(text).not.toContain('免费版')
    expect(text).not.toContain('membership')
    expect(wrapper.find('[data-testid="creator-identity"]').exists()).toBe(true)
  })

  it('空作品：封面走纹样兜底 + IP 空态与去社区 CTA', async () => {
    const wrapper = await mountCreator([])
    const text = wrapper.text()
    expect(text).toContain('这片海域还没有作品')
    expect(wrapper.text()).toContain('去社区看看')
    expect(wrapper.find('[data-testid="creator-cover"]').exists()).toBe(true)
  })
})

// ---------------------------------------------------------------- P2 关注

describe('CreatorPage 关注（P2 Task 1）', () => {
  beforeEach(() => {
    followPost.mockReset()
    followDel.mockReset()
    getRelation.mockReset()
    openLogin.mockReset()
    authState.isLoggedIn = true
    authState.userId = 'u_other'
    getRelation.mockResolvedValue({ data: { data: { following: false } } })
  })

  it('身份行渲染关注按钮 + 粉丝数', async () => {
    const wrapper = await mountCreator([oneWork])
    expect(wrapper.find('[data-testid="follow-btn"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('3 粉丝')
  })

  it('游客点击关注走登录引导，不发请求', async () => {
    authState.isLoggedIn = false
    const wrapper = await mountCreator([oneWork])
    await wrapper.find('[data-testid="follow-btn"]').trigger('click')
    await flushPromises()
    expect(openLogin).toHaveBeenCalled()
    expect(followPost).not.toHaveBeenCalled()
  })

  it('点击关注后变「已关注」并更新粉丝数', async () => {
    followPost.mockResolvedValue({ data: { data: { following: true, followersCount: 4 } } })
    const wrapper = await mountCreator([oneWork])
    await wrapper.find('[data-testid="follow-btn"]').trigger('click')
    await flushPromises()
    expect(followPost).toHaveBeenCalledWith('u_1')
    expect(wrapper.find('[data-testid="follow-btn"]').text()).toContain('已关注')
    expect(wrapper.text()).toContain('4 粉丝')
  })

  it('已关注态点击走取关', async () => {
    getRelation.mockResolvedValue({ data: { data: { following: true } } })
    followDel.mockResolvedValue({ data: { data: { following: false, followersCount: 2 } } })
    const wrapper = await mountCreator([oneWork])
    await flushPromises()
    expect(wrapper.find('[data-testid="follow-btn"]').text()).toContain('已关注')
    await wrapper.find('[data-testid="follow-btn"]').trigger('click')
    await flushPromises()
    expect(followDel).toHaveBeenCalledWith('u_1')
    expect(wrapper.find('[data-testid="follow-btn"]').text()).toContain('关注')
  })

  it('作者本人不渲染关注按钮，改为「编辑资料」', async () => {
    authState.userId = 'u_1'
    const wrapper = await mountCreator([oneWork])
    expect(wrapper.find('[data-testid="follow-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="edit-profile"]').exists()).toBe(true)
  })

  it('服务端失败时回滚本地态（按钮回到未关注）', async () => {
    followPost.mockRejectedValue(new Error('boom'))
    const wrapper = await mountCreator([oneWork])
    await wrapper.find('[data-testid="follow-btn"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="follow-btn"]').text()).not.toContain('已关注')
  })

  it('关注请求失败期间按钮禁用（防连点）', async () => {
    let resolveFn: (v: unknown) => void = () => {}
    followPost.mockReturnValue(new Promise((r) => { resolveFn = r }) as never)
    const wrapper = await mountCreator([oneWork])
    await wrapper.find('[data-testid="follow-btn"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="follow-btn"]').attributes('disabled')).toBeDefined()
    resolveFn({ data: { data: { following: true, followersCount: 4 } } })
    await flushPromises()
  })
})

// ---------------------------------------------------------- P2 置顶 + 分组

const canvasWork = {
  id: 'w_2', title: '星海画布', coverUrl: 'https://cdn/y.jpg', type: 'canvas',
  likes: 0, views: 0, createdAt: '2026-10-02T00:00:00.000Z',
}
const seriesWork = {
  id: 'w_3', title: '星海系列', coverUrl: 'https://cdn/z.jpg', type: 'shortfilm',
  category: '星海系列', likes: 0, views: 0, createdAt: '2026-10-03T00:00:00.000Z',
}

describe('CreatorPage 置顶 + 分组（P2 Task 2）', () => {
  beforeEach(() => {
    setPinned.mockReset()
    followPost.mockReset()
    followDel.mockReset()
    getRelation.mockReset()
    getRelation.mockResolvedValue({ data: { data: { following: false } } })
    authState.isLoggedIn = true
    authState.userId = 'u_1'
  })

  it('有置顶作品时渲染置顶区，2.35:1 大卡', async () => {
    const wrapper = await mountCreator([oneWork, canvasWork], ['w_1'])
    const section = wrapper.find('[data-testid="pinned-section"]')
    expect(section.exists()).toBe(true)
    expect(section.html()).toContain('2.35')
    expect(section.text()).toContain('星海回响')
  })

  it('无置顶作品时不渲染置顶区', async () => {
    const wrapper = await mountCreator([oneWork, canvasWork], [])
    expect(wrapper.find('[data-testid="pinned-section"]').exists()).toBe(false)
  })

  it('置顶作品不重复出现在「全部」网格里', async () => {
    const wrapper = await mountCreator([oneWork, canvasWork], ['w_1'])
    expect(wrapper.findAll('.work-card-stub')).toHaveLength(1)
  })

  it('分组 Tab 四项：全部 / 短片 / 画布 / 系列', async () => {
    const wrapper = await mountCreator([oneWork, canvasWork, seriesWork], [])
    const tabs = wrapper.findAll('[role="tab"]').map((t) => t.text())
    expect(tabs).toEqual(['全部', '短片', '画布', '系列'])
  })

  it('点「短片」只显示 type=shortfilm 的作品', async () => {
    const wrapper = await mountCreator([oneWork, canvasWork], [])
    expect(wrapper.findAll('.work-card-stub')).toHaveLength(2)
    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.work-card-stub')).toHaveLength(1)
  })

  it('点「画布」只显示 type=canvas 的作品', async () => {
    const wrapper = await mountCreator([oneWork, canvasWork], [])
    await wrapper.findAll('[role="tab"]')[2]!.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.work-card-stub')).toHaveLength(1)
  })

  it('点「系列」只显示有 category 的作品', async () => {
    const wrapper = await mountCreator([canvasWork, seriesWork], [])
    await wrapper.findAll('[role="tab"]')[3]!.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.work-card-stub')).toHaveLength(1)
  })

  it('作者本人看到置顶控件', async () => {
    const wrapper = await mountCreator([oneWork, canvasWork], [])
    expect(wrapper.find('[data-testid="pin-toggle"]').exists()).toBe(true)
  })

  it('访客看不到置顶控件，也不发越权请求', async () => {
    authState.userId = 'u_other'
    const wrapper = await mountCreator([oneWork, canvasWork], [])
    expect(wrapper.find('[data-testid="pin-toggle"]').exists()).toBe(false)
    expect(setPinned).not.toHaveBeenCalled()
  })

  it('作者点置顶控件调用 setPinnedWorks 并更新置顶区', async () => {
    setPinned.mockResolvedValue({ data: { data: { pinnedWorkIds: ['w_2'] } } })
    const wrapper = await mountCreator([oneWork, canvasWork], [])
    await wrapper.findAll('[data-testid="pin-toggle"]')[1]!.trigger('click')
    await flushPromises()
    expect(setPinned).toHaveBeenCalledWith(['w_2'])
    expect(wrapper.find('[data-testid="pinned-section"]').text()).toContain('星海画布')
  })

  it('置顶区内的控件文案为「取消置顶」', async () => {
    const wrapper = await mountCreator([oneWork, canvasWork], ['w_1'])
    expect(wrapper.find('[data-testid="pinned-section"]').text()).toContain('取消置顶')
  })

  it('置顶失败（超 2 个等）时提示且不改本地态', async () => {
    setPinned.mockRejectedValue(new Error('too many'))
    const wrapper = await mountCreator([oneWork, canvasWork], [])
    await wrapper.findAll('[data-testid="pin-toggle"]')[0]!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="pinned-section"]').exists()).toBe(false)
  })
})
