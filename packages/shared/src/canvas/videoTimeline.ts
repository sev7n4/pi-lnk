export type TimelineResolution = '720p' | '1080p' | '2k' | '4k'

export const TIMELINE_RESOLUTIONS: Record<TimelineResolution, { width: number; height: number }> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '2k': { width: 2560, height: 1440 },
  '4k': { width: 3840, height: 2160 },
}

export interface TimelineTrack {
  nodeId: string
  type: 'video' | 'image' | 'audio'
  title: string
  url: string
  durationSec: number
  startSec: number
  sourceInSec?: number
  sourceOutSec?: number
  volume?: number
  muted?: boolean
  audioTrackIndex?: 0 | 1
  durationEstimated?: boolean
}

export interface TimelineExport {
  fileName: string
  resolution: TimelineResolution
  format: 'mp4' | 'mov'
  volume: number
  muted: boolean
  keepFullAudioTail: boolean
}

export interface VideoTimeline {
  version: 1
  clipCount: number
  trackOrder: string[]
  tracks: TimelineTrack[]
  export: TimelineExport
}

export type TimelineOp =
  | { op: 'add_visual'; node_id: string; at?: number; source_in_sec?: number; source_out_sec?: number; duration_sec?: number }
  | { op: 'add_audio'; node_id: string; audio_track_index: 0 | 1; start_sec: number; source_in_sec?: number; source_out_sec?: number; volume?: number; muted?: boolean }
  | { op: 'move_visual'; from: number; to: number }
  | { op: 'trim'; node_id: string; source_in_sec: number; source_out_sec: number; duration_sec?: number }
  | { op: 'set_volume'; node_id: string; volume: number; muted?: boolean }
  | { op: 'remove'; node_id: string }
  | { op: 'set_export'; file_name?: string; resolution?: TimelineResolution; format?: 'mp4' | 'mov'; volume?: number; muted?: boolean; keep_full_audio_tail?: boolean }
  | { op: 'request_render' }

/**
 * 单个片段的实际渲染时长（单一真相源）。
 * video 有裁剪区间时 = sourceOut-sourceIn，与编译器 clip.duration 同源（避免 Editly 自动变速）；
 * image / 未裁剪 video = durationSec。
 * ⚠️ 时长展示、音频裁切点、编译输出必须都走这里，否则 trim 显式传 duration_sec（变速）时
 *    visualDurationSec 与编译器口径分叉，音频尾段会被裁到错误位置。
 */
export function clipDurationSec(track: TimelineTrack): number {
  if (track.type === 'image') return track.durationSec
  if (track.sourceInSec !== undefined || track.sourceOutSec !== undefined) {
    return Math.max(0, (track.sourceOutSec ?? track.durationSec) - (track.sourceInSec ?? 0))
  }
  return track.durationSec
}

export function visualDurationSec(t: VideoTimeline): number {
  const order = new Map(t.trackOrder.map((id, i) => [id, i]))
  return t.tracks
    .filter((x) => x.type === 'video' || x.type === 'image')
    .sort((a, b) => (order.get(a.nodeId) ?? 0) - (order.get(b.nodeId) ?? 0))
    .reduce((sum, x) => sum + clipDurationSec(x), 0)
}

export function validateTimeline(t: VideoTimeline): string[] {
  const errors: string[] = []
  if (t.version !== 1) errors.push('unsupported_version')
  if (!t.tracks.some((x) => x.type === 'video' || x.type === 'image')) errors.push('empty_visual_track')
  for (const track of t.tracks) {
    if (!track.nodeId || !track.url) errors.push(`missing_source:${track.nodeId || 'unknown'}`)
    if (track.type === 'audio') {
      if (track.audioTrackIndex !== 0 && track.audioTrackIndex !== 1) errors.push(`invalid_audio_index:${track.nodeId}`)
      if (track.startSec < 0) errors.push(`invalid_start:${track.nodeId}`)
    }
    if (track.sourceInSec !== undefined || track.sourceOutSec !== undefined) {
      const i = track.sourceInSec ?? 0
      const o = track.sourceOutSec ?? track.durationSec
      if (i < 0 || o <= i) errors.push(`invalid_trim:${track.nodeId}`)
    }
    if ((track.volume ?? 1) < 0 || (track.volume ?? 1) > 2) errors.push(`invalid_volume:${track.nodeId}`)
  }
  for (const idx of [0, 1] as const) {
    const items = t.tracks
      .filter((x) => x.type === 'audio' && x.audioTrackIndex === idx)
      .sort((a, b) => a.startSec - b.startSec)
    for (let i = 1; i < items.length; i += 1) {
      const prev = items[i - 1]!
      const cur = items[i]!
      if (cur.startSec < prev.startSec + prev.durationSec) errors.push(`overlap:${cur.nodeId}`)
    }
  }
  return errors
}

export function sanitizeTimelineFileName(raw: string, format: 'mp4' | 'mov'): string {
  const cleaned = raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().replace(/^[._]+/, '').slice(0, 120)
  const base = cleaned || 'video_timeline'
  return base.toLowerCase().endsWith(`.${format}`) ? base : `${base}.${format}`
}

export interface EditlySpec {
  outPath: string
  width: number
  height: number
  fps: number
  /** 禁用 editly 默认 0.5s 转场：否则每个 clip 被吃掉 0.5s，成片时长 ≠ 视觉总长（spike 实证 3 clips: 7s→6s）。 */
  defaults: { transition: null }
  clips: Array<{ duration: number; layers: Array<Record<string, unknown>> }>
  audioTracks: Array<{ path: string; start: number; cutFrom: number; cutTo: number; mixVolume: number }>
  keepSourceAudio: boolean
  clipsAudioVolume: number
  outputVolume: number
}

export function compileTimelineToEditly(
  timeline: VideoTimeline,
  localPaths: Record<string, string>,
  outDir = '/tmp/out',
): EditlySpec {
  const errors = validateTimeline(timeline)
  if (errors.length) throw new Error(`invalid timeline: ${errors.join(',')}`)
  const order = new Map(timeline.trackOrder.map((id, i) => [id, i]))
  const visual = timeline.tracks
    .filter((x) => x.type === 'video' || x.type === 'image')
    .sort((a, b) => (order.get(a.nodeId) ?? 0) - (order.get(b.nodeId) ?? 0))
  const visualLen = visualDurationSec(timeline)
  const dims = TIMELINE_RESOLUTIONS[timeline.export.resolution]
  const fileName = sanitizeTimelineFileName(timeline.export.fileName, timeline.export.format)
  const clips: EditlySpec['clips'] = visual.map((track) => {
    const path = localPaths[track.nodeId]
    if (!path) throw new Error(`missing_local_source:${track.nodeId}`)
    if (track.type === 'image') {
      return { duration: clipDurationSec(track), layers: [{ type: 'image', path }] }
    }
    const sourceIn = track.sourceInSec ?? 0
    const sourceOut = track.sourceOutSec ?? track.durationSec
    return {
      duration: clipDurationSec(track),
      layers: [{
        type: 'video', path, cutFrom: sourceIn, cutTo: sourceOut,
        mixVolume: track.muted ? 0 : (track.volume ?? 1),
      }],
    }
  })
  const volume = timeline.export.muted ? 0 : timeline.export.volume
  const audioTracks = timeline.tracks
    .filter((x) => x.type === 'audio')
    .map((x) => {
      const head = x.sourceInSec ?? 0
      const allowed = timeline.export.keepFullAudioTail
        ? x.durationSec
        : Math.max(0, Math.min(x.durationSec, visualLen - x.startSec))
      return {
        path: localPaths[x.nodeId] ?? '',
        start: x.startSec,
        cutFrom: head,
        cutTo: head + allowed,
        mixVolume: volume * (x.muted ? 0 : (x.volume ?? 1)),
      }
    })
    .filter((x) => x.path && x.cutTo > x.cutFrom)
  return {
    outPath: `${outDir}/${fileName}`,
    width: dims.width,
    height: dims.height,
    fps: 25,
    defaults: { transition: null },
    clips,
    audioTracks,
    keepSourceAudio: clips.some((c) => c.layers.some((l) => l.type === 'video' && Number(l.mixVolume ?? 0) > 0)),
    clipsAudioVolume: volume,
    outputVolume: volume,
  }
}
