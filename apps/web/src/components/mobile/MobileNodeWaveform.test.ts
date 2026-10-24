import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeWaveform from './MobileNodeWaveform.vue'

function peaks(n: number, fill: number) {
  return Array.from({ length: n }, () => fill)
}

function barHeights(w: ReturnType<typeof mount>) {
  return w.findAll('.mobile-node-waveform-bar').map((b) => parseFloat(b.attributes('style')!.match(/height:\s*([\d.]+)%/)![1]))
}

describe('MobileNodeWaveform', () => {
  it('每个峰值一根条，不多不少', () => {
    const w = mount(MobileNodeWaveform, { props: { peaks: peaks(24, 0.5) } })
    expect(w.findAll('.mobile-node-waveform-bar').length).toBe(24)
  })

  it('峰值越大条越高（视觉真的在编码音量）', () => {
    const w = mount(MobileNodeWaveform, { props: { peaks: [0.1, 0.4, 1] } })
    const heights = barHeights(w)
    expect(heights[2]).toBeGreaterThan(heights[1])
    expect(heights[1]).toBeGreaterThan(heights[0])
  })

  it('静音段也是可见的条（跌到 0 会整排消失）', () => {
    const w = mount(MobileNodeWaveform, { props: { peaks: [0, 0, 0] } })
    expect(barHeights(w).every((h) => h > 0)).toBe(true)
  })

  it('loading ⇒ 显示「波形加载中」微标；此时 aria 也说明是加载中', () => {
    const w = mount(MobileNodeWaveform, { props: { peaks: peaks(4, 0.5), loading: true } })
    expect(w.find('[data-testid="mobile-node-waveform-loading"]').exists()).toBe(true)
    expect(w.attributes('aria-label')).toBe('音频波形加载中')
  })

  it('不 loading 就不挂 loading 微标（没在尝试就别装作在加载）', () => {
    const w = mount(MobileNodeWaveform, { props: { peaks: peaks(4, 0.5), loading: false } })
    expect(w.find('[data-testid="mobile-node-waveform-loading"]').exists()).toBe(false)
  })

  it('占位态 aria 明说是占位，真数据态不再这么自称', () => {
    const placeholder = mount(MobileNodeWaveform, { props: { peaks: peaks(4, 0.5), source: 'placeholder' } })
    expect(placeholder.attributes('aria-label')).toBe('音频波形占位')
    const real = mount(MobileNodeWaveform, { props: { peaks: peaks(4, 0.5), source: 'real' } })
    expect(real.attributes('aria-label')).toBe('音频波形')
  })

  it('data-source 透出来源，便于取证样式分支', () => {
    const w = mount(MobileNodeWaveform, { props: { peaks: peaks(4, 0.5), source: 'real' } })
    expect(w.attributes('data-source')).toBe('real')
  })
})
