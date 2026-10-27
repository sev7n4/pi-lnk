import { describe, it, expect } from 'vitest'
import { isViewableNodeType } from './canvasNodeActions'

/**
 * D2 修订（2026-10-27 真机走查④）：音频波形查看器落地 ⇒ `audio` 重新可进查看器。
 * ⭐ 此守卫是 NodeRenderer 的**运行时最后一道闸**——若它仍排除 audio，
 * openPolicy 放行了也会在这里被静默拦掉（tap 无反应，正是走查④的现象）。
 */
describe('isViewableNodeType（D2 修订：audio 回归可查看）', () => {
  it('audio 可进查看器（波形查看器）', () => {
    expect(isViewableNodeType('audio')).toBe(true)
  })

  it('四类类型全部可进；未知类型仍被拦', () => {
    expect(isViewableNodeType('image')).toBe(true)
    expect(isViewableNodeType('video')).toBe(true)
    expect(isViewableNodeType('text')).toBe(true)
    expect(isViewableNodeType('prompt')).toBe(false)
    expect(isViewableNodeType('')).toBe(false)
  })
})
