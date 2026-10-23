import { describe, it, expect } from 'vitest'
import { resolveMobileNodeState } from './mobileNodeState'

/**
 * 移动端节点状态判据（D-C 五态归一，R3-T1）。
 *
 * ⭐ 为什么需要它：R2 只落地了 `empty` 一行（D-C 状态机 empty → generating →
 *   pending → confirmed → error）。移动端的状态呈现此前是**断的**——
 *   ① NodeRenderer 未向磁贴传 `:status` ⇒ 徽标恒不渲染；
 *   ② 徽标表只覆盖 2/5 态，且判的 'pending' ≠ 桌面用的 'pending_confirm'。
 *
 * 判据收敛到纯函数，磁贴 / 徽标 / 壳层状态栏三处消费同一答案（审阅焦点 #1）。
 */
describe('resolveMobileNodeState（D-C 五态归一）', () => {
  it('无内容无状态 → empty', () => {
    expect(resolveMobileNodeState({ type: 'image', data: {} })).toBe('empty')
    expect(resolveMobileNodeState({ type: 'text', data: {} })).toBe('empty')
    expect(resolveMobileNodeState({ type: 'image', data: null })).toBe('empty')
    expect(resolveMobileNodeState({ type: 'image' })).toBe('empty')
  })

  it('generating / fallback_pending → generating', () => {
    expect(resolveMobileNodeState({ type: 'image', data: { status: 'generating' } })).toBe('generating')
    expect(resolveMobileNodeState({ type: 'image', data: { status: 'fallback_pending' } })).toBe('generating')
  })

  it('pending_confirm → pending（不是别的 pending 值）', () => {
    expect(resolveMobileNodeState({ type: 'image', data: { status: 'pending_confirm' } })).toBe('pending')
  })

  it('error / failed → error', () => {
    expect(resolveMobileNodeState({ type: 'image', data: { status: 'error' } })).toBe('error')
    expect(resolveMobileNodeState({ type: 'image', data: { status: 'failed' } })).toBe('error')
  })

  it('有内容（url / content）且非生成态 → confirmed', () => {
    expect(resolveMobileNodeState({ type: 'image', data: { url: 'https://x/a.png' } })).toBe('confirmed')
    expect(resolveMobileNodeState({ type: 'video', data: { url: 'https://x/a.mp4' } })).toBe('confirmed')
    expect(resolveMobileNodeState({ type: 'audio', data: { url: 'https://x/a.mp3' } })).toBe('confirmed')
    expect(resolveMobileNodeState({ type: 'text', data: { content: '你好' } })).toBe('confirmed')
  })

  it('生成态优先于内容（有 url 但仍在生成 → generating）', () => {
    expect(
      resolveMobileNodeState({ type: 'image', data: { url: 'https://x/a.png', status: 'generating' } }),
    ).toBe('generating')
  })

  it('待确认优先于内容（待确认时不该被当成 confirmed）', () => {
    expect(
      resolveMobileNodeState({ type: 'image', data: { url: 'https://x/a.png', status: 'pending_confirm' } }),
    ).toBe('pending')
  })

  it('失败优先于内容（失败时不该被当成 confirmed）', () => {
    expect(
      resolveMobileNodeState({ type: 'image', data: { url: 'https://x/a.png', status: 'error' } }),
    ).toBe('error')
  })

  it('文本只看 content（url 对文本无意义）', () => {
    expect(resolveMobileNodeState({ type: 'text', data: { url: 'https://x/a.png' } })).toBe('empty')
    expect(resolveMobileNodeState({ type: 'text', data: { content: '   ' } })).toBe('empty')
  })

  it('非语义态（draft / idle / completed / uploading）不改变判据', () => {
    // draft + 有内容 = 已完成的内容（agent 提议待生成前的态）
    expect(resolveMobileNodeState({ type: 'image', data: { status: 'draft', url: 'https://x/a.png' } })).toBe('confirmed')
    // uploading + 无内容 = 还没出内容
    expect(resolveMobileNodeState({ type: 'image', data: { status: 'uploading' } })).toBe('empty')
    expect(resolveMobileNodeState({ type: 'image', data: { status: 'completed' } })).toBe('empty')
  })
})
