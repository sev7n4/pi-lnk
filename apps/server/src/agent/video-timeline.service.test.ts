import { describe, expect, it, vi } from 'vitest'
import { VideoTimelineService } from './video-timeline.service'

function fakeDeps(initialNodes: Array<{ id: string; type: string; data: Record<string, unknown> }> = []) {
  const state = { nodes: initialNodes, edges: [] as Array<{ id: string; source: string; target: string }> }
  const session = {
    canvasData: JSON.stringify(state),
    stagedActions: null,
  }
  const tx = {
    session: {
      findUnique: async () => session,
      update: async ({ data }: { data: { canvasData: string } }) => {
        session.canvasData = data.canvasData
        const parsed = JSON.parse(data.canvasData) as typeof state
        state.nodes = parsed.nodes
        state.edges = parsed.edges
      },
    },
  }
  const generationCreate = vi.fn(async () => ({ id: 'gen_1' }))
  const prisma = {
    session: { findFirst: async () => session },
    generationRecord: { create: generationCreate },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  }
  return { service: new VideoTimelineService(prisma as never, {} as never, {} as never), state, generationCreate }
}

describe('VideoTimelineService', () => {
  it('create 从 nodeIds 建草稿，不创建 GenerationRecord', async () => {
    const { service, state, generationCreate } = fakeDeps([
      { id: 'v1', type: 'video', data: { url: '/api/uploads/u1/a.mp4', title: '镜头1' } },
      { id: 'i1', type: 'image', data: { url: '/api/uploads/u1/b.png' } },
    ])
    const res = await service.create({ sessionId: 's1', userId: 'u1', title: '雨夜回家', sourceNodeIds: ['v1', 'i1'] })
    expect(res.ok).toBe(true)
    const draft = state.nodes.find((n) => String(n.id).startsWith('vt_'))
    expect(draft?.type).toBe('video')
    expect((draft?.data.timeline as { trackOrder: string[] }).trackOrder).toEqual(['v1', 'i1'])
    expect(draft?.data.url).toBeUndefined()
    expect(generationCreate).not.toHaveBeenCalled()
  })

  it('edit 同轨重叠时整批拒绝且不写画布', async () => {
    const timeline = {
      version: 1 as const,
      clipCount: 1,
      trackOrder: ['v1'],
      tracks: [
        { nodeId: 'v1', type: 'video' as const, title: 'v', url: 'u', durationSec: 5, startSec: 0 },
        { nodeId: 'a1', type: 'audio' as const, title: 'a1', url: 'u', durationSec: 3, startSec: 0, audioTrackIndex: 0 as const },
        { nodeId: 'a2', type: 'audio' as const, title: 'a2', url: 'u', durationSec: 3, startSec: 2, audioTrackIndex: 0 as const },
      ],
      export: { fileName: 'x.mp4', resolution: '1080p' as const, format: 'mp4' as const, volume: 1, muted: false, keepFullAudioTail: false },
    }
    const before = JSON.stringify(timeline)
    const { service, state } = fakeDeps([
      { id: 'vt_1', type: 'video', data: { status: 'draft', timeline } },
      { id: 'v1', type: 'video', data: { url: 'u' } },
    ])
    const res = await service.edit({ sessionId: 's1', userId: 'u1', nodeId: 'vt_1', ops: [] })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('overlap')
    expect(JSON.stringify((state.nodes[0]!.data.timeline as unknown))).toBe(before)
  })

  it('set_export 拒绝未取证的 MOV/2K/4K（首期 allowlist）', async () => {
    const timeline = {
      version: 1 as const, clipCount: 1, trackOrder: ['v1'],
      tracks: [{ nodeId: 'v1', type: 'video' as const, title: 'v', url: 'u', durationSec: 5, startSec: 0 }],
      export: { fileName: 'x.mp4', resolution: '1080p' as const, format: 'mp4' as const, volume: 1, muted: false, keepFullAudioTail: false },
    }
    for (const op of [
      { op: 'set_export' as const, format: 'mov' as const },
      { op: 'set_export' as const, resolution: '2k' as const },
      { op: 'set_export' as const, resolution: '4k' as const },
    ]) {
      const { service, state } = fakeDeps([{ id: 'vt_1', type: 'video', data: { status: 'draft', timeline } }])
      const res = await service.edit({ sessionId: 's1', userId: 'u1', nodeId: 'vt_1', ops: [op] })
      expect(res.ok).toBe(false)
      expect(res.error).toContain('unsupported_')
      expect(JSON.stringify(state.nodes[0]!.data.timeline)).toBe(JSON.stringify(timeline))
    }
  })

  it('edit add_visual 补齐假接线：从画布 source 节点入轨，缺省 5s 标 estimated', async () => {
    const timeline = {
      version: 1 as const, clipCount: 1, trackOrder: ['v1'],
      tracks: [{ nodeId: 'v1', type: 'video' as const, title: 'v', url: 'u', durationSec: 5, startSec: 0 }],
      export: { fileName: 'x.mp4', resolution: '1080p' as const, format: 'mp4' as const, volume: 1, muted: false, keepFullAudioTail: false },
    }
    const { service, state } = fakeDeps([
      { id: 'vt_1', type: 'video', data: { status: 'draft', timeline } },
      { id: 'v2', type: 'video', data: { title: '镜头2', url: '/api/uploads/u1/v2.mp4' } },
    ])
    const res = await service.edit({ sessionId: 's1', userId: 'u1', nodeId: 'vt_1', ops: [{ op: 'add_visual', node_id: 'v2' }] })
    expect(res.ok).toBe(true)
    const saved = state.nodes[0]!.data.timeline as typeof timeline
    expect(saved.trackOrder).toEqual(['v1', 'v2'])
    expect(saved.tracks.find((t) => t.nodeId === 'v2')?.durationEstimated).toBe(true)
  })

  it('edit split 切分视觉轨：tracks+1、trackOrder 插入、时长守恒', async () => {
    const timeline = {
      version: 1 as const, clipCount: 1, trackOrder: ['v1'],
      tracks: [{ nodeId: 'v1', type: 'video' as const, title: 'v', url: 'u', durationSec: 5, startSec: 0, sourceInSec: 0, sourceOutSec: 5 }],
      export: { fileName: 'x.mp4', resolution: '1080p' as const, format: 'mp4' as const, volume: 1, muted: false, keepFullAudioTail: false },
    }
    const { service, state } = fakeDeps([{ id: 'vt_1', type: 'video', data: { status: 'draft', timeline } }])
    const res = await service.edit({ sessionId: 's1', userId: 'u1', nodeId: 'vt_1', ops: [{ op: 'split', node_id: 'v1', at_sec: 2 }] })
    expect(res.ok).toBe(true)
    const saved = state.nodes[0]!.data.timeline as typeof timeline
    expect(saved.tracks).toHaveLength(2)
    expect(saved.trackOrder).toHaveLength(2)
    expect(saved.tracks.reduce((s, t) => s + (t.sourceOutSec ?? t.durationSec) - (t.sourceInSec ?? 0), 0)).toBeCloseTo(5)
  })

  it('render 无确认事实时拒绝且不建任务', async () => {
    process.env.VIDEO_TIMELINE_RENDER_ENABLED = 'true'
    const timeline = {
      version: 1 as const, clipCount: 1, trackOrder: ['v1'],
      tracks: [{ nodeId: 'v1', type: 'video' as const, title: 'v', url: 'u', durationSec: 5, startSec: 0 }],
      export: { fileName: 'x.mp4', resolution: '1080p' as const, format: 'mp4' as const, volume: 1, muted: false, keepFullAudioTail: false },
    }
    const { service, generationCreate } = fakeDeps([
      { id: 'vt_1', type: 'video', data: { status: 'draft', timeline } },
    ])
    await expect(service.render({ sessionId: 's1', userId: 'u1', nodeId: 'vt_1' })).rejects.toThrow('渲染需要先获得用户确认')
    expect(generationCreate).not.toHaveBeenCalled()
    delete process.env.VIDEO_TIMELINE_RENDER_ENABLED
  })
})
