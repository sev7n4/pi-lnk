import { describe, expect, it } from 'vitest'
import type { VideoTimeline } from '@lnkpi/shared'
import { createEditSession } from './useVideoTimelineEditSession'

const base = (): VideoTimeline => ({
  version: 1, clipCount: 2, trackOrder: ['v1', 'i1'],
  tracks: [
    { nodeId: 'v1', type: 'video', title: '镜头1', url: '/api/uploads/u1/a.mp4', durationSec: 4, startSec: 0, sourceInSec: 0, sourceOutSec: 4 },
    { nodeId: 'i1', type: 'image', title: '图1', url: '/api/uploads/u1/b.png', durationSec: 3, startSec: 0 },
  ],
  export: { fileName: '成片.mp4', resolution: '720p', format: 'mp4', volume: 1, muted: false, keepFullAudioTail: false },
})

describe('useVideoTimelineEditSession（P1.4 浮层独立历史栈）', () => {
  it('applyOp 后预览=共享 reducer 重放结果（双通道同构）', () => {
    const s = createEditSession(base())
    s.applyOp({ op: 'split', node_id: 'v1', at_sec: 2 })
    expect(s.preview.value.ok).toBe(true)
    expect(s.preview.value.timeline!.tracks).toHaveLength(3)
    expect(s.canUndo.value).toBe(true)
    expect(s.canRedo.value).toBe(false)
  })

  it('undo/redo 只回退游标，不改 base（服务端是唯一真相源）', () => {
    const s = createEditSession(base())
    s.applyOp({ op: 'remove', node_id: 'i1' })
    expect(s.preview.value.timeline!.tracks).toHaveLength(1)
    expect(s.undo()).toBe(true)
    expect(s.preview.value.timeline!.tracks).toHaveLength(2)
    expect(s.canRedo.value).toBe(true)
    expect(s.redo()).toBe(true)
    expect(s.preview.value.timeline!.tracks).toHaveLength(1)
  })

  it('undo 后产生新 op ⇒ 清空 redo 栈（标准编辑器语义）', () => {
    const s = createEditSession(base())
    s.applyOp({ op: 'remove', node_id: 'i1' })
    s.undo()
    expect(s.canRedo.value).toBe(true)
    s.applyOp({ op: 'trim', node_id: 'v1', source_in_sec: 1, source_out_sec: 3 })
    expect(s.canRedo.value).toBe(false)
    expect(s.commitOps()).toEqual([{ op: 'trim', node_id: 'v1', source_in_sec: 1, source_out_sec: 3 }])
  })

  it('commitOps 只提交 cursor 之前的 op（撤销的 op 不写回）', () => {
    const s = createEditSession(base())
    s.applyOp({ op: 'remove', node_id: 'i1' })
    s.applyOp({ op: 'trim', node_id: 'v1', source_in_sec: 1, source_out_sec: 3 })
    s.undo()
    expect(s.commitOps()).toHaveLength(1)
    expect(s.commitOps()[0]!.op).toBe('remove')
  })

  it('split 预览 nextId 确定性：undo/redo 后片段 id 不变', () => {
    const s = createEditSession(base())
    s.applyOp({ op: 'split', node_id: 'v1', at_sec: 2 })
    const id1 = s.preview.value.timeline!.trackOrder[1]
    s.undo(); s.redo()
    expect(s.preview.value.timeline!.trackOrder[1]).toBe(id1)
  })
})
