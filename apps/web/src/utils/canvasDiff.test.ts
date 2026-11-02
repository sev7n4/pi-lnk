/**
 * P1-C C1b：canvasDiff 单测（规格 2026-11-02-p1c-write-path-governance-design §3.2/§5）。
 * 判据 C1-1（无变更零 ops）/ C1-2（拖动仅 position 变更一条）/ 白名单外键丢弃。
 */
import { describe, expect, it, vi } from 'vitest'
import { diffCanvasData, CLIENT_FORBIDDEN_NODE_DATA_KEYS } from './canvasDiff'
import type { CanvasData } from '@lnkpi/shared'

function d(nodes: unknown[], edges: unknown[] = []): CanvasData {
  return { nodes, edges } as unknown as CanvasData
}

describe('diffCanvasData', () => {
  it('C1-1：无变更 ⇒ 零 ops（上层零请求）', () => {
    const canvas = d([
      { id: 'n1', type: 'image', position: { x: 1, y: 2 }, data: { title: 't', prompt: 'p' } },
    ])
    const out = diffCanvasData(canvas, structuredClone(canvas))
    expect(out.ops).toEqual([])
    expect(out.droppedKeys).toBe(0)
  })

  it('C1-2：拖动节点 ⇒ 仅 1 条 update_node，payload 只含 id+position', () => {
    const saved = d([{ id: 'n1', type: 'image', position: { x: 1, y: 2 }, data: { title: 't' } }])
    const current = d([{ id: 'n1', type: 'image', position: { x: 9, y: 8 }, data: { title: 't' } }])
    const out = diffCanvasData(saved, current)
    expect(out.ops).toHaveLength(1)
    expect(out.ops[0]).toEqual({ type: 'update_node', payload: { id: 'n1', position: { x: 9, y: 8 } } })
  })

  it('data 变化键级提交：仅变化键进 payload（服务端 merge 未提交键保留）', () => {
    const saved = d([{ id: 'n1', type: 'text', position: { x: 0, y: 0 }, data: { a: 1, b: 'keep', c: 3 } }])
    const current = d([{ id: 'n1', type: 'text', position: { x: 0, y: 0 }, data: { a: 2, b: 'keep', c: 4 } }])
    const out = diffCanvasData(saved, current)
    expect(out.ops).toHaveLength(1)
    expect(out.ops[0]).toEqual({
      type: 'update_node',
      payload: { id: 'n1', data: { a: 2, c: 4 } },
    })
  })

  it('新增/删除节点 ⇒ add_node / remove_node', () => {
    const saved = d([{ id: 'old', type: 'text', position: { x: 0, y: 0 }, data: {} }])
    const current = d([{ id: 'new', type: 'image', position: { x: 5, y: 6 }, data: { prompt: 'p' } }])
    const out = diffCanvasData(saved, current)
    expect(out.ops).toContainEqual({
      type: 'remove_node',
      payload: { id: 'old' },
    })
    expect(out.ops).toContainEqual({
      type: 'add_node',
      payload: { id: 'new', nodeType: 'image', position: { x: 5, y: 6 }, data: { prompt: 'p' } },
    })
  })

  it('白名单外键（status 等）变化被丢弃并计数，白名单内键照常提交', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const saved = d([{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { status: 'draft', title: 'a' } }])
    const current = d([{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { status: 'completed', title: 'b' } }])
    const out = diffCanvasData(saved, current)
    expect(out.droppedKeys).toBe(1)
    expect(out.ops).toHaveLength(1)
    const payload = (out.ops[0] as { payload: { data: Record<string, unknown> } }).payload.data
    expect(payload).toEqual({ title: 'b' })
    for (const key of CLIENT_FORBIDDEN_NODE_DATA_KEYS) expect(key in payload).toBe(false)
    warn.mockRestore()
  })

  it('白名单外键「有→无」同样丢弃，不产生 null 覆盖', () => {
    const saved = d([{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { errorMessage: 'x', title: 'a' } }])
    const current = d([{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { title: 'a' } }])
    const out = diffCanvasData(saved, current)
    expect(out.droppedKeys).toBe(1)
    expect(out.ops).toEqual([])
  })

  it('saved 独有的白名单内键（如 url）⇒ null 覆盖进 ops', () => {
    const saved = d([{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { url: 'http://a', title: 't' } }])
    const current = d([{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { title: 't' } }])
    const out = diffCanvasData(saved, current)
    expect(out.ops).toHaveLength(1)
    expect(out.ops[0]).toEqual({ type: 'update_node', payload: { id: 'n1', data: { url: null } } })
  })

  it('边：新增/删除/端点变更（remove+add）', () => {
    const saved = d(
      [{ id: 'n1', type: 'text', position: { x: 0, y: 0 }, data: {} }],
      [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
      ],
    )
    const current = d(
      [{ id: 'n1', type: 'text', position: { x: 0, y: 0 }, data: {} }],
      [
        { id: 'e1', source: 'n1', target: 'n9' }, // 端点变更
        { id: 'e3', source: 'n3', target: 'n4' }, // 新增
      ],
    )
    const out = diffCanvasData(saved, current)
    expect(out.ops).toContainEqual({ type: 'remove_edge', payload: { id: 'e1' } })
    expect(out.ops).toContainEqual({ type: 'add_edge', payload: { id: 'e1', source: 'n1', target: 'n9' } })
    expect(out.ops).toContainEqual({ type: 'add_edge', payload: { id: 'e3', source: 'n3', target: 'n4' } })
    expect(out.ops).toContainEqual({ type: 'remove_edge', payload: { id: 'e2' } })
  })

  it('lastSaved 为 null（首存）⇒ 全量 add ops', () => {
    const current = d(
      [{ id: 'n1', type: 'text', position: { x: 1, y: 1 }, data: { prompt: 'p' } }],
      [{ id: 'e1', source: 'n1', target: 'n2' }],
    )
    const out = diffCanvasData(null, current)
    expect(out.ops).toContainEqual({
      type: 'add_node',
      payload: { id: 'n1', nodeType: 'text', position: { x: 1, y: 1 }, data: { prompt: 'p' } },
    })
    expect(out.ops).toContainEqual({ type: 'add_edge', payload: { id: 'e1', source: 'n1', target: 'n2' } })
  })

  it('viewport 变化 ⇒ set_viewport op；不变 ⇒ 无 op', () => {
    const base = { nodes: [], edges: [] } as unknown as CanvasData
    const saved = { ...base, viewport: { x: 0, y: 0, zoom: 1 } } as CanvasData
    const moved = { ...base, viewport: { x: 10, y: 5, zoom: 1.2 } } as CanvasData
    expect(diffCanvasData(saved, moved).ops).toEqual([
      { type: 'set_viewport', payload: { viewport: { x: 10, y: 5, zoom: 1.2 } } },
    ])
    expect(diffCanvasData(saved, structuredClone(saved)).ops).toEqual([])
    // current 无 viewport ⇒ 不产生 op（无法表达删除，见文件头边界）
    expect(diffCanvasData(saved, base).ops).toEqual([])
  })

  it('侧车变化 ⇒ set_groups / set_composition_run_group op（C2a 通道；旗标仅观测）', () => {
    const base = { nodes: [], edges: [] } as unknown as CanvasData
    // groups 出现 ⇒ set_groups 全量替换
    const withGroup = {
      ...base,
      groups: [{ id: 'g1', title: 't', childIds: ['n1'], position: { x: 0, y: 0 }, size: { width: 10, height: 10 } }],
    } as unknown as CanvasData
    const out = diffCanvasData(base, withGroup)
    expect(out.sidecarChanged).toBe(true)
    expect(out.ops).toEqual([{ type: 'set_groups', payload: { groups: withGroup.groups } }])
    // groups 清空（有→无）⇒ set_groups 空数组（统一「设置」语义）
    const outClear = diffCanvasData(withGroup, base)
    expect(outClear.ops).toEqual([{ type: 'set_groups', payload: { groups: [] } }])
    // compositionRunGroup 出现 ⇒ set_composition_run_group（对象）
    const withRunGroup = {
      ...base,
      compositionRunGroup: { nodeIds: ['n1'], dumpHash: 'h', createdAt: 't' },
    } as unknown as CanvasData
    const outRun = diffCanvasData(base, withRunGroup)
    expect(outRun.sidecarChanged).toBe(true)
    expect(outRun.ops).toEqual([
      { type: 'set_composition_run_group', payload: { compositionRunGroup: withRunGroup.compositionRunGroup } },
    ])
    // compositionRunGroup 清除（有→无）⇒ null（applier 删键）
    const outRunClear = diffCanvasData(withRunGroup, base)
    expect(outRunClear.ops).toEqual([
      { type: 'set_composition_run_group', payload: { compositionRunGroup: null } },
    ])
    // 无变化 ⇒ 无侧车 op
    expect(diffCanvasData(base, structuredClone(base)).sidecarChanged).toBe(false)
    expect(diffCanvasData(base, structuredClone(base)).ops).toEqual([])
  })

  it('脏形状（null/缺数组）安全空 diff', () => {
    expect(diffCanvasData(null, null).ops).toEqual([])
    expect(diffCanvasData(d([]), null).ops).toEqual([])
    expect(diffCanvasData(null, d([])).ops).toEqual([])
  })
})
