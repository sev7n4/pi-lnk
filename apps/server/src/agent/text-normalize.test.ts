import { describe, expect, it } from 'vitest'
import { normalizeAssistantText } from './text-normalize'

describe('normalizeAssistantText（助手消息首尾空行归一化）', () => {
  it('剥离开头连续空行（生产实测：1~13 个 \\n）', () => {
    expect(normalizeAssistantText('\n\n\n\n\n\n\n\n\n实际回答')).toBe('实际回答')
    expect(normalizeAssistantText('\n第一行')).toBe('第一行')
  })

  it('剥离纯空白行（不只是 \\n，含空格/制表/全角空格）', () => {
    expect(normalizeAssistantText('   \t  \n   \n正文')).toBe('正文')
    expect(normalizeAssistantText('\u3000\n正文')).toBe('正文')
  })

  it('保留正文内部空行（markdown 段落/列表必须 intact）', () => {
    const src = '第一段\n\n第二段\n\n- a\n- b'
    expect(normalizeAssistantText('\n\n' + src + '\n\n\n')).toBe(src)
  })

  it('去掉结尾空行但保留行尾单个换行符之外的结构', () => {
    expect(normalizeAssistantText('正文\n\n\n\n')).toBe('正文')
    expect(normalizeAssistantText('正文  \n\n')).toBe('正文')
  })

  it('行内缩进不动：首个内容行带缩进时不被吃掉', () => {
    const src = '  ```\n  code\n  ```'
    expect(normalizeAssistantText('\n' + src)).toBe(src)
  })

  it('CRLF 开头同样处理，中间 CRLF 保留', () => {
    expect(normalizeAssistantText('\r\n\r\n正文\r\n第二行\r\n\r\n')).toBe('正文\r\n第二行')
  })

  it('空串/纯空白：原样返回空串（finalizeTurn 仍走 || \' \' 兜底）', () => {
    expect(normalizeAssistantText('')).toBe('')
    expect(normalizeAssistantText('   \n\n\t')).toBe('')
  })

  it('幂等：normalize(normalize(x)) === normalize(x)', () => {
    const src = '\n\n\n首行\n\n\n尾行\n\n\n'
    expect(normalizeAssistantText(normalizeAssistantText(src))).toBe(normalizeAssistantText(src))
  })

  it('无前置空行的文本字节级等价（Review Focus #1：只动首尾，不动正文）', () => {
    const src = '普通回复 ✓\n多行\n-content'
    expect(normalizeAssistantText(src)).toBe(src)
  })
})
