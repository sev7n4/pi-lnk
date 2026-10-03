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

  it('空串/纯空白：归一化为空串（调用方不做 || 兜底，空 content 是合法落库态）', () => {
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

// ── 终审追加：以下用例复现 2026-10-03 生产取证发现的三个问题 ──────────────

describe('normalizeAssistantText（终审补锁）', () => {
  it('【R-1】纯空白 content 归一化后必须为空串，不能是单空格', () => {
    // 纯函数层本来就返回 ''，真正的缺陷在调用方`normalizeAssistantText(x) || ' '`
    // 把「无正文」伪装成「有一个空格」（生产实测存在 len=1 / codepoint=32 的行）。
    // 这条只锁纯函数契约；调用方的落库行为由 agent.service.pi-runtime.test.ts
    // 的「落库 content」用例锁——纯函数层测不出 || 兜底。
    expect(normalizeAssistantText(' ')).toBe('');
    expect(normalizeAssistantText(' \n')).toBe('');
    expect(normalizeAssistantText('\n'.repeat(123))).toBe(''); // 生产实测 len=123
    expect(normalizeAssistantText('\n'.repeat(82))).toBe(''); // 生产实测 len=82
  })

  it('【R-2】剥完仍有正文的行才返回正文（存量 205 条脏数据的真实形态）', () => {
    // 生产 283 条首部空白里205 条剥后有正文、78 条剥后全空。
    // 两种都必须走同一条规则：normalize 决定 content，调用方不再叠加兜底。
    expect(normalizeAssistantText('\n\n\n实际回答')).toBe('实际回答'); // 205 条那类
    expect(normalizeAssistantText('\n\n\n')).toBe(''); // 78 条那类
  })

  it('【R-3】正文中含「仅空白」的段落间隔不被误判为尾部（TRAILING_BLANK 的边界）', () => {
    // TRAILING_BLANK 是贪婪的尾部匹配，若正文以「空白行+ 换行」结构收尾，
    // 需保证不会把正文的最后一行一起吃掉。
    const src = '第一段\n\n第二段';
    expect(normalizeAssistantText(src)).toBe(src);
    // 缩进代码块作为最后一块：行尾两空格是 markdown 换行语义的一部分，
    // 但归一化按既定契约剥掉行尾空白（与既有测试「正文  \n\n → 正文」一致）。
    expect(normalizeAssistantText('  ```\n  code\n  ```\n\n  \n')).toBe('  ```\n  code\n  ```');
  })
})
