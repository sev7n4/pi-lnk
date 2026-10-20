import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { WORK_CATEGORIES } from '@lnkpi/shared'
import CommunityPage from './CommunityPage.vue'

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }))

vi.mock('@/services/api', () => ({ api: { get: apiGet } }))

const routerMocks = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('vue-router', () => ({
  useRouter: () => routerMocks,
  useRoute: () => ({ params: {}, query: {} }),
}))

const stubs = {
  WorkCard: { template: '<div class="work-card-stub" />', props: ['work'] },
  RouterLink: { template: '<a :href="to"><slot /></a>', props: ['to'] },
}

async function mountCommunity() {
  const wrapper = mount(CommunityPage, { global: { stubs } })
  await flushPromises()
  return wrapper
}

describe('CommunityPage 分类 chips（P1）', () => {
  beforeEach(() => {
    apiGet.mockReset()
    apiGet.mockResolvedValue({ data: { data: { items: [] } } })
  })

  it('渲染出 WORK_CATEGORIES 的全部分类项', async () => {
    const wrapper = await mountCommunity()
    const chips = wrapper.findAll('[data-testid="category-chip"]')
    expect(chips).toHaveLength(WORK_CATEGORIES.length)
    expect(chips.map((c) => c.text())).toEqual([...WORK_CATEGORIES])
  })

  it('分类项只有 全部/短片/画布——运营位已移出分类体系', async () => {
    const wrapper = await mountCommunity()
    const texts = wrapper.findAll('[data-testid="category-chip"]').map((c) => c.text())
    expect(texts).not.toContain('2026-赛事')
    expect(texts).not.toContain('精选作品')
  })

  it('默认选中「全部」且 aria-pressed 表达选中态', async () => {
    const wrapper = await mountCommunity()
    const chips = wrapper.findAll('[data-testid="category-chip"]')
    expect(chips[0]!.attributes('aria-pressed')).toBe('true')
    expect(chips[1]!.attributes('aria-pressed')).toBe('false')
  })

  it('点「短片」后按 category=短片 重新请求', async () => {
    const wrapper = await mountCommunity()
    apiGet.mockClear()
    const shortChip = wrapper
      .findAll('[data-testid="category-chip"]')
      .find((c) => c.text() === '短片')!
    await shortChip.trigger('click')
    await flushPromises()
    expect(apiGet).toHaveBeenCalledWith(
      '/works',
      expect.objectContaining({ params: expect.objectContaining({ category: '短片' }) }),
    )
  })

  it('点「全部」时不传 category 参数（不传空串）', async () => {
    const wrapper = await mountCommunity()
    const allChip = wrapper.findAll('[data-testid="category-chip"]')[0]!
    await allChip.trigger('click')
    await flushPromises()
    const params = apiGet.mock.calls.at(-1)?.[1]?.params
    expect(params?.category).toBeUndefined()
  })

  it('切换分类会更新 aria-pressed（选中唯一）', async () => {
    const wrapper = await mountCommunity()
    const chips = wrapper.findAll('[data-testid="category-chip"]')
    await chips[1]!.trigger('click')
    await flushPromises()
    const after = wrapper.findAll('[data-testid="category-chip"]')
    expect(after.filter((c) => c.attributes('aria-pressed') === 'true')).toHaveLength(1)
    expect(after[1]!.attributes('aria-pressed')).toBe('true')
  })
})
