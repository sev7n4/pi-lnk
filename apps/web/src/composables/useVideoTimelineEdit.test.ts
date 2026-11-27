import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoTimeline } from '@lnkpi/shared'
import { submitTimelineOps } from './useVideoTimelineEdit'

const postMock = vi.hoisted(() => vi.fn())
const getMock = vi.hoisted(() => vi.fn())
vi.mock('@/services/api', () => ({ api: { post: postMock, get: getMock } }))

const timeline: VideoTimeline = {
  version: 1,
  clipCount: 1,
  trackOrder: ['v1'],
  tracks: [{ nodeId: 'v1', type: 'video', title: 'v', url: 'u', durationSec: 2, startSec: 0 }],
  export: { fileName: 'x.mp4', resolution: '720p', format: 'mp4', volume: 1, muted: false, keepFullAudioTail: false },
}

function canvasEnvelope(nodes: Array<{ id: string; data: Record<string, unknown> }>) {
  return { data: { canvasData: JSON.stringify({ nodes, edges: [] }) } }
}

describe('submitTimelineOps（P1.2 前端写回以服务端回读为准）', () => {
  beforeEach(() => {
    postMock.mockReset()
    getMock.mockReset()
  })

  it('提交后 GET 服务端回读 timeline，不信任本地预览', async () => {
    postMock.mockResolvedValueOnce({ data: { ok: true, data: { visualDurationSec: 2 } } })
    // 服务端回读的 timeline 与本地可能不同——以回读为准；且目标节点不在首位，验证按 nodeId 精确匹配
    const serverTimeline = { ...timeline, clipCount: 2 }
    getMock.mockResolvedValueOnce({
      data: canvasEnvelope([
        { id: 'unrelated_node', data: { timeline: { ...timeline, clipCount: 99 } } },
        { id: 'vt_1', data: { timeline: serverTimeline } },
      ]),
    })

    const res = await submitTimelineOps({ sessionId: 's1', nodeId: 'vt_1', ops: [{ op: 'remove', node_id: 'x' }] })
    expect(res.ok).toBe(true)
    expect(res.timeline?.clipCount).toBe(2) // 取自服务端回读
    expect(res.visualDurationSec).toBe(2)
    expect(postMock).toHaveBeenCalledWith('/video-timeline/edit', expect.objectContaining({
      sessionId: 's1', nodeId: 'vt_1', ops: [{ op: 'remove', node_id: 'x' }],
    }))
  })

  it('GET 带 no-store 语义（Cache-Control/Pragma），避免缓存旧画布', async () => {
    postMock.mockResolvedValueOnce({ data: { ok: true, data: {} } })
    getMock.mockResolvedValueOnce({ data: canvasEnvelope([{ id: 'vt_1', data: { timeline } }]) })
    await submitTimelineOps({ sessionId: 's1', nodeId: 'vt_1', ops: [] })
    const cfg = getMock.mock.calls[0]![1] as { headers: Record<string, string> }
    expect(cfg.headers['Cache-Control']).toBe('no-cache')
    expect(cfg.headers.Pragma).toBe('no-cache')
  })

  it('edit 被拒（越权/非法 op）时不发 GET 回读，返回错误', async () => {
    postMock.mockResolvedValueOnce({ data: { ok: false, error: '无权访问该画布' } })
    const res = await submitTimelineOps({ sessionId: 's1', nodeId: 'vt_1', ops: [] })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('无权访问该画布')
    expect(getMock).not.toHaveBeenCalled()
  })

  it('回读找不到目标 timeline 时失败（不静默接受）', async () => {
    postMock.mockResolvedValueOnce({ data: { ok: true, data: {} } })
    getMock.mockResolvedValueOnce({ data: canvasEnvelope([{ id: 'other', data: {} }]) })
    const res = await submitTimelineOps({ sessionId: 's1', nodeId: 'vt_1', ops: [] })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('timeline_not_found_after_write')
  })

  it('非法输入直接拒绝，不发请求', async () => {
    expect((await submitTimelineOps({ sessionId: '', nodeId: 'vt_1', ops: [] })).ok).toBe(false)
    expect((await submitTimelineOps({ sessionId: 's1', nodeId: 'vt_1', ops: 'bad' as never })).ok).toBe(false)
    expect(postMock).not.toHaveBeenCalled()
  })
})
