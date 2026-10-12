import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MultiSelectToolbar from './MultiSelectToolbar.vue'

/**
 * 分组色卡入口回归锁（2026-10-12，P3）：选中分组（canUngroup）时工具条
 * 出现「颜色」按钮，弹 8+1 格色板（首格复位），点击 emit groupColor。
 */
describe('MultiSelectToolbar: 分组色卡', () => {
  const base = { selectedIds: ['g-1'], screenPosition: { x: 0, y: 0 } }

  it('有效性前置：canUngroup 时「颜色」按钮存在，否则不渲染', () => {
    const on = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true } })
    expect(on.find('[data-testid="group-color-trigger"]').exists()).toBe(true)
    on.unmount()
    const off = mount(MultiSelectToolbar, { props: { ...base, canUngroup: false } })
    expect(off.find('[data-testid="group-color-trigger"]').exists()).toBe(false)
    off.unmount()
  })

  it('点开色板：8 色格 + 1 复位格；点 moss emit groupColor ["moss"]', async () => {
    const w = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true } })
    await w.find('[data-testid="group-color-trigger"]').trigger('click')
    expect(w.find('[data-testid="group-color-none"]').exists(), '复位格必须存在').toBe(true)
    const swatches = w.findAll('.group-color-swatch')
    expect(swatches.length, '8 色 + 1 复位').toBe(9)
    const moss = w.find('[data-testid="group-color-moss"]')
    expect(moss.exists()).toBe(true)
    // 色值必须走令牌（组件内无字面 hex）
    expect(moss.attributes('style')).toContain('var(--neo-group-moss)')
    expect(moss.attributes('style')).not.toMatch(/#[0-9a-fA-F]{3,}/)
    await moss.trigger('click')
    expect(w.emitted('groupColor')).toEqual([['moss']])
    w.unmount()
  })

  it('复位格 emit groupColor [null]', async () => {
    const w = mount(MultiSelectToolbar, { props: { ...base, canUngroup: true } })
    await w.find('[data-testid="group-color-trigger"]').trigger('click')
    await w.find('[data-testid="group-color-none"]').trigger('click')
    expect(w.emitted('groupColor')).toEqual([[null]])
    w.unmount()
  })
})
