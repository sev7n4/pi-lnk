import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAgentStore } from './agent'

/**
 * 零事件兜底（2026-10-07 生产事故复盘）。
 *
 * 事故形态：run 被 vendor 以 `LaneBusy: Lane "main" already has an active operation`
 * 拒掉 ⇒ 前端一个事件都收不到；SSE 9ms 后断开。前端的「异常结束」兜底分支
 * 全部以 `last?.role === 'assistant'` 为前提而落空，且 `appendText` 在没有
 * assistant 消息时静默 no-op ⇒ 用户屏幕上什么都不出现。
 */
describe('appendTurnNotice（回合级提示：有兜底通道）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('零事件（本轮无 assistant 消息）⇒ 新建 assistant 消息并写入文案', () => {
    const s = useAgentStore()
    s.addUserMessage('在吗')
    expect(s.messages.some((m) => m.role === 'assistant')).toBe(false)

    s.appendTurnNotice('连接中断，没有收到任何回复内容。')

    const last = s.messages[s.messages.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.content).toContain('没有收到任何回复内容')
  })

  it('已有空的 assistant 消息 ⇒ 复用它，不新建第二条', () => {
    const s = useAgentStore()
    s.addUserMessage('hi')
    s.startAssistantMessage()
    s.appendTurnNotice('连接中断。')

    const assistants = s.messages.filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].content).toBe('连接中断。')
  })

  it('已有有内容的 assistant 消息 ⇒ 追加到同一条，不新建（不打断已收到的回复）', () => {
    const s = useAgentStore()
    s.addUserMessage('hi')
    s.startAssistantMessage()
    s.appendText('已经收到的部分。')
    s.appendTurnNotice('\n\n连接中断。')

    const assistants = s.messages.filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].content).toBe('已经收到的部分。\n\n连接中断。')
  })

  it('新建的消息初始 streaming=true，随后 finishStreaming 能正常收尾', () => {
    const s = useAgentStore()
    s.addUserMessage('hi')
    s.appendTurnNotice('连接中断。')
    expect(s.messages[s.messages.length - 1].streaming).toBe(true)

    s.finishStreaming()
    expect(s.isStreaming).toBe(false)
    expect(s.messages[s.messages.length - 1].streaming).toBe(false)
  })

  it('回归防线：appendText 的静默语义**未被改动**（既有调用方依赖它）', () => {
    const s = useAgentStore()
    s.addUserMessage('hi')
    s.appendText('这条应当被丢弃')
    // 无assistant 消息 ⇒ appendText 保持原有 no-op 行为，不创建消息、不落文本
    expect(s.messages.some((m) => m.role === 'assistant')).toBe(false)
    expect(s.messages.every((m) => !m.content.includes('这条应当被丢弃'))).toBe(true)
  })
})