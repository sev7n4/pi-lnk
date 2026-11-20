// 思考强度按模型种子 composable：key 归一 + 读写。
import { beforeEach, describe, expect, it } from 'vitest'
import { __resetForTest } from './usePreferences'
import { useThinkingByModel } from './useThinkingByModel'

describe('useThinkingByModel', () => {
  beforeEach(() => __resetForTest())

  it('无种子返回 undefined', () => {
    const { seedFor } = useThinkingByModel()
    expect(seedFor('ch_1::gpt-5')).toBeUndefined()
    expect(seedFor('')).toBeUndefined()
  })

  it('save 后按模型 key 归一读回（ch_x:: 前缀剥离）', () => {
    const { seedFor, saveSeed } = useThinkingByModel()
    saveSeed('ch_1::gpt-5', '极限')
    // catalogModelKeyFromValue('ch_1::gpt-5') === 'gpt-5'
    expect(seedFor('gpt-5')).toBe('极限')
    expect(seedFor('ch_1::gpt-5')).toBe('极限')
  })

  it('不同模型互不影响', () => {
    const { seedFor, saveSeed } = useThinkingByModel()
    saveSeed('ch_1::claude-sonnet-4', '深入')
    saveSeed('ch_1::gpt-5', '极限')
    expect(seedFor('claude-sonnet-4')).toBe('深入')
    expect(seedFor('gpt-5')).toBe('极限')
  })

  it('改同一模型覆盖旧档', () => {
    const { seedFor, saveSeed } = useThinkingByModel()
    saveSeed('o3', '深入')
    saveSeed('o3', '标准')
    expect(seedFor('o3')).toBe('标准')
  })
})
