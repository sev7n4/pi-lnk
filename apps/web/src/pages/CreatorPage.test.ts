import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const { routerMocks, getCreator } = vi.hoisted(() => ({
  routerMocks: { push: vi.fn() },
  getCreator: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRouter: () => routerMocks,
  useRoute: () => ({ params: { id: 'u_1' } }),
}))

vi.mock('@/services/users-api', () => ({
  usersApi: { getCreator: (...args: unknown[]) => getCreator(...args) },
}))

vi.mock('@/components/works/WorkCard.vue', () => ({ default: { template: '<div class="work-card-stub" />' } }))

import CreatorPage from './CreatorPage.vue'

function creatorPayload(works: unknown[] = []) {
  return {
    data: {
      data: {
        // workCount 必须给：身份行「N 作品」直接读它，漏了会渲染 undefined
        user: { id: 'u_1', nickname: '墨行者', workCount: 1, createdAt: '2026-04-01T00:00:00.000Z' },
        works,
      },
    },
  }
}

async function mountCreator(works?: unknown[]) {
  setActivePinia(createPinia())
  getCreator.mockResolvedValue(creatorPayload(works))
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
