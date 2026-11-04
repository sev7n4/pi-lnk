import { describe, expect, it } from 'vitest'
import { resolveModelDisplayName, stripChannelPrefix } from './model-display'

// 规格 §14.5-C8 金样：渠道前缀 key 绝不原样透出（生产实例：回合摘要
// 「共消耗 7 积分 · platform::agnes-2.5-flash」）。

describe('stripChannelPrefix', () => {
  it('platform:: 前缀剥除', () => {
    expect(stripChannelPrefix('platform::agnes-2.5-flash')).toBe('agnes-2.5-flash')
  })

  it('BYOK 渠道前缀剥除', () => {
    expect(stripChannelPrefix('ch_abc123::my-model')).toBe('my-model')
  })

  it('裸名原样透传', () => {
    expect(stripChannelPrefix('agnes-2.5-flash')).toBe('agnes-2.5-flash')
  })

  it('空值兜底：null→空串、undefined→空串、空串→空串', () => {
    expect(stripChannelPrefix(null)).toBe('')
    expect(stripChannelPrefix(undefined)).toBe('')
    expect(stripChannelPrefix('')).toBe('')
  })

  it('变异：只剥第一个 :: 之前（防「剥了一半」实现回归）', () => {
    // 渠道 id 含字母数字下划线，不含 ::；此处守卫实现用 lastIndexOf/split 行为漂移
    expect(stripChannelPrefix('platform::step-3.5-flash')).toBe('step-3.5-flash')
  })
})

describe('resolveModelDisplayName', () => {
  it('目录命中 → 目录 displayName', () => {
    const lookup = (k: string) => (k === 'platform::agnes-2.5-flash' ? 'Agnes 2.5 Flash' : undefined)
    expect(resolveModelDisplayName('platform::agnes-2.5-flash', lookup)).toBe('Agnes 2.5 Flash')
  })

  it('目录未命中 → 降级剥前缀裸名（绝不透出渠道前缀）', () => {
    expect(resolveModelDisplayName('platform::agnes-2.5-flash')).toBe('agnes-2.5-flash')
    expect(resolveModelDisplayName('platform::agnes-2.5-flash', () => undefined)).toBe(
      'agnes-2.5-flash',
    )
  })

  it('目录返回空白串视为未命中 → 降级剥前缀', () => {
    expect(resolveModelDisplayName('platform::m', () => '   ')).toBe('m')
  })

  it('BYOK 渠道未命中目录 → 裸名（BYOK displayName=模型名惯例）', () => {
    expect(resolveModelDisplayName('ch_abc::my-model')).toBe('my-model')
  })

  it('空值 → 空串', () => {
    expect(resolveModelDisplayName(null)).toBe('')
    expect(resolveModelDisplayName(undefined)).toBe('')
    expect(resolveModelDisplayName('')).toBe('')
  })

  it('变异：displayName 前后空白被 trim（防渲染出带空白的 chip）', () => {
    expect(resolveModelDisplayName('platform::m', () => ' Name ')).toBe('Name')
  })
})
