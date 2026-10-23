// MobileNodeCoachMark（R1-T7）：一次性引导「点按播放 · 长按编辑」。
// 首进画布显示一次，关闭后写 localStorage 标记；已看过不渲染。
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeCoachMark from './MobileNodeCoachMark.vue'

const KEY = 'mobile-node-coach-seen'

beforeEach(() => {
  localStorage.clear()
})

describe('MobileNodeCoachMark', () => {
  it('首次显示，关闭后写 localStorage 标记', async () => {
    const w = mount(MobileNodeCoachMark)
    expect(w.find('.coach-mark').exists()).toBe(true)
    expect(w.text()).toContain('点按播放')
    await w.find('.coach-close').trigger('click')
    expect(localStorage.getItem(KEY)).toBe('1')
    // 关闭后同实例即收起（不需要等重挂载）
    expect(w.find('.coach-mark').exists()).toBe(false)
  })

  it('已看过则不渲染', () => {
    localStorage.setItem(KEY, '1')
    const w = mount(MobileNodeCoachMark)
    expect(w.find('.coach-mark').exists()).toBe(false)
  })
})
