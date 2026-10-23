import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import MobileNodeTile from './MobileNodeTile.vue'

/**
 * 瓦片级接线守卫：音频节点必须真的把波形渲染出来（而不是回到 CSS 渐变占位）。
 * jsdom 没有 AudioContext ⇒ 真实峰值拿不到 ⇒ 这里是「降级形态」的取证：
 * 一个波形条都不许少，且老实标着 placeholder。
 */
describe('MobileNodeTile · 音频波形接线', () => {
  it('音频瓦片渲染 64 根波形条 + 播放钮', async () => {
    const w = mount(MobileNodeTile, { props: { id: 'n-audio-1', type: 'audio', data: { url: 'a.mp3' } } })
    await flushPromises()
    expect(w.find('.mobile-audio-wave').exists()).toBe(true)
    expect(w.find('[data-testid="mobile-node-waveform"]').exists()).toBe(true)
    expect(w.findAll('.mobile-node-waveform-bar').length).toBe(64)
    expect(w.find('.mobile-audio-play').exists()).toBe(true)
  })

  it('jsdom 无 AudioContext ⇒ 保持占位来源且不残留 loading 微标', async () => {
    const w = mount(MobileNodeTile, { props: { id: 'n-audio-2', type: 'audio', data: { url: 'b.mp3' } } })
    await flushPromises()
    const wave = w.find('[data-testid="mobile-node-waveform"]')
    expect(wave.attributes('data-source')).toBe('placeholder')
    expect(w.find('[data-testid="mobile-node-waveform-loading"]').exists()).toBe(false)
  })

  it('同 id 两次挂载波形不跳变（滚动重组不会闪）', async () => {
    const a = mount(MobileNodeTile, { props: { id: 'n-audio-stable', type: 'audio', data: { url: 'c.mp3' } } })
    const b = mount(MobileNodeTile, { props: { id: 'n-audio-stable', type: 'audio', data: {} } })
    await flushPromises()
    const heightsOf = (w: ReturnType<typeof mount>) =>
      w.findAll('.mobile-node-waveform-bar').map((el) => el.attributes('style'))
    expect(heightsOf(a)).toEqual(heightsOf(b))
  })
})
