import { describe, expect, it } from 'vitest'
import type { CanvasAction, CanvasData } from '@lnkpi/shared'
import {
  applyActionsToFlow,
  canvasDataToFlow,
  type FlowEdge,
  type FlowNode,
} from './useCanvasActions'

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

  // 2026-10-01 生产事故：画布 SSOT 在前端，SSE 重放把同一条 add_node 再投一次
  // → 前端 push 出第二条同 id → 下次 saveCanvas 整份覆盖回 DB，重复固化。
  it('add_node 同 id 重复下发 → upsert 不产生重复节点', () => {
    const out = applyActionsToFlow([], [], [
      { type: 'add_node', payload: { id: 'n1', nodeType: 'image', position: { x: 5, y: 6 }, data: { title: 'A' } } } as CanvasAction,
      { type: 'add_node', payload: { id: 'n1', nodeType: 'image', position: { x: 5, y: 6 }, data: { title: 'A' } } } as CanvasAction,
    ])
    expect(out.nodes).toHaveLength(1)
    expect(out.nodes[0].id).toBe('n1')
  })

  it('add_node 命中已存在节点 → 覆盖 position 并合并 data（不新建）', () => {
    const out = applyActionsToFlow([node('n1', { title: '旧', keep: 1 })], [], [
      { type: 'add_node', payload: { id: 'n1', nodeType: 'image', position: { x: 9, y: 9 }, data: { title: '新' } } } as CanvasAction,
    ])
    expect(out.nodes).toHaveLength(1)
    expect(out.nodes[0].position).toEqual({ x: 9, y: 9 })
    expect(out.nodes[0].data).toEqual({ title: '新', keep: 1 })
  })
})

describe('canvasDataToFlow —— 存量重复节点自愈', () => {
  const dupData: CanvasData = {
    nodes: [
      { id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { title: '首条' } },
      { id: 'n2', type: 'image', position: { x: 1, y: 0 }, data: { title: 'B' } },
      { id: 'n1', type: 'image', position: { x: 2, y: 0 }, data: { title: '重放副本' } },
    ],
    edges: [],
  }

  // 保留「首条」与 update_node 的 find-first 语义一致：
  // 重复产生后 update 只落在首条，首条才是内容最新的那条。
  it('加载画布时按 id 去重，保留首条', () => {
    const out = canvasDataToFlow(dupData)
    expect(out.nodes.map((n) => n.id)).toEqual(['n1', 'n2'])
    expect(out.nodes[0].data).toEqual({ title: '首条' })
  })

  it('去重后指向被丢弃副本的边仍然成立（源/目标是保留节点）', () => {
    const out = canvasDataToFlow({
      nodes: dupData.nodes,
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    })
    expect(out.edges).toHaveLength(1)
    expect(out.nodes.filter((n) => n.id === 'n1')).toHaveLength(1)
  })

  it('无重复时行为不变（回归）', () => {
    const out = canvasDataToFlow({
      nodes: [
        { id: 'a', type: 'image', position: { x: 0, y: 0 }, data: {} },
        { id: 'b', type: 'image', position: { x: 1, y: 0 }, data: {} },
      ],
      edges: [],
    })
    expect(out.nodes.map((n) => n.id)).toEqual(['a', 'b'])
  })
})
