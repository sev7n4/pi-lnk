import { describe, it, expect } from 'vitest'
import { resolveAnnotateIntent } from './mobileAnnotateIntent'

/**
 * 标注底图来源（规格 §4.3 / 拍板项 L1；v1.5 §4.12.8 拍板项 Q 修订）。
 * 指向形态随媒介：图=圈 / 文=文字引用 / 视频=圈帧 / **音频=不圈选（时间戳替代）**。
 */
describe('resolveAnnotateIntent（标注底图来源）', () => {
  it('图片 = image；视频 = video-frame；文本 = text', () => {
    expect(resolveAnnotateIntent({ type: 'image', data: { url: 'https://x/a.png' } })).toBe('image')
    expect(resolveAnnotateIntent({ type: 'video', data: { url: 'https://x/a.mp4' } })).toBe('video-frame')
    expect(resolveAnnotateIntent({ type: 'text', data: { content: '你好' } })).toBe('text')
  })

  it('音频 = none（v1.5 Q：波形圈选判伪功能，G-22）', () => {
    expect(resolveAnnotateIntent({ type: 'audio', data: { url: 'https://x/a.mp3' } })).toBe('none')
    expect(resolveAnnotateIntent({ type: 'audio', data: {} })).toBe('none')
  })

  it('未知类型兜底 = image（⛔ 不猜不抛）', () => {
    expect(resolveAnnotateIntent({ type: 'unknown', data: {} })).toBe('image')
    expect(resolveAnnotateIntent({ type: 'image' })).toBe('image')
  })
})
