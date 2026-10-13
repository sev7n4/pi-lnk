import { describe, it, expect } from 'vitest'
import { isSystemEventText } from './systemEventRender'

describe('isSystemEventText', () => {
  it('[系统事件· 前缀 → 系统事件', () => {
    expect(isSystemEventText('[系统事件·生成失败] node=x record=y')).toBe(true)
  })
  it('普通用户消息 → 非系统事件', () => {
    expect(isSystemEventText('帮我把这张图做成视频')).toBe(false)
  })
  it('形似但前缀不完整的消息 → false（前缀必须逐字符匹配）', () => {
    expect(isSystemEventText('[系统事件] 没有·')).toBe(false)
    expect(isSystemEventText('前缀[系统事件·生成失败] 在中间')).toBe(false)
  })
  it('空/非字符串 → false', () => {
    expect(isSystemEventText('')).toBe(false)
    expect(isSystemEventText(undefined as never)).toBe(false)
    expect(isSystemEventText(null as never)).toBe(false)
    expect(isSystemEventText(123 as never)).toBe(false)
  })
})
