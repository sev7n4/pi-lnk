import { describe, it, expect, beforeEach } from 'vitest'
import { CanvasPatchMetrics, NEAR_CONCURRENT_MS, canvasPatchMetrics, targetKeysOf } from './canvas-patch-metrics'

describe('targetKeysOf', () => {
  it('提取 node/edge 目标键', () => {
    expect(targetKeysOf([
      { type: 'update_node', payload: { id: 'n1' } },
      { type: 'add_edge', payload: { id: 'e1', source: 'n1', target: 'n2' } },
      { type: 'set_viewport', payload: { viewport: {} } },
    ])).toEqual(['node:n1', 'edge:e1'])
  })
})

describe('CanvasPatchMetrics', () => {
  let m: CanvasPatchMetrics
  beforeEach(() => { m = new CanvasPatchMetrics() })
  it('六项计数精确', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 2, 1,
      [{ type: 'update_node' }])
    expect(m.snapshot()).toMatchObject({ patches: 1, ops: 2, applied: 1, skipped: 1,
      skippedByType: { update_node: 1 }, distinctClients: 1,
      nearConcurrentPairs: 0, keyOverlapPairs: 0 })
  })
  it('R5：同 clientId 2s 内连发不自计', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000 + NEAR_CONCURRENT_MS, targetKeys: ['node:n1'] }, 1, 1, [])
    expect(m.snapshot().nearConcurrentPairs).toBe(0)
  })
  it('不同 clientId + 2s 内 + 键相交 ⇒ stale_conflict', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's1', clientId: 'c2', ts: 1500, targetKeys: ['node:n1'] }, 1, 1, [])
    expect(m.snapshot()).toMatchObject({ nearConcurrentPairs: 1, keyOverlapPairs: 1, distinctClients: 2 })
  })
  it('不同 clientId + 键不相交 ⇒ 只计 nearConcurrent', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's1', clientId: 'c2', ts: 1500, targetKeys: ['node:n2'] }, 1, 1, [])
    expect(m.snapshot()).toMatchObject({ nearConcurrentPairs: 1, keyOverlapPairs: 0 })
  })
  it('超过 2s / 不同 session 均不计', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's1', clientId: 'c2', ts: 1000 + NEAR_CONCURRENT_MS + 1, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's2', clientId: 'c2', ts: 1000 + NEAR_CONCURRENT_MS + 2, targetKeys: ['node:n1'] }, 1, 1, [])
    expect(m.snapshot().nearConcurrentPairs).toBe(0)
  })
  it('R12：非相邻对不参与 stale_conflict 计数（相邻前驱键不相交）', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1100, targetKeys: ['node:n2'] }, 1, 1, [])
    m.record({ sessionId: 's1', clientId: 'c2', ts: 1200, targetKeys: ['node:n1'] }, 1, 1, [])
    expect(m.snapshot()).toMatchObject({ nearConcurrentPairs: 1, keyOverlapPairs: 0, staleConflict: 0 })
  })
  it('R13：distinctClients 为全局 clientId 去重（跨 session 同一 client 只计一次）', () => {
    m.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 1, 1, [])
    m.record({ sessionId: 's2', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 1, 1, [])
    expect(m.snapshot().distinctClients).toBe(1)
  })
  it('单例可 reset', () => {
    canvasPatchMetrics.reset()
    canvasPatchMetrics.record({ sessionId: 's1', clientId: 'c1', ts: 1000, targetKeys: ['node:n1'] }, 2, 1,
      [{ type: 'update_node' }])
    canvasPatchMetrics.record({ sessionId: 's1', clientId: 'c2', ts: 1500, targetKeys: ['node:n1'] }, 1, 1, [])
    expect(canvasPatchMetrics.snapshot()).toMatchObject({
      patches: 2, skipped: 1, skippedByType: { update_node: 1 },
      nearConcurrentPairs: 1, keyOverlapPairs: 1, distinctClients: 2,
    })
    canvasPatchMetrics.reset()
    expect(canvasPatchMetrics.snapshot().patches).toBe(0)
    expect(canvasPatchMetrics.snapshot()).toEqual({
      patches: 0, ops: 0, applied: 0, skipped: 0,
      skippedByType: {},
      distinctClients: 0,
      nearConcurrentPairs: 0, keyOverlapPairs: 0, staleConflict: 0,
    })
  })
})
