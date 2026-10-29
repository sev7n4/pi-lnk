import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MobileViewerChrome from './MobileViewerChrome.vue'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 查看 chrome 组件（规格 v1.5 §4.12.4 / §4.12.5，拍板项 P · §9 #36）。
 * 断言：显隐类 / X 关闭 / 动作透传 / 图标与毛玻璃形态（G-20 / G-24）。
 */
const TELEPORT_FREE = {} // 无 Teleport，直接挂载

describe('MobileViewerChrome（chrome 显隐 + 迷你操作条）', () => {
  const actions = [
    { key: 'annotate', label: '圈选', icon: 'marker' as const },
    { key: 'edit', label: '改词', icon: 'pencil' as const },
  ]

  it('visible=false ⇒ 根节点带 chrome-hidden（opacity:0 + pointer-events:none）', () => {
    const w = mount(MobileViewerChrome, { ...TELEPORT_FREE, props: { visible: false, actions } })
    expect(w.find('[data-testid="mobile-viewer-close"]').classes()).toContain('chrome-hidden')
    expect(w.find('[data-testid="mobile-viewer-chrome-bar"]').classes()).toContain('chrome-hidden')
    w.unmount()
  })

  it('X 关闭 emit close；动作项 emit action（key 透传，data-testid 契约保持 mobile-viewer-bottom-*）', async () => {
    const w = mount(MobileViewerChrome, { ...TELEPORT_FREE, props: { visible: true, actions } })
    await w.find('[data-testid="mobile-viewer-close"]').trigger('click')
    await w.find('[data-testid="mobile-viewer-bottom-edit"]').trigger('click')
    await w.find('[data-testid="mobile-viewer-bottom-annotate"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    expect(w.emitted('action')![0]).toEqual(['edit'])
    expect(w.emitted('action')![1]).toEqual(['annotate'])
    w.unmount()
  })

  it('每项含 22×22 内联 SVG 图标 + 标签；条容器为毛玻璃材质（backdrop-filter）', () => {
    const w = mount(MobileViewerChrome, { ...TELEPORT_FREE, props: { visible: true, actions } })
    expect(w.find('[data-testid="mobile-viewer-bottom-edit"] svg').exists()).toBe(true)
    expect(w.find('[data-testid="mobile-viewer-bottom-annotate"] svg').exists()).toBe(true)
    expect(w.find('[data-testid="mobile-viewer-bottom-edit"]').text()).toContain('改词')
    const bar = w.find('[data-testid="mobile-viewer-chrome-bar"]')
    expect(bar.classes()).toContain('viewer-bottom-actions')
    // 毛玻璃材质 = 静态样式契约（源码断言；scoped style 不落在 style 属性上）
    const src = readFileSync(join(HERE, 'MobileViewerChrome.vue'), 'utf8')
    expect(src).toMatch(/backdrop-filter:\s*blur\(var\(--lnk-glass-blur\)\)/)
    w.unmount()
  })

  it('actions 为空 ⇒ 不渲染条，但 X 恒在（文本阅读器最小 chrome）', () => {
    const w = mount(MobileViewerChrome, { ...TELEPORT_FREE, props: { visible: true, actions: [] } })
    expect(w.find('[data-testid="mobile-viewer-chrome-bar"]').exists()).toBe(false)
    expect(w.find('[data-testid="mobile-viewer-close"]').exists()).toBe(true)
    w.unmount()
  })

  it('reduced-motion：样式含直切分支（prefers-reduced-motion 媒体查询）', () => {
    // 静态契约（仓库既有风格）：读 SFC 源码断言媒体查询存在
    const src = readFileSync(join(HERE, 'MobileViewerChrome.vue'), 'utf8')
    expect(src).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
  })
})
