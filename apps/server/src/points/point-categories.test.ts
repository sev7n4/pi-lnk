import { describe, expect, it } from 'vitest'
import { studioPointCategory } from './point-categories'

/**
 * 分类映射是「扣费分类 = 退款分类」的唯一真源，改它就是改账。
 * reaper 与 studio.service（失败/取消退款）共用本函数，因此这里锁死全部取值。
 */
describe('studioPointCategory', () => {
  it('图片侧三类：image / image_edit 归 image，image_upscale 归 other（现状即如此）', () => {
    expect(studioPointCategory('image')).toBe('image')
    expect(studioPointCategory('image_edit')).toBe('image')
    expect(studioPointCategory('image_upscale')).toBe('other')
  })

  it('其他模态直取同名分类', () => {
    expect(studioPointCategory('video')).toBe('video')
    expect(studioPointCategory('audio')).toBe('audio')
  })

  it('文本与提示词归 text，未知类型兜底 other', () => {
    expect(studioPointCategory('text')).toBe('text')
    expect(studioPointCategory('prompt')).toBe('text')
    expect(studioPointCategory('whatever')).toBe('other')
  })
})
