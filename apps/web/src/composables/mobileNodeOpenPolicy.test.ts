import { describe, it, expect } from 'vitest'
import { resolveMobileNodeTapIntent } from './mobileNodeOpenPolicy'

/**
 * R2-T1：空态路由单一真源（D-C 状态机 empty 行）。
 * R1 的 viewer 对空节点（无 url/无 content）会渲染一片空白；音频空 src 走
 * toggleAudio 毫无反应。
 *
 * ⚠️ 2026-10-25（Task 1 · D1/D3）契约变更：空态路由由「editor」改为「none」。
 * 产品铁律 P1「单击 = 查看」：任何类型、任何状态，单击都不进入编辑；
 * 空 / 生成中 / 失败无旧产物 = 无 op + 轻提示（引导长按），编辑只走长按。
 */
describe('resolveMobileNodeTapIntent（空态路由）', () => {
  it('有 url 的图/视频 → viewer', () => {
    expect(resolveMobileNodeTapIntent({ type: 'image', data: { url: 'https://x/a.png' } })).toBe('viewer')
    expect(resolveMobileNodeTapIntent({ type: 'video', data: { url: 'https://x/a.mp4' } })).toBe('viewer')
  })

  it('空 url 的图/视频 → none（无 op + 轻提示，不进编辑器）', () => {
    expect(resolveMobileNodeTapIntent({ type: 'image', data: { url: '' } })).toBe('none')
    expect(resolveMobileNodeTapIntent({ type: 'video', data: {} })).toBe('none')
    expect(resolveMobileNodeTapIntent({ type: 'image' })).toBe('none')
  })

  it('有内容的文本 → viewer；空文本 → none', () => {
    expect(resolveMobileNodeTapIntent({ type: 'text', data: { content: '你好' } })).toBe('viewer')
    expect(resolveMobileNodeTapIntent({ type: 'text', data: { content: '' } })).toBe('none')
    expect(resolveMobileNodeTapIntent({ type: 'text', data: { content: '   ' } })).toBe('none')
    expect(resolveMobileNodeTapIntent({ type: 'text' })).toBe('none')
  })

  it('音频：永远 inline（有 url → 磁贴内联播放；空 url → 也不进编辑器）', () => {
    expect(resolveMobileNodeTapIntent({ type: 'audio', data: { url: 'https://x/a.mp3' } })).toBe('inline')
    expect(resolveMobileNodeTapIntent({ type: 'audio', data: {} })).toBe('inline')
    expect(resolveMobileNodeTapIntent({ type: 'audio' })).toBe('inline')
  })

  it('未知类型 → none（无产物 ⇒ 无 op + 轻提示，不开空白 viewer）', () => {
    expect(resolveMobileNodeTapIntent({ type: 'prompt', data: {} })).toBe('none')
  })
})

describe('resolveMobileNodeTapIntent（状态门控 · D1/D3）', () => {
  it('empty 节点 tap = none（不进编辑器）', () => {
    expect(resolveMobileNodeTapIntent({ type: 'image', data: {} })).toBe('none')
    expect(resolveMobileNodeTapIntent({ type: 'text', data: {} })).toBe('none')
    expect(resolveMobileNodeTapIntent({ type: 'image', data: null })).toBe('none')
  })

  it('generating tap = none（不重复入口，壳层状态栏已有）', () => {
    expect(resolveMobileNodeTapIntent({ type: 'image', data: { status: 'generating' } })).toBe('none')
    expect(resolveMobileNodeTapIntent({ type: 'image', data: { status: 'fallback_pending' } })).toBe('none')
  })

  it('pending tap = viewer（确认前必须能先看）', () => {
    expect(resolveMobileNodeTapIntent({ type: 'image', data: { status: 'pending_confirm' } })).toBe('viewer')
    expect(resolveMobileNodeTapIntent({ type: 'text', data: { status: 'pending_confirm' } })).toBe('viewer')
  })

  it('confirmed tap = viewer', () => {
    expect(resolveMobileNodeTapIntent({ type: 'image', data: { url: 'https://x/a.png' } })).toBe('viewer')
    expect(resolveMobileNodeTapIntent({ type: 'text', data: { content: '你好' } })).toBe('viewer')
  })

  it('error 无旧产物 = none；有旧产物 = viewer（Review Focus #1）', () => {
    expect(resolveMobileNodeTapIntent({ type: 'image', data: { status: 'error' } })).toBe('none')
    expect(
      resolveMobileNodeTapIntent({ type: 'image', data: { status: 'error', url: 'https://x/a.png' } }),
    ).toBe('viewer')
  })

  it('音频永远 inline（不进查看器、不进编辑器）', () => {
    expect(resolveMobileNodeTapIntent({ type: 'audio', data: { url: 'https://x/a.mp3' } })).toBe('inline')
    expect(resolveMobileNodeTapIntent({ type: 'audio', data: { status: 'pending_confirm' } })).toBe('inline')
  })
})
