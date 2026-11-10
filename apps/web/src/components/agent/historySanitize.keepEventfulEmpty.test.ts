/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { sanitizeHistoryMessages } from './historySanitize'

// P0-C（SSE 会话恢复）：服务端允许"有 thinking/toolCalls 无正文"的回合落库
// （agent.service.ts 已实证）。这类 assistant 行带 executionEvents、历史回放需重建过程态，
// 不得静默丢行。仅剔除"正文空且毫无过程事件"的真空行。

describe('historySanitize：保留"正文空但带 executionEvents"的 assistant 行（P0-C）', () => {
  it('P0-C 正向：正文空 + 有 executionEvents 的 assistant 行不剔除', () => {
    const input = [
      { id: 'u1', role: 'user', content: '帮我做视频' },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        metadata: '{"executionEvents":[{"type":"thinking","summary":"分析中"}]}',
      },
    ]
    const r = sanitizeHistoryMessages(input)
    expect(r.droppedEmptyAssistant).toBe(0)
    expect(r.rows.map((x) => x.id)).toContain('a1')
  })

  it('真空对照：正文空 + 无 metadata 的 assistant 行仍剔除', () => {
    const r = sanitizeHistoryMessages([{ id: 'a1', role: 'assistant', content: '   ' }])
    expect(r.droppedEmptyAssistant).toBe(1)
    expect(r.rows.length).toBe(0)
  })

  it('真空对照：正文非空 assistant 行正常保留', () => {
    const r = sanitizeHistoryMessages([{ id: 'a1', role: 'assistant', content: '已为你创建节点' }])
    expect(r.droppedEmptyAssistant).toBe(0)
    expect(r.rows.length).toBe(1)
  })
})
