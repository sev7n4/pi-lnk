/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { dedupeNodesById, mergeCanvasNodesFromServer } from './canvasNodeMerge'

describe('mergeCanvasNodesFromServer', () => {
  it('prefers server url over local empty', () => {
    const merged = mergeCanvasNodesFromServer(
      [{ id: 'i1', data: { url: '', status: 'draft' } }],
      [{ id: 'i1', data: { url: 'https://x/a.png', status: 'completed' } }],
    )
    expect(merged[0].data?.url).toBe('https://x/a.png')
    expect(merged[0].data?.status).toBe('completed')
  })

  it('preserves generationStartedAt while server node is generating', () => {
    const merged = mergeCanvasNodesFromServer(
      [{ id: 'v1', data: { status: 'draft' } }],
      [{
        id: 'v1',
        data: {
          status: 'generating',
          generationRecordId: 'rec-1',
          generationStartedAt: '2026-08-14T12:00:00.000Z',
        },
      }],
    )
    expect(merged[0].data?.status).toBe('generating')
    expect(merged[0].data?.generationRecordId).toBe('rec-1')
    expect(merged[0].data?.generationStartedAt).toBe('2026-08-14T12:00:00.000Z')
  })

  it('appends server-only nodes', () => {
    const merged = mergeCanvasNodesFromServer(
      [{ id: 'a', data: {} }],
      [
        { id: 'a', data: {} },
        { id: 'b', data: { title: '新' } },
      ],
    )
    expect(merged.map((n) => n.id)).toEqual(['a', 'b'])
  })
})

// 2026-10-01 生产事故：253 个画布会话中 30 个的 canvasData 里存在同 id 重复节点
// （最早样本 2026-07-25）。服务端数据进入前端时按 id 收敛，重复即自愈。
describe('dedupeNodesById', () => {
  it('按 id 去重，保留首条', () => {
    const out = dedupeNodesById([
      { id: 'n1', data: { title: '首条' } },
      { id: 'n2', data: {} },
      { id: 'n1', data: { title: '重放副本' } },
    ])
    expect(out.map((n) => n.id)).toEqual(['n1', 'n2'])
    expect(out[0].data?.title).toBe('首条')
  })

  it('保留首条的理由：update_node 只命中首条，首条才带最新内容', () => {
    // 与 applyCanvasActions / applyActionsToFlow 的 find-first 语义保持一致
    const out = dedupeNodesById([
      { id: 'n1', data: { prompt: '已被 update 的新提示词', url: 'https://x/a.png' } },
      { id: 'n1', data: { prompt: '原始提示词' } },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].data?.prompt).toBe('已被 update 的新提示词')
    expect(out[0].data?.url).toBe('https://x/a.png')
  })

  it('无重复时保持原顺序与长度（回归）', () => {
    const input = [{ id: 'a', data: {} }, { id: 'b', data: {} }, { id: 'c', data: {} }]
    const out = dedupeNodesById(input)
    expect(out.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(out).toHaveLength(3)
  })

  it('空数组安全', () => {
    expect(dedupeNodesById([])).toEqual([])
  })
})
