import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeTile from './MobileNodeTile.vue'
import { CANVAS_MULTI_SELECT_ACTIVE_KEY } from '@/composables/canvasNodeActions'

describe('MobileNodeTile', () => {
  it('image: 渲染媒体本身，无 12px 内联钮', () => {
    const w = mount(MobileNodeTile, { props: { type: 'image', data: { url: 'x.png' } } })
    expect(w.find('img').exists() || w.find('.mobile-node-media').exists()).toBe(true)
    expect(w.find('.neo-node-preview-btn').exists()).toBe(false)
  })

  it('video: preload=metadata + 播放态提示（避免白框）', () => {
    const w = mount(MobileNodeTile, { props: { type: 'video', data: { url: 'v.mp4', poster: 'p.png' } } })
    const v = w.find('video')
    expect(v.exists()).toBe(true)
    expect(v.attributes('preload')).toBe('metadata')
    expect(w.find('.mobile-node-video-play').exists()).toBe(true)
  })

  it('audio: 渲染波形占位 + 播放钮，无原生 controls', () => {
    const w = mount(MobileNodeTile, { props: { type: 'audio', data: { url: 'a.mp3' } } })
    expect(w.find('.mobile-audio-wave').exists()).toBe(true)
    expect(w.find('.mobile-audio-play').exists()).toBe(true)
    const audio = w.find('audio')
    expect(audio.exists()).toBe(true)
    expect(audio.attributes('controls')).toBeUndefined()
  })

  it('text: 渲染截断内容，无标题栏', () => {
    const w = mount(MobileNodeTile, { props: { type: 'text', data: { content: '一二三四五六七八九十' } } })
    expect(w.find('.neo-node-external-title').exists()).toBe(false)
    expect(w.text()).toContain('一二三四')
  })

  // ── 选择模式（D4 / H1：对标 iOS 照片多选）─────────────────────────────
  // ⭐ 多选态信号**已存在**（`CANVAS_MULTI_SELECT_ACTIVE_KEY` 注入，R4-T4 起用于
  //   多选徽标）⇒ 本任务**不新增** `selectionMode` prop（避免第二个真源）。
  describe('选择模式（全局圆圈 + 轻点即选）', () => {
    function mountTile(multiActive: boolean, selected = false) {
      return mount(MobileNodeTile, {
        props: { id: 'n1', type: 'image', data: { url: 'https://x/a.png' }, selected },
        global: {
          provide: { [CANVAS_MULTI_SELECT_ACTIVE_KEY as symbol]: { value: multiActive } },
        },
      })
    }

    it('选择模式下显示圆形选择指示器（未选 = 空心）', () => {
      const w = mountTile(true, false)
      const ind = w.find('[data-testid="mobile-node-select-indicator"]')
      expect(ind.exists()).toBe(true)
      expect(ind.classes()).not.toContain('is-selected')
      w.unmount()
    })

    it('已选中的节点：指示器为选中态', () => {
      const w = mountTile(true, true)
      expect(w.find('[data-testid="mobile-node-select-indicator"]').classes()).toContain('is-selected')
      w.unmount()
    })

    it('非选择模式：不显示指示器（不打扰常态）', () => {
      const w = mountTile(false, false)
      expect(w.find('[data-testid="mobile-node-select-indicator"]').exists()).toBe(false)
      w.unmount()
    })

    it('选择模式下 tap = 切换选中（emit toggle-select），**不** emit tap（不开查看器）', async () => {
      const w = mountTile(true, false)
      await w.get('.mobile-node-tile').trigger('click')
      expect(w.emitted('toggle-select')).toBeTruthy()
      expect(w.emitted('tap')).toBeFalsy()
      w.unmount()
    })

    it('非选择模式下 tap 仍走原路径（emit tap）', async () => {
      const w = mountTile(false, false)
      await w.get('.mobile-node-tile').trigger('click')
      expect(w.emitted('tap')).toBeTruthy()
      expect(w.emitted('toggle-select')).toBeFalsy()
      w.unmount()
    })
  })
})
