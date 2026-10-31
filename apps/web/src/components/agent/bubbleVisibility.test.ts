import { describe, expect, it } from 'vitest'
import type { AgentStreamMessage } from '@/stores/agent'
import type { TimelinePart, TurnTimeline } from '@/components/agent/turnTimeline'
import { hasActionableWait, hasBubbleContent } from '@/components/agent/bubbleVisibility'

function assistant(content: string, streaming = false) {
  return { id: 'a1', role: 'assistant', content, streaming } as AgentStreamMessage
}

function user(content: string) {
  return { id: 'u1', role: 'user', content } as AgentStreamMessage
}

/** 带时间线的助手消息（B3 阻塞等待回合的形状）。 */
function assistantWithTimeline(parts: TimelinePart[], streaming = true) {
  return {
    id: 'a2',
    role: 'assistant',
    content: '',
    streaming,
    timeline: { parts } as TurnTimeline,
  } as AgentStreamMessage
}

describe('hasBubbleContent（P0：零内容不渲染白块）', () => {
  it('流式但零内容（阻塞等待期典型现场）→ false', () => {
    expect(hasBubbleContent(assistant('', true))).toBe(false)
  })
  it('流式且已有 token → true', () => {
    expect(hasBubbleContent(assistant('起', true))).toBe(true)
  })
  it('非流式无内容 → false', () => {
    expect(hasBubbleContent(assistant(''))).toBe(false)
  })
  it('助手纯机器载荷 → false', () => {
    expect(hasBubbleContent(assistant('__new_task__'))).toBe(false)
  })
  it('用户纯机器载荷 → false', () => {
    expect(hasBubbleContent(user('__scheme_decision__'))).toBe(false)
  })
  it('用户正常消息 → true', () => {
    expect(hasBubbleContent(user('画只卡通小狗'))).toBe(true)
  })
})

describe('hasActionableWait（B3：阻塞等待回合零 token 也要放行气泡）', () => {
  // 2026-10-31 生产实证 cmvvaw8ar000moe01fdolrugb：propose 等待期零文本 token，
  // hasBubbleContent 把整颗气泡（含内嵌 AgentTurnTimeline 的 proposal 确认卡）藏掉
  // = 确认卡在对话流里静默不可见。判据与 store 等待态查询侧同构。
  it('pending_confirm 的 proposal part → true（放行气泡，内联卡可见）', () => {
    const msg = assistantWithTimeline([
      { kind: 'proposal', id: 'p1', toolName: 'propose_generation', status: 'pending_confirm' },
    ] as unknown as TimelinePart[])
    expect(hasActionableWait(msg)).toBe(true)
  })
  it('pending_answer 的 question part → true', () => {
    const msg = assistantWithTimeline([
      {
        kind: 'question',
        id: 'q1',
        status: 'pending_answer',
        questions: [],
      },
    ] as unknown as TimelinePart[])
    expect(hasActionableWait(msg)).toBe(true)
  })
  it('已确认/已回答的终态 part → false（不放行空等待回合）', () => {
    const msg = assistantWithTimeline([
      { kind: 'proposal', id: 'p1', toolName: 'propose_generation', status: 'confirmed' },
      { kind: 'question', id: 'q1', status: 'answered', questions: [] },
    ] as unknown as TimelinePart[])
    expect(hasActionableWait(msg)).toBe(false)
  })
  it('无时间线 / 空 parts / 用户消息 → false', () => {
    expect(hasActionableWait(assistant('', true))).toBe(false)
    expect(hasActionableWait(assistantWithTimeline([]))).toBe(false)
    expect(
      hasActionableWait({ id: 'u2', role: 'user', content: '', timeline: { parts: [] } } as unknown as AgentStreamMessage),
    ).toBe(false)
  })
})
