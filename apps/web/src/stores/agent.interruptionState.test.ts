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

  it('跨消息单门（W1c-R2）：服务端 state 只认一个活门 ⇒ 旧消息残留活卡翻 expired，防多卡同屏可点', () => {
    const agent = useAgentStore()
    // 旧消息（断流/恢复后未让位的残留轮）
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
    agent.messages.push({ id: 'm1', role: 'assistant', content: '', streaming: false, timeline: tl1 } as unknown as AgentStreamMessage)
    // 新消息（权威轮）
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
    expect(agent.applyInterruptionState(summary)).toBe(true)
    // 新轮翻终态（权威）
    expect(questionPart(agent.messages[1]!)?.status).toBe('expired')
    // 旧轮残留活卡也翻终态（单门：全局只允许 summary.callId 一张活卡）
    expect(questionPart(agent.messages[0]!)?.status).toBe('expired')
    expect(agent.pendingQuestion).toBeNull()
  })

  it('跨消息同 callId 双卡（断流恢复实证场景）：summary=answered ⇒ 权威卡 answered，旧消息残留卡一并终态化', () => {
    const agent = useAgentStore()
    // 旧消息：live 期间建的同 callId 卡（恢复后未让位的旧消息残留）
    const tl1 = createTurnTimeline()
    tl1.parts.push({
      kind: 'question',
      id: 'question:call-dup',
      callId: 'call-dup',
      title: '重复卡',
      status: 'pending_answer',
      questions: [{ id: 'q', question: '是否按此方案执行？', options: [{ label: '开始执行', value: 'execute' }] }],
      startedAt: Date.now() - 2000,
    })
    agent.messages.push({ id: 'm-old', role: 'assistant', content: '', streaming: false, timeline: tl1 } as unknown as AgentStreamMessage)
    // 新消息：恢复补建的同 callId 卡
    const tl2 = createTurnTimeline()
    tl2.parts.push({
      kind: 'question',
      id: 'question:call-dup',
      callId: 'call-dup',
      title: '重复卡',
      status: 'pending_answer',
      questions: [{ id: 'q', question: '是否按此方案执行？', options: [{ label: '开始执行', value: 'execute' }] }],
      startedAt: Date.now() - 1000,
    })
    agent.messages.push({ id: 'm-new', role: 'assistant', content: '', streaming: true, timeline: tl2 } as unknown as AgentStreamMessage)
    agent.isStreaming = true

    const summary: InterruptionSummary = {
      callId: 'call-dup',
      kind: 'ask_user',
      questions: [],
      expiresAt: Date.now() - 1,
      status: 'answered',
    }
    expect(agent.applyInterruptionState(summary)).toBe(true)
    // 权威卡（新消息）answered
    expect(questionPart(agent.messages[1]!)?.status).toBe('answered')
    // 旧消息残留卡不再可点（answered，与权威卡同态）
    expect(questionPart(agent.messages[0]!)?.status).toBe('answered')
    expect(agent.pendingQuestion).toBeNull()
  })

  it('feedTimeline：waiting_user{resolved} 跨消息广播 ⇒ 旧消息同 callId 活卡翻 answered', () => {
    const agent = useAgentStore()
    // 旧消息带活卡（断流恢复残留）
    const tl1 = createTurnTimeline()
    tl1.parts.push({
      kind: 'question',
      id: 'question:call-x',
      callId: 'call-x',
      title: '残留',
      status: 'pending_answer',
      questions: [],
      startedAt: Date.now() - 2000,
    })
    agent.messages.push({ id: 'm-old', role: 'assistant', content: '', streaming: false, timeline: tl1 } as unknown as AgentStreamMessage)
    // 新消息（当前活跃）
    const tl2 = createTurnTimeline()
    tl2.parts.push({
      kind: 'question',
      id: 'question:call-x',
      callId: 'call-x',
      title: '权威',
      status: 'pending_answer',
      questions: [],
      startedAt: Date.now() - 1000,
    })
    agent.messages.push({ id: 'm-new', role: 'assistant', content: '', streaming: true, timeline: tl2 } as unknown as AgentStreamMessage)
    agent.isStreaming = true

    agent.feedTimeline({ type: 'waiting_user', data: { status: 'resolved', toolName: 'propose_plan', callId: 'call-x', reason: 'answered' } })
    // 两条消息的同 callId 卡都翻 answered（resolved 只到达一次）
    expect(questionPart(agent.messages[0]!)?.status).toBe('answered')
    expect(questionPart(agent.messages[1]!)?.status).toBe('answered')
  })

  it('feedTimeline resolved 广播对非目标 callId 零改动', () => {
    const agent = useAgentStore()
    // 旧消息：另一个 callId 的活卡（真实的多轮残留）
    const tl1 = createTurnTimeline()
    tl1.parts.push({
      kind: 'question',
      id: 'question:call-other',
      callId: 'call-other',
      title: '其他轮',
      status: 'pending_answer',
      questions: [],
      startedAt: Date.now() - 2000,
    })
    agent.messages.push({ id: 'm-old', role: 'assistant', content: '', streaming: false, timeline: tl1 } as unknown as AgentStreamMessage)
    // 新消息：call-y 的卡
    const tl2 = createTurnTimeline()
    tl2.parts.push({
      kind: 'question',
      id: 'question:call-y',
      callId: 'call-y',
      title: '本轮',
      status: 'pending_answer',
      questions: [],
      startedAt: Date.now() - 1000,
    })
    agent.messages.push({ id: 'm-new', role: 'assistant', content: '', streaming: true, timeline: tl2 } as unknown as AgentStreamMessage)
    agent.isStreaming = true

    agent.feedTimeline({ type: 'waiting_user', data: { status: 'resolved', toolName: 'propose_plan', callId: 'call-y', reason: 'answered' } })
    // 本轮卡翻 answered；其他轮卡不受 resolved 事件影响（由 W1c 单门统一裁决）
    expect(questionPart(agent.messages[1]!)?.status).toBe('answered')
    expect(questionPart(agent.messages[0]!)?.status).toBe('pending_answer')
  })
})
