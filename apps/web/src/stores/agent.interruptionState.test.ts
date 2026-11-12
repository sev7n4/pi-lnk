/**
 * W1c（D1=A）接线测试：AgentSideRail 的两个恢复入口（loadHistory / reconcileLatestAssistant）
 * 在拿到服务端 `interruption` 摘要后，统一委托 `agent.applyInterruptionState(summary)` 刷新
 * 最后一条 assistant timeline 的 question part。本测试在 store 层锁定该委托的真实效果
 * （组件内 `reconcileInterruptionFromState` 仅做 fetch + 竞态护栏 + 转发，逻辑收敛于此）。
 *
 * 覆盖：W1c-1（活门保持）、W1c-2（终态翻）、W1c-1a（null ⇒ 翻 expired）、多轮不串。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from '@/stores/agent'
import type { AgentStreamMessage } from '@/stores/agent'
import { createTurnTimeline, type InterruptionSummary, type TimelinePart } from '@/components/agent/turnTimeline'

function seedAssistantWithQuestion(
  agent: ReturnType<typeof useAgentStore>,
  callId = 'call-1',
  status: 'pending_answer' | 'answered' | 'declined' | 'expired' = 'pending_answer',
) {
  const tl = createTurnTimeline()
  tl.parts.push({
    kind: 'question',
    id: `question:${callId}`,
    callId,
    title: '需要你回答',
    status,
    questions: [{ id: 'q1', question: '选哪个？', options: [{ label: 'A', value: 'A' }] }],
    startedAt: Date.now() - 1000,
  })
  agent.messages.push({
    id: 'm-live',
    role: 'assistant',
    content: '',
    streaming: true,
    timeline: tl,
  } as unknown as AgentStreamMessage)
  agent.isStreaming = true
}

function questionPart(m: AgentStreamMessage): Extract<TimelinePart, { kind: 'question' }> | undefined {
  const tl = (m as unknown as { timeline?: { parts: TimelinePart[] } }).timeline
  return tl?.parts.find((p) => p.kind === 'question') as
    | Extract<TimelinePart, { kind: 'question' }>
    | undefined
}

describe('agent — W1c 接线：applyInterruptionState 刷新 question part', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('W1c-1：活门 summary ⇒ 现有 pending_answer 卡保持可点，changed=false（幂等）', () => {
    const agent = useAgentStore()
    seedAssistantWithQuestion(agent, 'call-1', 'pending_answer')
    const summary: InterruptionSummary = {
      callId: 'call-1',
      kind: 'ask_user',
      questions: [],
      expiresAt: Date.now() + 999_999,
      status: 'pending',
    }
    expect(agent.applyInterruptionState(summary)).toBe(false)
    expect(agent.pendingQuestion?.callId).toBe('call-1') // 仍可点
  })

  it('W1c-2：终态 summary(answered) ⇒ 翻 answered，pendingQuestion 归 null', () => {
    const agent = useAgentStore()
    seedAssistantWithQuestion(agent, 'call-1', 'pending_answer')
    const summary: InterruptionSummary = {
      callId: 'call-1',
      kind: 'ask_user',
      questions: [],
      expiresAt: Date.now() - 1,
      status: 'answered',
    }
    expect(agent.applyInterruptionState(summary)).toBe(true)
    expect(agent.pendingQuestion).toBeNull()
    expect(questionPart(agent.messages[0]!)?.status).toBe('answered')
  })

  it('W1c-1a：summary===null ⇒ 现有 pending_answer 翻 expired（无权威证据即不可点）', () => {
    const agent = useAgentStore()
    seedAssistantWithQuestion(agent, 'call-1', 'pending_answer')
    expect(agent.applyInterruptionState(null)).toBe(true)
    expect(agent.pendingQuestion).toBeNull()
    expect(questionPart(agent.messages[0]!)?.status).toBe('expired')
  })

  it('多轮不串：只作用于最后一条 assistant（前一轮 pending 不受影响）', () => {
    const agent = useAgentStore()
    // 第一轮（旧）
    const tl1 = createTurnTimeline()
    tl1.parts.push({
      kind: 'question',
      id: 'question:call-old',
      callId: 'call-old',
      title: '旧',
      status: 'pending_answer',
      questions: [],
      startedAt: Date.now() - 2000,
    })
    agent.messages.push({ id: 'm1', role: 'assistant', content: '', streaming: true, timeline: tl1 } as unknown as AgentStreamMessage)
    // 第二轮（新，活）
    const tl2 = createTurnTimeline()
    tl2.parts.push({
      kind: 'question',
      id: 'question:call-new',
      callId: 'call-new',
      title: '新',
      status: 'pending_answer',
      questions: [],
      startedAt: Date.now() - 1000,
    })
    agent.messages.push({ id: 'm2', role: 'assistant', content: '', streaming: true, timeline: tl2 } as unknown as AgentStreamMessage)
    agent.isStreaming = true

    const summary: InterruptionSummary = {
      callId: 'call-new',
      kind: 'ask_user',
      questions: [],
      expiresAt: Date.now() - 1,
      status: 'expired',
    }
    agent.applyInterruptionState(summary)
    // 新轮翻终态
    expect(questionPart(agent.messages[1]!)?.status).toBe('expired')
    // 旧轮仍 pending（不串）
    expect(questionPart(agent.messages[0]!)?.status).toBe('pending_answer')
    expect(agent.pendingQuestion?.callId).toBe('call-old')
  })
})
