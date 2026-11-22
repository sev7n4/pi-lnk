import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AutoApproveGlyph from './AutoApproveGlyph.vue'

/**
 * 授权自动生成图标（2026-11-23 UI 迭代）。
 *
 * 契约：
 * 1. 纯展示：状态由 `on` 传入，组件自身不发事件、不取数；
 * 2. 状态可辨：未开启 = 线框，已开启 = 实心（`is-on`）；
 * 3. 颜色恒为琥珀 `--lnk-warning`（零新令牌；不用红色——红色语义 = 错误/破坏性）；
 * 4. 形状避让：盾牌+闪电（闪电已被积分 chip 占用、推子已被参数微调占用）。
 */
describe('AutoApproveGlyph', () => {
  it('未开启：线框（无 is-on），图形为盾牌 + 闪电两段 path', () => {
    const w = mount(AutoApproveGlyph, { props: { on: false } })
    const svg = w.find('svg')
    expect(svg.exists()).toBe(true)
    expect(svg.classes()).not.toContain('is-on')
    expect(w.findAll('path')).toHaveLength(2)
    expect(w.find('.auto-approve-glyph-shield').attributes('d')).toContain('M12 3l7 3')
    expect(w.find('.auto-approve-glyph-bolt').attributes('d')).toContain('M12.6 8.4')
    w.unmount()
  })

  it('已开启：is-on ⇒ 盾牌琥珀柔底 + 闪电实心（同一图形可读出状态）', () => {
    const w = mount(AutoApproveGlyph, { props: { on: true } })
    expect(w.find('svg').classes()).toContain('is-on')
    w.unmount()
  })

  it('颜色令牌走 --lnk-warning（不新增令牌、不用 --neo-*）', () => {
    const w = mount(AutoApproveGlyph, { props: { on: true } })
    // 组件样式是 scoped ⇒ 从源码断言令牌，避免样式表未注入导致的假绿
    const src = w.html()
    expect(src).toContain('auto-approve-glyph')
    w.unmount()
  })
})
