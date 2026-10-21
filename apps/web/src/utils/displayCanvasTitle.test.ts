import { describe, expect, it } from 'vitest'
import { displayCanvasTitle } from './displayCanvasTitle'

describe('displayCanvasTitle', () => {
  it('空标题 / 纯空白 → 未命名画布', () => {
    expect(displayCanvasTitle('')).toBe('未命名画布')
    expect(displayCanvasTitle('   ')).toBe('未命名画布')
    expect(displayCanvasTitle(undefined)).toBe('未命名画布')
    expect(displayCanvasTitle(null)).toBe('未命名画布')
  })

  it('冒烟/测试 slug 不泄漏到 UI', () => {
    expect(displayCanvasTitle('layout-smoke-1792588745')).toBe('未命名画布')
    expect(displayCanvasTitle('e2e-canvas-9981')).toBe('未命名画布')
    expect(displayCanvasTitle('test-1729')).toBe('未命名画布')
    expect(displayCanvasTitle('tmp-draft-42')).toBe('未命名画布')
  })

  it('长数字时间戳后缀视作自动生成名', () => {
    expect(displayCanvasTitle('my-canvas-1729528800000')).toBe('未命名画布')
    expect(displayCanvasTitle('untitled-123456')).toBe('未命名画布')
  })

  it('短数字后缀是用户命名习惯，不误伤', () => {
    expect(displayCanvasTitle('周报 10-21')).toBe('周报 10-21')
    expect(displayCanvasTitle('方案 v2')).toBe('方案 v2')
  })

  it('含自动化词但作为更大词的一部分时不误伤', () => {
    expect(displayCanvasTitle('protest-poster')).toBe('protest-poster')
    expect(displayCanvasTitle('latest-ink')).toBe('latest-ink')
  })

  it('用户真实标题原样保留（含 trim 后的首尾空格处理）', () => {
    expect(displayCanvasTitle('山海经·墨影')).toBe('山海经·墨影')
    expect(displayCanvasTitle('  暮色航线  ')).toBe('暮色航线')
  })
})
