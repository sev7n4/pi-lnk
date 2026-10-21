import { describe, expect, it } from 'vitest'
import {
  applyLayoutOps,
  getAbsolutePosition,
  getNodeSize,
  layoutNodesAlongEdges,
  layoutNodesInGrid,
  moveNodes,
  type LayoutNode,
} from './canvas-layout.util'

function node(
  id: string,
  type: string,
  x: number,
  y: number,
  extra: Partial<LayoutNode> = {},
): LayoutNode {
  return {
    id,
    type,
    position: { x, y },
    data: {},
    ...extra,
  }
}

describe('canvas-layout.util', () => {
  describe('getNodeSize', () => {
    it('uses type defaults', () => {
      expect(getNodeSize(node('a', 'image', 0, 0))).toEqual({ w: 280, h: 280 })
      // prompt 2026-10-17 下线（创建入口已断），但存量节点仍渲染为 280×120 ⇒ 按真实尺寸量。
      // ⚠️ 尺寸表 ≠ 可创建类型表（NodeType 才是 4 项）：下线类型的历史节点仍在存量画布里，
      //   按 fallback 280×160 量会让放置内核算出的 bbox 与真实渲染尺寸不符 ⇒ 可能压盖。
      expect(getNodeSize(node('b', 'prompt', 0, 0))).toEqual({ w: 280, h: 120 })
      expect(getNodeSize(node('c', 'unknown', 0, 0))).toEqual({ w: 280, h: 160 })
    })

    it('prefers dimensions over style and type defaults', () => {
      const sized = node('a', 'image', 0, 0, {
        dimensions: { width: 400, height: 300 },
        style: { width: 100, height: 100 },
      })
      expect(getNodeSize(sized)).toEqual({ w: 400, h: 300 })
    })

    it('parses numeric style sizes', () => {
      const styled = node('a', 'text', 0, 0, {
        style: { width: 320, height: 180 },
      })
      expect(getNodeSize(styled)).toEqual({ w: 320, h: 180 })
    })

    it('parses string style sizes', () => {
      const styled = node('a', 'text', 0, 0, {
        style: { width: '360px', height: '200' },
      })
      expect(getNodeSize(styled)).toEqual({ w: 360, h: 200 })
    })
  })

  describe('getAbsolutePosition', () => {
    it('returns position for root nodes', () => {
      const nodes = [node('a', 'image', 100, 50)]
      expect(getAbsolutePosition(nodes[0]!, nodes)).toEqual({ x: 100, y: 50 })
    })

    it('accumulates offsets along a nested parentNode chain', () => {
      // 存量画布仍可能带 parentNode（VueFlow 通用机制），绝对坐标解析不能因 group 下线而失效。
      const nodes = [
        node('p1', 'image', 200, 100),
        node('a', 'image', 40, 30, { parentNode: 'p1' }),
        node('p2', 'image', 10, 20, { parentNode: 'p1' }),
        node('b', 'text', 5, 5, { parentNode: 'p2' }),
      ]
      expect(getAbsolutePosition(nodes[1]!, nodes)).toEqual({ x: 240, y: 130 })
      expect(getAbsolutePosition(nodes[3]!, nodes)).toEqual({ x: 215, y: 125 })
    })

    it('stops when parent chain is broken', () => {
      const orphan = node('a', 'image', 10, 20, { parentNode: 'missing' })
      expect(getAbsolutePosition(orphan, [orphan])).toEqual({ x: 10, y: 20 })
    })
  })

  describe('layoutNodesInGrid', () => {
    it('returns input unchanged when fewer than two layout targets', () => {
      const nodes = [node('a', 'image', 10, 10)]
      expect(layoutNodesInGrid(nodes, ['a'])).toBe(nodes)
      expect(layoutNodesInGrid(nodes, ['a', 'missing'])).toBe(nodes)
    })

    it('arranges root nodes in a sqrt grid anchored at selection bounding-box origin', () => {
      const nodes = [
        node('a', 'image', 200, 100),
        node('b', 'text', 500, 300),
        node('c', 'video', 800, 50),
        node('d', 'prompt', 900, 900),
      ]

      const next = layoutNodesInGrid(nodes, ['a', 'b', 'c', 'd'], 20)
      const byId = Object.fromEntries(next.map((n) => [n.id, n.position]))

      // Anchor = min absolute x/y across selected nodes (c.y=50 is the top edge).
      expect(byId.a).toEqual({ x: 200, y: 50 })
      expect(byId.b).toEqual({ x: 200 + 280 + 20, y: 50 })
      // video 包络 320×320（尺寸随比例 contain，见 mediaNodeDisplaySize）
      expect(byId.c).toEqual({ x: 200, y: 50 + 320 + 20 })
      expect(byId.d).toEqual({ x: 200 + 280 + 20, y: 50 + 120 + 20 })
    })

    it('updates relative positions for nodes nested under a parent', () => {
      const base = [
        node('parent', 'image', 100, 50),
        node('a', 'image', 40, 30, { parentNode: 'parent' }),
        node('b', 'text', 360, 30, { parentNode: 'parent' }),
      ]

      const next = layoutNodesInGrid(base, ['a', 'b'], 10)
      const parentAbs = getAbsolutePosition(next.find((n) => n.id === 'parent')!, next)

      for (const id of ['a', 'b']) {
        const child = next.find((n) => n.id === id)!
        const abs = getAbsolutePosition(child, next)
        expect(child.parentNode).toBe('parent')
        expect(child.position.x).toBe(abs.x - parentAbs.x)
        expect(child.position.y).toBe(abs.y - parentAbs.y)
      }
    })
  })

  describe('moveNodes', () => {
    it('moves root nodes to absolute coordinates', () => {
      const nodes = [node('a', 'image', 0, 0), node('b', 'text', 200, 200)]
      const { nodes: next, movedIds } = moveNodes(nodes, [
        { nodeId: 'a', x: 500, y: 600 },
      ])
      expect(movedIds).toEqual(['a'])
      expect(next.find((n) => n.id === 'a')?.position).toEqual({ x: 500, y: 600 })
      expect(next.find((n) => n.id === 'b')?.position).toEqual({ x: 200, y: 200 })
    })

    it('converts absolute coordinates to parent-relative positions', () => {
      const nodes = [
        node('parent', 'image', 100, 100),
        node('a', 'image', 40, 30, { parentNode: 'parent' }),
      ]
      const { nodes: next } = moveNodes(nodes, [{ nodeId: 'a', x: 300, y: 300 }])
      const child = next.find((n) => n.id === 'a')!
      expect(getAbsolutePosition(child, next)).toEqual({ x: 300, y: 300 })
    })
  })

  describe('layoutNodesAlongEdges', () => {
    it('returns input unchanged when fewer than two layout targets', () => {
      const nodes = [node('a', 'image', 10, 10)]
      expect(layoutNodesAlongEdges(nodes, [], ['a'])).toBe(nodes)
    })

    it('aligns an unconnected pair on one horizontal row (same y)', () => {
      const nodes = [node('a', 'image', 400, 300), node('b', 'image', 100, 80)]
      const next = layoutNodesAlongEdges(nodes, [], ['a', 'b'], 40)
      const byId = Object.fromEntries(next.map((n) => [n.id, n.position]))
      expect(byId.b.y).toBe(byId.a.y)
      expect(byId.b.x).toBeLessThan(byId.a.x)
      expect(byId.a.x - byId.b.x).toBe(280 + 40)
    })

    it('places a chain left-to-right with shared y', () => {
      const nodes = [
        node('a', 'image', 0, 200),
        node('b', 'image', 50, 10),
        node('c', 'image', 80, 400),
      ]
      const next = layoutNodesAlongEdges(
        nodes,
        [
          { source: 'a', target: 'b' },
          { source: 'b', target: 'c' },
        ],
        ['a', 'b', 'c'],
        40,
      )
      const byId = Object.fromEntries(next.map((n) => [n.id, n.position]))
      expect(byId.a.y).toBe(byId.b.y)
      expect(byId.b.y).toBe(byId.c.y)
      expect(byId.b.x - byId.a.x).toBe(280 + 40)
      expect(byId.c.x - byId.b.x).toBe(280 + 40)
    })

    it('stacks siblings in the same rank vertically', () => {
      const nodes = [
        node('a', 'image', 0, 0),
        node('b', 'image', 400, 0),
        node('c', 'image', 400, 400),
      ]
      const next = layoutNodesAlongEdges(
        nodes,
        [
          { source: 'a', target: 'b' },
          { source: 'a', target: 'c' },
        ],
        ['a', 'b', 'c'],
        40,
      )
      const byId = Object.fromEntries(next.map((n) => [n.id, n.position]))
      expect(byId.b.x).toBe(byId.c.x)
      expect(byId.b.x).toBe(byId.a.x + 280 + 40)
      expect(Math.abs(byId.c.y - byId.b.y)).toBe(280 + 40)
    })
  })

  describe('applyLayoutOps', () => {
    it('chains grid and move (group/ungroup ops retired 2026-10-19)', () => {
      const base = [node('a', 'image', 0, 0), node('b', 'text', 400, 0), node('c', 'video', 0, 400)]
      const { nodes, results } = applyLayoutOps(base, [
        { op: 'arrange_grid', nodeIds: ['c'], gap: 20 },
        { op: 'move', items: [{ nodeId: 'c', x: 800, y: 800 }] },
      ])
      expect(results.map((r) => r.op)).toEqual(['arrange_grid', 'move'])
      expect(nodes.find((n) => n.id === 'c')?.position).toEqual({ x: 800, y: 800 })
    })

    it('group/ungroup ops round-trip through the sidecar (2026-10-20)', () => {
      const base = [node('a', 'image', 0, 0), node('b', 'text', 400, 0)]
      const grouped = applyLayoutOps(base, [{ op: 'group', nodeIds: ['a', 'b'], title: 'Pair' }])
      expect(grouped.results[0]?.op).toBe('group')
      expect(grouped.groups).toHaveLength(1)
      const groupId = grouped.groups[0]!.id
      expect(grouped.groups[0]!.childIds).toEqual(['a', 'b'])
      // 分组不再是节点：nodes 里不应凭空多出一个 group 节点
      expect(grouped.nodes).toHaveLength(2)

      const ungrouped = applyLayoutOps(grouped.nodes, [{ op: 'ungroup', groupId }], [], grouped.groups)
      expect(ungrouped.groups).toEqual([])
      expect(ungrouped.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    })

    it('rejects a group op on fewer than 2 ungrouped nodes', () => {
      const base = [node('a', 'image', 0, 0), node('b', 'text', 400, 0)]
      expect(() => applyLayoutOps(base, [{ op: 'group', nodeIds: ['a'] }])).toThrow(/at least 2/)
      expect(() => applyLayoutOps(base, [{ op: 'ungroup', groupId: 'g-missing' }])).toThrow(/group not found/)
    })

    it('arrange_along_edges uses provided edges', () => {
      const base = [node('a', 'image', 0, 200), node('b', 'image', 50, 10)]
      const { nodes, results } = applyLayoutOps(
        base,
        [{ op: 'arrange_along_edges', nodeIds: ['a', 'b'] }],
        [{ source: 'a', target: 'b' }],
      )
      expect(results[0]?.op).toBe('arrange_along_edges')
      const byId = Object.fromEntries(nodes.map((n) => [n.id, n.position]))
      expect(byId.a.y).toBe(byId.b.y)
      expect(byId.b.x - byId.a.x).toBe(280 + 40)
    })
  })
})
