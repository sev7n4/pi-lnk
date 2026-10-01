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

  // 2026-10-01 生产事故：253 个画布会话中 30 个存在同 id 重复节点（最早样本 2026-07-25）。
  // 根因 = add_node 无条件 push，同一条 action 被 apply 两次（SSE 重放 / 前端覆盖保存）
  // 就直接产出两条同 id 节点；且 update_node 只命中首条 → 两条内容分化。
  it('add_node 同 id 重复下发 → upsert 不产生重复节点', () => {
    const data: CanvasData = { nodes: [], edges: [] }
    const action = {
      type: 'add_node',
      payload: { id: 'n1', nodeType: 'image', position: { x: 5, y: 6 }, data: { title: 'A' } },
    } as const
    const result = applyCanvasActions(data, [action, action])
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]?.id).toBe('n1')
  })

  it('add_node 命中已存在节点 → 覆盖 position 并合并 data（不新建）', () => {
    const data: CanvasData = {
      nodes: [{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { title: '旧', keep: 1 } }],
      edges: [],
    }
    const result = applyCanvasActions(data, [
      { type: 'add_node', payload: { id: 'n1', nodeType: 'image', position: { x: 9, y: 9 }, data: { title: '新' } } },
    ])
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]?.position).toEqual({ x: 9, y: 9 })
    expect(result.nodes[0]?.data).toEqual({ title: '新', keep: 1 })
  })

  it('add_node 命中已存在节点 → parentShot 边不重复追加', () => {
    const data: CanvasData = {
      nodes: [
        { id: 'shot-1', type: 'shot', position: { x: 0, y: 0 }, data: {} },
        { id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [{ id: 'e-shot-1-n1', source: 'shot-1', target: 'n1' }],
    }
    const result = applyCanvasActions(data, [
      { type: 'add_node', payload: { id: 'n1', nodeType: 'image', parentShotId: 'shot-1' } },
    ])
    expect(result.nodes).toHaveLength(2)
    expect(result.edges).toHaveLength(1)
  })
})
