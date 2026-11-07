import { describe, it, expect, vi } from 'vitest'
import type { AgentStreamMessage } from '@/stores/agent'
import type { AgentPresentationEnvelope } from '@/components/agent/presentation/types'

vi.mock('@/components/agent/executionTraceReducer', () => ({
  turnSummaryLine: vi.fn(() => 'SUMMARY_LINE'),
}))

import { historyPresentation, historyMacroSelectedIds, bubbleSummaryLine } from './agentMessageRender'

function userMsg(partial: Partial<AgentStreamMessage> = {}): AgentStreamMessage {
  return { role: 'user', streaming: false, content: '', ...partial } as unknown as AgentStreamMessage
}
function assistantMsg(partial: Partial<AgentStreamMessage> = {}): AgentStreamMessage {
  return { role: 'assistant', streaming: false, content: '', ...partial } as unknown as AgentStreamMessage
}

describe('historyPresentation', () => {
  it('user 消息返回 null', () => {
    expect(historyPresentation(userMsg())).toBeNull()
  })
  it('assistant 流式消息返回 null', () => {
    expect(historyPresentation(assistantMsg({ streaming: true, presentation: {} as AgentPresentationEnvelope }))).toBeNull()
  })
  it('assistant 非流式但无 presentation 返回 null', () => {
    expect(historyPresentation(assistantMsg({ streaming: false }))).toBeNull()
  })
  it('svg_card presentation 返回 null（走独立挂载）', () => {
    const p = { kind: 'svg_card' } as AgentPresentationEnvelope
    expect(historyPresentation(assistantMsg({ streaming: false, presentation: p }))).toBeNull()
  })
  it('host presentation 返回该 presentation', () => {
    const p = { kind: 'host' } as AgentPresentationEnvelope
    expect(historyPresentation(assistantMsg({ streaming: false, presentation: p }))).toBe(p)
  })
})

describe('historyMacroSelectedIds', () => {
  it('有 recommended 方案时只返回 recommended id', () => {
    const p = {
      body: { schemes: [
        { id: 1, recommended: false },
        { id: 2, recommended: true },
        { id: 3, recommended: true },
      ] },
    } as unknown as AgentPresentationEnvelope
    expect(historyMacroSelectedIds(p)).toEqual(['2', '3'])
  })
  it('无 recommended 时取前 max_select（默认 2）个', () => {
    const p = {
      body: { schemes: [{ id: 10 }, { id: 11 }, { id: 12 }] },
    } as unknown as AgentPresentationEnvelope
    expect(historyMacroSelectedIds(p)).toEqual(['10', '11'])
  })
  it('max_select 显式指定时取前 N 个', () => {
    const p = {
      body: { schemes: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }], max_select: 3 },
    } as unknown as AgentPresentationEnvelope
    expect(historyMacroSelectedIds(p)).toEqual(['1', '2', '3'])
  })
  it('body 为空时返回 []', () => {
    expect(historyMacroSelectedIds({} as AgentPresentationEnvelope)).toEqual([])
  })
})

describe('bubbleSummaryLine', () => {
  it('user 消息返回 null', () => {
    expect(bubbleSummaryLine(userMsg({ executionTrace: {} as never }))).toBeNull()
  })
  it('assistant 流式返回 null', () => {
    expect(bubbleSummaryLine(assistantMsg({ streaming: true, executionTrace: {} as never }))).toBeNull()
  })
  it('assistant 无 trace 返回 null', () => {
    expect(bubbleSummaryLine(assistantMsg({ streaming: false }))).toBeNull()
  })
  it('assistant 有 trace 返回 turnSummaryLine 结果', () => {
    const trace = { foo: 'bar' } as never
    expect(bubbleSummaryLine(assistantMsg({ streaming: false, executionTrace: trace }))).toBe('SUMMARY_LINE')
  })
})
