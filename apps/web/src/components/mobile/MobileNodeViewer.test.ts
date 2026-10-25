import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeViewer from './MobileNodeViewer.vue'

/**
 * D2（2026-10-25 规格 §6.2 / §4.1 P3）：全屏查看器必须有**两条**退出通道
 * ——「右上 X」与「下滑关闭」，且**退出即停**（视频 pause）。
 *
 * ⚠️ 契约变更（D2）：左上 `‹` 文本字符（U+2039 细笔画，形态随字重不稳、
 *   识别失败）已删除，改为**右上角 X 的内联 SVG**（§4.11.5：禁文本字符当图标）。
 *   既有断言 `.viewer-back` 相应改写为 `.viewer-close`，**回归防护保留**。
 */
describe('MobileNodeViewer（退出通道 · D2）', () => {
  it('右上角有 X 按钮（44px 触控目标）并 emit close', async () => {
    const wrapper = mount(MobileNodeViewer, {
      props: { type: 'image', data: { url: 'https://x/a.png' } },
    })
    const btn = wrapper.find('[data-testid="mobile-viewer-close"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('无 audio 类型分支（音频永不进查看器）', () => {
    const wrapper = mount(MobileNodeViewer, {
      props: { type: 'image', data: { url: 'https://x/a.png' } },
    })
    expect(wrapper.find('video').exists()).toBe(false)
  })

  it('image: 全屏灯箱（根容器有 testid + 渲染 img）', () => {
    const w = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'x.png' } } })
    expect(w.find('[data-testid="mobile-viewer"]').exists()).toBe(true)
    expect(w.find('img').exists()).toBe(true)
  })

  it('text: 渲染阅读器内容', () => {
    const w = mount(MobileNodeViewer, { props: { type: 'text', data: { content: '正文' } } })
    expect(w.text()).toContain('正文')
  })

  it('下滑超过阈值 ⇒ emit close（第二条退出通道）', async () => {
    const w = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'x.png' } } })
    const root = w.get('[data-testid="mobile-viewer"]')
    await root.trigger('touchstart', { touches: [{ clientY: 300 }] })
    await root.trigger('touchmove', { touches: [{ clientY: 150 }] })
    await root.trigger('touchend')
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('下滑不足阈值 ⇒ 不 emit close', async () => {
    const w = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'x.png' } } })
    const root = w.get('[data-testid="mobile-viewer"]')
    await root.trigger('touchstart', { touches: [{ clientY: 300 }] })
    await root.trigger('touchmove', { touches: [{ clientY: 280 }] })
    await root.trigger('touchend')
    expect(w.emitted('close')).toBeFalsy()
  })

  it('视频退出即停：close 前调用 pause()（P3「退出即停」）', async () => {
    // ⚠️ 用原型 spy 而非替换 ref —— 组件内部持有自己的 ref，
    // 从外部替换 exposed.videoRef 换不掉内部引用（第一次写错，红了才发现）。
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    try {
      const w = mount(MobileNodeViewer, { props: { type: 'video', data: { url: 'x.mp4' } } })
      await w.get('[data-testid="mobile-viewer-close"]').trigger('click')
      expect(pause).toHaveBeenCalled()
    } finally {
      pause.mockRestore()
    }
  })
})
