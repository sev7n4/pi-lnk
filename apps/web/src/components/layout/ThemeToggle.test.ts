/**
 * ThemeToggle 行为守卫。
 *
 * ## 为什么这里用 `vi.resetModules()` + 动态 import
 *
 * `useCanvasTheme.ts` 的 `theme` ref 在**模块首次求值时**从 `<html data-theme>` 读初值
 * （以 DOM 为唯一真相源）。这意味着：
 *
 * - 静态 import 会在测试文件的顶层代码之前完成求值 ⇒ 改 DOM 已经来不及；
 * - 两次用例之间不重置模块 ⇒ 第二条用例读到的是第一条遗留的状态。
 *
 * ⛔ 这曾经是真正的线上缺陷：那个 ref 的初始化（连同模块级副作用 `applyTheme()`）
 *    是「主题机制失效」的根因。守卫必须**如实复现这条求值顺序**，不能图省事用
 *    mock 把 composable 换掉 —— 那样测的是替身，不是这套机制。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

async function freshToggle() {
  vi.resetModules()
  const mod = await import('./ThemeToggle.vue')
  return mod.default
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.setAttribute('data-theme', 'dark')
  document.documentElement.classList.add('dark')
})

describe('ThemeToggle', () => {
  it('深色时展示太阳、aria-label 指向「切换到白天模式」', async () => {
    const wrapper = mount(await freshToggle())
    const btn = wrapper.get('button')
    expect(btn.attributes('aria-label')).toBe('切换到白天模式')
    expect(btn.attributes('title')).toBe('切换到白天模式')
    // 太阳有 <circle>，月亮没有 —— 用它区分两个图标，比数 svg 个数可靠
    expect(wrapper.find('circle').exists()).toBe(true)
  })

  it('浅色时展示月亮、aria-label 反向', async () => {
    document.documentElement.setAttribute('data-theme', 'light')
    const wrapper = mount(await freshToggle())
    expect(wrapper.get('button').attributes('aria-label')).toBe('切换到黑夜模式')
    expect(wrapper.find('circle').exists()).toBe(false)
  })

  it('⛔ 点击后必须同时改 DOM 属性、Element Plus 的 .dark class、并落 localStorage', async () => {
    const wrapper = mount(await freshToggle())
    await wrapper.get('button').trigger('click')

    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    // 不同步这个 class，el-dialog / el-input 会继续用深色皮肤（Element Plus 靠它切主题）
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(localStorage.getItem('lnkpi-canvas-theme')).toBe('light')
  })

  it('⛔ 图标按钮必须有可读名称（纯图标按钮无 aria-label = 读屏只能念「按钮」）', async () => {
    const wrapper = mount(await freshToggle())
    const btn = wrapper.get('button')
    expect(btn.attributes('aria-label')).toBeTruthy()
    expect(btn.text()).toBe('')
  })
})
