import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import GuideLines from './GuideLines.vue'

// jsdom 不计算 scoped 样式 ⇒ 令牌/交互约束只能从源码静态断言。
// 用 vite 的 ?raw glob 读同目录源码（不依赖 import.meta.url 的 scheme）。
const rawFiles = import.meta.glob('./GuideLines.vue', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const src = Object.values(rawFiles).join('\n')

describe('GuideLines（拖拽智能参考线渲染）', () => {
  it('传 horizontal=100 → 渲染一条水平参考线，位于 top: 100px', () => {
    const w = mount(GuideLines, { props: { horizontal: 100 } })
    const line = w.find('.snap-guide-h')
    expect(line.exists()).toBe(true)
    expect((line.element as HTMLElement).style.top).toBe('100px')
    // 水平线不应带 left 定位（left/right 由样式铺满）
    expect((line.element as HTMLElement).style.left).toBe('')
  })

  it('传 vertical=200 → 渲染一条垂直参考线，位于 left: 200px', () => {
    const w = mount(GuideLines, { props: { vertical: 200 } })
    const line = w.find('.snap-guide-v')
    expect(line.exists()).toBe(true)
    expect((line.element as HTMLElement).style.left).toBe('200px')
    expect((line.element as HTMLElement).style.top).toBe('')
  })

  it('两个方向都传 → 同时渲染横竖两条', () => {
    const w = mount(GuideLines, { props: { horizontal: 10, vertical: 20 } })
    expect(w.findAll('.snap-guide')).toHaveLength(2)
    expect(w.find('.snap-guide-h').exists()).toBe(true)
    expect(w.find('.snap-guide-v').exists()).toBe(true)
  })

  it('都不传 → 不渲染任何参考线', () => {
    const w = mount(GuideLines)
    expect(w.findAll('.snap-guide')).toHaveLength(0)
  })

  it('样式只用 L2 令牌 var(--lnk-accent) 且 pointer-events: none（不写死色值、不吞画布交互）', () => {
    // 有效性断言：源码确实读到了（否则下面的否定断言会空转通过）
    expect(src).toContain('snap-guide')
    expect(src).toContain('var(--lnk-accent)')
    expect(src).toContain('pointer-events: none')
    // ⛔ 组件不得内联任何色值（hex / rgb / hsl / 工具类）
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(src).not.toMatch(/\brgba?\(/i)
    expect(src).not.toMatch(/\bhsla?\(/i)
    expect(src).not.toContain('text-white')
    expect(src).not.toContain('bg-[#')
  })
})
