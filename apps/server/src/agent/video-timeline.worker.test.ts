import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VideoTimelineWorkerService, type WorkerPorts } from './video-timeline.worker'
import type { VideoTimeline } from '@lnkpi/shared'

const TIMELINE: VideoTimeline = {
  version: 1,
  clipCount: 2,
  trackOrder: ['v1', 'i1'],
  tracks: [
    { nodeId: 'v1', type: 'video', title: '镜头1', url: '/api/uploads/u1/a.mp4', durationSec: 2, startSec: 0 },
    { nodeId: 'i1', type: 'image', title: '定格', url: '/api/uploads/u1/b.png', durationSec: 1, startSec: 0 },
    { nodeId: 'a1', type: 'audio', title: 'bgm', url: '/api/uploads/u1/bgm.mp3', durationSec: 8, startSec: 0, audioTrackIndex: 0 },
  ],
  export: { fileName: '雨夜回家', resolution: '1080p', format: 'mp4', volume: 1, muted: false, keepFullAudioTail: false },
}

function basePorts(): WorkerPorts & {
  render: ReturnType<typeof vi.fn>
  probe: ReturnType<typeof vi.fn>
  downloads: string[]
  copies: string[]
} {
  const downloads: string[] = []
  const copies: string[] = []
  const render = vi.fn(async () => {})
  const probe = vi.fn(async () => 3)
  return {
    renderEditly: render,
    probeDurationSec: probe,
    render,
    probe,
    openDownload: async (_source: unknown, dest: string) => {
      downloads.push(dest)
      return { bytesWritten: 10, filename: dest }
    },
    copyOutput: async (_outPath: string, dest: string) => {
      copies.push(dest)
    },
    downloads,
    copies,
  }
}

function fakeDeps(timeline: VideoTimeline | null, opts: { queuedCount?: number } = {}) {
  const job = {
    id: 'job1',
    userId: 'u1',
    sessionId: 's1',
    nodeId: 'vt_draft',
    status: 'queued',
    metadata: timeline ? JSON.stringify({ timeline, createdAt: new Date().toISOString() }) : '{}',
  }
  const recordState = { status: job.status, url: null as string | null, metadata: job.metadata }
  const state = {
    nodes: [
      { id: 'vt_draft', type: 'video', data: { status: 'pending_confirm', proposalKind: 'video_timeline_render', timeline } },
      { id: 'v1', type: 'video', data: { url: '/api/uploads/u1/a.mp4' } },
    ] as Array<{ id: string; type: string; data: Record<string, unknown> }>,
    edges: [] as Array<{ id: string; source: string; target: string }>,
  }
  const session = { canvasData: JSON.stringify(state), stagedActions: null }
  const tx = {
    session: {
      findUnique: async () => session,
      update: async ({ data }: { data: { canvasData: string } }) => {
        const parsed = JSON.parse(data.canvasData) as typeof state
        state.nodes = parsed.nodes
        state.edges = parsed.edges
        session.canvasData = data.canvasData
      },
    },
  }
  let claimCount = 0
  const claimResponses = Array.from({ length: opts.queuedCount ?? 1 }, () => ({ count: 1 }))
  const prisma = {
    generationRecord: {
      findFirst: async ({ where }: { where: { status?: string } }) => {
        if (where.status === 'generating') return { ...job, status: 'generating', metadata: recordState.metadata }
        return recordState.status === 'generating' ? { ...job, status: 'generating', metadata: recordState.metadata } : job
      },
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; status: string }; data: { status: string; url?: string; metadata?: string } }) => {
        if (where.status !== recordState.status) return { count: 0 }
        if (opts.queuedCount !== undefined && data.status === 'generating') {
          const r = claimResponses[claimCount++] ?? { count: 0 }
          if (r.count === 0) return { count: 0 }
        }
        recordState.status = data.status
        if (data.url !== undefined) recordState.url = data.url
        if (data.metadata !== undefined) recordState.metadata = data.metadata
        return { count: 1 }
      }),
    },
    session: { findFirst: async () => session },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  }
  const media = {
    resolveDownloadSource: vi.fn(async (_userId: string, url: string) => ({ kind: 'disk', absPath: `/src/${url.slice(-8)}`, filename: url.slice(-8) })),
  }
  const persist = { persistRemote: vi.fn(async () => ({ persistedUrl: '/api/uploads/u1/vt_out.mp4', assetId: 'asset1', storageTier: 'persisted' })) }
  return { svc: new VideoTimelineWorkerService(prisma as never, media as never, persist as never), prisma, media, persist, state, recordState }
}

describe('VideoTimelineWorkerService.processQueuedJob', () => {
  it('queued→generating→completed：下载源、渲染、落库、建独立成片节点与连线、草稿标记完成', async () => {
    const ports = basePorts()
    const { svc, state, recordState, media, persist } = fakeDeps(TIMELINE)
    const tmpRoot = mkdtempSync(join(tmpdir(), 'vt-worker-'))
    const res = await svc.processQueuedJob({ ...ports, tmpRoot })
    expect(res.processed).toBe(true)
    expect(res.status).toBe('completed')
    // 音频超长被裁到画面长度：画面 = 2 + 1 = 3s
    expect(ports.render).toHaveBeenCalledTimes(1)
    const spec = ports.render.mock.calls[0]![0] as { outPath: string; clips: unknown[]; audioTracks: Array<{ cutTo: number; cutFrom: number }> }
    expect(spec.clips).toHaveLength(2)
    expect(spec.audioTracks[0]!.cutTo).toBeLessThanOrEqual(3.0001)
    expect(ports.probe).toHaveBeenCalledTimes(1)
    // 落库走 upload-ref，不回写草稿节点 url
    const persistArg = persist.persistRemote.mock.calls[0]![0] as Record<string, unknown>
    expect(persistArg.kind).toBe('video')
    expect(persistArg.replaceNodeUrl).toBeUndefined()
    const final = state.nodes.find((n) => String(n.id).startsWith('vf_'))
    expect(final?.data.url).toBe('/api/uploads/u1/vt_out.mp4')
    expect(final?.data.sourceTimelineNodeId).toBe('vt_draft')
    expect(state.edges.some((e) => e.source === 'vt_draft' && e.target === final?.id)).toBe(true)
    expect((state.nodes.find((n) => n.id === 'vt_draft')?.data.status)).toBe('completed')
    expect(recordState.status).toBe('completed')
    expect(recordState.url).toBe('/api/uploads/u1/vt_out.mp4')
    expect(media.resolveDownloadSource).toHaveBeenCalledWith('u1', '/api/uploads/u1/a.mp4', undefined, 's1')
    expect(ports.downloads).toHaveLength(3)
  })

  it('keepFullAudioTail=true 跳过时长上限校验', async () => {
    const ports = basePorts()
    const t = structuredClone(TIMELINE)
    t.export = { ...t.export, keepFullAudioTail: true }
    const { svc } = fakeDeps(t)
    const res = await svc.processQueuedJob({ ...ports, probe: vi.fn(async () => 99) })
    expect(res.status).toBe('completed')
  })

  it('4k 任务直接失败，不启动渲染', async () => {
    const ports = basePorts()
    const t = structuredClone(TIMELINE)
    t.export = { ...t.export, resolution: '4k' }
    const { svc, recordState, state } = fakeDeps(t)
    const res = await svc.processQueuedJob(ports)
    expect(res.status).toBe('failed')
    expect(ports.render).not.toHaveBeenCalled()
    expect(recordState.status).toBe('failed')
    expect(JSON.parse(recordState.metadata ?? '{}').errorMessage).toContain('4k')
    expect((state.nodes.find((n) => n.id === 'vt_draft')?.data.status)).toBe('failed')
  })

  it('渲染产物时长超画面上限时失败且不建成片节点', async () => {
    const ports = basePorts()
    ports.renderEditly = ports.render
    ports.probeDurationSec = vi.fn(async () => 99)
    ports.probe = ports.probeDurationSec
    const { svc, state, recordState } = fakeDeps(TIMELINE)
    const res = await svc.processQueuedJob(ports)
    expect(res.status).toBe('failed')
    expect(recordState.status).toBe('failed')
    expect(JSON.parse(recordState.metadata ?? '{}').errorMessage).toContain('duration_overflow')
    expect(state.nodes.some((n) => String(n.id).startsWith('vf_'))).toBe(false)
  })

  it('渲染抛错时记录失败并回写草稿状态', async () => {
    const ports = basePorts()
    const boom = vi.fn(async () => { throw new Error('editly boom') })
    ports.renderEditly = boom
    ports.render = boom
    const { svc, recordState, state } = fakeDeps(TIMELINE)
    const res = await svc.processQueuedJob(ports)
    expect(res.status).toBe('failed')
    expect(JSON.parse(recordState.metadata ?? '{}').errorMessage).toContain('editly boom')
    expect((state.nodes.find((n) => n.id === 'vt_draft')?.data.status)).toBe('failed')
  })

  it('无 queued 任务时空转；抢占失败（count=0）不渲染', async () => {
    const ports = basePorts()
    const noJobPrisma = {
      generationRecord: { findFirst: async () => null, updateMany: vi.fn() },
      $transaction: async () => {},
    }
    const noneSvc = new VideoTimelineWorkerService(noJobPrisma as never, {} as never, {} as never)
    const none = await noneSvc.processQueuedJob(ports)
    expect(none.processed).toBe(false)

    const racePorts = basePorts()
    const race = fakeDeps(TIMELINE, { queuedCount: 0 })
    const raced = await race.svc.processQueuedJob(racePorts)
    expect(raced.processed).toBe(false)
    expect(racePorts.render).not.toHaveBeenCalled()
  })

  it('产物复制进 uploadsRoot 并以 upload-ref 形态落库', async () => {
    const ports = basePorts()
    const { svc } = fakeDeps(TIMELINE)
    const uploadsRoot = mkdtempSync(join(tmpdir(), 'vt-uploads-'))
    await svc.processQueuedJob({ ...ports, uploadsRoot })
    const dest = ports.copies[0]!
    expect(dest.startsWith(uploadsRoot)).toBe(true)
    expect(dest).toContain('/u1/')
    expect(dest.endsWith('.mp4')).toBe(true)
  })

  it('产出文件落在挂载的 out 目录', async () => {
    const ports = basePorts()
    const tmpRoot = mkdtempSync(join(tmpdir(), 'vt-worker-'))
    const { svc } = fakeDeps(TIMELINE)
    await svc.processQueuedJob({ ...ports, tmpRoot })
    const spec = ports.render.mock.calls[0]![0] as { outPath: string }
    expect(spec.outPath.startsWith(tmpRoot)).toBe(true)
    expect(existsSync(tmpRoot)).toBe(true)
  })
})
