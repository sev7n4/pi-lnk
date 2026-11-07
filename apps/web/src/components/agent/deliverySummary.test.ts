import { describe, it, expect } from 'vitest'
import {
  applyTimelineEvent,
  createTurnTimeline,
  type TimelineEvent,
  type TurnTimeline,
} from '@/components/agent/turnTimeline'
import {
  canvasDigestEntry,
  deliveryCountLabel,
  digestEntryForTurn,
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

describe('turnDeliveryItems — 画布存在性过滤（2026-11-05 真机修复 Q2：已删节点不残留）', () => {
  it('canvasNodes 提供时，过滤 nodeId 已不在画布的项（删除 ⇒ 清单同步减）', () => {
    const tl = feed([
      addNode('n1'),
      status('n1', 'done', 'https://x/a.png'),
      addNode('n2'),
      status('n2', 'done', 'https://x/b.png'),
    ])
    const nodes = [{ id: 'n1' }, { id: 'n9' }]
    expect(turnDeliveryItems(tl.parts, nodes).map((i) => i.nodeId)).toEqual(['n1'])
  })

  it('canvasNodes 为 null/undefined ⇒ 不过滤（未接线/预览场景保守显示）', () => {
    const tl = feed([addNode('n1'), status('n1', 'done', 'https://x/a.png')])
    expect(turnDeliveryItems(tl.parts, undefined).map((i) => i.nodeId)).toEqual(['n1'])
    expect(turnDeliveryItems(tl.parts, null).map((i) => i.nodeId)).toEqual(['n1'])
  })

  it('空数组 ⇒ 全过滤（画布确无节点 = 全部已删，不留幽灵 tile）', () => {
    const tl = feed([addNode('n1'), status('n1', 'done', 'https://x/a.png')])
    expect(turnDeliveryItems(tl.parts, [])).toEqual([])
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

describe('P1a（2026-11-07）总览与「本轮产物」清单解耦', () => {
  const digestNode = { id: 'd1', type: 'text', data: { digest: true, source: 'system-digest' } }

  it('canvasNodes 含 digest 节点 ⇒ turnDeliveryItems 仍只有本轮 artifacts，零 digest tile', () => {
    const tl = feed([addNode('n1'), status('n1', 'done', 'https://x/a.png')])
    const items = turnDeliveryItems(tl.parts, [
      { id: 'n1', data: {} as Record<string, unknown> },
      digestNode,
    ])
    expect(items.length).toBe(1)
    expect(items[0].nodeId).toBe('n1')
    expect(items.some((it) => it.digest)).toBe(false)
  })

  it('零产物回合（纯聊天）即使有总览节点 ⇒ 清单为空 ⇒ 交付条隐藏', () => {
    const tl = feed([{ type: 'text_delta', data: { text: '好的' } }])
    expect(turnDeliveryItems(tl.parts, [digestNode])).toEqual([])
    expect(deliveryCountLabel(turnDeliveryItems(tl.parts, [digestNode]).length)).toBe('')
  })

  it('canvasDigestEntry：有 digest 节点则返回带 digest/format 的 tile；已删/未知态 ⇒ null（S4）', () => {
    expect(canvasDigestEntry([digestNode])).toEqual({
      nodeId: 'd1', nodeType: 'text', title: '画布总览', digest: true, format: 'html',
    })
    expect(canvasDigestEntry([{ id: 'n1', data: {} }])).toBeNull()
    expect(canvasDigestEntry([])).toBeNull()
    expect(canvasDigestEntry(null)).toBeNull()
  })

  it('digestEntryForTurn：历史回合一律 null（不注入当时还不存在的总览）', () => {
    const entry = canvasDigestEntry([digestNode])!
    expect(digestEntryForTurn(entry, true)).toEqual(entry)
    expect(digestEntryForTurn(entry, false)).toBeNull()
    expect(digestEntryForTurn(null, true)).toBeNull()
  })

  it('canvasNodes null（未知态）⇒ turnDeliveryItems 保守不派生、不追加总览', () => {
    const tl = feed([addNode('n1'), status('n1', 'done', 'https://x/a.png')])
    expect(turnDeliveryItems(tl.parts, null).length).toBe(1)
  })
})

// ── 2026-11-06：文本/HTML 产物显示区分（规格 #636 §4.7 / E2-a D-d）──────────
describe('turnDeliveryItems — 文本系 format 纯派生', () => {
  it('canvasNodes 里 text 节点显式 format:html ⇒ item.format === html', () => {
    const tl = feed([addNode('t1', 'text', '落地页'), status('t1', 'done')])
    const items = turnDeliveryItems(tl.parts, [
      { id: 't1', data: { content: '<!DOCTYPE html><title>落地页</title>', format: 'html' } },
    ])
    expect(items).toEqual([
      { nodeId: 't1', nodeType: 'text', title: '落地页', format: 'html' },
    ])
  })

  it('纯文本 / 非法 format ⇒ 不写字段（fail-soft 降级 plain，历史派生结果不变）', () => {
    const tl = feed([addNode('t1', 'text', '文案'), status('t1', 'done')])
    const plain = turnDeliveryItems(tl.parts, [{ id: 't1', data: { content: '一段文案' } }])
    expect(plain).toEqual([{ nodeId: 't1', nodeType: 'text', title: '文案' }])
    const bogus = turnDeliveryItems(tl.parts, [{ id: 't1', data: { format: 'jsx' } }])
    expect(bogus).toEqual([{ nodeId: 't1', nodeType: 'text', title: '文案' }])
  })

  it('⛔ 不做内容嗅探：content 长得像 HTML 但未标 format ⇒ 仍按纯文本', () => {
    const tl = feed([addNode('t1', 'text', '文案'), status('t1', 'done')])
    const items = turnDeliveryItems(tl.parts, [
      { id: 't1', data: { content: '<html><body>hi</body></html>' } },
    ])
    expect(items[0]?.format).toBeUndefined()
  })

  it('⛔ 非文本节点即便 data.format 恰好是 html 也不写字段（容器格式不是产物格式）', () => {
    const tl = feed([addNode('i1', 'image', '配图'), status('i1', 'done', 'https://x/a.png')])
    const items = turnDeliveryItems(tl.parts, [{ id: 'i1', data: { format: 'html' } }])
    expect(items[0]).toEqual({ nodeId: 'i1', nodeType: 'image', title: '配图' })
  })

  it('canvasNodes null（未知态）⇒ 不派生 format，保守显示', () => {
    const tl = feed([addNode('t1', 'text', '文案'), status('t1', 'done')])
    expect(turnDeliveryItems(tl.parts, null)[0]?.format).toBeUndefined()
  })
})
