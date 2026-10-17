/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import type { ExecutionStep } from './executionTraceReducer'
import {
  buildCanvasOutputs,
  parseLinkedOutputsFromToolCalls,
  resolveMessageOutputs,
  shouldCollapseOutputs,
  truncateTitle,
  visibleOutputCount,
} from './agentCanvasOutputs'

describe('buildCanvasOutputs', () => {
  it('dedupes by nodeId preferring latest status', () => {
    const traceSteps: ExecutionStep[] = [
      {
        id: 's1',
        kind: 'node_gen',
        label: '主图',
        status: 'done',
        meta: { nodeId: 'n1' },
      },
    ]
    const out = buildCanvasOutputs({
      traceSteps,
      taskItems: [{ nodeId: 'n1', title: '主图', status: 'running' }],
    })
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe('running')
  })

  it('merges trace and task items for distinct nodeIds', () => {
    const out = buildCanvasOutputs({
      traceSteps: [
        {
          id: 's1',
          kind: 'canvas',
          label: '添加图片节点「主图」',
          status: 'done',
          meta: { nodeId: 'n1' },
        },
      ],
      taskItems: [{ nodeId: 'n2', title: '详情头图', status: 'running' }],
    })
    expect(out).toHaveLength(2)
    expect(out.map((o) => o.nodeId).sort()).toEqual(['n1', 'n2'])
  })

  it('⭐ 产物口径（2026-10-17 用户裁定）：连线/移除/视口等画布过程动作不是产物', () => {
    // add_edge 的 canvas step 带 meta.nodeId（payload.id），旧实现会把它映射成产物卡片
    const out = buildCanvasOutputs({
      traceSteps: [
        {
          id: 's1',
          kind: 'canvas',
          label: '添加视频节点「开场」',
          status: 'done',
          meta: { nodeId: 'n1' },
        },
        { id: 's2', kind: 'canvas', label: '连接画布节点', status: 'done', meta: { nodeId: 'e1' } },
        { id: 's3', kind: 'canvas', label: '移除连线', status: 'done', meta: { nodeId: 'e2' } },
        { id: 's4', kind: 'canvas', label: '调整画布视图', status: 'done' },
        { id: 's5', kind: 'canvas', label: '更新节点「开场」', status: 'done', meta: { nodeId: 'n1' } },
      ],
    })
    expect(out).toHaveLength(1)
    expect(out[0].nodeId).toBe('n1')
    expect(out[0].nodeType).toBe('video')
  })
})

describe('shouldCollapseOutputs', () => {
  it('collapse threshold is 5', () => {
    expect(shouldCollapseOutputs(5)).toBe(false)
    expect(shouldCollapseOutputs(6)).toBe(true)
  })

  it('shows 5 items when collapsed', () => {
    expect(visibleOutputCount(6, false)).toBe(5)
    expect(visibleOutputCount(6, true)).toBe(6)
  })
})

describe('truncateTitle', () => {
  it('truncates long titles to 20 chars', () => {
    const long = '一二三四五六七八九十一二三四五六七八九十一'
    expect(truncateTitle(long)).toBe('一二三四五六七八九十一二三四五六七八九十…')
  })
})

describe('parseLinkedOutputsFromToolCalls', () => {
  it('parses add_node canvas actions', () => {
    const out = parseLinkedOutputsFromToolCalls([
      {
        type: 'add_node',
        payload: {
          id: 'img-1',
          nodeType: 'image',
          data: { title: '主图 Banner' },
          position: { x: 0, y: 0 },
        },
      },
      {
        type: 'add_edge',
        payload: { id: 'e1', source: 'a', target: 'b' },
      },
    ])
    expect(out).toEqual([
      {
        nodeId: 'img-1',
        title: '主图 Banner',
        nodeType: 'image',
        status: 'done',
      },
    ])
  })

  it('parses persisted JSON string toolCalls', () => {
    const raw = JSON.stringify([
      {
        type: 'add_node',
        payload: {
          id: 'prompt-1',
          nodeType: 'prompt',
          data: { prompt: '方案文案' },
          position: { x: 0, y: 0 },
        },
      },
    ])
    const out = parseLinkedOutputsFromToolCalls(raw)
    expect(out[0]?.nodeId).toBe('prompt-1')
    expect(out[0]?.nodeType).toBe('prompt')
    expect(out[0]?.title).toBe('方案文案')
  })
})

describe('resolveMessageOutputs', () => {
  it('prefers linkedOutputs for historical messages', () => {
    const persisted = [
      { nodeId: 'n1', title: '主图', nodeType: 'image', status: 'done' as const },
    ]
    const out = resolveMessageOutputs({
      linkedOutputs: persisted,
      canvasActions: [
        {
          type: 'add_node',
          payload: {
            id: 'n2',
            nodeType: 'image',
            data: { title: 'other' },
            position: { x: 0, y: 0 },
          },
        },
      ],
    })
    expect(out).toEqual(persisted)
  })

  it('falls back to toolCalls when linkedOutputs missing', () => {
    const out = resolveMessageOutputs({
      canvasActions: [
        {
          type: 'add_node',
          payload: {
            id: 'n3',
            nodeType: 'video',
            data: { title: '分镜视频' },
            position: { x: 0, y: 0 },
          },
        },
      ],
    })
    expect(out[0]?.nodeId).toBe('n3')
  })
})
