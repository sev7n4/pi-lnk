import { describe, expect, it } from 'vitest'
import { renderReviewBaseImage } from './renderReviewBaseImage'

/**
 * stub ctx：记录 fillText / fillRect 调用；measureText 用「每字符 10px」的确定性假测量。
 * 与 composeAnnotatedImage 的注入式可测性同模式（不碰真 canvas）。
 */
function makeStub(deps?: { charWidth?: number }) {
  const fillTexts: Array<{ text: string; x: number; y: number }> = []
  const fillRects: Array<{ x: number; y: number; w: number; h: number }> = []
  const charWidth = deps?.charWidth ?? 10
  const ctx = {
    fillStyle: '',
    font: '',
    fillText(text: string, x: number, y: number) {
      fillTexts.push({ text, x, y })
    },
    fillRect(x: number, y: number, w: number, h: number) {
      fillRects.push({ x, y, w, h })
    },
    measureText(text: string) {
      return { width: [...text].length * charWidth }
    },
  }
  const canvas = { width: 0, height: 0, getContext: () => ctx }
  const createCanvas = (w: number, h: number) => {
    canvas.width = w
    canvas.height = h
    return canvas as unknown as HTMLCanvasElement
  }
  return { fillTexts, fillRects, createCanvas, canvas }
}

describe('renderReviewBaseImage（§9 #49 审阅层整屏底图）', () => {
  it('尺寸非法抛错', () => {
    const { createCanvas } = makeStub()
    expect(() => renderReviewBaseImage({ prompt: 'x', paramsLine: '', width: 0, height: 100 }, createCanvas)).toThrow(
      '画布尺寸非法',
    )
  })

  it('画白底 + 标题行 + 参数行置底', () => {
    const { fillTexts, fillRects, createCanvas } = makeStub()
    renderReviewBaseImage({ prompt: '短提示词', paramsLine: '参数：1:1', width: 300, height: 200 }, createCanvas)
    expect(fillRects).toEqual([{ x: 0, y: 0, w: 300, h: 200 }])
    const texts = fillTexts.map((t) => t.text)
    expect(texts[0]).toBe('提示词（agent 提议）')
    expect(texts).toContain('参数：1:1')
    const params = fillTexts.find((t) => t.text === '参数：1:1')!
    expect(params.y).toBeGreaterThan(200 - 40)
  })

  it('CJK 逐字折行：每行宽 ≤ 内容宽，行数正确', () => {
    // 内容宽 = 100 - 32 = 68 ⇒ 每行 6 字（10px/字）
    const { fillTexts, createCanvas } = makeStub()
    const prompt = '一二三四五六七八九十甲乙丙丁' // 14 字 ⇒ 3 行（6+6+2）
    renderReviewBaseImage({ prompt, paramsLine: '', width: 100, height: 400 }, createCanvas)
    const bodyLines = fillTexts.filter((t) => t.text !== '提示词（agent 提议）')
    expect(bodyLines.map((t) => t.text)).toEqual([
      '一二三四五六',
      '七八九十甲乙',
      '丙丁',
    ])
    // 行距恒定
    expect(bodyLines[1]!.y - bodyLines[0]!.y).toBe(24)
  })

  it('空行跳过；超出可视区截断（R-17 当前屏语义）', () => {
    const { fillTexts, createCanvas } = makeStub()
    const prompt = '甲乙丙\n\n丁戊己'
    renderReviewBaseImage({ prompt, paramsLine: '', width: 300, height: 100 }, createCanvas)
    // 高度 100 ⇒ bottomLimit=56 ⇒ 只有标题后第一行 y=56 画得出；后续行 y=80 > 56 截断
    const bodyTexts = fillTexts.filter((t) => t.text !== '提示词（agent 提议）').map((t) => t.text)
    expect(bodyTexts).toEqual(['甲乙丙'])
  })
})
