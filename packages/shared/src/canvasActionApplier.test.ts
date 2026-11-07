import { describe, expect, it } from 'vitest'
import type { CanvasAction, CanvasData } from './index'
import { applyCanvasActions, mergeNodeData } from './canvasActionApplier'

const data = (over: Partial<CanvasData> = {}): CanvasData => ({ nodes: [], edges: [], ...over })

const node = (id: string, data: Record<string, unknown> = {}): CanvasData['nodes'][0] => ({
  id,
  type: 'image',
  position: { x: 0, y: 0 },
  data,
})

describe('applyCanvasActions —— Phase 5 SSOT（web / agent 收敛后的唯一实现）', () => {
  it('add_node：父节点存在 ⇒ 子节点置于 父.x+320 / 父.y+20，并补父→子边', () => {
    const d = data({ nodes: [node('p')] })
    const out = applyCanvasActions(d, [
      { type: 'add_node', payload: { id: 'c', nodeType: 'image', parentShotId: 'p' } },
    ])
    const child = out.nodes.find((n) => n.id === 'c')
    expect(child?.position).toEqual({ x: 320, y: 20 })
    expect(out.edges).toContainEqual({ id: 'e-p-c', source: 'p', target: 'c' })
  })

  it('add_node：无父无 position ⇒ 兜底 {200,200}', () => {
    const out = applyCanvasActions(data(), [{ type: 'add_node', payload: { id: 'n1', nodeType: 'image' } }])
    expect(out.nodes[0]?.position).toEqual({ x: 200, y: 200 })
  })

  it('add_node：缺 id ⇒ 跳过（统一要求 id，杜绝非确定性兜底 id 破坏双端一致）', () => {
    const out = applyCanvasActions(data(), [
      { type: 'add_node', payload: { nodeType: 'image', position: { x: 1, y: 1 } } } as CanvasAction,
    ])
    expect(out.nodes).toHaveLength(0)
  })

  it('add_node 同 id 重复下发 ⇒ upsert 不产生重复节点', () => {
    const a: CanvasAction = {
      type: 'add_node',
      payload: { id: 'n1', nodeType: 'image', position: { x: 5, y: 6 }, data: { title: 'A' } },
    }
    const out = applyCanvasActions(data(), [a, a])
    expect(out.nodes).toHaveLength(1)
  })

  it('add_edge：缺 id 时按 source-target 生成（保留 web 行为 + 重放幂等）', () => {
    const d = data({ nodes: [node('a'), node('b')] })
    const out = applyCanvasActions(d, [{ type: 'add_edge', payload: { source: 'a', target: 'b' } }])
    expect(out.edges).toHaveLength(1)
    expect(out.edges[0]).toEqual({ id: 'e-a-b', source: 'a', target: 'b' })
  })

  it('add_edge：source/target 缺失 ⇒ 跳过（保留 agent 空值防御）', () => {
    const out = applyCanvasActions(data(), [
      { type: 'add_edge', payload: { id: 'x', source: 'a' } } as CanvasAction,
    ])
    expect(out.edges).toHaveLength(0)
  })

  it('remove_node 连带删除其关联边', () => {
    const d = data({ nodes: [node('a'), node('b')], edges: [{ id: 'e1', source: 'a', target: 'b' }] })
    const out = applyCanvasActions(d, [{ type: 'remove_node', payload: { id: 'a' } }])
    expect(out.nodes.map((n) => n.id)).toEqual(['b'])
    expect(out.edges).toEqual([])
  })

  it('update_node 终态→generating 无新 recordId ⇒ 整体丢弃（守卫 2）', () => {
    const d = data({ nodes: [node('n1', { status: 'error', generationRecordId: 'rec-1', errorMessage: 'x' })] })
    const out = applyCanvasActions(d, [
      { type: 'update_node', payload: { id: 'n1', data: { status: 'generating', title: '重放' } } },
    ])
    expect(out.nodes[0]?.data.status).toBe('error')
    expect(out.nodes[0]?.data.title).toBeUndefined()
  })

  it('update_node 终态→generating 携带新 recordId ⇒ 放行（新一轮生成合法重置）', () => {
    const d = data({ nodes: [node('n1', { status: 'error', generationRecordId: 'rec-1' })] })
    const out = applyCanvasActions(d, [
      { type: 'update_node', payload: { id: 'n1', data: { status: 'generating', generationRecordId: 'rec-2' } } },
    ])
    expect(out.nodes[0]?.data.status).toBe('generating')
    expect(out.nodes[0]?.data.generationRecordId).toBe('rec-2')
  })

  it('update_node 在途/终态被迟到 pending_confirm 覆盖 ⇒ 仅丢 status（守卫 1）', () => {
    const d = data({ nodes: [node('img-1', { status: 'generating', prompt: '旧' })] })
    const out = applyCanvasActions(d, [
      { type: 'update_node', payload: { id: 'img-1', data: { status: 'pending_confirm', prompt: '新' } } },
    ])
    expect(out.nodes[0]?.data.status).toBe('generating')
    expect(out.nodes[0]?.data.prompt).toBe('新')
  })

  it('set_groups 全量替换；清空不删键；set_composition_run_group null 删键', () => {
    const d = data({
      groups: [{ id: 'g0', title: 'old', childIds: [], position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }],
      compositionRunGroup: { nodeIds: ['a'], dumpHash: 'h0', createdAt: 't0' },
    })
    const g1 = [{ id: 'g1', title: 'new', childIds: ['a'], position: { x: 2, y: 3 }, size: { width: 9, height: 9 } }]
    const r1 = applyCanvasActions(d, [{ type: 'set_groups', payload: { groups: g1 } }])
    expect(r1.groups).toEqual(g1)
    const r2 = applyCanvasActions(r1, [{ type: 'set_groups', payload: { groups: [] } }])
    expect(r2.groups).toEqual([])
    const r3 = applyCanvasActions(r2, [{ type: 'set_composition_run_group', payload: { compositionRunGroup: null } }])
    expect('compositionRunGroup' in r3).toBe(false)
  })

  it('set_composition_run_group 缺载荷 ⇒ 幂等 no-op（不动既有字段）', () => {
    const d = data({ compositionRunGroup: { nodeIds: ['a'], dumpHash: 'h0', createdAt: 't0' } })
    const out = applyCanvasActions(d, [{ type: 'set_composition_run_group', payload: {} }])
    expect(out.compositionRunGroup).toEqual({ nodeIds: ['a'], dumpHash: 'h0', createdAt: 't0' })
  })

  it('onGuardReject 在吸收态拒绝时回调 nodeId', () => {
    const rejected: string[] = []
    const d = data({ nodes: [node('n1', { status: 'error', generationRecordId: 'rec-1' })] })
    applyCanvasActions(
      d,
      [{ type: 'update_node', payload: { id: 'n1', data: { status: 'generating' } } }],
      { onGuardReject: (id) => rejected.push(id) },
    )
    expect(rejected).toEqual(['n1'])
  })

  it('未知 type 静默丢弃且不抛', () => {
    expect(() =>
      applyCanvasActions(data(), [{ type: 'nope', payload: {} } as unknown as CanvasAction]),
    ).not.toThrow()
  })
})

describe('mergeNodeData —— 双守卫吸收态（web / agent 共用同一纯函数）', () => {
  it('终态被无新 recordId 的 generating 写回 ⇒ 整体丢弃 incoming', () => {
    expect(
      mergeNodeData(
        { status: 'error', generationRecordId: 'rec-1', errorMessage: 'x' },
        { status: 'generating', title: '重放' },
      ),
    ).toEqual({ status: 'error', generationRecordId: 'rec-1', errorMessage: 'x' })
  })
  it('终态 + 新 recordId ⇒ 放行', () => {
    const m = mergeNodeData(
      { status: 'error', generationRecordId: 'rec-1' },
      { status: 'generating', generationRecordId: 'rec-2' },
    )
    expect(m.status).toBe('generating')
    expect(m.generationRecordId).toBe('rec-2')
  })
  it('在途/终态被迟到 pending_confirm 覆盖 ⇒ 仅丢 status，其余字段照常合并', () => {
    const m = mergeNodeData({ status: 'generating', prompt: '旧' }, { status: 'pending_confirm', prompt: '新' })
    expect(m.status).toBe('generating')
    expect(m.prompt).toBe('新')
  })
  it('非终态照常合并', () => {
    expect(mergeNodeData({ status: 'draft' }, { status: 'pending_confirm' }).status).toBe('pending_confirm')
  })
})
