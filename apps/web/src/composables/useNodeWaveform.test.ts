import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import MobileNodeWaveform from '../components/mobile/MobileNodeWaveform.vue'
import { useNodeWaveform, type WaveformDecoder } from './useNodeWaveform'
import { buildPlaceholderPeaks } from './waveformPeaks'

/**
 * 行为级守卫：把 composable 挂进真实组件树渲染真实 DOM，
 * 断言的是「用户/取证看得见的出口」（data-source / 条数 / 条高 / loading 微标），
 * 而不是 composable 的内部字段。
 */
function harness(opts: { decoder?: WaveformDecoder; url?: string; nodeId?: string; count?: number }) {
  return mount(
    defineComponent({
      setup() {
        const wf = useNodeWaveform({
          nodeId: () => opts.nodeId ?? 'n-wave-1',
          url: () => opts.url,
          count: opts.count,
          decoder: opts.decoder,
        })
        return () =>
          h(MobileNodeWaveform, {
            peaks: wf.peaks.value,
            source: wf.source.value,
            loading: wf.loading.value,
          })
      },
    }),
  )
}

function barHeights(w: ReturnType<typeof mount>) {
  return w
    .findAll('.mobile-node-waveform-bar')
    .map((b) => parseFloat(b.attributes('style')!.match(/height:\s*([\d.]+)%/)![1]))
}

/** 前半段响、后半段静——真数据必须在视觉上能看出这个差别 */
function loudThenQuiet() {
  const ch = new Float32Array(64)
  for (let i = 0; i < 32; i++) ch[i] = 0.9
  return ch
}

describe('useNodeWaveform', () => {
  it('解码成功 ⇒ 换成真实峰值、来源标 real、loading 微标收起', async () => {
    const decoder = vi.fn(async () => loudThenQuiet())
    const w = harness({ decoder, url: 'https://example.test/ok.mp3' })
    expect(w.attributes('data-source')).toBe('placeholder')
    expect(w.find('[data-testid="mobile-node-waveform-loading"]').exists()).toBe(true)
    await flushPromises()
    expect(w.attributes('data-source')).toBe('real')
    expect(w.find('[data-testid="mobile-node-waveform-loading"]').exists()).toBe(false)
    expect(decoder).toHaveBeenCalledTimes(1)
  })

  it('真实峰值真的进到视觉编码里（前半条高、后半条矮）', async () => {
    const w = harness({ decoder: async () => loudThenQuiet(), url: 'https://example.test/shape.mp3' })
    await flushPromises()
    const heights = barHeights(w)
    expect(heights.length).toBe(64)
    expect(heights[4]).toBeGreaterThan(heights[60])
  })

  it('解码抛错 ⇒ 保持确定性占位，且不假装有真数据', async () => {
    const w = harness({
      decoder: async () => {
        throw new Error('CORS blocked')
      },
      url: 'https://example.test/fail.mp3',
      nodeId: 'n-fail',
    })
    await flushPromises()
    expect(w.attributes('data-source')).toBe('placeholder')
    // 不再尝试就别继续挂着 loading 微标
    expect(w.find('[data-testid="mobile-node-waveform-loading"]').exists()).toBe(false)
    // 且仍是这个节点的确定性占位波形
    const expected = harness({ url: undefined, nodeId: 'n-fail' })
    expect(barHeights(w)).toEqual(barHeights(expected))
  })

  it('解码器返回 null（跨域/超限）⇒ 同样保持占位', async () => {
    const w = harness({ decoder: async () => null, url: 'https://example.test/null.mp3' })
    await flushPromises()
    expect(w.attributes('data-source')).toBe('placeholder')
    expect(w.find('[data-testid="mobile-node-waveform-loading"]').exists()).toBe(false)
  })

  it('无 url ⇒ 压根不发起解码（空音频节点不该打网络）', async () => {
    const decoder = vi.fn(async () => loudThenQuiet())
    const w = harness({ decoder, url: undefined })
    await flushPromises()
    expect(decoder).not.toHaveBeenCalled()
    expect(w.attributes('data-source')).toBe('placeholder')
    // 空音频也得画出完整波形条（= 类型可辨识性），只是没有真数据
    expect(w.findAll('.mobile-node-waveform-bar').length).toBe(64)
  })

  it('同一 url 只解一次：第二次挂载直接吃缓存（也是 real）', async () => {
    const decoder = vi.fn(async () => loudThenQuiet())
    const first = harness({ decoder, url: 'https://example.test/cached.mp3' })
    await flushPromises()
    const second = harness({ decoder, url: 'https://example.test/cached.mp3' })
    await flushPromises()
    expect(decoder).toHaveBeenCalledTimes(1)
    expect(first.attributes('data-source')).toBe('real')
    expect(second.attributes('data-source')).toBe('real')
  })

  it('不同 url 各自解一次', async () => {
    const decoder = vi.fn(async () => loudThenQuiet())
    harness({ decoder, url: 'https://example.test/one.mp3' })
    harness({ decoder, url: 'https://example.test/two.mp3' })
    await flushPromises()
    expect(decoder).toHaveBeenCalledTimes(2)
  })

  it('占位波形按 nodeId 确定性（同 id 两次挂载完全一致）', () => {
    const a = harness({ url: undefined, nodeId: 'n-same' })
    const b = harness({ url: undefined, nodeId: 'n-same' })
    const c = harness({ url: undefined, nodeId: 'n-diff' })
    expect(barHeights(a)).toEqual(barHeights(b))
    expect(barHeights(a)).not.toEqual(barHeights(c))
    expect(barHeights(a)).toEqual(
      buildPlaceholderPeaks('n-same').map((p) => Math.round((0.08 + 0.92 * p) * 1000) / 10),
    )
  })
})
