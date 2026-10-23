import { describe, expect, it } from 'vitest'
import { displayCanvasTitle } from './displayCanvasTitle'

describe('displayCanvasTitle', () => {
  it('空标题 / 纯空白 → 未命名项目', () => {
    expect(displayCanvasTitle('')).toBe('未命名项目')
    expect(displayCanvasTitle('   ')).toBe('未命名项目')
    expect(displayCanvasTitle(undefined)).toBe('未命名项目')
    expect(displayCanvasTitle(null)).toBe('未命名项目')
  })

  it('IA v4 两个历史默认落库值都收口为「未命名项目」（存量不露旧名词）', () => {
    // 2026-10-23 IA v4：默认值从「未命名画布」改为「未命名项目」，但存量项目
    // 标题恒为旧值 ⇒ 展示层必须把旧名词映射过来，否则同一物件两个名字。
    // 编号兜底（项目 N）在服务端 canvas.service.list，本函数不编号。
    expect(displayCanvasTitle('未命名画布')).toBe('未命名项目')
    expect(displayCanvasTitle('未命名项目')).toBe('未命名项目')
  })

  it('冒烟/测试 slug 不泄漏到 UI', () => {
    expect(displayCanvasTitle('layout-smoke-1792588745')).toBe('未命名项目')
    expect(displayCanvasTitle('e2e-canvas-9981')).toBe('未命名项目')
    expect(displayCanvasTitle('test-1729')).toBe('未命名项目')
    expect(displayCanvasTitle('tmp-draft-42')).toBe('未命名项目')
  })

  it('长数字时间戳后缀视作自动生成名', () => {
    expect(displayCanvasTitle('my-canvas-1729528800000')).toBe('未命名项目')
    expect(displayCanvasTitle('untitled-123456')).toBe('未命名项目')
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
