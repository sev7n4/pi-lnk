// 思考强度按模型种子（模型配置页 AD3）：localStorage lnkpi.preferences 通道内新增
// thinkingByModel: Record<modelKey, ThinkingLevel>。切模型查表种入会话级单值。
import { beforeEach, describe, expect, it } from 'vitest'
import { __resetForTest, usePreferences } from './usePreferences'
import type { ThinkingLevel } from '@/components/agent/composer/thinkingLevels'

describe('usePreferences.thinkingByModel（按模型种子）', () => {
  beforeEach(() => {
    __resetForTest()
  })

  it('默认空表（存量偏好零变化）', () => {
    expect(usePreferences().value.thinkingByModel).toEqual({})
  })

  it('按模型 key 写读，互不影响', () => {
    const prefs = usePreferences()
    prefs.value.thinkingByModel = {
      'claude-sonnet-4': '极限',
      'gpt-5': '深入',
    }
    expect(prefs.value.thinkingByModel['claude-sonnet-4']).toBe('极限')
    expect(prefs.value.thinkingByModel['gpt-5']).toBe('深入')
    // 落 localStorage（同通道）
    const raw = localStorage.getItem('lnkpi.preferences')
    expect(raw).toContain('thinkingByModel')
  })

  it('haptics 既有字段不被破坏', () => {
    const prefs = usePreferences()
    expect(prefs.value.haptics).toBe(true)
    prefs.value.thinkingByModel = { o3: '标准' }
    expect(prefs.value.haptics).toBe(true)
  })

  it('损坏 thinkingByModel 字段容错回落空表', () => {
    localStorage.setItem('lnkpi.preferences', JSON.stringify({ haptics: true, thinkingByModel: 'bad' }))
    // 重新加载需 reset 触发；此处直接验证 load 容错通过 __resetForTest 的回落
    __resetForTest()
    expect(usePreferences().value.thinkingByModel).toEqual({})
  })
})
