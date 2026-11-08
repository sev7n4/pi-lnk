import { describe, it, expect } from 'vitest'
import {
  applyTimelineEvent,
  createTurnTimeline,
  type TimelineEvent,
  type TimelinePart,
  type TurnTimeline,
} from '@/components/agent/turnTimeline'

/**
 * P3（fix/observer-refusal-exempt）：waiting_user resolved 必须按 callId 精确翻匹配的
 * question part，不得一律翻成第一张。
 *
 * 回归背景：生产会话 cmw7kmv3x01q4r401i7ir33b4 出现 4 张 ask_user 卡；旧逻辑
 * `timeline.parts.find(p => p.kind === 'question')` 永远命中第一张 ⇒ 解析其余 3 张时
 * 它们仍停留 pending_answer 误显。修复后镜像 proposal 的三态条件
 * `(!d.callId || !p.callId || p.callId === d.callId)`。
 *
 * 以下断言在修复前必红（旧逻辑翻错/误翻），修复后转绿 ⇒ 行为级 RED→PASS 守卫。
 */
function feed(events: TimelineEvent[]): TurnTimeline {
  const tl = createTurnTimeline()
  for (const e of events) applyTimelineEvent(tl, e)
  return tl
}

function questions(tl: TurnTimeline) {
  return tl.parts.filter((p) => p.kind === 'question') as Extract<
    TimelinePart,
    { kind: 'question' }
  >[]
}

const ask = (callId: string): TimelineEvent =>
  ({ type: 'ask_user', data: { callId, title: `卡-${callId}`, questions: [] } } as never)

const resolve = (callId?: string): TimelineEvent =>
  ({
    type: 'waiting_user',
    data: callId
      ? { status: 'resolved', callId, reason: 'answered' }
      : { status: 'resolved', reason: 'answered' },
  } as never)

describe('turnTimeline — waiting_user resolved 按 callId 精确翻 question（P3）', () => {
  it('多张 ask_user 卡：resolved 的 callId 只翻匹配的那张，其余保持 pending_answer', () => {
    const tl = feed([ask('c1'), ask('c2')])
    const qs = questions(tl)
    expect(qs).toHaveLength(2)
    expect(qs.map((q) => q.id).sort()).toEqual(['question:c1', 'question:c2'])
    expect(qs.every((q) => q.status === 'pending_answer')).toBe(true)

    applyTimelineEvent(tl, resolve('c2'))
    const after = questions(tl)
    const c1 = after.find((q) => q.id === 'question:c1')!
    const c2 = after.find((q) => q.id === 'question:c2')!
    expect(c1.status, 'c1 未被 resolve 应保持 pending_answer').toBe('pending_answer')
    expect(c2.status, 'c2 被精确 resolve 应翻 answered').toBe('answered')
  })

  it('callId 不匹配任何 question 时不得误翻（保持既存 pending）', () => {
    const tl = feed([ask('c1')])
    applyTimelineEvent(tl, resolve('nope'))
    expect(questions(tl)[0].status, 'callId 不匹配不得翻 answered').toBe('pending_answer')
  })

  it('legacy：resolved 无 callId 时回落首张 question（向后兼容，不漏翻）', () => {
    const tl = feed([ask('c1'), ask('c2')])
    applyTimelineEvent(tl, resolve())
    const after = questions(tl)
    expect(after.find((q) => q.id === 'question:c1')!.status, '无 callId 回落首张，c1 应翻 answered').toBe(
      'answered',
    )
    expect(
      after.find((q) => q.id === 'question:c2')!.status,
      '无 callId 时不该误翻 c2',
    ).toBe('pending_answer')
  })
})
