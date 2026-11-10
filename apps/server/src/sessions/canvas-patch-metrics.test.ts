import { describe, it, expect, beforeEach } from 'vitest'
import {
  CanvasPatchMetrics,
  NEAR_CONCURRENT_MS,
  RECENT_CONFLICTS_MAX,
  canvasPatchMetrics,
  targetKeysOf,
} from './canvas-patch-metrics'

describe('targetKeysOf', () => {
  it('提取 node/edge 目标键', () => {
    expect(
      targetKeysOf([
        { type: 'update_node', payload: { id: 'n1' } },
        { type: 'add_edge', payload: { id: 'e1', source: 'n1', target: 'n2' } },
        { type: 'set_viewport', payload: { viewport: {} } },
      ]),
    ).toEqual(['node:n1', 'edge:e1'])
  })
})

describe('CanvasPatchMetrics', () => {
  let m: CanvasPatchMetrics
  beforeEach(() => {
    m = new CanvasPatchMetrics()
  })

  it('六项计数精确（阶段 1 不变式）', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 2, 1, [
      { type: 'update_node' },
    ])
    expect(m.snapshot()).toMatchObject({
      patches: 1,
      ops: 2,
      applied: 1,
      skipped: 1,
      skippedByType: { update_node: 1 },
      distinctClients: 1,
      nearConcurrentPairs: 0,
      keyOverlapPairs: 0,
    })
  })

  it('R5：同 clientId 2s 内连发不自计', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000 + NEAR_CONCURRENT_MS, targetKeys: ['node:n1'] }, 1, 1, [])
    expect(m.snapshot().nearConcurrentPairs).toBe(0)
  })

  it('不同 clientId + 2s 内 + 键相交 ⇒ stale_conflict + 缺口 B 事件', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's1', clientId: 'c2', ts: 1500, targetKeys: ['node:n1'] }, 1, 1, [])
    const snap = m.snapshot()
    expect(snap).toMatchObject({ nearConcurrentPairs: 1, keyOverlapPairs: 1, staleConflict: 1, sessionsWithStaleConflict: 1 })
    expect(snap.recentConflicts).toHaveLength(1)
    expect(snap.recentConflicts[0]).toMatchObject({ sessionId: 's1', clientA: 'c1', clientB: 'c2', keys: ['node:n1'] })
  })

  it('不同 clientId + 键不相交 ⇒ 只计 nearConcurrent，不记冲突事件', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's1', clientId: 'c2', ts: 1500, targetKeys: ['node:n2'] }, 1, 1, [])
    const snap = m.snapshot()
    expect(snap).toMatchObject({ nearConcurrentPairs: 1, keyOverlapPairs: 0, sessionsWithStaleConflict: 0 })
    expect(snap.recentConflicts).toHaveLength(0)
  })

  it('超过 2s / 不同 session 均不计', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's1', clientId: 'c2', ts: 1000 + NEAR_CONCURRENT_MS + 1, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's2', clientId: 'c2', ts: 1000 + NEAR_CONCURRENT_MS + 2, targetKeys: ['node:n1'] }, 1, 1, [])
    expect(m.snapshot().nearConcurrentPairs).toBe(0)
  })

  it('缺口 B：多 session 冲突 → sessionsWithStaleConflict 去重', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's1', clientId: 'c2', ts: 1500, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's2', clientId: 'c3', ts: 1000, targetKeys: ['node:n2'] }, 1, 1, [])
    m.record({ sessionId: 's2', clientId: 'c4', ts: 1500, targetKeys: ['node:n2'] }, 1, 1, [])
    // 同 session 第二次冲突不应重复计入 session 集合
    m.record({ sessionId: 's1', clientId: 'c1', ts: 2000, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's1', clientId: 'c2', ts: 2500, targetKeys: ['node:n1'] }, 1, 1, [])
    const snap = m.snapshot()
    expect(snap.sessionsWithStaleConflict).toBe(2)
    // 4 次相邻对均满足「不同 clientId + ≤2s + 键相交」⇒ 4 次冲突，session 集合去重为 2
    expect(snap.staleConflict).toBe(4)
  })

  it('缺口 B：recentConflicts 环形上限 RECENT_CONFLICTS_MAX', () => {
    for (let i = 0; i < RECENT_CONFLICTS_MAX + 50; i++) {
      const t = 1000 + i * 10
      m.record({ sessionId: 's1', clientId: 'c1', ts: t, targetKeys: ['node:n1'] }, 1, 1, [])
      m.record({ sessionId: 's1', clientId: 'c2', ts: t + 5, targetKeys: ['node:n1'] }, 1, 1, [])
    }
    const snap = m.snapshot()
    expect(snap.recentConflicts.length).toBe(RECENT_CONFLICTS_MAX)
    // 每轮 2 条 record ⇒ 2 次冲突，但首轮第一条 c1 无前驱不计 ⇒ (MAX+50)*2 - 1 次累计（环形只保留最近 MAX 条事件）
    expect(snap.staleConflict).toBe(2 * (RECENT_CONFLICTS_MAX + 50) - 1)
  })

  it('单例可 reset（含缺口 B 字段）', () => {
    canvasPatchMetrics.reset()
    expect(canvasPatchMetrics.snapshot().patches).toBe(0)
    expect(canvasPatchMetrics.snapshot().sessionsWithStaleConflict).toBe(0)
    expect(canvasPatchMetrics.snapshot().recentConflicts).toHaveLength(0)
  })
})
