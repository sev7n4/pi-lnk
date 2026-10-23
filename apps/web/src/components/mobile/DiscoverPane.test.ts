import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DiscoverPane from './DiscoverPane.vue'
import WorkCard from '@/components/works/WorkCard.vue'

/**
 * 移动端发现页（IA v4：发现 = 社区 / 分享）的行为守卫。
 *
 * 与 WEB 端【社区精选】同源：`GET /works` + `WORK_CATEGORIES` 分类 + WorkCard 流；
 * 五个跳转路由逐字对齐（分享页 / 作者主页 / 创作过程页）——移动端与 WEB 端同语义。
 *
 * 锁的关键行为（含两条「诚实降级」）：
 *  ① 挂载即拉 /works；「全部」分类传 undefined 而非空串（服务端按 category 判空）
 *  ② 分类切换 → 带 category 重新拉取
 *  ③ 点作品 → /share/:id（与 WEB 端同一路由）
 *  ④ 失败 / 空结果 ⇒ 空态；⛔ 绝不塞 mock 作品（用户会以为真有人发了这些）
 */

const { apiGet, routerPush } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  routerPush: vi.fn(),
}))

vi.mock('@/services/api', () => ({
  api: { get: apiGet },
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush }),
}))

function makeWork(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `w${i + 1}`,
    title: `作品${i + 1}`,
    coverUrl: `https://cdn/cover${i + 1}.jpg`,
    type: (i % 2 === 0 ? 'canvas' : 'shortfilm') as 'canvas' | 'shortfilm',
    authorId: `u${i + 1}`,
    authorName: `作者${i + 1}`,
    likes: 10 * (i + 1),
    views: 100 * (i + 1),
    createdAt: '2026-10-01T00:00:00.000Z',
  }))
}

async function mountPane() {
  const wrapper = mount(DiscoverPane)
  await flushPromises()
  return wrapper
}

describe('DiscoverPane — 发现 = 社区精选', () => {
  beforeEach(() => {
    apiGet.mockReset()
    routerPush.mockReset()
    apiGet.mockResolvedValue({ data: { data: { items: makeWork(4) } } })
  })

  it('① 挂载即拉 /works，「全部」分类不传 category（空串会漏进服务端过滤分支）', async () => {
    const wrapper = await mountPane()
    expect(apiGet).toHaveBeenCalledTimes(1)
    const [url, config] = apiGet.mock.calls[0]!
    expect(url).toBe('/works')
    expect(config.params.category).toBeUndefined()
    expect(config.params.search).toBeUndefined()
    // 作品流渲染：每条一个 WorkCard（2 列栅格由 CSS 承担，组件层只管数量）
    expect(wrapper.findAllComponents(WorkCard)).toHaveLength(4)
    expect(wrapper.find('[data-testid="discover-work-grid"]').exists()).toBe(true)
  })

  it('② 分类切换：带 category 重拉，且同分类重复点不重拉', async () => {
    const wrapper = await mountPane()
    const chips = wrapper.findAll('.cat-chip')
    expect(chips.length).toBeGreaterThan(1)
    await chips[1]!.trigger('click')
    await flushPromises()
    expect(apiGet).toHaveBeenCalledTimes(2)
    expect(apiGet.mock.calls[1]![1].params.category).toBe(chips[1]!.text())
    // 同分类再点：早退（不做无谓请求）
    await chips[1]!.trigger('click')
    await flushPromises()
    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it('③ 点作品 → /share/:id（与 WEB 端同一路由）', async () => {
    const wrapper = await mountPane()
    await wrapper.findAllComponents(WorkCard)[0]!.find('article').trigger('click')
    expect(routerPush).toHaveBeenCalledWith('/share/w1')
  })

  it('④ 空结果 → 空态（不塞 mock 作品）', async () => {
    apiGet.mockResolvedValue({ data: { data: { items: [] } } })
    const wrapper = await mountPane()
    expect(wrapper.find('[data-testid="discover-empty"]').exists()).toBe(true)
    expect(wrapper.findAllComponents(WorkCard)).toHaveLength(0)
    expect(wrapper.text()).toContain('暂无作品')
  })

  it('⑤ 接口失败 → 同样落空态（诚实降级，不假装有内容）', async () => {
    apiGet.mockRejectedValue(new Error('network down'))
    const wrapper = await mountPane()
    expect(wrapper.find('[data-testid="discover-empty"]').exists()).toBe(true)
    expect(wrapper.findAllComponents(WorkCard)).toHaveLength(0)
  })

  it('⑥ 加载中显示骨架（不闪空态）', async () => {
    // 挂载即 pending ⇒ 断言骨架在 works 到达前占位
    let resolveFn: (v: unknown) => void = () => {}
    apiGet.mockReturnValue(new Promise((r) => (resolveFn = r)))
    const wrapper = mount(DiscoverPane)
    expect(wrapper.find('[data-testid="discover-skeleton"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="discover-empty"]').exists()).toBe(false)
    resolveFn({ data: { data: { items: makeWork(2) } } })
    await flushPromises()
    expect(wrapper.find('[data-testid="discover-skeleton"]').exists()).toBe(false)
    expect(wrapper.findAllComponents(WorkCard)).toHaveLength(2)
  })

  it('⑦ 能力预留位保留且置灰（专家 / 技能 / 连接器），社区流仍是主位', async () => {
    const wrapper = await mountPane()
    const soon = wrapper.findAll('.soon .row-item')
    expect(soon).toHaveLength(3)
    expect(soon.map((b) => b.text()).join()).toContain('专家')
    expect(soon.map((b) => b.text()).join()).toContain('技能')
    expect(soon.map((b) => b.text()).join()).toContain('连接器')
    for (const b of soon) {
      expect(b.attributes('disabled')).toBeDefined()
    }
    // 结构上：作品流在「敬请期待」区块之前（社区是主叙事）
    const html = wrapper.html()
    expect(html.indexOf('discover-work-grid')).toBeLessThan(html.indexOf('soon-title'))
  })

  it('⑧ IA v4：社区化后不再有「资料库」跨页签入口与项目空间行', async () => {
    const wrapper = await mountPane()
    expect(wrapper.text()).not.toContain('资料库')
    expect(wrapper.text()).not.toContain('项目空间')
    // 分类维度来自 shared 的单一真相源，不在组件里写死形状
    expect(wrapper.html()).not.toContain('shortfilm"')  // 分类名不写死
  })
})