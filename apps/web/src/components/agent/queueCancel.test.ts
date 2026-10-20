/**
 * 撤回已入队插话（2026-10-20 P0）的纯函数单测。
 *
 * 背景：前端气泡的「放弃 / 取回内容」此前**只清前端槽位**，服务端那条仍在 vendor inbox 里
 * 照常被消费 —— 用户以为撤回了，实际它还会插进 agent 上下文。本次接上上游
 * `AgentLane.cancelQueued`，撤回键 = 入队时回传的 `entryId`。
 *
 * 这里锁两件事：
 *   ① `cancelOutcomeHint` 三态各有**不同的诚实说法**（把 already_consumed 说成「已撤回」是谎报）；
 *   ② `entryId` 的提取与缺失处理（缺 key ⇒ 不能假装能撤回）。
 */
import { describe, expect, it } from 'vitest'
import { cancelOutcomeHint, type QueueCancelOutcome } from './queueDelivery'

/** 与 AgentSideRail 中 deliverQueued 的提取口径一致：Nest 包一层 { code, data }。 */
function extractEntryId(body: unknown): string | undefined {
  const outer = body as { data?: { entryId?: string } } | null
  return typeof outer?.data?.entryId === 'string' ? outer.data.entryId : undefined
}

describe('cancelOutcomeHint（撤回三态文案）', () => {
  it('cancelled：明确告知撤回了，且这条不会进上下文', () => {
    expect(cancelOutcomeHint('cancelled')).toContain('已撤回')
    expect(cancelOutcomeHint('cancelled')).toContain('不会进入')
  })

  it('⭐ already_consumed：不能说成「已撤回」（内容已在对话历史里，撤回已晚）', () => {
    const hint = cancelOutcomeHint('already_consumed')
    expect(hint).not.toContain('已撤回')
    expect(hint).toContain('接住')
  })

  it('not_found：说清是队列里找不到，别让用户以为撤回成功', () => {
    const hint = cancelOutcomeHint('not_found')
    expect(hint).not.toContain('已撤回')
    expect(hint).toContain('找不到')
  })

  it('三态文案互不相同（防止两支被写成同一句话而失去区分度）', () => {
    const all: QueueCancelOutcome[] = ['cancelled', 'already_consumed', 'not_found']
    const hints = all.map(cancelOutcomeHint)
    expect(new Set(hints).size).toBe(3)
  })
})

describe('entryId 提取（撤回键）', () => {
  it('Nest 包层 { code:0, data:{ entryId } } → 取出', () => {
    expect(extractEntryId({ code: 0, data: { queued: true, entryId: 'pi-123' } })).toBe('pi-123')
  })

  it('data 缺失 → undefined（不是空串：空串会被当成「有 key」而调撤回）', () => {
    expect(extractEntryId({ code: 0, data: { queued: true } })).toBeUndefined()
    expect(extractEntryId(null)).toBeUndefined()
    expect(extractEntryId({ data: { entryId: 42 } })).toBeUndefined()
  })
})