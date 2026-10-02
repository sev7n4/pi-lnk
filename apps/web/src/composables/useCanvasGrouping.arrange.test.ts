import { describe, expect, it } from 'vitest'
import { applyArrangeLayout, type FlowNode } from './useCanvasGrouping'

function node(id: string, x: number, y: number, type = 'image'): FlowNode {
  return { id, type, position: { x, y }, data: {} }
}

function posOf(nodes: FlowNode[]) {
  return Object.fromEntries(nodes.map((n) => [n.id, n.position]))
}

describe('applyArrangeLayout（arrange_nodes 工具与多选工具栏共用派发）', () => {
  it('少于两个目标 → 原样返回（不重排）', () => {
    const nodes = [node('a', 10, 10)]
    expect(applyArrangeLayout(nodes, { nodeIds: ['a'], mode: 'grid' })).toBe(nodes)
  })

  it('mode=grid 按 cols=ceil(√n) 铺格，锚点为原包围盒左上角', () => {
    const nodes = [node('a', 0, 0), node('b', 500, 300), node('c', 20, 10), node('d', 900, 900)]
    const next = applyArrangeLayout(nodes, { nodeIds: ['a', 'b', 'c', 'd'], mode: 'grid', gap: 40 })
    const p = posOf(next)
    const w = p.b.x - p.a.x - 40
    const h = p.c.y - p.a.y - 40
    expect(p.a).toEqual({ x: 0, y: 0 })
    // 2 列 × 2 行：b 在右、c 在下、d 在右下
    expect(p.b.x).toBeGreaterThan(p.a.x)
    expect(p.b.y).toBe(p.a.y)
    expect(p.c.x).toBe(p.a.x)
    expect(p.c.y).toBeGreaterThan(p.a.y)
    expect(p.d.x).toBe(p.a.x + w + 40)
    expect(p.d.y).toBe(p.a.y + h + 40)
  })

  it('mode=along_edges 优先用显式 edges 分层', () => {
    const nodes = [node('a', 500, 300), node('b', 100, 80), node('c', 300, 20)]
    const next = applyArrangeLayout(
      nodes,
      { nodeIds: ['a', 'b', 'c'], mode: 'along_edges', edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }] },
    )
    const p = posOf(next)
    expect(p.a.x).toBeLessThan(p.b.x)
    expect(p.b.x).toBeLessThan(p.c.x)
  })

  it('mode=along_edges 且未显式传 edges → 退回画布全量边（同手动「顺着连线」）', () => {
    const nodes = [node('a', 500, 300), node('b', 100, 80), node('c', 300, 20)]
    const canvasEdges = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }]
    const explicit = applyArrangeLayout(
      nodes.map((n) => ({ ...n })),
      { nodeIds: ['a', 'b', 'c'], mode: 'along_edges', edges: canvasEdges },
    )
    const fallback = applyArrangeLayout(
      nodes.map((n) => ({ ...n })),
      { nodeIds: ['a', 'b', 'c'], mode: 'along_edges' },
      canvasEdges,
    )
    expect(posOf(fallback)).toEqual(posOf(explicit))
  })

  it('gap 缺失或非法 → 兜底 40', () => {
    const nodes = [node('a', 0, 0), node('b', 900, 900)]
    const withDefault = posOf(applyArrangeLayout(nodes.map((n) => ({ ...n })), { nodeIds: ['a', 'b'], mode: 'grid' }))
    const withNaN = posOf(applyArrangeLayout(nodes.map((n) => ({ ...n })), { nodeIds: ['a', 'b'], mode: 'grid', gap: Number.NaN }))
    const with20 = posOf(applyArrangeLayout(nodes.map((n) => ({ ...n })), { nodeIds: ['a', 'b'], mode: 'grid', gap: 20 }))
    expect(withDefault).toEqual(withNaN)
    expect(with20.b.x).toBe(withDefault.b.x - 20)
  })
})
