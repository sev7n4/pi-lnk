import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DockCreditBadge from './DockCreditBadge.vue'

/**
 * P2 T8 · spec §6.7：徽标新增 variant（fixed | from）。
 * from = token 计费口径「⚡N积分起」+ hover 明细；默认 fixed 完全兼容既有调用点。
 */
describe('DockCreditBadge variant（P2 T8 · spec §6.7）', () => {
  it('默认 fixed：显示「N积分」+ 预估 title（既有口径零变化）', () => {
    const w = mount(DockCreditBadge, { props: { credits: 5 } })
    expect(w.text()).toContain('5积分')
    expect(w.text()).not.toContain('积分起')
    expect(w.find('.dock-credit-badge').attributes('title')).toBe('预估消耗积分 5')
  })

  it('variant="from"：显示「N积分起」+ hover 明细「按 token 计费 · 单次至少 1 积分 · 典型 1–2」', () => {
    const w = mount(DockCreditBadge, { props: { credits: 1, variant: 'from' } })
    expect(w.text()).toContain('1积分起')
    expect(w.find('.dock-credit-badge').attributes('title')).toBe(
      '按 token 计费 · 单次至少 1 积分 · 典型 1–2',
    )
  })

  it('免费态不受 variant 影响：credits=0 仍显示「免费」', () => {
    const w = mount(DockCreditBadge, { props: { credits: 0, variant: 'from' } })
    expect(w.text()).toContain('免费')
    expect(w.text()).not.toContain('积分起')
  })
})
