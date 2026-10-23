import { describe, it, expect } from 'vitest'
import { resolveMobileNodeTapIntent } from './mobileNodeOpenPolicy'

/**
 * R2-T1：空态路由单一真源（D-C 状态机 empty 行）。
 * R1 的 viewer 对空节点（无 url/无 content）会渲染一片空白；音频空 src 走
 * toggleAudio 毫无反应。二者都应路由到编辑 sheet（「点击生成/撰写」主动作）。
 */
describe('resolveMobileNodeTapIntent（空态路由）', () => {
  it('有 url 的图/视频 → viewer', () => {
    expect(resolveMobileNodeTapIntent({ type: 'image', data: { url: 'https://x/a.png' } })).toBe('viewer')
    expect(resolveMobileNodeTapIntent({ type: 'video', data: { url: 'https://x/a.mp4' } })).toBe('viewer')
  })

  it('空 url 的图/视频 → editor（不开空白灯箱）', () => {
    expect(resolveMobileNodeTapIntent({ type: 'image', data: { url: '' } })).toBe('editor')
    expect(resolveMobileNodeTapIntent({ type: 'video', data: {} })).toBe('editor')
    expect(resolveMobileNodeTapIntent({ type: 'image' })).toBe('editor')
  })

  it('有内容的文本 → viewer；空文本 → editor', () => {
    expect(resolveMobileNodeTapIntent({ type: 'text', data: { content: '你好' } })).toBe('viewer')
    expect(resolveMobileNodeTapIntent({ type: 'text', data: { content: '' } })).toBe('editor')
    expect(resolveMobileNodeTapIntent({ type: 'text', data: { content: '   ' } })).toBe('editor')
    expect(resolveMobileNodeTapIntent({ type: 'text' })).toBe('editor')
  })

  it('音频：有 url → inline（磁贴内联播放）；空 url → editor', () => {
    expect(resolveMobileNodeTapIntent({ type: 'audio', data: { url: 'https://x/a.mp3' } })).toBe('inline')
    expect(resolveMobileNodeTapIntent({ type: 'audio', data: {} })).toBe('editor')
    expect(resolveMobileNodeTapIntent({ type: 'audio' })).toBe('editor')
  })

  it('未知类型 → editor（保守：给编辑入口而不是空白 viewer）', () => {
    expect(resolveMobileNodeTapIntent({ type: 'prompt', data: {} })).toBe('editor')
  })
})
