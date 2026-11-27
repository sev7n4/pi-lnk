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
  | { op: 'split'; node_id: string; at_sec: number }
  | { op: 'set_volume'; node_id: string; volume: number; muted?: boolean }
  | { op: 'remove'; node_id: string }
  | { op: 'set_export'; file_name?: string; resolution?: TimelineResolution; format?: 'mp4' | 'mov'; volume?: number; muted?: boolean; keep_full_audio_tail?: boolean }
  | { op: 'request_render' }

/** applyTimelineOps 的上下文：仅注入校验所需的外部事实，reducer 本身保持纯函数。 */
export interface ApplyTimelineOpsContext {
  /**
   * 当前 session 内可作为素材源的画布节点（服务端从 canvas.nodes 注入，浮层从画布快照注入）。
   * add_visual/add_audio 必须据此校验 node_id 存在、类型合法、url 真实——禁止裸 URL 注入。
   */
  sources?: Array<{ nodeId: string; type: string; title?: string; url?: string }>
  /** split 生成新片段 id 的工厂（服务端用 randomUUID，浮层用确定性 id 便于预览稳定）。 */
  nextId?: () => string
}

export interface ApplyTimelineOpsResult {
  ok: boolean
  timeline?: VideoTimeline
  error?: string
  opIndex?: number
  /** 本批是否包含 request_render（确认门打点由 service 层消费，reducer 不改 timeline 内容）。 */
  requestsRender?: boolean
}

/**
 * 双通道唯一的 op reducer：服务端 edit() 与浮层预览都调用这一份，杜绝语义分叉。
 * 语义对齐既有 service.edit()：remove/set_volume/set_export/move_visual/trim；
 * 补齐 add_visual/add_audio（P0 假接线）与 split（P1 新增）。
 * 输入 timeline 不被修改（structuredClone）。
 */
export function applyTimelineOps(
  input: VideoTimeline,
  ops: TimelineOp[],
  ctx: ApplyTimelineOpsContext = {},
): ApplyTimelineOpsResult {
  const timeline: VideoTimeline = structuredClone(input)
  let requestsRender = false
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]!
    if (op.op === 'request_render') { requestsRender = true; continue }
    if (op.op === 'remove') {
      timeline.tracks = timeline.tracks.filter((t) => t.nodeId !== op.node_id)
      timeline.trackOrder = timeline.trackOrder.filter((id) => id !== op.node_id)
      continue
    }
    if (op.op === 'set_volume') {
      const track = timeline.tracks.find((x) => x.nodeId === op.node_id)
      if (!track) return { ok: false, error: `unknown_track:${op.node_id}`, opIndex: i }
      track.volume = op.volume
      if (op.muted !== undefined) track.muted = op.muted
      continue
    }
    if (op.op === 'set_export') {
      // 首期 allowlist：MOV/2K/4K 未经 spike 取证，禁止写入草稿（与 P0 service 一致）。
      const resolution = op.resolution ?? timeline.export.resolution
      const format = op.format ?? timeline.export.format
      if (!['720p', '1080p'].includes(resolution)) return { ok: false, error: `unsupported_resolution:${resolution}`, opIndex: i }
      if (format !== 'mp4') return { ok: false, error: `unsupported_format:${format}`, opIndex: i }
      Object.assign(timeline.export, {
        fileName: op.file_name ?? timeline.export.fileName,
        resolution,
        format,
        volume: op.volume ?? timeline.export.volume,
        muted: op.muted ?? timeline.export.muted,
        keepFullAudioTail: op.keep_full_audio_tail ?? timeline.export.keepFullAudioTail,
      })
      continue
    }
    if (op.op === 'move_visual') {
      const [item] = timeline.trackOrder.splice(op.from, 1)
      if (!item) return { ok: false, error: 'invalid_move_index', opIndex: i }
      timeline.trackOrder.splice(op.to, 0, item)
      continue
    }
    if (op.op === 'trim') {
      const track = timeline.tracks.find((x) => x.nodeId === op.node_id)
      if (!track) return { ok: false, error: `unknown_track:${op.node_id}`, opIndex: i }
      track.sourceInSec = op.source_in_sec
      track.sourceOutSec = op.source_out_sec
      if (op.duration_sec !== undefined) track.durationSec = op.duration_sec
      else track.durationSec = op.source_out_sec - op.source_in_sec
      continue
    }
    if (op.op === 'split') {
      const track = timeline.tracks.find((x) => x.nodeId === op.node_id)
      if (!track || (track.type !== 'video' && track.type !== 'image')) {
        return { ok: false, error: 'unsupported_split_audio', opIndex: i }
      }
      const inSec = track.sourceInSec ?? 0
      const outSec = track.sourceOutSec ?? track.durationSec
      if (!(op.at_sec > inSec && op.at_sec < outSec)) {
        return { ok: false, error: 'invalid_split_point', opIndex: i }
      }
      const newId = ctx.nextId?.() ?? `vtseg_${op.node_id}_${op.at_sec}`
      const right: TimelineTrack = {
        ...structuredClone(track),
        nodeId: newId,
        title: `${track.title}·后`,
        sourceInSec: op.at_sec,
        sourceOutSec: outSec,
        durationSec: outSec - op.at_sec,
        durationEstimated: false,
      }
      track.sourceOutSec = op.at_sec
      track.durationSec = op.at_sec - inSec
      track.durationEstimated = false
      const pos = timeline.trackOrder.indexOf(op.node_id)
      timeline.tracks.push(right)
      timeline.trackOrder.splice(pos + 1, 0, newId)
      continue
    }
    if (op.op === 'add_visual') {
      const source = ctx.sources?.find((s) => s.nodeId === op.node_id)
      if (!source) return { ok: false, error: 'unknown_source_node', opIndex: i }
      if (source.type !== 'video' && source.type !== 'image') {
        return { ok: false, error: `unsupported_add_visual:${op.node_id}`, opIndex: i }
      }
      if (timeline.tracks.some((t) => t.nodeId === op.node_id)) {
        return { ok: false, error: `duplicate_node:${op.node_id}`, opIndex: i }
      }
      const inSec = op.source_in_sec ?? 0
      const outSec = op.source_out_sec ?? (op.duration_sec !== undefined ? inSec + op.duration_sec : inSec + 5)
      const track: TimelineTrack = {
        nodeId: op.node_id,
        type: source.type,
        title: String(source.title ?? op.node_id).slice(0, 48),
        url: String(source.url ?? ''),
        durationSec: op.duration_sec ?? outSec - inSec,
        startSec: 0,
        sourceInSec: op.source_in_sec,
        sourceOutSec: op.source_out_sec,
        durationEstimated: op.duration_sec === undefined,
      }
      timeline.tracks.push(track)
      const at = Math.max(0, Math.min(op.at ?? timeline.trackOrder.length, timeline.trackOrder.length))
      timeline.trackOrder.splice(at, 0, op.node_id)
      continue
    }
    if (op.op === 'add_audio') {
      const source = ctx.sources?.find((s) => s.nodeId === op.node_id)
      if (!source) return { ok: false, error: 'unknown_source_node', opIndex: i }
      if (source.type !== 'audio') return { ok: false, error: `unsupported_add_audio:${op.node_id}`, opIndex: i }
      if (timeline.tracks.some((t) => t.nodeId === op.node_id)) {
        return { ok: false, error: `duplicate_node:${op.node_id}`, opIndex: i }
      }
      const head = op.source_in_sec ?? 0
      const tail = op.source_out_sec ?? head + 3
      timeline.tracks.push({
        nodeId: op.node_id,
        type: 'audio',
        title: String(source.title ?? op.node_id).slice(0, 48),
        url: String(source.url ?? ''),
        durationSec: tail - head,
        startSec: op.start_sec,
        sourceInSec: op.source_in_sec,
        sourceOutSec: op.source_out_sec,
        audioTrackIndex: op.audio_track_index,
        volume: op.volume,
        muted: op.muted,
        durationEstimated: true,
      })
    }
  }
  timeline.clipCount = timeline.trackOrder.length
  const errors = validateTimeline(timeline)
  if (errors.length) return { ok: false, error: errors.join(','), opIndex: Math.max(0, ops.length - 1) }
  return { ok: true, timeline, requestsRender }
}

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
