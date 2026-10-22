/**
 * A3 · 移动端回访作品带（MobileRecentWorksStrip）
 *
 * 形态契约（来自《A3 回访作品带 · 封面与交互设计规范 v1》）：
 * - 落点：移动端【对话】页签顶部（不是空态下半屏 —— 实测移动端几乎不渲染空态）
 * - ≤4 张，横滑；88px 封面 + 单行标题 + 相对时间
 * - **不设「继续创作」按钮**（卡片本身即入口；多一个按钮=第二入口=注意力竞争）
 * - 有产物图 → 真实图；无产物图 → 墨鱼默认封面（恒深底 + 品牌紫墨鱼 + 白色墨滴锚印记）
 * - 浅色主题下封面加 1px 细描边（深色主题不加，否则噪音）
 * - 点作品 = 打开该画布并定位到那张产物图（focusNode）
 *
 * 判据要点：
 * - 封面必须有真实产物图时用真实图、否则用默认封面 —— 不能反（默认封面在多画布间
 *   完全相同，用户认不出哪个是自己做过的）。
 * - 点作品必须带上 focusNode —— 不带就退化成「打开画布」，规格要求的「定位到产物」落空。
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileRecentWorksStrip from './MobileRecentWorksStrip.vue'

const WORKS = [
  { id: 'w1', title: '大闸蟹礼盒', coverUrl: 'https://x/a.png', coverNodeId: 'n-a', updatedAt: '2026-10-22T10:00:00.000Z' },
  { id: 'w2', title: '包装主视觉', coverUrl: null, coverNodeId: null, updatedAt: '2026-10-21T10:00:00.000Z' },
  { id: 'w3', title: '种草图', coverUrl: 'https://x/c.png', coverNodeId: 'n-c', updatedAt: '2026-10-20T10:00:00.000Z' },
]

describe('MobileRecentWorksStrip · A3 回访作品带', () => {
  it('渲染每张作品的封面与标题', () => {
    const w = mount(MobileRecentWorksStrip, {
      props: { works: WORKS },
      global: { stubs: { RouterLink: true } },
    })
    const items = w.findAll('[data-testid="recent-work-item"]')
    expect(items).toHaveLength(3)
    expect(w.text()).toContain('大闸蟹礼盒')
    expect(w.text()).toContain('包装主视觉')
  })

  it('有 coverUrl 用真实图；无 coverUrl 用默认封面（墨鱼印记版）', () => {
    const w = mount(MobileRecentWorksStrip, {
      props: { works: WORKS },
      global: { stubs: { RouterLink: true } },
    })
    const imgs = w.findAll('[data-testid="recent-work-cover"]')
    expect(imgs).toHaveLength(3)
    expect(imgs[0]!.attributes('src')).toBe('https://x/a.png')
    // 无产物图 ⇒ 默认封面
    expect(imgs[1]!.attributes('src')).toContain('/brand/canvas-cover/default-')
    expect(imgs[2]!.attributes('src')).toBe('https://x/c.png')
  })

  it('点作品：带 focusNode 定位到那张产物图', async () => {
    const w = mount(MobileRecentWorksStrip, {
      props: { works: WORKS },
      global: { stubs: { RouterLink: true } },
    })
    await w.findAll('[data-testid="recent-work-item"]')[0]!.trigger('click')
    const emitted = w.emitted('open') as unknown[][]
    expect(emitted).toBeTruthy()
    expect(emitted[0]![0]).toEqual({ id: 'w1', focusNodeId: 'n-a' })
  })

  it('无产物图的作品：open 事件里 focusNodeId 为 null（不编造定位目标）', async () => {
    const w = mount(MobileRecentWorksStrip, {
      props: { works: WORKS },
      global: { stubs: { RouterLink: true } },
    })
    await w.findAll('[data-testid="recent-work-item"]')[1]!.trigger('click')
    const emitted = w.emitted('open') as unknown[][]
    expect(emitted[0]![0]).toEqual({ id: 'w2', focusNodeId: null })
  })

  it('不渲染「继续创作」按钮（卡片本身即入口，多一个按钮即第二入口）', () => {
    const w = mount(MobileRecentWorksStrip, {
      props: { works: WORKS },
      global: { stubs: { RouterLink: true } },
    })
    expect(w.find('[data-testid="recent-work-continue"]').exists()).toBe(false)
    const buttons = w.findAll('button')
    // 每张作品一个可点元素即可，不应有额外的独立按钮
    expect(buttons.length).toBeLessThanOrEqual(WORKS.length)
  })

  it('空列表时整条不渲染（没有作品就不显示「最近作品」）', () => {
    const w = mount(MobileRecentWorksStrip, {
      props: { works: [] },
      global: { stubs: { RouterLink: true } },
    })
    expect(w.find('[data-testid="recent-works-strip"]').exists()).toBe(false)
  })

  it('最多渲染 4 张（规格上限）', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `w${i}`, title: `作品${i}`, coverUrl: null, coverNodeId: null,
      updatedAt: '2026-10-22T10:00:00.000Z',
    }))
    const w = mount(MobileRecentWorksStrip, {
      props: { works: many },
      global: { stubs: { RouterLink: true } },
    })
    expect(w.findAll('[data-testid="recent-work-item"]')).toHaveLength(4)
  })

  it('相对时间：刚刚 / N 小时前 / N 天前', () => {
    const now = new Date('2026-10-22T12:00:00.000Z')
    vi.setSystemTime(now)
    const w = mount(MobileRecentWorksStrip, {
      props: {
        works: [
          { id: 'a', title: 'A', coverUrl: null, coverNodeId: null, updatedAt: '2026-10-22T11:59:30.000Z' },
          { id: 'b', title: 'B', coverUrl: null, coverNodeId: null, updatedAt: '2026-10-22T09:00:00.000Z' },
          { id: 'c', title: 'C', coverUrl: null, coverNodeId: null, updatedAt: '2026-10-19T12:00:00.000Z' },
        ],
      },
      global: { stubs: { RouterLink: true } },
    })
    const text = w.text()
    expect(text).toContain('刚刚')
    expect(text).toContain('3 小时前')
    expect(text).toContain('3 天前')
    vi.useRealTimers()
  })
})
