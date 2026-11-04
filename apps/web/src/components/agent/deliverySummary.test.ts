import { describe, it, expect } from 'vitest'
import {
  applyTimelineEvent,
  createTurnTimeline,
  type TimelineEvent,
  type TurnTimeline,
} from '@/components/agent/turnTimeline'
import {
  deliveryCountLabel,
  hasRunningGeneration,
  turnDeliveryItems,
} from '@/components/agent/deliverySummary'

/** E2-a Task 1（规格 2026-11-04-e2a-ghost-delivery-summary §3 D-a/D-b）：
 *  事件流构造 timeline（沿用 turnTimeline.test.ts 的 feed 风格），纯函数只读消费 parts。 */

function feed(events: TimelineEvent[]): TurnTimeline {
  const tl = createTurnTimeline()
  for (const e of events) applyTimelineEvent(tl, e)
  return tl
}

const addNode = (id: string, nodeType = 'image', title = '三国英雄照片'): TimelineEvent => ({
  type: 'canvas_action',
  data: { type: 'add_node', payload: { id, nodeType, data: { title } } } as never,
})
const status = (nodeId: string, s: 'generating' | 'done' | 'failed', url?: string): TimelineEvent => ({
  type: 'node_status',
  data: { nodeId, status: s, ...(url ? { url } : {}) },
})

describe('turnDeliveryItems — D-a 派生纯函数', () => {
  it('过滤：仅 done 且有 nodeId 的 artifact part 入选，保序', () => {
    const tl = feed([
      addNode('n1'),
      status('n1', 'generating'),
      addNode('n2', 'image', '概念图 A'),
      status('n2', 'done', 'https://x/a.png'),
      addNode('n3', 'image', '概念图 B'),
      status('n3', 'failed'),
      addNode('n4', 'text', '文案'),
      status('n4', 'done'),
    ])
    const items = turnDeliveryItems(tl.parts)
    expect(items.map((i) => i.nodeId)).toEqual(['n2', 'n4'])
    expect(items[0]).toEqual({ nodeId: 'n2', nodeType: 'image', title: '概念图 A' })
    expect(items[1]).toEqual({ nodeId: 'n4', nodeType: 'text', title: '文案' })
  })

  it('pending（尚未有 node_status 拍）不计入', () => {
    const tl = feed([addNode('n1'), addNode('n2'), status('n2', 'done', 'https://x/b.png')])
    expect(turnDeliveryItems(tl.parts).map((i) => i.nodeId)).toEqual(['n2'])
  })

  it('重放一致性：同输入两次调用同输出，且不 mutate 入参', () => {
    const events = [addNode('n1'), status('n1', 'done', 'https://x/a.png'), addNode('n2'), status('n2', 'failed')]
    const tlA = feed(events)
    const tlB = feed(events)
    const snapshot = JSON.stringify(tlA.parts)
    const a = turnDeliveryItems(tlA.parts)
    const b = turnDeliveryItems(tlB.parts)
    expect(a).toEqual(b)
    expect(JSON.stringify(tlA.parts)).toBe(snapshot)
  })
})

describe('hasRunningGeneration — D-b 回合态判定', () => {
  it('存在 running artifact ⇒ true', () => {
    const tl = feed([addNode('n1'), status('n1', 'generating')])
    expect(hasRunningGeneration(tl.parts)).toBe(true)
  })
  it('全终态（done/failed）⇒ false', () => {
    const tl = feed([
      addNode('n1'),
      status('n1', 'done', 'https://x/a.png'),
      addNode('n2'),
      status('n2', 'failed'),
    ])
    expect(hasRunningGeneration(tl.parts)).toBe(false)
  })
  it('空 timeline ⇒ false', () => {
    expect(hasRunningGeneration(feed([]).parts)).toBe(false)
  })
})

describe('deliveryCountLabel — D-b 计数文案', () => {
  it('0 → 空串（整行不渲染由调用方判定）', () => {
    expect(deliveryCountLabel(0)).toBe('')
  })
  it('1→"1"、9→"9"', () => {
    expect(deliveryCountLabel(1)).toBe('1')
    expect(deliveryCountLabel(9)).toBe('9')
  })
  it('10 及以上 → "9+"', () => {
    expect(deliveryCountLabel(10)).toBe('9+')
    expect(deliveryCountLabel(23)).toBe('9+')
  })
})
