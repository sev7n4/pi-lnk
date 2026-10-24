import { describe, expect, it } from 'vitest'
import {
  WAVEFORM_PEAK_COUNT,
  buildPlaceholderPeaks,
  peaksFromChannelData,
} from './waveformPeaks'

describe('buildPlaceholderPeaks', () => {
  it('默认 64 点，取值恒在 0~1', () => {
    const peaks = buildPlaceholderPeaks('node-abc')
    expect(peaks.length).toBe(WAVEFORM_PEAK_COUNT)
    for (const p of peaks) {
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
    }
  })

  it('同一 nodeId 恒同一条波形（滚动重绘不跳变）', () => {
    expect(buildPlaceholderPeaks('node-stable')).toEqual(buildPlaceholderPeaks('node-stable'))
  })

  it('不同 nodeId 给出不同波形（否则所有空音频长得一样）', () => {
    expect(buildPlaceholderPeaks('node-a')).not.toEqual(buildPlaceholderPeaks('node-b'))
  })

  it('包络中间高两头低——占位也得看着像一段音频', () => {
    const peaks = buildPlaceholderPeaks('node-env')
    const head = peaks.slice(0, 4).reduce((a, b) => a + b, 0) / 4
    const middle = peaks.slice(30, 34).reduce((a, b) => a + b, 0) / 4
    expect(middle).toBeGreaterThan(head)
  })

  it('count 可指定', () => {
    expect(buildPlaceholderPeaks('node-x', 16).length).toBe(16)
  })
})

describe('peaksFromChannelData', () => {
  it('每桶取绝对值最大值（负峰也算音量）', () => {
    // 8 样本 → 4 桶：[0.2, -0.9] / [0.4, 0.1] / [-0.3, -0.5] / [0.7, 0.6]
    const channel = new Float32Array([0.2, -0.9, 0.4, 0.1, -0.3, -0.5, 0.7, 0.6])
    expect(peaksFromChannelData(channel, 4)).toEqual([0.9, 0.4, 0.5, 0.7])
  })

  it('声道与点数不等长时仍返回定长 count', () => {
    const channel = new Float32Array(1000)
    expect(peaksFromChannelData(channel, 64).length).toBe(64)
    expect(peaksFromChannelData(new Float32Array([1]), 64).length).toBe(64)
  })

  it('空声道返回 count 个 0，而不是空数组（每条都要画出来）', () => {
    expect(peaksFromChannelData(new Float32Array(0), 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('恒定音量 ⇒ 恒定峰值', () => {
    const peaks = peaksFromChannelData(new Float32Array(64).fill(0.5), 8)
    expect(peaks.every((p) => p === 0.5)).toBe(true)
  })

  it('超过 1 的样本被夹到 1（JSON 契约边界）', () => {
    expect(peaksFromChannelData(new Float32Array([3, 3]), 1)).toEqual([1])
  })
})
