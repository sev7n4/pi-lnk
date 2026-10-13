import { describe, expect, it, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MultiSelectToolbar from './MultiSelectToolbar.vue'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 分组背景色：内外环触发钮 + hover 下拉回归锁（2026-10-13 迭代）。
 *
 * 交互从「常驻单排 8 色点」改为「触发钮 + hover 展开下拉」：
 * ① 触发钮分内外环——内环（core）实时显示当前分组背景色，host 改色即跟随；
 * ② 指针进入触发区展开下拉，横向平铺 8 个色块（替代旧三排网格）；
 * ③ 指针进入色条整条放大到易点尺寸（transform 缩放，不占布局盒）；
 * ④ 当前分组色以品牌色环高亮；neutral 即默认色，复位语义与色点合一。
 * 色值全部走 --neo-group-* 令牌，组件内无字面 hex。
 */
describe('MultiSelectToolbar: 分组背景色触发钮 + hover 下拉', () => {
  const base = { selectedIds: ['g-1'], screenPosition: { x: 0, y: 0 } }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('有效性前置：canUngroup 时触发钮存在（含内外环 core），否则不渲染', () => {
    const on = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true } })
    const trigger = on.find('[data-testid="group-color-trigger"]')
    expect(trigger.exists(), '触发钮必须渲染').toBe(true)
    expect(trigger.find('.group-color-trigger-core').exists(), '内环 core 必须渲染').toBe(true)
    expect(trigger.attributes('aria-expanded')).toBe('false')
    on.unmount()
    const off = mount(MultiSelectToolbar, { props: { ...base, canUngroup: false } })
    expect(off.find('[data-testid="group-color-trigger"]').exists()).toBe(false)
    off.unmount()
  })

  it('下拉默认收起；mouseenter 触发区展开、横向 8 色块平铺', async () => {
    const w = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true } })
    expect(w.find('[data-testid="group-color-dropdown"]').exists(), '默认不应展开').toBe(false)
    await w.find('.group-color-menu').trigger('mouseenter')
    const dropdown = w.find('[data-testid="group-color-dropdown"]')
    expect(dropdown.exists(), 'mouseenter 后应展开').toBe(true)
    const dots = dropdown.findAll('.group-color-dot')
    expect(dots.length, '8 个预设色块（neutral/moss/dusk/clay/celadon/graphite/rose/plum）').toBe(8)
    // 横向平铺判据：色条为 flex 行（CSS 层），DOM 层锁 8 个色块同属一个 strip
    expect(dropdown.find('.group-color-strip').exists()).toBe(true)
    w.unmount()
  })

  it('mouseleave 后宽限 220ms 才收起（按钮→下拉途中不闪闭）；到点即收', async () => {
    vi.useFakeTimers()
    const w = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true } })
    await w.find('.group-color-menu').trigger('mouseenter')
    expect(w.find('[data-testid="group-color-dropdown"]').exists()).toBe(true)
    await w.find('.group-color-menu').trigger('mouseleave')
    // 宽限窗口内仍展开（指针正在前往下拉的途中）
    vi.advanceTimersByTime(200)
    await nextTick()
    expect(w.find('[data-testid="group-color-dropdown"]').exists(), '220ms 宽限内不应收起').toBe(true)
    vi.advanceTimersByTime(50)
    await nextTick()
    expect(w.find('[data-testid="group-color-dropdown"]').exists(), '宽限结束应收起').toBe(false)
    w.unmount()
  })

  it('再次 mouseenter 取消待收窄限（往返按钮不闪闭）', async () => {
    vi.useFakeTimers()
    const w = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true } })
    await w.find('.group-color-menu').trigger('mouseenter')
    await w.find('.group-color-menu').trigger('mouseleave')
    vi.advanceTimersByTime(200)
    await w.find('.group-color-menu').trigger('mouseenter')
    vi.advanceTimersByTime(100)
    await nextTick()
    expect(w.find('[data-testid="group-color-dropdown"]').exists(), '重新进入应取消收起').toBe(true)
    w.unmount()
  })

  it('点击触发钮 toggle 展开（触屏/点击路径可达）', async () => {
    const w = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true } })
    await w.find('[data-testid="group-color-trigger"]').trigger('click')
    expect(w.find('[data-testid="group-color-dropdown"]').exists()).toBe(true)
    await w.find('[data-testid="group-color-trigger"]').trigger('click')
    expect(w.find('[data-testid="group-color-dropdown"]').exists()).toBe(false)
    w.unmount()
  })

  it('点 rose emit groupColor ["rose"]；色值走令牌无字面 hex', async () => {
    const w = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true } })
    await w.find('.group-color-menu').trigger('mouseenter')
    const rose = w.find('[data-testid="group-color-rose"]')
    expect(rose.attributes('style')).toContain('var(--neo-group-rose)')
    expect(rose.attributes('style')).not.toMatch(/#[0-9a-fA-F]{3,}/)
    await rose.trigger('click')
    expect(w.emitted('groupColor')).toEqual([['rose']])
    w.unmount()
  })

  it('neutral 即默认色：点 neutral emit groupColor ["neutral"]（复位语义合一）', async () => {
    const w = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true } })
    await w.find('.group-color-menu').trigger('mouseenter')
    await w.find('[data-testid="group-color-neutral"]').trigger('click')
    expect(w.emitted('groupColor')).toEqual([['neutral']])
    w.unmount()
  })

  it('内环实时跟随：groupColorKey=rose → core 背景 var(--neo-group-rose)', () => {
    const w = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true, groupColorKey: 'rose' } })
    const core = w.find('[data-testid="group-color-trigger-core"]')
    expect(core.attributes('style')).toContain('var(--neo-group-rose)')
    expect(core.attributes('style')).not.toMatch(/#[0-9a-fA-F]{3,}/)
    w.unmount()
  })

  it('未传 groupColorKey 时内环落 neutral（默认色可见）', () => {
    const w = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true } })
    const core = w.find('[data-testid="group-color-trigger-core"]')
    expect(core.attributes('style')).toContain('var(--neo-group-neutral)')
    w.unmount()
  })

  it('当前色高亮：groupColorKey=rose 时 rose 带 is-active，其余不带', async () => {
    const w = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true, groupColorKey: 'rose' } })
    await w.find('.group-color-menu').trigger('mouseenter')
    expect(w.find('[data-testid="group-color-rose"]').classes()).toContain('is-active')
    expect(w.find('[data-testid="group-color-moss"]').classes()).not.toContain('is-active')
    expect(w.find('[data-testid="group-color-rose"]').attributes('aria-pressed')).toBe('true')
    w.unmount()
  })

  it('CSS 契约：色块 transform 缩放（hover 放大不占布局盒）+ 当前色品牌色环 + 触发钮内外环', () => {
    const src = readFileSync(join(HERE, 'MultiSelectToolbar.vue'), 'utf8')
    // 色块：静止缩小、色条 hover 放大（transform 不占布局盒）
    expect(src).toMatch(/\.group-color-dot\s*\{[^}]*transform:\s*scale\(0\.7\)/)
    expect(src).toMatch(/\.group-color-strip:hover \.group-color-dot\s*\{[^}]*transform:\s*scale\(1\.2\)/)
    // 当前色品牌色环高亮
    expect(src).toMatch(/\.group-color-dot\.is-active\s*\{[^}]*--neo-accent/)
    // 触发钮内外环结构：外环圆描边 + 内环实心圆
    expect(src).toMatch(/\.group-color-trigger\s*\{[^}]*border-radius:\s*9999px/)
    expect(src).toMatch(/\.group-color-trigger-core\s*\{[^}]*border-radius:\s*9999px/)
  })
})
