import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeTile from './MobileNodeTile.vue'

describe('MobileNodeTile', () => {
  it('image: 渲染媒体本身，无 12px 内联钮', () => {
    const w = mount(MobileNodeTile, { props: { type: 'image', data: { url: 'x.png' } } })
    expect(w.find('img').exists() || w.find('.mobile-node-media').exists()).toBe(true)
    expect(w.find('.neo-node-preview-btn').exists()).toBe(false)
  })

  it('video: preload=none + 海报', () => {
    const w = mount(MobileNodeTile, { props: { type: 'video', data: { url: 'v.mp4', poster: 'p.png' } } })
    const v = w.find('video')
    expect(v.exists()).toBe(true)
    expect(v.attributes('preload')).toBe('none')
  })

  it('audio: 渲染波形占位 + 播放钮，无原生 controls', () => {
    const w = mount(MobileNodeTile, { props: { type: 'audio', data: { url: 'a.mp3' } } })
    expect(w.find('audio').exists()).toBe(false)
    expect(w.find('.mobile-audio-wave').exists()).toBe(true)
    expect(w.find('.mobile-audio-play').exists()).toBe(true)
  })

  it('text: 渲染截断内容，无标题栏', () => {
    const w = mount(MobileNodeTile, { props: { type: 'text', data: { content: '一二三四五六七八九十' } } })
    expect(w.find('.neo-node-external-title').exists()).toBe(false)
    expect(w.text()).toContain('一二三四')
  })
})
