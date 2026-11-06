import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NodeViewerView from './NodeViewerView.vue'

/**
 * NodeViewerView（Task 3 提升的共享查看器，presentation/，设备无关）。
 *
 * 本测试只验证「渲染主体」已从移动壳抽出并等价可用：给定各 type 节点数据，
 * NodeViewerView 渲染出与旧 MobileNodeViewer 等价的查看器结构
 * （全屏容器 / 媒体区 / 标注容器 / 缩放容器 / 审核内容层）。
 * 行为（手势/退出/缩放探测）契约由 MobileNodeViewer.test.ts 经壳层委托覆盖。
 */
describe('NodeViewerView（共享查看器渲染主体）', () => {
  it('image: 渲染全屏容器 + 媒体区 + 灯箱 img（缩放容器）', () => {
    const w = mount(NodeViewerView, {
      global: { stubs: { teleport: true } },
      props: { type: 'image', data: { url: 'x.png' } },
    })
    expect(w.find('[data-testid="mobile-viewer"]').exists()).toBe(true)
    expect(w.find('.viewer-body').exists()).toBe(true)
    expect(w.find('img.viewer-media').exists()).toBe(true)
    // 标注入口（圈选）与退出 X 同属渲染主体
    expect(w.find('[data-testid="mobile-viewer-bottom-annotate"]').exists()).toBe(true)
    expect(w.find('[data-testid="mobile-viewer-close"]').exists()).toBe(true)
    w.unmount()
  })

  it('video: 渲染 video 元素（倍速交原生 controls，不自绘）', () => {
    const w = mount(NodeViewerView, {
      global: { stubs: { teleport: true } },
      props: { type: 'video', data: { url: 'x.mp4' } },
    })
    expect(w.find('video').exists()).toBe(true)
    // #743：视频倍速退役，原生 <video controls> 是唯一速率入口
    expect(w.find('[data-testid="mobile-viewer-speed"]').exists()).toBe(false)
    w.unmount()
  })

  it('audio: 渲染波形查看器（audio 元素 + 播放 + 可拖进度）', () => {
    const w = mount(NodeViewerView, {
      global: { stubs: { teleport: true } },
      props: { type: 'audio', data: { url: 'x.mp3' } },
    })
    expect(w.find('[data-testid="mobile-viewer-audio"]').exists()).toBe(true)
    expect(w.find('audio').exists()).toBe(true)
    expect(w.find('[data-testid="mobile-viewer-audio-play"]').exists()).toBe(true)
    expect(w.find('input[type="range"]').exists()).toBe(true)
    w.unmount()
  })

  it('text: 渲染阅读器内容', () => {
    const w = mount(NodeViewerView, {
      global: { stubs: { teleport: true } },
      props: { type: 'text', data: { content: '正文' } },
    })
    expect(w.text()).toContain('正文')
    w.unmount()
  })

  it('pending + 无产物 ⇒ 渲染审核内容层（非空白黑媒体区）', () => {
    const w = mount(NodeViewerView, {
      global: { stubs: { teleport: true } },
      props: {
        type: 'image',
        data: { status: 'pending_confirm', prompt: '赛博朋克城市夜景', imageAspect: '16:9', imageResolution: '2K' },
      },
    })
    expect(w.find('[data-testid="mobile-viewer-review"]').exists()).toBe(true)
    expect(w.find('[data-testid="mobile-viewer-review-prompt"]').text()).toContain('赛博朋克城市夜景')
    expect(w.find('[data-testid="mobile-viewer-review-params"]').text()).toBe('16:9 · 2K')
    expect(w.find('img').exists()).toBe(false)
    w.unmount()
  })

  it('标注态容器随渲染出现（画笔覆盖层 testid）', async () => {
    const w = mount(NodeViewerView, {
      global: { stubs: { teleport: true } },
      props: { type: 'image', data: { url: 'x.png' } },
    })
    await w.get('[data-testid="mobile-viewer-bottom-annotate"]').trigger('click')
    expect(w.find('[data-testid="mobile-viewer-ink"]').isVisible()).toBe(true)
    w.unmount()
  })
})
