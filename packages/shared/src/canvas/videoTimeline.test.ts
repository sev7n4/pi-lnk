import { describe, expect, it } from 'vitest'
import {
  applyTimelineOps,
  clipDurationSec,
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

describe('裁剪时长口径一致性（visualDurationSec ≡ 编译器 clips 总长）', () => {
  it('video 裁剪后按 sourceOut-sourceIn 计，而非 durationSec 原值', () => {
    const t = base() // v1: durationSec=2, sourceIn=1, sourceOut=3 → 实际 2s（恰好相等）
    t.tracks[0]!.durationSec = 99 // 模拟 trim 显式传 duration_sec 变速，durationSec 与裁剪区间脱钩
    expect(clipDurationSec(t.tracks[0]!)).toBe(2)
    expect(visualDurationSec(t)).toBe(5) // 2(v1裁剪) + 3(i1)，不是 99 + 3
  })

  it('visualDurationSec 与编译出的 clips 总长恒等（音频裁切点不会偏移）', () => {
    const t = base()
    t.tracks[0]!.durationSec = 99 // durationSec 故意与裁剪不等
    const spec = compileTimelineToEditly(t, { v1: 'v', i1: 'i', a1: 'a' })
    const clipsTotal = spec.clips.reduce((sum, c) => sum + c.duration, 0)
    expect(visualDurationSec(t)).toBe(clipsTotal)
    // 音频裁切点以画面实际总长为准：start=1，画面 5s → cutTo=4，不受 durationSec=99 污染
    expect(spec.audioTracks[0]!.cutTo).toBe(4)
  })
})
it('文件名清洗', () => expect(sanitizeTimelineFileName('../a:b/成片.mp4', 'mp4')).toBe('a_b_成片.mp4'))

describe('applyTimelineOps（双通道共享 reducer，服务端 edit 与浮层预览同一份）', () => {
  it('split 视觉片段：区间内切成两条、时长守恒、trackOrder 插入、clipCount 同步', () => {
    const t = base()
    const before = visualDurationSec(t)
    const r = applyTimelineOps(t, [{ op: 'split', node_id: 'i1', at_sec: 1.5 }], { nextId: () => 'vtseg_new1' })
    expect(r.ok).toBe(true)
    expect(r.timeline!.tracks).toHaveLength(4) // 原 3 + 1（i1 拆二）
    expect(r.timeline!.trackOrder).toEqual(['v1', 'i1', 'vtseg_new1'])
    expect(r.timeline!.clipCount).toBe(3)
    expect(visualDurationSec(r.timeline!)).toBeCloseTo(before) // 1.5+1.5 = 3
    expect(validateTimeline(r.timeline!)).toEqual([])
  })

  it('split 拒绝不存在节点与区间外分割点', () => {
    const t = base()
    expect(applyTimelineOps(t, [{ op: 'split', node_id: 'nope', at_sec: 2 }]).error).toBe('unsupported_split_audio')
    expect(applyTimelineOps(t, [{ op: 'split', node_id: 'i1', at_sec: 99 }]).error).toBe('invalid_split_point')
    expect(applyTimelineOps(t, [{ op: 'split', node_id: 'i1', at_sec: -1 }]).error).toBe('invalid_split_point')
  })

  it('split 后 visualDurationSec ≡ 编译 clips 总长（时长口径不分叉）', () => {
    const t = base()
    const r = applyTimelineOps(t, [{ op: 'split', node_id: 'v1', at_sec: 2 }], { nextId: () => 'vtseg_x' })
    const spec = compileTimelineToEditly(r.timeline!, { v1: 'v', i1: 'i', a1: 'a', vtseg_x: 'vx' })
    expect(visualDurationSec(r.timeline!)).toBeCloseTo(spec.clips.reduce((s, c) => s + c.duration, 0))
  })

  it('add_visual 补齐假接线：校验 source 存在且类型合法，缺省时长 5s 标 estimated', () => {
    const t = base()
    const sources = [
      { nodeId: 'v2', type: 'video', title: '镜头2', url: '/api/uploads/u1/v2.mp4' },
      { nodeId: 'bad', type: 'agent', title: 'x', url: 'u' },
    ]
    const ok = applyTimelineOps(t, [{ op: 'add_visual', node_id: 'v2', at: 1 }], { sources })
    expect(ok.ok).toBe(true)
    expect(ok.timeline!.trackOrder).toEqual(['v1', 'v2', 'i1'])
    const added = ok.timeline!.tracks.find((x) => x.nodeId === 'v2')!
    expect(added.durationSec).toBe(5)
    expect(added.durationEstimated).toBe(true)
    expect(applyTimelineOps(t, [{ op: 'add_visual', node_id: 'bad' }], { sources }).error).toBe('unsupported_add_visual:bad')
    expect(applyTimelineOps(t, [{ op: 'add_visual', node_id: 'missing' }], { sources }).error).toBe('unknown_source_node')
  })

  it('add_audio 补齐假接线：校验 audio index 上限与 source 类型', () => {
    const t = base()
    const sources = [{ nodeId: 'a2', type: 'audio', title: '音效', url: '/api/uploads/u1/a2.wav' }]
    const ok = applyTimelineOps(t, [{ op: 'add_audio', node_id: 'a2', audio_track_index: 1, start_sec: 0 }], { sources })
    expect(ok.ok).toBe(true)
    const added = ok.timeline!.tracks.find((x) => x.nodeId === 'a2')!
    expect(added.type).toBe('audio')
    expect(added.audioTrackIndex).toBe(1)
    expect(applyTimelineOps(t, [{ op: 'add_audio', node_id: 'a2', audio_track_index: 0, start_sec: 0 }], { sources }).error).toContain('overlap')
  })

  it('P2.1 audio split：源内坐标切成两段、同轨不进 trackOrder、startSec 按可视时长偏移、时长守恒', () => {
    const t = base()
    // a1: durationSec=8, startSec=1, 无显式 sourceIn/out → in=0, out=8
    const r = applyTimelineOps(t, [{ op: 'split', node_id: 'a1', at_sec: 3 }], { nextId: () => 'a1_right' })
    expect(r.ok).toBe(true)
    expect(r.timeline!.tracks).toHaveLength(4)
    const left = r.timeline!.tracks.find((x) => x.nodeId === 'a1')!
    const right = r.timeline!.tracks.find((x) => x.nodeId === 'a1_right')!
    expect(left.sourceOutSec).toBe(3)
    expect(left.durationSec).toBe(3)
    expect(left.startSec).toBe(1)
    expect(right.sourceInSec).toBe(3)
    expect(right.sourceOutSec).toBe(8)
    expect(right.durationSec).toBe(5)
    expect(right.startSec).toBe(4) // 左段 start 1 + 可视 3
    expect(right.audioTrackIndex).toBe(0)
    expect(right.volume).toBe(0.5)
    expect(r.timeline!.trackOrder).toEqual(['v1', 'i1']) // audio 不进 trackOrder
    expect(validateTimeline(r.timeline!)).toEqual([]) // 相邻不重叠
  })

  it('P2.1 audio split：显式裁剪区间按源内坐标切，startSec 偏移用可视时长', () => {
    const t = base()
    const a1 = t.tracks.find((x) => x.nodeId === 'a1')!
    a1.sourceInSec = 2; a1.sourceOutSec = 10; a1.durationSec = 8; a1.startSec = 6
    const r = applyTimelineOps(t, [{ op: 'split', node_id: 'a1', at_sec: 5 }], { nextId: () => 'a1b' })
    expect(r.ok).toBe(true)
    const left = r.timeline!.tracks.find((x) => x.nodeId === 'a1')!
    const right = r.timeline!.tracks.find((x) => x.nodeId === 'a1b')!
    expect(left.sourceOutSec).toBe(5)
    expect(left.durationSec).toBe(3) // 5 - 2
    expect(right.sourceInSec).toBe(5)
    expect(right.durationSec).toBe(5) // 10 - 5
    expect(right.startSec).toBe(9) // 6 + 3
    expect(validateTimeline(r.timeline!)).toEqual([])
  })

  it('P2.1 audio split：区间外点拒绝，非法裁剪区间返回 unsupported_split_audio', () => {
    const t = base()
    expect(applyTimelineOps(t, [{ op: 'split', node_id: 'a1', at_sec: 99 }]).error).toBe('invalid_split_point')
    const bad = base()
    const a1 = bad.tracks.find((x) => x.nodeId === 'a1')!
    a1.sourceInSec = 5; a1.sourceOutSec = 4 // 非法区间
    expect(applyTimelineOps(bad, [{ op: 'split', node_id: 'a1', at_sec: 4 }]).error).toBe('unsupported_split_audio')
  })

  it('P2.1 duplicate visual：新 id 插相邻位、clipCount 同步、时长守恒', () => {
    const t = base()
    const before = visualDurationSec(t)
    const r = applyTimelineOps(t, [{ op: 'duplicate', node_id: 'i1' }], { nextId: () => 'i1_copy' })
    expect(r.ok).toBe(true)
    expect(r.timeline!.trackOrder).toEqual(['v1', 'i1', 'i1_copy']) // 插到相邻位（i1 在 index 1 → pos+1=2）
    expect(r.timeline!.clipCount).toBe(3)
    expect(visualDurationSec(r.timeline!)).toBeCloseTo(before + 3)
    expect(r.timeline!.tracks.find((x) => x.nodeId === 'i1_copy')!.title).toContain('副本')
    expect(validateTimeline(r.timeline!)).toEqual([])
  })

  it('P2.1 duplicate audio：同轨找空位插入、不进 trackOrder', () => {
    const t = base()
    const r = applyTimelineOps(t, [{ op: 'duplicate', node_id: 'a1' }], { nextId: () => 'a1_copy' })
    expect(r.ok).toBe(true)
    const copy = r.timeline!.tracks.find((x) => x.nodeId === 'a1_copy')!
    expect(copy.type).toBe('audio')
    expect(copy.audioTrackIndex).toBe(0)
    // a1 占 [1,9]，空位从 9 起
    expect(copy.startSec).toBe(9)
    expect(r.timeline!.trackOrder).toEqual(['v1', 'i1'])
    expect(validateTimeline(r.timeline!)).toEqual([])
  })

  it('P2.1 duplicate：未知节点拒绝', () => {
    const t = base()
    expect(applyTimelineOps(t, [{ op: 'duplicate', node_id: 'nope' }]).error).toBe('unknown_track:nope')
  })

  it('既有 op（remove/move/trim/set_export）保持 P0 语义不变', () => {
    const t = base()
    const r = applyTimelineOps(t, [
      { op: 'move_visual', from: 0, to: 1 },
      { op: 'trim', node_id: 'v1', source_in_sec: 0, source_out_sec: 2 },
      { op: 'set_export', resolution: '720p' },
    ])
    expect(r.ok).toBe(true)
    expect(r.timeline!.trackOrder).toEqual(['i1', 'v1'])
    expect(r.timeline!.export.resolution).toBe('720p')
    expect(r.timeline!.tracks.find((x) => x.nodeId === 'v1')!.sourceOutSec).toBe(2)
  })
})
