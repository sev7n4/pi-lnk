import { describe, expect, it } from 'vitest'
import type { CanvasAction, CanvasData } from '@lnkpi/shared'
import { applyCanvasActions as applyCanvasActionsSSOT } from '@lnkpi/shared'
import {
  applyActionsToFlow,
  canvasDataToFlow,
  deriveProposeConfirmAnchor,
  extrasForCanvasSave,
  flowToCanvasData,
  mergeNodeData,
  shouldStartPolling,
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

describe('状态降级守卫（2026-10-01：阻塞 propose 的 stale update_node 不得回退在途状态）', () => {
  it('update_node 把 generating 节点改成 pending_confirm → 状态被丢弃（其他字段照常合并）', () => {
    const out = applyActionsToFlow(
      [node('img-1', { status: 'generating', prompt: '旧提示词' })],
      [],
      [
        {
          type: 'update_node',
          payload: { id: 'img-1', data: { status: 'pending_confirm', prompt: '新提示词' } },
        } as unknown as CanvasAction,
      ],
    )
    expect(out.nodes[0]?.data.status).toBe('generating')
    expect(out.nodes[0]?.data.prompt).toBe('新提示词')
  })

  it('add_node 同 id upsert 携带 stale pending_confirm → 同样不回退', () => {
    const out = applyActionsToFlow(
      [node('img-1', { status: 'completed', url: 'a.png' })],
      [],
      [
        {
          type: 'add_node',
          payload: { id: 'img-1', nodeType: 'image', data: { status: 'pending_confirm' } },
        } as unknown as CanvasAction,
      ],
    )
    expect(out.nodes[0]?.data.status).toBe('completed')
    expect(out.nodes[0]?.data.url).toBe('a.png')
  })

  it('正向流转不受影响：draft→pending_confirm、pending_confirm→generating 照常合并', () => {
    const out = applyActionsToFlow(
      [node('a', { status: 'draft' }), node('b', { status: 'pending_confirm' })],
      [],
      [
        {
          type: 'update_node',
          payload: { id: 'a', data: { status: 'pending_confirm' } },
        } as unknown as CanvasAction,
        {
          type: 'update_node',
          payload: { id: 'b', data: { status: 'generating' } },
        } as unknown as CanvasAction,
      ],
    )
    expect(out.nodes[0]?.data.status).toBe('pending_confirm')
    expect(out.nodes[1]?.data.status).toBe('generating')
  })
})

// SP-A（2026-10-21）：批量创建的混合 actions 必须一次应用齐全——
// create_nodes_batch 的一批 add_node + add_edge 走同一 SSE flush，
// 前端批量应用面不得只落节点丢边（否则画布出现孤立节点）。
describe('SP-A：混合批量 actions 一次应用齐全（create_nodes_batch 回归锁）', () => {
  it('一批 add_node×2 + add_edge×1 一次应用，节点与边同时到位', () => {
    const out = applyActionsToFlow([], [], [
      { type: 'add_node', payload: { id: 'image-1', nodeType: 'image', position: { x: 80, y: 80 }, data: { status: 'draft' } } } as unknown as CanvasAction,
      { type: 'add_node', payload: { id: 'image-2', nodeType: 'image', position: { x: 400, y: 80 }, data: { status: 'draft' } } } as unknown as CanvasAction,
      { type: 'add_edge', payload: { id: 'e-1-2', source: 'image-1', target: 'image-2' } } as unknown as CanvasAction,
    ])
    expect(out.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['image-1', 'image-2']))
    expect(out.edges.map((e) => e.id)).toContain('e-1-2')
    expect(out.edges[0]!.source).toBe('image-1')
    expect(out.edges[0]!.target).toBe('image-2')
  })

  it('重复 id 的 add_node 幂等（重放不产生第二个节点），边不重复追加', () => {
    const first = applyActionsToFlow([], [], [
      { type: 'add_node', payload: { id: 'image-1', nodeType: 'image', position: { x: 80, y: 80 }, data: { status: 'draft' } } } as unknown as CanvasAction,
      { type: 'add_edge', payload: { id: 'e-1-1', source: 'image-1', target: 'image-1' } } as unknown as CanvasAction,
    ])
    const replay = applyActionsToFlow(first.nodes, first.edges, [
      { type: 'add_node', payload: { id: 'image-1', nodeType: 'image', position: { x: 999, y: 999 }, data: { status: 'draft' } } } as unknown as CanvasAction,
    ])
    expect(replay.nodes.filter((n) => n.id === 'image-1')).toHaveLength(1)
  })
})

// SP-C（2026-10-23）：视口入序列化，但必须是「可选键」——
// 不传时 payload 里**连键都不能有**（否则存量画布形状变了，且等于凭空产生一次 migration）。
describe('SP-C：canvasData 序列化透传可选 viewport（N1/N2）', () => {
  it('传 viewport ⇒ 产出含该键且逐值全等', () => {
    const data = flowToCanvasData([node('a')], [], { viewport: { x: -120, y: 33, zoom: 1.25 } })
    expect(data.viewport).toEqual({ x: -120, y: 33, zoom: 1.25 })
  })

  it('不传 ⇒ 产出**不含** viewport 键（不是 viewport: undefined）', () => {
    const data = flowToCanvasData([node('a')], [])
    expect('viewport' in data).toBe(false)
    expect(data.viewport).toBeUndefined()
  })

  it('extrasForCanvasSave 透传 viewport；不传则 extras 也不含该键', () => {
    const withVp = extrasForCanvasSave({ viewport: { x: 1, y: 2, zoom: 0.5 } })
    expect(withVp.viewport).toEqual({ x: 1, y: 2, zoom: 0.5 })
    const without = extrasForCanvasSave({ groups: [] })
    expect('viewport' in without).toBe(false)
  })
})

// ── P0-2 / P0-1（规格 2026-10-30-propose-confirm-execution-unity §8）──────────
describe('deriveProposeConfirmAnchor：等待可见性锚点唯一判定', () => {
  it('part 锚优先：等待NodeId 存在即 part（即便 status 还是 draft——2026-10-29 事故窗口期）', () => {
    expect(deriveProposeConfirmAnchor('n1', 'draft')).toBe('part')
    expect(deriveProposeConfirmAnchor('n1', undefined)).toBe('part')
  })
  it('无 part 时退化 status 锚：pending_confirm → status', () => {
    expect(deriveProposeConfirmAnchor(null, 'pending_confirm')).toBe('status')
    expect(deriveProposeConfirmAnchor(undefined, 'pending_confirm')).toBe('status')
  })
  it('两者皆无 → none（不渲染确认面）', () => {
    expect(deriveProposeConfirmAnchor(null, 'draft')).toBe('none')
    expect(deriveProposeConfirmAnchor(null, 'generating')).toBe('none')
    expect(deriveProposeConfirmAnchor('', 'pending_confirm')).toBe('status')
  })
})

describe('shouldStartPolling：服务端启动生成的轮询挂载去重判据', () => {
  const base = { status: 'generating', generationRecordId: 'rec-1' }
  it('generating + recordId + 不在轮询中 → true', () => {
    expect(shouldStartPolling(base, null)).toBe(true)
    expect(shouldStartPolling(base, 'rec-old')).toBe(true)
  })
  it('已在轮询同一 record / 非 generating / 缺 recordId → false', () => {
    expect(shouldStartPolling(base, 'rec-1')).toBe(false)
    expect(shouldStartPolling({ ...base, status: 'completed' }, null)).toBe(false)
    expect(shouldStartPolling({ status: 'generating' }, null)).toBe(false)
    expect(shouldStartPolling(null, null)).toBe(false)
  })
})

describe('mergeNodeData 吸收态守卫（规格 2026-11-04-generation-terminal-projection §5.2）', () => {
  it('终态节点被无新 recordId 的 generating 写回 ⇒ 整体丢弃 incoming', () => {
    const existing = { status: 'error', generationRecordId: 'rec-1', errorMessage: 'x' }
    expect(mergeNodeData(existing, { status: 'generating', title: '重放' })).toEqual(existing)
  })

  it('终态节点 + 携带新 recordId 的 generating ⇒ 放行（新一轮生成合法重置）', () => {
    const merged = mergeNodeData(
      { status: 'error', generationRecordId: 'rec-1' },
      { status: 'generating', generationRecordId: 'rec-2' },
    )
    expect(merged.status).toBe('generating')
    expect(merged.generationRecordId).toBe('rec-2')
  })

  it('非终态节点照常合并（pending_confirm 旧守卫不受影响）', () => {
    const merged = mergeNodeData({ status: 'draft' }, { status: 'pending_confirm' })
    expect(merged.status).toBe('pending_confirm')
  })

  it('update_node 走 applyActionsToFlow 时守卫生效', () => {
    const nodes = [node('n1', { status: 'error', generationRecordId: 'rec-1' })]
    const out = applyActionsToFlow(nodes, [], [
      { type: 'update_node', payload: { id: 'n1', data: { status: 'generating' } } } as CanvasAction,
    ])
    expect(out.nodes[0].data.status).toBe('error')
  })
})

// ── Phase 5 双端一致锁（spec §8：收敛为单一 applier，配变异测试锁双端一致）──────────
// 同一组「共同 action」（不含侧车 set_groups / set_composition_run_group，web 实时通道不处理）
// 经 web `applyActionsToFlow`（Flow ⇄ CanvasData 投影）与共享 SSOT（CanvasData 直跑）应产出
// 同一份 CanvasData。任一端行为漂移都会让 toEqual 失败——这是双端同源的回归契约。
function flowToData(ns: FlowNode[], es: FlowEdge[]): CanvasData {
  return {
    nodes: ns.map((n) => ({ id: n.id, type: (n.type ?? 'text') as CanvasData['nodes'][0]['type'], position: n.position, data: n.data })),
    edges: es.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  }
}
function resultToData(r: { nodes: FlowNode[]; edges: FlowEdge[]; viewport?: { x: number; y: number; zoom: number } }): CanvasData {
  const out: CanvasData = {
    nodes: r.nodes.map((n) => ({ id: n.id, type: (n.type ?? 'text') as CanvasData['nodes'][0]['type'], position: n.position, data: n.data })),
    edges: r.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  }
  if (r.viewport) out.viewport = r.viewport
  return out
}

describe('Phase 5 双端一致锁：applyActionsToFlow ≡ 共享 SSOT（共同 action 集）', () => {
  const scenarios: { name: string; nodes: FlowNode[]; edges: FlowEdge[]; actions: CanvasAction[] }[] = [
    { name: 'add_node', nodes: [], edges: [], actions: [{ type: 'add_node', payload: { id: 'n1', nodeType: 'image', position: { x: 5, y: 6 }, data: { title: 'A' } } }] },
    { name: 'update_node', nodes: [node('n1', { title: '旧', keep: 1 })], edges: [], actions: [{ type: 'update_node', payload: { id: 'n1', data: { title: '新' } } }] },
    { name: 'remove_node', nodes: [node('a'), node('b')], edges: [edge('e1', 'a', 'b')], actions: [{ type: 'remove_node', payload: { id: 'a' } }] },
    { name: 'add_edge 无 id', nodes: [node('a'), node('b')], edges: [], actions: [{ type: 'add_edge', payload: { source: 'a', target: 'b' } }] },
    { name: 'add_edge 有 id', nodes: [node('a'), node('b')], edges: [], actions: [{ type: 'add_edge', payload: { id: 'x', source: 'a', target: 'b' } }] },
    { name: 'remove_edge', nodes: [node('a'), node('b')], edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')], actions: [{ type: 'remove_edge', payload: { id: 'e1' } }] },
    { name: 'set_viewport', nodes: [], edges: [], actions: [{ type: 'set_viewport', payload: { viewport: { x: 10, y: 20, zoom: 1.5 } } }] },
    { name: '混合批量', nodes: [], edges: [], actions: [
      { type: 'add_node', payload: { id: 'image-1', nodeType: 'image', position: { x: 80, y: 80 }, data: { status: 'draft' } } },
      { type: 'add_node', payload: { id: 'image-2', nodeType: 'image', position: { x: 400, y: 80 }, data: { status: 'draft' } } },
      { type: 'add_edge', payload: { id: 'e-1-2', source: 'image-1', target: 'image-2' } },
    ] },
    { name: 'add_node 父偏移', nodes: [node('p')], edges: [], actions: [{ type: 'add_node', payload: { id: 'c', nodeType: 'image', parentShotId: 'p' } }] },
    { name: 'guard 终态→generating', nodes: [node('n1', { status: 'error', generationRecordId: 'rec-1' })], edges: [], actions: [{ type: 'update_node', payload: { id: 'n1', data: { status: 'generating' } } }] },
    { name: 'guard stale pending_confirm', nodes: [node('img-1', { status: 'generating', prompt: '旧' })], edges: [], actions: [{ type: 'update_node', payload: { id: 'img-1', data: { status: 'pending_confirm', prompt: '新' } } }] },
    { name: 'add_node 同 id 幂等', nodes: [], edges: [], actions: [
      { type: 'add_node', payload: { id: 'n1', nodeType: 'image', position: { x: 5, y: 6 }, data: { title: 'A' } } },
      { type: 'add_node', payload: { id: 'n1', nodeType: 'image', position: { x: 5, y: 6 }, data: { title: 'A' } } },
    ] },
  ]

  for (const s of scenarios) {
    it(`一致：${s.name}`, () => {
      const flowOut = applyActionsToFlow([...s.nodes], [...s.edges], s.actions)
      const dataOut = applyCanvasActionsSSOT(flowToData(s.nodes, s.edges), s.actions)
      expect(resultToData(flowOut)).toEqual(dataOut)
    })
  }
})
