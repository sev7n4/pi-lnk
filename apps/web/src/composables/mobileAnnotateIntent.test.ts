import { describe, it, expect } from 'vitest'
import { resolveAnnotateIntent } from './mobileAnnotateIntent'

/**
 * 标注底图来源（规格 §4.3 / 拍板项 L1）。
 * ⭐ 四类节点收敛为「一张图 + 一句话」—— 只有底图不同，工具与契约完全一致。
 */
describe('resolveAnnotateIntent（标注底图来源）', () => {
  it('图片 = image；视频 = video-frame；音频 = waveform；文本 = text', () => {
    expect(resolveAnnotateIntent({ type: 'image', data: { url: 'https://x/a.png' } })).toBe('image')
    expect(resolveAnnotateIntent({ type: 'video', data: { url: 'https://x/a.mp4' } })).toBe('video-frame')
    expect(resolveAnnotateIntent({ type: 'audio', data: { url: 'https://x/a.mp3' } })).toBe('waveform')
    expect(resolveAnnotateIntent({ type: 'text', data: { content: '你好' } })).toBe('text')
  })

  it('未知类型兜底 = image（⛔ 不猜不抛）', () => {
    expect(resolveAnnotateIntent({ type: 'unknown', data: {} })).toBe('image')
    expect(resolveAnnotateIntent({ type: 'image' })).toBe('image')
  })

  it('⭐ 音频是「波形图」而非时间段拖选（§4.3：只有一支笔）', () => {
    expect(resolveAnnotateIntent({ type: 'audio', data: {} })).toBe('waveform')
  })
})
