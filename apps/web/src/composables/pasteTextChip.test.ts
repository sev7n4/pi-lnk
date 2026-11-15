import { describe, expect, it } from 'vitest'
import { PASTE_TEXT_CHIP_MIN_CHARS, shouldPromotePasteToTextChip } from './pasteTextChip'
import type { PasteTextContext } from './pasteTextChip'

const base = (over: Partial<PasteTextContext> = {}): PasteTextContext => ({
  text: 'x'.repeat(PASTE_TEXT_CHIP_MIN_CHARS),
  itemTypes: ['text/plain'],
  hasFiles: false,
  selectionStart: 5,
  selectionEnd: 5,
  isComposing: false,
  pendingCount: 0,
  maxCount: 5,
  ...over,
})

describe('shouldPromotePasteToTextChip', () => {
  it('阈值边界 999 / 1000 / 1001', () => {
    expect(shouldPromotePasteToTextChip(base({ text: 'x'.repeat(999) })).reason).toBe('too-short')
    expect(shouldPromotePasteToTextChip(base()).promote).toBe(true)
    expect(shouldPromotePasteToTextChip(base({ text: 'x'.repeat(1001) })).promote).toBe(true)
  })

  it('按码点不按字节：400 汉字（≈1200 字节）仍 too-short', () => {
    expect(shouldPromotePasteToTextChip(base({ text: '中'.repeat(400) })).reason).toBe('too-short')
  })

  it('emoji 按码点计数', () => {
    expect(shouldPromotePasteToTextChip(base({ text: '😀'.repeat(1000) })).promote).toBe(true)
  })

  it('空白 / 选区 / IME / 文件或媒体 / 容量满 全部拒绝且给出 reason', () => {
    expect(shouldPromotePasteToTextChip(base({ text: '  \n ' })).reason).toBe('empty')
    expect(shouldPromotePasteToTextChip(base({ selectionEnd: 8 })).reason).toBe('has-selection')
    expect(shouldPromotePasteToTextChip(base({ isComposing: true })).reason).toBe('composing')
    expect(shouldPromotePasteToTextChip(base({ hasFiles: true })).reason).toBe('has-files')
    expect(shouldPromotePasteToTextChip(base({ itemTypes: ['text/plain', 'image/png'] })).reason).toBe('has-files')
    expect(shouldPromotePasteToTextChip(base({ pendingCount: 5 })).reason).toBe('capacity-full')
  })

  it('text/html 富文本粘贴不因此被排除', () => {
    expect(shouldPromotePasteToTextChip(base({ itemTypes: ['text/plain', 'text/html'] })).promote).toBe(true)
  })

  it('阈值可覆盖', () => {
    expect(shouldPromotePasteToTextChip(base(), 2000).reason).toBe('too-short')
  })
})
