import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { randomUUID } from 'crypto'
import {
  validateTimeline,
  visualDurationSec,
  type TimelineOp,
  type VideoTimeline,
} from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'
import { MediaService } from '../media/media.service'
import { PersistRemoteService } from '../assets/persist-remote.service'
import { transactGovernedCanvasOps } from '../sessions/canvas-op-write'

export interface TimelineResult {
  ok: boolean
  data?: Record<string, unknown>
  error?: string
  opIndex?: number
}

type CanvasLike = {
  nodes: Array<{ id: string; type: string; data: Record<string, unknown> }>
  edges: Array<{ id: string; source: string; target: string }>
}

function parseCanvas(raw: string | null | undefined): CanvasLike {
  try {
    const parsed = JSON.parse(raw ?? '{}') as Partial<CanvasLike>
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    }
  } catch {
    return { nodes: [], edges: [] }
  }
}

@Injectable()
export class VideoTimelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly persist: PersistRemoteService,
  ) {}

  private renderEnabled(): boolean {
    return process.env.VIDEO_TIMELINE_RENDER_ENABLED === 'true'
  }

  private async ownedSession(sessionId: string, userId: string) {
    const session = await this.prisma.session.findFirst({ where: { id: sessionId, userId } })
    if (!session) throw new ForbiddenException('无权访问该画布')
    return session
  }

  async create(input: { sessionId: string; userId: string; title: string; sourceNodeIds: string[] }): Promise<TimelineResult> {
    if (!input.sourceNodeIds.length) return { ok: false, error: 'source_node_ids is required' }
    const session = await this.ownedSession(input.sessionId, input.userId)
    const canvas = parseCanvas(session.canvasData)
    const nodeMap = new Map(canvas.nodes.map((n) => [n.id, n]))
    const tracks: VideoTimeline['tracks'] = []
    for (const nodeId of input.sourceNodeIds) {
      const node = nodeMap.get(nodeId)
      if (!node) return { ok: false, error: `unknown_node:${nodeId}` }
      if (!['video', 'image', 'audio'].includes(node.type)) return { ok: false, error: `unsupported_node_type:${nodeId}` }
      const track: VideoTimeline['tracks'][number] = {
        nodeId,
        type: node.type as 'video' | 'image' | 'audio',
        title: String(node.data.title ?? nodeId).slice(0, 48),
        url: String(node.data.url ?? ''),
        durationSec: node.type === 'audio' ? 3 : 5,
        startSec: 0,
        durationEstimated: true,
      }
      if (node.type === 'audio') track.audioTrackIndex = 0
      tracks.push(track)
    }
    const visual = tracks.filter((x) => x.type === 'video' || x.type === 'image')
    const audio = tracks.filter((x) => x.type === 'audio')
    if (audio.length > 2) return { ok: false, error: 'audio_track_limit:2' }
    audio.forEach((track, i) => { track.audioTrackIndex = (i % 2) as 0 | 1 })

    const timeline: VideoTimeline = {
      version: 1,
      clipCount: visual.length,
      trackOrder: visual.map((x) => x.nodeId),
      tracks,
      export: {
        fileName: input.title || 'video_timeline',
        resolution: '1080p',
        format: 'mp4',
        volume: 1,
        muted: false,
        keepFullAudioTail: false,
      },
    }
    const draftId = `vt_${randomUUID()}`
    const result = await transactGovernedCanvasOps(this.prisma, input.sessionId, () => ({
      ops: [
        {
          type: 'add_node' as const,
          payload: { id: draftId, nodeType: 'video', position: { x: 900, y: 120 }, data: {} },
        },
        ...tracks.map((t) => ({ type: 'add_edge' as const, payload: { source: t.nodeId, target: draftId } })),
        {
          type: 'update_node' as const,
          payload: { id: draftId, data: { title: input.title, status: 'draft', timeline } },
        },
      ],
    }), { onStaged: 'conflict' })
    if (result.outcome !== 'applied') return { ok: false, error: `canvas_write_${result.outcome}` }
    return {
      ok: true,
      data: { nodeId: draftId, trackCount: visual.length, estimatedVisualDurationSec: visualDurationSec(timeline) },
    }
  }

  private async readDraft(sessionId: string, userId: string, nodeId: string): Promise<{
    ok: boolean
    timeline?: VideoTimeline
    epoch?: number
    error?: string
  }> {
    const session = await this.ownedSession(sessionId, userId)
    const node = parseCanvas(session.canvasData).nodes.find((n) => n.id === nodeId)
    if (!node || node.type !== 'video' || !node.data.timeline) return { ok: false, error: 'timeline_draft_not_found' }
    return {
      ok: true,
      timeline: node.data.timeline as VideoTimeline,
      epoch: Number(node.data.proposalEpoch ?? 0),
    }
  }

  async edit(input: { sessionId: string; userId: string; nodeId: string; ops: TimelineOp[]; save?: boolean }): Promise<TimelineResult> {
    const read = await this.readDraft(input.sessionId, input.userId, input.nodeId)
    if (!read.ok) return read
    const timeline = structuredClone(read.timeline!)
    for (let i = 0; i < input.ops.length; i += 1) {
      const op = input.ops[i]!
      if (op.op === 'request_render') continue
      if (op.op === 'remove') {
        timeline.tracks = timeline.tracks.filter((t) => t.nodeId !== op.node_id)
        timeline.trackOrder = timeline.trackOrder.filter((id) => id !== op.node_id)
      }
      if (op.op === 'set_volume') {
        const track = timeline.tracks.find((x) => x.nodeId === op.node_id)
        if (!track) return { ok: false, error: `unknown_track:${op.node_id}`, opIndex: i }
        track.volume = op.volume
        if (op.muted !== undefined) track.muted = op.muted
      }
      if (op.op === 'set_export') {
        // 首期 allowlist（计划 Global Constraints）：MOV/2K/4K 未经 spike 取证，禁止写入草稿。
        // 资源约束：4K 在 CVM 扩容前由 worker 直接拒绝；这里更早失败，避免生成不可渲染的草稿。
        const resolution = op.resolution ?? timeline.export.resolution
        const format = op.format ?? timeline.export.format
        if (!['720p', '1080p'].includes(resolution)) {
          return { ok: false, error: `unsupported_resolution:${resolution}`, opIndex: i }
        }
        if (format !== 'mp4') {
          return { ok: false, error: `unsupported_format:${format}`, opIndex: i }
        }
        Object.assign(timeline.export, {
          fileName: op.file_name ?? timeline.export.fileName,
          resolution,
          format,
          volume: op.volume ?? timeline.export.volume,
          muted: op.muted ?? timeline.export.muted,
          keepFullAudioTail: op.keep_full_audio_tail ?? timeline.export.keepFullAudioTail,
        })
      }
      if (op.op === 'move_visual') {
        const [item] = timeline.trackOrder.splice(op.from, 1)
        if (!item) return { ok: false, error: 'invalid_move_index', opIndex: i }
        timeline.trackOrder.splice(op.to, 0, item)
      }
      if (op.op === 'trim') {
        const track = timeline.tracks.find((x) => x.nodeId === op.node_id)
        if (!track) return { ok: false, error: `unknown_track:${op.node_id}`, opIndex: i }
        track.sourceInSec = op.source_in_sec
        track.sourceOutSec = op.source_out_sec
        if (op.duration_sec !== undefined) track.durationSec = op.duration_sec
        else track.durationSec = op.source_out_sec - op.source_in_sec
      }
    }
    timeline.clipCount = timeline.trackOrder.length
    const errors = validateTimeline(timeline)
    if (errors.length) return { ok: false, error: errors.join(','), opIndex: Math.max(0, input.ops.length - 1) }
    const patch: Record<string, unknown> = { timeline }
    if (input.ops.some((op) => op.op === 'request_render')) {
      Object.assign(patch, {
        status: 'pending_confirm',
        proposalKind: 'video_timeline_render',
        proposalEpoch: (read.epoch ?? 0) + 1,
      })
    }
    const result = await transactGovernedCanvasOps(this.prisma, input.sessionId, () => ({
      ops: [{ type: 'update_node', payload: { id: input.nodeId, data: patch } }],
    }), { onStaged: 'conflict' })
    if (result.outcome !== 'applied') return { ok: false, error: `canvas_write_${result.outcome}` }
    return {
      ok: true,
      data: {
        nodeId: input.nodeId,
        visualDurationSec: visualDurationSec(timeline),
        appliedOpCount: input.ops.length,
      },
    }
  }

  async render(input: { sessionId: string; userId: string; nodeId: string }): Promise<TimelineResult> {
    if (!this.renderEnabled()) {
      throw new ServiceUnavailableException('VIDEO_TIMELINE_RENDER_ENABLED=false，渲染能力未启用')
    }
    const session = await this.ownedSession(input.sessionId, input.userId)
    const node = parseCanvas(session.canvasData).nodes.find((n) => n.id === input.nodeId)
    if (!node || node.data.status !== 'pending_confirm' || node.data.proposalKind !== 'video_timeline_render') {
      throw new BadRequestException('渲染需要先获得用户确认')
    }
    const timeline = node.data.timeline as VideoTimeline
    const errors = validateTimeline(timeline)
    if (errors.length) throw new BadRequestException(errors.join(','))
    const record = await this.prisma.generationRecord.create({
      data: {
        userId: input.userId,
        type: 'video_timeline_render',
        prompt: String(node.data.title ?? 'video timeline'),
        model: 'editly@0.14.2',
        status: 'queued',
        sessionId: input.sessionId,
        nodeId: input.nodeId,
        metadata: JSON.stringify({ timeline, createdAt: new Date().toISOString() }),
      },
    })
    return {
      ok: true,
      data: { generationRecordId: record.id, draftNodeId: input.nodeId, status: 'queued' },
    }
  }
}
