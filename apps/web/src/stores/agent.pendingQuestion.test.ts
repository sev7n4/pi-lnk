import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from '@/stores/agent'
import type { AgentStreamMessage } from '@/stores/agent'

/** 根治规格（2026-10-28）：ask_user 等待态单一真相 = 时间线 question part。
 * 取代组件级 pendingAskUser ref；`pendingQuestion` 只取 `pending_answer` 的 part，
 * `resolveQuestionPart` 按 callId 翻终态。 */
function seedAssistant(agent: ReturnType<typeof useAgentStore>, id = 'm-live') {
  agent.messages.push({
    id,
    role: 'assistant',
    content: '',
    streaming: true,
  } as unknown as AgentStreamMessage)
  agent.isStreaming = true
}

describe('agent — 等待态单一真相：question part 查询侧', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('pendingQuestion 初始为 null；trackAskUser 后出现 pending_answer 的 part', () => {
    const agent = useAgentStore()
    seedAssistant(agent)
    expect(agent.pendingQuestion).toBeNull()

    agent.trackAskUser({
      callId: 'ask-1',
      title: '风格选择',
      questions: [{ id: 'q1', question: '选风格？', options: [{ label: 'A', value: 'a' }] }],
    })

    expect(agent.pendingQuestion?.callId).toBe('ask-1')
    expect(agent.pendingQuestion?.status).toBe('pending_answer')
  })

  it('resolveQuestionPart 按 callId 翻终态后 pendingQuestion 归 null（declined 亦同）', () => {
    const agent = useAgentStore()
    seedAssistant(agent)
    agent.trackAskUser({
      callId: 'ask-1',
      title: '风格选择',
      questions: [{ id: 'q1', question: '选风格？', options: [{ label: 'A', value: 'a' }] }],
    })
    expect(agent.pendingQuestion).not.toBeNull()

    agent.resolveQuestionPart('ask-1', 'declined')

    // 查询侧：终态不再视为 pending
    expect(agent.pendingQuestion).toBeNull()
    // 直接读 part 确认状态已翻 declined
    const part = (agent.messages[0] as unknown as { timeline: { parts: Array<{ kind: string; status: string }> } })
      .timeline.parts.find((p) => p.kind === 'question')
    expect(part?.status).toBe('declined')
  })

  it('pendingQuestion 取最后一条 assistant 的 pending 提问（多轮不串）', () => {
    const agent = useAgentStore()
    agent.messages.push({ id: 'm1', role: 'assistant', content: '', streaming: true } as unknown as AgentStreamMessage)
    agent.trackAskUser({ callId: 'ask-old', title: '旧', questions: [{ id: 'q1', question: '?', options: [] }] })
    agent.messages.push({ id: 'm2', role: 'assistant', content: '', streaming: true } as unknown as AgentStreamMessage)
    agent.isStreaming = true
    agent.trackAskUser({ callId: 'ask-new', title: '新', questions: [{ id: 'q1', question: '?', options: [] }] })

    expect(agent.pendingQuestion?.callId).toBe('ask-new')
  })

  it('与 proposal 互不干扰：两者可同时 pending，各自独立查询', () => {
    const agent = useAgentStore()
    seedAssistant(agent)
    agent.trackAskUser({ callId: 'ask-1', title: '风格', questions: [{ id: 'q1', question: '?', options: [] }] })
    agent.trackWaitingUser({ status: 'waiting', toolName: 'propose_generation', callId: 'call-1', nodeId: 'node-1' })

    expect(agent.pendingQuestion?.callId).toBe('ask-1')
    expect(agent.pendingProposal?.callId).toBe('call-1')
    // 只翻 question，proposal 仍为 pending
    agent.resolveQuestionPart('ask-1', 'answered')
    expect(agent.pendingQuestion).toBeNull()
    expect(agent.pendingProposal?.callId).toBe('call-1')
  })
})
