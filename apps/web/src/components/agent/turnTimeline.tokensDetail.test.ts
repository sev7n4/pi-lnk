import { describe, expect, it } from 'vitest'
import {
  applyTimelineEvent,
  createTurnTimeline,
  composeTokensDetail,
  finalizeTurnTimeline,
  replayTimelineEvents,
  type TurnTimeline,
} from './turnTimeline'

/** 摘要 notice 按 id 精确取（与 refreshTimelineSummary 同判据）。 */
function summaryNotice(tl: TurnTimeline): { text: string; detail?: string } {
  const notice = tl.parts.find(
    (p): p is Extract<TurnTimeline['parts'][number], { kind: 'notice'; id: string }> =>
      p.kind === 'notice' && p.id === 'notice:turn-summary',
  )
  expect(notice).toBeDefined()
  return notice as { text: string; detail?: string }
}

/**
 * 点⑤（2026-11-04 tokens 移详情）：主行只留积分，tokens 收进悬停详情态（notice.detail，
 * 与 executionTrace T7 口径一致）。Q2 降级路径（无积分段）主行 tokens 保留（唯一可用口径）。
 */
describe('turnTimeline: tokens 移详情（点⑤）', () => {
  it('有预估积分 → 主行不含 tokens；detail 悬停含 T7 口径 breakdown（cacheWrite 并入输入）', () => {
    const tl = createTurnTimeline()
    applyTimelineEvent(tl, {
      type: 'turn_usage',
      data: { inputTokens: 8200, cacheReadTokens: 2000, cacheWriteTokens: 50, outputTokens: 400, estimatedCredits: 8 },
    })
    finalizeTurnTimeline(tl)
    const n = summaryNotice(tl)
    expect(n.text).not.toContain('tokens')
    expect(n.text).toContain('预计消耗 ≈8 积分（非正式结算）')
    // T7 口径：输入 = input + cacheWrite = 8250 → 8.3k（round(8250/100)/10 = 8.3）
    expect(n.detail).toBe('tokens 输入 8.3k · 缓存 2.0k · 输出 400')
  })

  it('settled 权威结算 → 主行只有结算段无 tokens；detail 仍挂 breakdown', () => {
    const tl = createTurnTimeline()
    applyTimelineEvent(tl, {
      type: 'turn_usage',
      data: { inputTokens: 1000, outputTokens: 500, estimatedCredits: 2 },
    })
    applyTimelineEvent(tl, {
      type: 'turn_settled',
      data: { holdId: 'h1', credits: 14, model: 'agnes-2.5-flash' },
    })
    finalizeTurnTimeline(tl)
    const n = summaryNotice(tl)
    expect(n.text).toContain('已结算 -14 积分（文本 · agnes-2.5-flash）')
    expect(n.text).not.toContain('tokens')
    expect(n.detail).toBe('tokens 输入 1.0k · 缓存 0 · 输出 500')
  })

  it('Q2 降级（无积分段）→ 主行 tokens 保留（唯一可用口径）；detail 同挂', () => {
    const tl = createTurnTimeline()
    applyTimelineEvent(tl, { type: 'turn_usage', data: { inputTokens: 100, outputTokens: 50 } })
    finalizeTurnTimeline(tl)
    const n = summaryNotice(tl)
    expect(n.text).toContain('消耗 150 tokens')
    expect(n.text).not.toContain('积分')
    expect(n.detail).toBe('tokens 输入 100 · 缓存 0 · 输出 50')
  })

  it('历史重放（含 turn_settled）→ 摘要 notice 同样挂 detail（replay 与 live 同构）', () => {
    const tl = replayTimelineEvents(
      [
        { type: 'turn_usage', data: { inputTokens: 1000, outputTokens: 500, estimatedCredits: 2 } },
        { type: 'turn_settled', data: { holdId: 'h1', credits: 7, model: 'agnes-2.5-flash' } },
      ],
      '正文',
    )
    finalizeTurnTimeline(tl)
    const n = summaryNotice(tl)
    expect(n.text).toContain('已结算 -7 积分（文本 · agnes-2.5-flash）')
    expect(n.detail).toBe('tokens 输入 1.0k · 缓存 0 · 输出 500')
  })

  it('composeTokensDetail：无 usage / 全 0 → null（notice 不挂悬停 affordance）', () => {
    expect(composeTokensDetail(createTurnTimeline())).toBeNull()
    const zero = createTurnTimeline()
    applyTimelineEvent(zero, { type: 'turn_usage', data: { inputTokens: 0, outputTokens: 0 } })
    expect(composeTokensDetail(zero)).toBeNull()
  })
})
