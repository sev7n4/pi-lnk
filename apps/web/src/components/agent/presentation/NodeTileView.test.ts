import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NodeTileView from '@/components/agent/presentation/NodeTileView.vue'
import MobileNodeTile from '@/components/mobile/MobileNodeTile.vue'

/**
 * NodeTileView = 由 MobileNodeTile 提升出的设备无关共享瓦片（presentation/）。
 * 本测试断言：给定与 MobileNodeTile 完全一致的 props，NodeTileView 渲染出
 * 等价的关键 DOM（头部 / 媒体元素 / 文本 / 状态徽标挂载点）。
 *
 * RED 阶段：NodeTileView.vue 尚不存在 ⇒ 模块解析失败 → 测试 FAIL。
 */
describe('NodeTileView（由 MobileNodeTile 提升的共享瓦片）', () => {
  it('image 节点：渲染头部 + 媒体 <img>', () => {
    const w = mount(NodeTileView, {
      props: { id: 'n1', type: 'image', data: { url: 'https://x/a.png' } },
    })
    expect(w.find('[data-testid="mobile-node-tile-header"]').exists()).toBe(true)
    expect(w.find('img.mobile-node-media').exists()).toBe(true)
  })

  it('video 节点：渲染头部 + 媒体 <video>', () => {
    const w = mount(NodeTileView, {
      props: { id: 'n2', type: 'video', data: { url: 'https://x/a.mp4' } },
    })
    expect(w.find('[data-testid="mobile-node-tile-header"]').exists()).toBe(true)
    expect(w.find('video.mobile-node-media').exists()).toBe(true)
  })

  it('audio 节点：渲染头部 + 播放按钮 + 波形', () => {
    const w = mount(NodeTileView, {
      props: { id: 'n3', type: 'audio', data: { url: 'https://x/a.mp3' } },
    })
    expect(w.find('[data-testid="mobile-node-tile-header"]').exists()).toBe(true)
    expect(w.find('.mobile-audio-play').exists()).toBe(true)
  })

  it('text 节点：渲染头部 + 文本内容', () => {
    const w = mount(NodeTileView, {
      props: { id: 'n4', type: 'text', data: { content: '一只猫在雨中奔跑' } },
    })
    expect(w.find('[data-testid="mobile-node-tile-header"]').exists()).toBe(true)
    expect(w.find('.mobile-node-text').exists()).toBe(true)
    expect(w.find('.mobile-node-text').text()).toContain('一只猫在雨中奔跑')
  })

  it('status 徽标挂载点：显式 status 时渲染 mobile-node-badge', () => {
    const w = mount(NodeTileView, {
      props: { id: 'n5', type: 'image', data: { url: 'x' }, status: 'error' },
    })
    expect(w.find('.mobile-node-badge').exists()).toBe(true)
  })

  it('结构等价：NodeTileView 与 MobileNodeTile 同 props 渲染同一根类', () => {
    const props = { id: 'n6', type: 'image', data: { url: 'https://x/a.png' } } as const
    const shared = mount(NodeTileView, { props })
    const shell = mount(MobileNodeTile, { props })
    expect(shared.find('.mobile-node-tile').exists()).toBe(true)
    expect(shell.find('.mobile-node-tile').exists()).toBe(true)
    expect(shell.find('img.mobile-node-media').exists()).toBe(true)
  })
})
