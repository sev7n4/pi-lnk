import { Injectable } from '@nestjs/common'
import { execFile } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import {
  compileTimelineToEditly,
  validateTimeline,
  visualDurationSec,
  type EditlySpec,
  type VideoTimeline,
} from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'
import { MediaService, openDownloadStream, type DownloadSource } from '../media/media.service'
import { PersistRemoteService } from '../assets/persist-remote.service'
import { transactGovernedCanvasOps } from '../sessions/canvas-op-write'

const execFileAsync = promisify(execFile)

type EditlyFn = (config: unknown) => Promise<void>

export interface WorkerPorts {
  /** 渲染入口：默认动态加载 editly（镜像内已装 ffmpeg + xvfb）。 */
  renderEditly: (spec: EditlySpec) => Promise<void>
  /** ffprobe 读取成片时长（秒）。 */
  probeDurationSec: (filePath: string) => Promise<number>
  /** 下载单条源素材到本地临时目录。 */
  openDownload: (source: DownloadSource, dest: string) => Promise<{ bytesWritten: number; filename: string }>
  /** 把渲染产物复制进 uploads 根目录。 */
  copyOutput: (outPath: string, dest: string) => Promise<void>
}

export interface WorkerRunOptions extends WorkerPorts {
  tmpRoot?: string
  uploadsRoot?: string
}

export type WorkerRunResult =
  | { processed: false; jobId?: string }
  | { processed: true; status: 'completed' | 'failed'; jobId?: string }

export function defaultWorkerPorts(): WorkerPorts {
  return {
    renderEditly: async (spec: EditlySpec) => {
      const mod = (await import('editly')) as { default?: EditlyFn } & EditlyFn
      const editly: EditlyFn = mod.default ?? mod
      await editly(spec as unknown)
    },
    probeDurationSec: async (filePath: string) => {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath,
      ])
      const n = Number(String(stdout).trim())
      return Number.isFinite(n) ? n : 0
    },
    openDownload: async (source: DownloadSource, dest: string) => {
      const { body } = await openDownloadStream(source)
      await pipeline(body, createWriteStream(dest))
      return { bytesWritten: 0, filename: source.filename }
    },
    copyOutput: async (outPath: string, dest: string) => {
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(outPath, dest)
    },
  }
}

interface RenderJobMeta {
  timeline?: VideoTimeline
  createdAt?: string
  errorMessage?: string
}

function parseMeta(raw: string | null | undefined): RenderJobMeta {
  try {
    const parsed = JSON.parse(raw ?? '{}') as RenderJobMeta
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

@Injectable()
export class VideoTimelineWorkerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly persist: PersistRemoteService,
  ) {}

  async processQueuedJob(opts: WorkerRunOptions = { ...defaultWorkerPorts(), tmpRoot: undefined, uploadsRoot: undefined }): Promise<WorkerRunResult> {
    const job = await this.prisma.generationRecord.findFirst({
      where: { type: 'video_timeline_render', status: 'queued' },
      orderBy: { createdAt: 'asc' },
    })
    if (!job) return { processed: false }
    const claimed = await this.prisma.generationRecord.updateMany({
      where: { id: job.id, status: 'queued' },
      data: { status: 'generating' },
    })
    if (claimed.count === 0) return { processed: false, jobId: job.id }
    if (!job.sessionId || !job.nodeId) {
      await this.failJob(job.id, null, null, 'missing_session_or_node')
      return { processed: true, status: 'failed', jobId: job.id }
    }
    const meta = parseMeta(job.metadata)
    const timeline = meta.timeline
    if (!timeline?.export || validateTimeline(timeline).length) {
      await this.failJob(job.id, job.nodeId, job.sessionId, 'invalid_timeline_snapshot')
      return { processed: true, status: 'failed', jobId: job.id }
    }
    if (timeline.export.resolution === '4k') {
      await this.failJob(job.id, job.nodeId, job.sessionId, 'resolution_4k_requires_dedicated_resources（4K 渲染需扩容后专用资源，当前拒绝）')
      return { processed: true, status: 'failed', jobId: job.id }
    }

    const tmpRoot = opts.tmpRoot ?? tmpdir()
    const uploadsRoot = opts.uploadsRoot ?? (process.env.UPLOADS_ROOT?.trim() || join(process.cwd(), 'uploads'))
    const workDir = join(tmpRoot, `vt_${job.id}`)
    mkdirSync(workDir, { recursive: true })
    try {
      const localPaths: Record<string, string> = {}
      const srcDir = join(workDir, 'src')
      await mkdir(srcDir, { recursive: true })
      for (const track of timeline.tracks) {
        const source = await this.media.resolveDownloadSource(job.userId, track.url, undefined, job.sessionId)
        const dest = join(srcDir, `${track.nodeId}${extFor(source, track.type)}`)
        await opts.openDownload(source, dest)
        localPaths[track.nodeId] = dest
      }
      const outDir = join(workDir, 'out')
      await mkdir(outDir, { recursive: true })
      const spec = compileTimelineToEditly(timeline, localPaths, outDir)
      await opts.renderEditly(spec)
      if (!timeline.export.keepFullAudioTail) {
        const durationSec = await opts.probeDurationSec(spec.outPath)
        const visual = visualDurationSec(timeline)
        if (durationSec > visual + 0.5) {
          throw new Error(`duration_overflow: ${durationSec.toFixed(2)}s > visual ${visual.toFixed(2)}s`)
        }
      }
      const outputFileName = `vt_${randomUUID()}.${timeline.export.format}`
      const dest = join(uploadsRoot, job.userId, outputFileName)
      await opts.copyOutput(spec.outPath, dest)
      const publicRef = `/api/uploads/${job.userId}/${outputFileName}`
      const persisted = await this.persist.persistRemote({
        userId: job.userId,
        url: publicRef,
        kind: 'video',
        label: timeline.export.fileName,
        sessionId: job.sessionId,
        sourceNodeId: job.nodeId,
        generationRecordId: job.id,
      })
      const finalNodeId = `vf_${randomUUID()}`
      const canvasResult = await transactGovernedCanvasOps(this.prisma, job.sessionId, (canvas) => {
        const draft = canvas.nodes.find((n) => n.id === job.nodeId)
        if (!draft) return null
        return {
          ops: [
            { type: 'add_node' as const, payload: { id: finalNodeId, nodeType: 'video', position: { x: (draft.position?.x ?? 900) + 60, y: (draft.position?.y ?? 120) + 80 }, data: {} } },
            { type: 'add_edge' as const, payload: { source: draft.id, target: finalNodeId } },
            { type: 'update_node' as const, payload: { id: draft.id, data: { status: 'completed' } } },
            {
              type: 'update_node' as const,
              payload: {
                id: finalNodeId,
                data: {
                  url: persisted.persistedUrl,
                  title: timeline.export.fileName,
                  status: 'completed',
                  generationRecordId: job.id,
                  sourceTimelineNodeId: draft.id,
                },
              },
            },
          ],
        }
      }, { onStaged: 'skip' })
      if (canvasResult.outcome !== 'applied') {
        throw new Error(`canvas_write_${canvasResult.outcome}`)
      }
      await this.completeJob(job.id, persisted.persistedUrl)
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
      return { processed: true, status: 'completed', jobId: job.id }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.failJob(job.id, job.nodeId, job.sessionId, message)
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
      return { processed: true, status: 'failed', jobId: job.id }
    }
  }

  /** 吸收态守卫：只在 generating 态写终态；被取消/结算过的任务退让。 */
  private async completeJob(jobId: string, url: string): Promise<void> {
    const existing = await this.prisma.generationRecord.findFirst({ where: { id: jobId } })
    if (!existing || existing.status !== 'generating') return
    const meta = parseMeta(existing.metadata)
    if (meta.errorMessage?.includes('cancelled')) return
    await this.prisma.generationRecord.updateMany({
      where: { id: jobId, status: 'generating' },
      data: {
        status: 'completed',
        url,
        metadata: JSON.stringify({ ...meta, completedAt: new Date().toISOString() }),
      },
    })
  }

  private async failJob(jobId: string, nodeId: string | null, sessionId: string | null, message: string): Promise<void> {
    const existing = await this.prisma.generationRecord.findFirst({ where: { id: jobId } })
    if (!existing || existing.status !== 'generating') return
    const meta = parseMeta(existing.metadata)
    await this.prisma.generationRecord.updateMany({
      where: { id: jobId, status: 'generating' },
      data: {
        status: 'failed',
        metadata: JSON.stringify({ ...meta, errorMessage: message.slice(0, 500), failedAt: new Date().toISOString() }),
      },
    })
    if (nodeId && sessionId) {
      await transactGovernedCanvasOps(this.prisma, sessionId, (canvas) => {
        const draft = canvas.nodes.find((n) => n.id === nodeId)
        if (!draft) return null
        return {
          ops: [{ type: 'update_node' as const, payload: { id: nodeId, data: { status: 'failed', errorMessage: message.slice(0, 200) } } }],
        }
      }, { onStaged: 'skip' })
    }
  }
}

function extFor(source: DownloadSource, type: VideoTimeline['tracks'][number]['type']): string {
  const raw = (source.filename ?? '').toLowerCase()
  const match = /\.[a-z0-9]{2,5}$/.exec(raw)
  if (match) return match[0]
  return type === 'image' ? '.png' : type === 'audio' ? '.mp3' : '.mp4'
}
