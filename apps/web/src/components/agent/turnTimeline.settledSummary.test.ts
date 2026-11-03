import { describe, expect, it } from 'vitest'
import {
  applyTimelineEvent,
  createTurnTimeline,
  finalizeTurnTimeline,
  replayTimelineEvents,
  summarizeTimeline,
  type TurnTimeline,
} from './turnTimeline'

/** 摘要 notice 按 id 精确取（与 refreshTimelineSummary 同判据）；拿不到报错即失败。 */
function summaryText(tl: TurnTimeline): string {
  const notice = tl.parts.find(
    (p): p is Extract<TurnTimeline['parts'][number], { kind: 'notice'; id: string }> =>
      p.kind === 'notice' && p.id === 'notice:turn-summary',
  )
  expect(notice).toBeDefined()
  return (notice as { text: string }).text
}

/** 2026-11-03 结算摘要（PR 积分单一真相源③）：turn_settled 权威值进时间线摘要行。 */
describe('turnTimeline: turn_settled 结算摘要', () => {
  const usage = {
    inputTokens: 1000,
    outputTokens: 500,
    estimatedCredits: 2,
  }

  it('settled 到达 → 摘要「共消耗 N 积分 · 模型名」，预估段不再出现', () => {
    const tl = createTurnTimeline()
    applyTimelineEvent(tl, { type: 'turn_usage', data: { ...usage } })
    applyTimelineEvent(tl, {
      type: 'turn_settled',
      data: { holdId: 'h1', credits: 14, model: 'agnes-2.5-flash' },
    })
    const s = summarizeTimeline(tl)!
    expect(s).toContain('共消耗 14 积分 · agnes-2.5-flash')
    expect(s).not.toContain('预估')
  })

  it('settled 未到 → 摘要维持「≈N 积分（预估）」口径', () => {
    const tl = createTurnTimeline()
    applyTimelineEvent(tl, { type: 'turn_usage', data: { ...usage } })
    expect(summarizeTimeline(tl)).toContain('≈2 积分（预估）')
  })

  it('released（预扣全退）→ 不显示共消耗，回退预估段', () => {
    const tl = createTurnTimeline()
    applyTimelineEvent(tl, { type: 'turn_usage', data: { ...usage } })
    applyTimelineEvent(tl, { type: 'turn_settled', data: { holdId: 'h1', released: true } })
    const s = summarizeTimeline(tl)!
    expect(s).not.toContain('共消耗')
    expect(s).toContain('≈2 积分（预估）')
  })

  it('回合先收束、结算晚到 → refreshTimelineSummary 原地刷新摘要 notice', () => {
    const tl = createTurnTimeline()
    applyTimelineEvent(tl, { type: 'turn_usage', data: { ...usage } })
    finalizeTurnTimeline(tl)
    // Epic 3 Task 10（规格 §5.3 flag-off 行）：收束后仍无 settled ⇒ flag-off 终态文案
    expect(summaryText(tl)).toContain('预计消耗 ≈2 积分（非正式结算）')

    applyTimelineEvent(tl, {
      type: 'turn_settled',
      data: { holdId: 'h1', credits: 14, model: 'agnes-2.5-flash' },
    })
    expect(summaryText(tl)).toContain('共消耗 14 积分 · agnes-2.5-flash')
    expect(summaryText(tl)).not.toContain('非正式结算')
  })

  it('历史重放：turn_settled 随 executionEvents 回放 → 摘要出权威值（模型名还原）', () => {
    const tl = replayTimelineEvents(
      [
        { type: 'turn_usage', data: usage },
        {
          type: 'turn_settled',
          data: { holdId: 'h1', credits: 7, model: 'agnes-2.5-flash' },
        },
      ],
      '正文',
    )
    finalizeTurnTimeline(tl)
    expect(summaryText(tl)).toContain('共消耗 7 积分 · agnes-2.5-flash')
  })

  it('model 键缺失（旧落库事件）→ 只显示积分，不显示 undefined', () => {
    const tl = createTurnTimeline()
    applyTimelineEvent(tl, { type: 'turn_usage', data: { ...usage } })
    applyTimelineEvent(tl, { type: 'turn_settled', data: { holdId: 'h1', credits: 14 } })
    const s = summarizeTimeline(tl)!
    expect(s).toContain('共消耗 14 积分')
    expect(s).not.toContain('undefined')
  })
})
