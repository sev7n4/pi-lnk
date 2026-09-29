import { describe, expect, it } from 'vitest'
import type { CanvasAction } from '@lnkpi/shared'
import { applyActionsToFlow, type FlowEdge, type FlowNode } from './useCanvasActions'

const node = (id: string, data: Record<string, unknown> = {}): FlowNode => ({
  id,
  type: 'image',
  position: { x: 0, y: 0 },
  data,
})
const edge = (id: string, source: string, target: string): FlowEdge => ({ id, source, target })

describe('applyActionsToFlow —— 6 种 action 全路由（spec 图 4）', () => {
  it('add_node 追加节点', () => {
    const out = applyActionsToFlow([], [], [
      { type: 'add_node', payload: { id: 'n1', nodeType: 'image', position: { x: 5, y: 6 }, data: { title: 'A' } } } as CanvasAction,
    ])
    expect(out.nodes).toHaveLength(1)
    expect(out.nodes[0].id).toBe('n1')
  })

  it('update_node 浅合并 data', () => {
    const out = applyActionsToFlow([node('n1', { title: '旧', keep: 1 })], [], [
      { type: 'update_node', payload: { id: 'n1', data: { title: '新' } } } as CanvasAction,
    ])
    expect(out.nodes[0].data).toEqual({ title: '新', keep: 1 })
  })

  it('remove_node 删节点及其关联边', () => {
    const out = applyActionsToFlow([node('a'), node('b')], [edge('e1', 'a', 'b')], [
      { type: 'remove_node', payload: { id: 'a' } } as CanvasAction,
    ])
    expect(out.nodes.map((n) => n.id)).toEqual(['b'])
    expect(out.edges).toEqual([])
  })

  it('add_edge 追加边', () => {
    const out = applyActionsToFlow([node('a'), node('b')], [], [
      { type: 'add_edge', payload: { source: 'a', target: 'b' } } as CanvasAction,
    ])
    expect(out.edges).toHaveLength(1)
    expect(out.edges[0].source).toBe('a')
  })

  it('remove_edge 按 id 删边（本包新增；此前被静默丢弃）', () => {
    const out = applyActionsToFlow([node('a'), node('b')], [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')], [
      { type: 'remove_edge', payload: { id: 'e1' } } as CanvasAction,
    ])
    expect(out.edges.map((e) => e.id)).toEqual(['e2'])
  })

  it('remove_edge 未命中 / 缺 id → no-op 不抛（Review Focus 2 的前端侧）', () => {
    const actions = [
      { type: 'remove_edge', payload: { id: 'missing' } },
      { type: 'remove_edge', payload: {} },
    ] as CanvasAction[]
    const out = applyActionsToFlow([node('a')], [edge('e1', 'a', 'a')], actions)
    expect(out.edges).toHaveLength(1)
  })

  it('set_viewport 透出 viewport（本包新增；此前被静默丢弃）', () => {
    const out = applyActionsToFlow([], [], [
      { type: 'set_viewport', payload: { viewport: { x: 10, y: 20, zoom: 1.5 } } } as CanvasAction,
    ])
    expect(out.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 })
  })

  it('未知 type 静默丢弃且不抛', () => {
    expect(() =>
      applyActionsToFlow([node('a')], [], [{ type: 'nope', payload: {} } as unknown as CanvasAction]),
    ).not.toThrow()
  })
})
