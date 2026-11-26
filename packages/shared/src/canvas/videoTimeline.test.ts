import { describe, expect, it } from 'vitest'
import {
  compileTimelineToEditly,
  sanitizeTimelineFileName,
  validateTimeline,
  visualDurationSec,
  type VideoTimeline,
} from './videoTimeline'

const base = (): VideoTimeline => ({
  version: 1,
  clipCount: 2,
  trackOrder: ['v1', 'i1'],
  tracks: [
    { nodeId: 'v1', type: 'video', title: '镜头1', url: '/api/uploads/u1/a.mp4', durationSec: 2, startSec: 0, sourceInSec: 1, sourceOutSec: 3 },
    { nodeId: 'i1', type: 'image', title: '图1', url: '/api/uploads/u1/b.png', durationSec: 3, startSec: 0 },
    { nodeId: 'a1', type: 'audio', title: '配乐', url: '/api/uploads/u1/c.wav', durationSec: 8, startSec: 1, audioTrackIndex: 0, volume: 0.5 },
  ],
  export: { fileName: '成片', resolution: '1080p', format: 'mp4', volume: 1, muted: false, keepFullAudioTail: false },
})

describe('validateTimeline', () => {
  it('同轨重叠报错并带 nodeId', () => {
    const t = base()
    t.tracks.push({ ...t.tracks[2]!, nodeId: 'a2', startSec: 2 })
    const errors = validateTimeline(t)
    expect(errors.some((e) => e.includes('a2') && e.includes('overlap'))).toBe(true)
  })

  it('视觉轨为空报错', () => {
    const t = base()
    t.tracks = t.tracks.filter((x) => x.type !== 'video' && x.type !== 'image')
    expect(validateTimeline(t)).toContain('empty_visual_track')
  })

  it('非法裁剪区间报错', () => {
    const t = base()
    t.tracks[0]!.sourceOutSec = 0
    expect(validateTimeline(t).some((e) => e.includes('invalid_trim'))).toBe(true)
  })
})

describe('compileTimelineToEditly', () => {
  it('按 trackOrder 生成视觉轨且音频按 startSec 对齐', () => {
    const spec = compileTimelineToEditly(base(), {
      v1: '/tmp/v1.mp4', i1: '/tmp/i1.png', a1: '/tmp/a1.wav',
    })
    expect(spec.clips.map((c) => c.duration)).toEqual([2, 3])
    expect(spec.audioTracks).toEqual([
      { path: '/tmp/a1.wav', start: 1, cutFrom: 0, cutTo: 4, mixVolume: 0.5 },
    ])
    expect(spec).toMatchObject({ width: 1920, height: 1080, keepSourceAudio: true, outPath: '/tmp/out/成片.mp4' })
    // spike 实证：editly 默认 0.5s 转场会吃掉时长（3 clips: 7s→6s），必须显式禁用。
    expect(spec.defaults).toEqual({ transition: null })
  })

  it('整体静音把所有音量置 0', () => {
    const t = base()
    t.export.muted = true
    const spec = compileTimelineToEditly(t, { v1: 'v', i1: 'i', a1: 'a' })
    expect(spec.outputVolume).toBe(0)
    expect(spec.audioTracks?.[0]?.mixVolume).toBe(0)
  })

  it('keepFullAudioTail 保留完整音频尾段', () => {
    const t = base()
    t.export.keepFullAudioTail = true
    const spec = compileTimelineToEditly(t, { v1: 'v', i1: 'i', a1: 'a' })
    expect(spec.audioTracks?.[0]?.cutTo).toBe(8)
  })
})

it('visualDurationSec 只算视觉轨', () => expect(visualDurationSec(base())).toBe(5))
it('文件名清洗', () => expect(sanitizeTimelineFileName('../a:b/成片.mp4', 'mp4')).toBe('a_b_成片.mp4'))
