import { describe, expect, it } from 'vitest'
import {
  applyTimelineEvent, createTurnTimeline, finalizeTurnTimeline,
  replayTimelineEvents, type TimelineEvent, type TimelinePart, type TurnTimeline,
} from '@/components/agent/turnTimeline'

function feed(events: TimelineEvent[]): TurnTimeline {
  const tl = createTurnTimeline()
  for (const e of events) applyTimelineEvent(tl, e)
  return tl
}
function tools(tl: TurnTimeline): Extract<TimelinePart, { kind: 'tool' }>[] {
  return tl.parts.filter((p): p is Extract<TimelinePart, { kind: 'tool' }> => p.kind === 'tool')
}
function notices(tl: TurnTimeline): Extract<TimelinePart, { kind: 'notice' }>[] {
  return tl.parts.filter((p): p is Extract<TimelinePart, { kind: 'notice' }> => p.kind === 'notice')
}
const spawnCall: TimelineEvent = {
  type: 'tool_call', data: { toolCallId: 'call_A', name: 'spawn_subagent', args: { task: '调研X' } },
}
const interrupted: TimelineEvent = {
  type: 'turn_interrupted',
  data: { reason: 'no_terminal_event', lastSeq: 152, outstandingToolCallIds: ['call_A'] },
}

describe('turn_interrupted 时间线：不再把未配对工具渲染成 ✓', () => {
  it('running 工具被翻成 interrupted，且出现一条 error notice（含未扣费文案）', () => {
    const tl = feed([spawnCall, interrupted])
    expect(tools(tl)[0]?.status).toBe('interrupted')
    const n = notices(tl).find((p) => p.id === 'notice:turn-interrupted')
    expect(n?.tone).toBe('error')
    expect(n?.text).toContain('未扣费')
    expect(n?.text).not.toContain('服务更新打断')
    expect(n?.retryLabel).toBeTruthy()
  })

  it('★ 回归锁：finalizeTurnTimeline 不得把 interrupted 翻回 done', () => {
    const tl = feed([spawnCall, interrupted])
    finalizeTurnTimeline(tl)
    expect(tools(tl)[0]?.status).toBe('interrupted')
  })

  it('★ 重放还原：replayTimelineEvents 含落库事件时同样还原中断态', () => {
    const tl = replayTimelineEvents([
      { type: 'tool_call', data: { toolCallId: 'call_A', name: 'spawn_subagent' }, seq: 1, gSeq: 152 },
      { type: 'turn_interrupted', data: { reason: 'no_terminal_event', lastSeq: 152 }, seq: 2, gSeq: 152 },
    ])
    expect(tools(tl)[0]?.status).toBe('interrupted')
    expect(notices(tl).some((p) => p.id === 'notice:turn-interrupted')).toBe(true)
  })

  it('幂等：turn_interrupted 重复到达只产生一条 notice', () => {
    const tl = feed([spawnCall, interrupted, interrupted])
    expect(notices(tl).filter((p) => p.id === 'notice:turn-interrupted')).toHaveLength(1)
  })

  it('可恢复：带 callId 的 tool_result 把 interrupted 翻回 done 并移除 notice', () => {
    const tl = feed([spawnCall, interrupted, {
      type: 'tool_result', data: { toolCallId: 'call_A', name: 'spawn_subagent', result: 'ok' },
    }])
    expect(tools(tl)[0]?.status).toBe('done')
    expect(notices(tl).some((p) => p.id === 'notice:turn-interrupted')).toBe(false)
  })

  it('可恢复：无 callId 的 tool_result 命中 interrupted 工具（不得孤儿降级）', () => {
    const tl = feed([
      { type: 'tool_call', data: { name: 'spawn_subagent' } },
      interrupted,
      { type: 'tool_result', data: { name: 'spawn_subagent', result: 'ok' } },
    ])
    expect(tools(tl)[0]?.status).toBe('done')
    expect(tools(tl)).toHaveLength(1)
  })

  it('历史老消息（只有 tool_call、无中断事件）：既有 truncated notice 行为不变', () => {
    const tl = replayTimelineEvents(
      [{ type: 'tool_call', data: { toolCallId: 'call_A', name: 'spawn_subagent' }, seq: 1 }],
      undefined,
      { truncated: true },
    )
    expect(notices(tl).some((p) => p.id === 'notice:truncated-ledger')).toBe(true)
    expect(notices(tl).some((p) => p.id === 'notice:turn-interrupted')).toBe(false)
  })

  it('中断发生在长回合前缀（有已配对工具）：未配对与新工具都标 interrupted，不误伤已完成的', () => {
    const tl = feed([
      { type: 'tool_call', data: { toolCallId: 'call_done', name: 'read' } },
      { type: 'tool_result', data: { toolCallId: 'call_done', name: 'read', result: 'ok' } },
      spawnCall,
      interrupted,
    ])
    expect(tools(tl).map((p) => p.status)).toEqual(['done', 'interrupted'])
  })
})
