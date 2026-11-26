import type { EditableFlowNode } from '@/composables/useSelectedNodeEditor'
import type { CanvasEdgeLike } from '@/composables/useUpstreamNodeContext'

export type CompositionTrackType = 'video' | 'image' | 'audio'

export interface CompositionTrack {
  nodeId: string
  type: CompositionTrackType
  title: string
  url: string
  label: string
  durationSec: number
  startSec: number
  sourceInSec?: number
  sourceOutSec?: number
  volume?: number
  muted?: boolean
  audioTrackIndex?: 0 | 1
  durationEstimated?: boolean
}

export interface CompositionTrackRecord {
  nodeId: string
  type: CompositionTrackType
  title: string
  url: string
  durationSec?: number
  startSec?: number
  sourceInSec?: number
  sourceOutSec?: number
  volume?: number
  muted?: boolean
  audioTrackIndex?: 0 | 1
  durationEstimated?: boolean
}

const DEFAULT_VIDEO_DURATION_SEC = 5
const DEFAULT_AUDIO_DURATION_SEC = 3

function trackLabel(type: CompositionTrackType) {
  return type === 'video' ? '视频' : type === 'image' ? '图片' : '音频'
}

function readTrackTitle(node: EditableFlowNode) {
  const data = node.data ?? {}
  return String(data.title ?? data.fileName ?? data.prompt ?? data.content ?? node.id).slice(0, 48)
}

function readTrackUrl(node: EditableFlowNode) {
  return String(node.data?.url ?? '').trim()
}

function inferNodeTrackType(node: EditableFlowNode): CompositionTrackType | null {
  const type = String(node.type ?? '')
  if (type === 'video') return 'video'
  if (type === 'image') return 'image'
  if (type === 'audio') return 'audio'
  return null
}

function defaultDuration(type: CompositionTrackType) {
  return type === 'audio' ? DEFAULT_AUDIO_DURATION_SEC : DEFAULT_VIDEO_DURATION_SEC
}

function buildTrack(node: EditableFlowNode, saved?: CompositionTrackRecord): CompositionTrack {
  const trackType = inferNodeTrackType(node)!
  return {
    nodeId: node.id,
    type: trackType,
    title: readTrackTitle(node),
    url: readTrackUrl(node),
    label: trackLabel(trackType),
    durationSec: saved?.durationSec ?? defaultDuration(trackType),
    startSec: saved?.startSec ?? 0,
    sourceInSec: saved?.sourceInSec,
    sourceOutSec: saved?.sourceOutSec,
    volume: saved?.volume,
    muted: saved?.muted,
    audioTrackIndex: saved?.audioTrackIndex,
    durationEstimated: saved?.durationEstimated ?? !saved?.durationSec,
  }
}

/** 按入边顺序收集 video / audio / 媒体输入轨 */
export function resolveCompositionTracks(
  targetNodeId: string,
  nodes: EditableFlowNode[],
  edges: CanvasEdgeLike[],
): CompositionTrack[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const tracks: CompositionTrack[] = []

  for (const edge of edges) {
    if (edge.target !== targetNodeId) continue
    const source = nodeMap.get(edge.source)
    if (!source || !inferNodeTrackType(source)) continue
    tracks.push(buildTrack(source))
  }

  return tracks
}

/** 合并实时轨与已保存 metadata，并按 trackOrder 排序（C-2） */
export function mergeCompositionTracks(
  liveTracks: CompositionTrack[],
  savedTracks: CompositionTrackRecord[] | undefined,
  trackOrder: string[] | undefined,
): CompositionTrack[] {
  const savedMap = new Map((savedTracks ?? []).map((track) => [track.nodeId, track]))
  const merged = liveTracks.map((track) => {
    const saved = savedMap.get(track.nodeId)
    if (!saved) return track
    return {
      ...track,
      durationSec: saved.durationSec ?? track.durationSec,
      startSec: saved.startSec ?? track.startSec,
      sourceInSec: saved.sourceInSec ?? track.sourceInSec,
      sourceOutSec: saved.sourceOutSec ?? track.sourceOutSec,
      volume: saved.volume ?? track.volume,
      muted: saved.muted ?? track.muted,
      audioTrackIndex: saved.audioTrackIndex ?? track.audioTrackIndex,
      durationEstimated: saved.durationEstimated ?? track.durationEstimated,
    }
  })

  return applyTrackOrder(merged, trackOrder)
}

export function applyTrackOrder(tracks: CompositionTrack[], trackOrder?: string[]): CompositionTrack[] {
  if (!trackOrder?.length) return tracks

  const trackMap = new Map(tracks.map((track) => [track.nodeId, track]))
  const ordered: CompositionTrack[] = []

  for (const nodeId of trackOrder) {
    const track = trackMap.get(nodeId)
    if (!track) continue
    ordered.push(track)
    trackMap.delete(nodeId)
  }

  for (const track of trackMap.values()) {
    ordered.push(track)
  }

  return ordered
}

export function reorderTrackIds(trackOrder: string[], fromIndex: number, toIndex: number) {
  const next = [...trackOrder]
  if (fromIndex < 0 || fromIndex >= next.length || toIndex < 0 || toIndex >= next.length) {
    return next
  }
  const [item] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, item)
  return next
}

export function compositionTracksToNodePatch(tracks: CompositionTrack[]) {
  return {
    clipCount: tracks.length,
    trackOrder: tracks.map((track) => track.nodeId),
    tracks: tracks.map((track) => ({
      nodeId: track.nodeId,
      type: track.type,
      title: track.title,
      url: track.url,
      durationSec: track.durationSec,
      startSec: track.startSec,
      sourceInSec: track.sourceInSec,
      sourceOutSec: track.sourceOutSec,
      volume: track.volume,
      muted: track.muted,
      audioTrackIndex: track.audioTrackIndex,
      durationEstimated: track.durationEstimated,
    })),
  }
}

export function computeTimelineLayout(tracks: CompositionTrack[]) {
  let cursor = 0
  return tracks.map((track) => {
    const startSec = track.startSec > 0 ? track.startSec : cursor
    const item = { ...track, startSec, endSec: startSec + track.durationSec }
    cursor = item.endSec
    return item
  })
}

export function totalTimelineDurationSec(tracks: CompositionTrack[]) {
  const layout = computeTimelineLayout(tracks)
  if (!layout.length) return 0
  return Math.max(...layout.map((item) => item.endSec))
}
