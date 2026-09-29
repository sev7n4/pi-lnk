import { describe, expect, it } from 'vitest'
import type { CanvasData } from '@lnkpi/shared'
import { applyCanvasActions } from './executor'

describe('applyCanvasActions', () => {
  it('keeps compositionRunGroup across update_node', () => {
    const group = {
      nodeIds: ['n1'],
      dumpHash: 'ab'.repeat(32),
      createdAt: '2026-09-16T00:00:00.000Z',
    }
    const data: CanvasData = {
      nodes: [{ id: 'n1', type: 'prompt', position: { x: 0, y: 0 }, data: { prompt: 'old' } }],
      edges: [],
      viewport: { x: 10, y: 20, zoom: 1 },
      compositionRunGroup: group,
    }
    const result = applyCanvasActions(data, [
      { type: 'update_node', payload: { id: 'n1', data: { prompt: 'new' } } },
    ])
    expect(result.compositionRunGroup).toEqual(group)
    expect(result.viewport).toEqual({ x: 10, y: 20, zoom: 1 })
    expect(result.nodes[0]?.data.prompt).toBe('new')
  })

  // 2026-09-29 补：applier 此前只认 add_node/update_node/add_edge/remove_node，
  // remove_edge / set_viewport 被静默忽略 → Nest 端点返回了 action 但 canvasData 未落库，
  // 回合末全量回拉时被删的边会「复活」。
  it('remove_edge 按 id 删边（服务端持久化）', () => {
    const data: CanvasData = {
      nodes: [],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'c' },
      ],
    }
    const result = applyCanvasActions(data, [{ type: 'remove_edge', payload: { id: 'e1' } }])
    expect(result.edges.map((e) => e.id)).toEqual(['e2'])
  })

  it('remove_edge 未命中 / 缺 id → 幂等 no-op', () => {
    const data: CanvasData = { nodes: [], edges: [{ id: 'e1', source: 'a', target: 'b' }] }
    expect(applyCanvasActions(data, [{ type: 'remove_edge', payload: { id: 'missing' } }]).edges).toHaveLength(1)
    expect(applyCanvasActions(data, [{ type: 'remove_edge', payload: {} }]).edges).toHaveLength(1)
  })

  it('set_viewport 写入 viewport', () => {
    const data: CanvasData = { nodes: [], edges: [] }
    const result = applyCanvasActions(data, [
      { type: 'set_viewport', payload: { viewport: { x: 1, y: 2, zoom: 1.5 } } },
    ])
    expect(result.viewport).toEqual({ x: 1, y: 2, zoom: 1.5 })
  })

  it('remove_node 仍然连带删除其关联边（回归）', () => {
    const data: CanvasData = {
      nodes: [
        { id: 'a', type: 'image', position: { x: 0, y: 0 }, data: {} },
        { id: 'b', type: 'video', position: { x: 1, y: 0 }, data: {} },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
    }
    const result = applyCanvasActions(data, [{ type: 'remove_node', payload: { id: 'a' } }])
    expect(result.nodes.map((n) => n.id)).toEqual(['b'])
    expect(result.edges).toEqual([])
  })
})
