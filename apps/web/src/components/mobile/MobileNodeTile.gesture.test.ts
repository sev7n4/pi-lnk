import { afterEach, describe, it, expect, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import MobileNodeTile from './MobileNodeTile.vue'
import { MOBILE_NODE_ACTION_REQUEST_KEY } from '@/composables/canvasNodeActions'
import { resetAudioPlaybackForTest } from '@/utils/audioPlayback'

function fireTouch(wrapper: any, type: string) {
  const el = wrapper.get('.mobile-node-tile').element as HTMLElement
  const ev = new Event(type, { bubbles: true }) as any
  ev.touches = [{ clientX: 0, clientY: 0 }]
  el.dispatchEvent(ev)
}

afterEach(() => {
  resetAudioPlaybackForTest()
  vi.restoreAllMocks()
})

describe('MobileNodeTile gesture', () => {
  it('tap 触发主内容动作', async () => {
    const w = mount(MobileNodeTile, { props: { id: 'n1', type: 'image', data: { url: 'x' } } })
    await w.get('.mobile-node-tile').trigger('click')
    expect(w.emitted('tap')).toHaveLength(1)
  })

  it('长按经 useLongPress 请求本端动作 sheet（不触发 tap）', async () => {
    const request = vi.fn()
    const w = mount(MobileNodeTile, {
      props: { id: 'n1', type: 'image', data: { url: 'x' } },
      global: { provide: { [MOBILE_NODE_ACTION_REQUEST_KEY as any]: request } },
    })
    fireTouch(w, 'touchstart')
    await new Promise((r) => setTimeout(r, 450))
    fireTouch(w, 'touchend')
    expect(request).toHaveBeenCalledWith({ id: 'n1', type: 'image', data: { url: 'x' } })
    expect(w.emitted('tap')).toBeFalsy()
  })

  // ⭐ 2026-11-05 真机反馈：旧按钮体恒为字符 '▶'，playing 只改 aria-label ⇒
  // 用户「点了没变成播放态」。这条断言锁的是**可见形态**而非无障碍标签。
  it('audio: 点击播放按钮切换可见图标 play→pause（不冒泡成 tap）', async () => {
    const w = mount(MobileNodeTile, { props: { id: 'n2', type: 'audio', data: { url: 'a.mp3' } } })
    const btn = w.find('.mobile-audio-play')
    expect(w.find('[data-testid="mobile-audio-icon-play"]').exists()).toBe(true)
    expect(w.find('[data-testid="mobile-audio-icon-pause"]').exists()).toBe(false)
    await btn.trigger('click')
    expect(btn.attributes('aria-label')).toBe('暂停')
    expect(w.find('[data-testid="mobile-audio-icon-play"]').exists()).toBe(false)
    expect(w.find('[data-testid="mobile-audio-icon-pause"]').exists()).toBe(true)
    expect(w.emitted('tap')).toBeFalsy()
    w.unmount()
  })

  it('audio: pause / ended 媒体事件复位图标（短音频播完不卡在播放态）', async () => {
    const w = mount(MobileNodeTile, { props: { id: 'n3', type: 'audio', data: { url: 'a.mp3' } } })
    const label = () => w.find('.mobile-audio-play').attributes('aria-label')
    const audio = w.find('audio')
    await audio.trigger('play')
    expect(label()).toBe('暂停')
    await audio.trigger('ended')
    expect(label()).toBe('播放')
    expect(w.find('[data-testid="mobile-audio-icon-play"]').exists()).toBe(true)
    await audio.trigger('play')
    await audio.trigger('pause')
    expect(label()).toBe('播放')
    w.unmount()
  })

  it('audio: play() 被自动播放策略拒绝时回滚形态（不出现「连点三次才响」）', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('NotAllowedError'))
    try {
      const w = mount(MobileNodeTile, { props: { id: 'n4', type: 'audio', data: { url: 'a.mp3' } } })
      await w.find('.mobile-audio-play').trigger('click')
      await flushPromises()
      expect(w.find('.mobile-audio-play').attributes('aria-label')).toBe('播放')
      expect(w.find('[data-testid="mobile-audio-icon-play"]').exists()).toBe(true)
      w.unmount()
    } finally {
      play.mockRestore()
    }
  })
})
