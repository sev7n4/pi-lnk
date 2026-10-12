import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MultiSelectToolbar from './MultiSelectToolbar.vue'

/**
 * 分组色卡单排回归锁（优化点③，2026-10-12）。
 *
 * 交互从「颜色触发钮 + 三排弹层（8 色 + 1 复位）」改为「常驻单排 8 色点」：
 * 指针进入色条整条放大到易点尺寸（transform 缩放，不占布局盒），当前分组色
 * 以品牌色环高亮。neutral 即默认色，复位语义与色点合一（不再单设复位格）。
 */
describe('MultiSelectToolbar: 分组色卡单排', () => {
  const base = { selectedIds: ['g-1'], screenPosition: { x: 0, y: 0 } }

  it('有效性前置：canUngroup 时单排色条存在（8 个色点），否则不渲染', () => {
    const on = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true } })
    const dots = on.findAll('.group-color-dot')
    expect(dots.length, '8 个预设色点（neutral/moss/dusk/clay/celadon/graphite/rose/plum）').toBe(8)
    expect(on.find('[data-testid="group-color-neutral"]').exists()).toBe(true)
    expect(on.find('[data-testid="group-color-rose"]').exists()).toBe(true)
    on.unmount()
    const off = mount(MultiSelectToolbar, { props: { ...base, canUngroup: false } })
    expect(off.find('.group-color-strip').exists()).toBe(false)
    off.unmount()
  })

  it('无弹层：旧 trigger 按钮与三排网格已移除（单排常驻，不需要点开）', () => {
    const w = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true } })
    expect(w.find('[data-testid="group-color-trigger"]').exists()).toBe(false)
    // 色点无需点击触发就已在 DOM 里（非 v-if 弹层）
    expect(w.find('[data-testid="group-color-moss"]').exists()).toBe(true)
    w.unmount()
  })

  it('点 rose emit groupColor ["rose"]；色值走令牌无字面 hex', async () => {
    const w = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true } })
    const rose = w.find('[data-testid="group-color-rose"]')
    expect(rose.attributes('style')).toContain('var(--neo-group-rose)')
    expect(rose.attributes('style')).not.toMatch(/#[0-9a-fA-F]{3,}/)
    await rose.trigger('click')
    expect(w.emitted('groupColor')).toEqual([['rose']])
    w.unmount()
  })

  it('neutral 即默认色：点 neutral emit groupColor ["neutral"]（复位语义合一）', async () => {
    const w = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true } })
    await w.find('[data-testid="group-color-neutral"]').trigger('click')
    expect(w.emitted('groupColor')).toEqual([['neutral']])
    w.unmount()
  })

  it('当前色高亮：groupColorKey=rose 时 rose 带 is-active，其余不带', () => {
    const w = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true, groupColorKey: 'rose' } })
    expect(w.find('[data-testid="group-color-rose"]').classes()).toContain('is-active')
    expect(w.find('[data-testid="group-color-moss"]').classes()).not.toContain('is-active')
    expect(w.find('[data-testid="group-color-rose"]').attributes('aria-pressed')).toBe('true')
    w.unmount()
  })

  it('未传 groupColorKey 时默认高亮 neutral（默认色可见）', () => {
    const w = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true } })
    expect(w.find('[data-testid="group-color-neutral"]').classes()).toContain('is-active')
    w.unmount()
  })
})
