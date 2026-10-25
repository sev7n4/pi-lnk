/**
 * A3 · 移动端回访作品带（RecentProjectsStrip）
 *
 * 形态契约（《A3 回访作品带 · 封面与交互设计规范》v1 2026-10-22 / v2 2026-10-23 IA v4）：
 * - 落点：移动端【对话】页签滚动流顶部（不是空态下半屏 —— 实测移动端几乎不渲染空态）
 * - ≤4 张，横滑；88px 封面 + 单行标题 + 相对时间
 * - 有产物图 → 真实图；无产物图 → 墨鱼默认封面（恒深底 + 品牌紫墨鱼 + 白色墨滴锚印记）
 * - 点作品 = 打开该项目并定位到那张产物图（focusNode）
 * - v2 IA v4：首卡【新建项目】tile / 标题行「全部 N 个 ›」/ 手动收拢（localStorage）/
 *   封面环双主题基线化 / 底部 1px 发丝线 / 右缘渐隐（仅非滚动末端）
 * - **仍不设「继续创作」按钮**（卡片本身即入口；v2 的三个新入口是 IA 级入口——
 *   新建 / 全量 / 收拢，不是每张作品的第二入口，不构成注意力竞争）
 *
 * 判据要点：
 * - 封面必须有真实产物图时用真实图、否则用默认封面 —— 不能反（默认封面在多画布间
 *   完全相同，用户认不出哪个是自己做过的）。
 * - 点作品必须带上 focusNode —— 不带就退化成「打开画布」，规格要求的「定位到产物」落空。
 * - CSS 契约走静态断言（jsdom 不计算 scoped CSS）；断言前剥注释，防「注释命中假红」。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import RecentProjectsStrip, { type RecentWorkItem } from './RecentProjectsStrip.vue'

const here = dirname(fileURLToPath(import.meta.url))

const WORKS: RecentWorkItem[] = [
  { id: 'w1', title: '大闸蟹礼盒', coverUrl: 'https://x/a.png', coverNodeId: 'n-a', updatedAt: '2026-10-22T10:00:00.000Z' },
  { id: 'w2', title: '包装主视觉', coverUrl: null, coverNodeId: null, updatedAt: '2026-10-21T10:00:00.000Z' },
  { id: 'w3', title: '种草图', coverUrl: 'https://x/c.png', coverNodeId: 'n-c', updatedAt: '2026-10-20T10:00:00.000Z' },
]

function mountStrip(works: RecentWorkItem[], now?: number) {
  return mount(RecentProjectsStrip, {
    props: now === undefined ? { works } : { works, now },
    global: { stubs: { RouterLink: true } },
  })
}

describe('RecentProjectsStrip · A3 回访作品带（v1 契约保持）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('渲染每张作品的封面与标题', () => {
    const w = mountStrip(WORKS)
    const items = w.findAll('[data-testid="recent-work-item"]')
    expect(items).toHaveLength(3)
    expect(w.text()).toContain('大闸蟹礼盒')
    expect(w.text()).toContain('包装主视觉')
  })

  it('有 coverUrl 用真实图；无 coverUrl 用默认封面（墨鱼印记版）', () => {
    const w = mountStrip(WORKS)
    const imgs = w.findAll('[data-testid="recent-work-cover"]')
    expect(imgs).toHaveLength(3)
    expect(imgs[0]!.attributes('src')).toBe('https://x/a.png')
    expect(imgs[1]!.attributes('src')).toContain('/brand/canvas-cover/default-')
    expect(imgs[2]!.attributes('src')).toBe('https://x/c.png')
  })

  it('点作品：带 focusNode 定位到那张产物图', async () => {
    const w = mountStrip(WORKS)
    await w.findAll('[data-testid="recent-work-item"]')[0]!.trigger('click')
    const emitted = w.emitted('open') as unknown[][]
    expect(emitted).toBeTruthy()
    expect(emitted[0]![0]).toEqual({ id: 'w1', focusNodeId: 'n-a' })
  })

  it('无产物图的作品：open 事件里 focusNodeId 为 null（不编造定位目标）', async () => {
    const w = mountStrip(WORKS)
    await w.findAll('[data-testid="recent-work-item"]')[1]!.trigger('click')
    const emitted = w.emitted('open') as unknown[][]
    expect(emitted[0]![0]).toEqual({ id: 'w2', focusNodeId: null })
  })

  it('不渲染「继续创作」按钮（每张作品只有一个可点元素）', () => {
    const w = mountStrip(WORKS)
    expect(w.find('[data-testid="recent-work-continue"]').exists()).toBe(false)
    // v1 的「按钮总数 ≤ 作品数」判据在 IA v4 失效（首卡 tile + 头部全部/收拢是
    // IA 级入口）⇒ 改判 per-work：作品卡按钮数 === 作品数，且没有继续按钮。
    expect(w.findAll('[data-testid="recent-work-item"]')).toHaveLength(WORKS.length)
  })

  it('空列表时整条不渲染（没有作品就不显示「最近作品」）', () => {
    const w = mountStrip([])
    expect(w.find('[data-testid="recent-works-strip"]').exists()).toBe(false)
  })

  it('最多渲染 4 张（规格上限）', () => {
    const many: RecentWorkItem[] = Array.from({ length: 9 }, (_, i) => ({
      id: `w${i}`, title: `作品${i}`, coverUrl: null, coverNodeId: null,
      updatedAt: '2026-10-22T10:00:00.000Z',
    }))
    const w = mountStrip(many)
    expect(w.findAll('[data-testid="recent-work-item"]')).toHaveLength(4)
  })

  it('相对时间：刚刚 / N 小时前 / N 天前', () => {
    vi.setSystemTime(new Date('2026-10-22T12:00:00.000Z'))
    const w = mountStrip([
      { id: 'a', title: 'A', coverUrl: null, coverNodeId: null, updatedAt: '2026-10-22T11:59:30.000Z' },
      { id: 'b', title: 'B', coverUrl: null, coverNodeId: null, updatedAt: '2026-10-22T09:00:00.000Z' },
      { id: 'c', title: 'C', coverUrl: null, coverNodeId: null, updatedAt: '2026-10-19T12:00:00.000Z' },
    ])
    const text = w.text()
    expect(text).toContain('刚刚')
    expect(text).toContain('3 小时前')
    expect(text).toContain('3 天前')
    vi.useRealTimers()
  })
})

describe('RecentProjectsStrip v2 · IA v4（2026-10-23）', () => {
  const NOW = Date.parse('2026-10-23T12:00:00.000Z')

  function makeWorks(n: number): RecentWorkItem[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `s${i}`,
      title: `项目 ${i + 1}`,
      coverUrl: i % 2 === 0 ? `https://x/${i}.png` : null,
      coverNodeId: i % 2 === 0 ? `n${i}` : null,
      updatedAt: new Date(NOW - (i + 1) * 60_000).toISOString(),
    }))
  }

  beforeEach(() => {
    localStorage.clear()
  })

  it('首卡是【新建项目】tile，且排在第一个作品卡之前（入口优先于回顾）', () => {
    const w = mountStrip(makeWorks(6), NOW)
    const cells = w.findAll('.recent-works__cell')
    expect(cells[0].find('[data-testid="recent-work-create"]').exists()).toBe(true)
    expect(cells[1].find('[data-testid="recent-work-item"]').exists()).toBe(true)
    expect(w.find('[data-testid="recent-work-create"]').text()).toContain('新建项目')
  })

  it('首卡点击 → emit create（新建项目＝新画布＋首个对话）', async () => {
    const w = mountStrip(makeWorks(2), NOW)
    await w.find('[data-testid="recent-work-create"]').trigger('click')
    expect(w.emitted('create')).toHaveLength(1)
  })

  it('「全部 N 个 ›」显示作品总数（不是可见数 4）并 emit open-all', async () => {
    const w = mountStrip(makeWorks(6), NOW)
    const all = w.find('[data-testid="recent-works-all"]')
    expect(all.text()).toContain('全部 6 个')
    await all.trigger('click')
    expect(w.emitted('open-all')).toHaveLength(1)
  })

  it('收拢：点 chevron ⇒ 收起为一行入口；localStorage 持久化，重挂载保持', async () => {
    // 5 个作品（可见 4 ≠ 总数 5）：收拢行的计数必须用总数——用可见数会显示 4，
    // 与「全部 N 个」信号矛盾（这个用例就是钉这个盲区的：头部按钮与收拢行
    // 是两个模板位置，只测一个另一个会被偷偷退化）。
    const w = mountStrip(makeWorks(5), NOW)
    expect(w.find('[data-testid="recent-work-item"]').exists()).toBe(true)

    await w.find('[data-testid="recent-works-collapse"]').trigger('click')
    expect(w.find('[data-testid="recent-work-item"]').exists()).toBe(false)
    expect(localStorage.getItem('lnk.recentWorks.collapsed')).toBe('1')
    // 收拢态仍给「带外还有」的信号（与全部入口合并成一行，计数=总数 5 非可见数 4）
    expect(w.find('[data-testid="recent-works-expand"]').text()).toContain('继续你的创作 · 全部 5 个')

    const again = mountStrip(makeWorks(5), NOW)
    expect(again.find('[data-testid="recent-work-item"]').exists()).toBe(false)
    await again.find('[data-testid="recent-works-expand"]').trigger('click')
    expect(again.find('[data-testid="recent-work-item"]').exists()).toBe(true)
    expect(localStorage.getItem('lnk.recentWorks.collapsed')).toBe('0')
  })

  it('右缘渐隐：可滚动时挂 is-fading，滚到末端摘除（横滑暗示不常年糊在内容上）', async () => {
    const w = mountStrip(makeWorks(4), NOW)
    const row = w.find('.recent-works__row').element as HTMLElement
    Object.defineProperty(row, 'scrollWidth', { value: 600, configurable: true })
    Object.defineProperty(row, 'clientWidth', { value: 300, configurable: true })
    Object.defineProperty(row, 'scrollLeft', { value: 0, configurable: true, writable: true })

    await row.dispatchEvent(new Event('scroll'))
    expect(w.find('.recent-works__row').classes()).toContain('is-fading')

    row.scrollLeft = 300
    await row.dispatchEvent(new Event('scroll'))
    expect(w.find('.recent-works__row').classes()).not.toContain('is-fading')
  })

  it('契约：封面环双主题基线化 + 发丝线 + 遮罩不撞令牌棘轮', () => {
    const sfc = readFileSync(join(here, 'RecentProjectsStrip.vue'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\/[^\n]*/g, '')
    // 深浅共用同一 1px 环（--lnk-border-subtle 深浅成对）——v1 浅色专属写法退役
    expect(sfc).toContain('box-shadow: 0 0 0 1px var(--lnk-border-subtle)')
    expect(sfc).not.toContain(":global(:root[data-theme='light'])")
    // 底部 1px 发丝线（作品带 ↔ 消息流边界）
    expect(sfc).toContain('border-bottom: 1px solid var(--lnk-border-subtle)')
    // 遮罩用 black/transparent 关键字：theme-usage 棘轮扫 .vue 内任意 rgba( 与深色 hex
    expect(sfc).toContain('mask-image')
    expect(sfc).not.toMatch(/rgba\(/)
  })
})
