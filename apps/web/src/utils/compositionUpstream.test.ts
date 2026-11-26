import { describe, expect, it } from 'vitest'
import { compositionTracksToNodePatch, resolveCompositionTracks } from './compositionUpstream'

describe('compositionUpstream timeline extension', () => {
  it('识别 image 节点为视觉轨并给默认 5 秒', () => {
    const tracks = resolveCompositionTracks('target', [
      { id: 'i1', type: 'image', data: { url: '/x.png' } },
      { id: 'target', type: 'video', data: {} },
    ] as never, [{ id: 'e1', source: 'i1', target: 'target' }] as never)
    expect(tracks[0]?.type).toBe('image')
    expect(tracks[0]?.durationSec).toBe(5)
    expect(tracks[0]?.durationEstimated).toBe(true)
  })

  it('写回 node patch 保留裁剪与音量字段', () => {
    const patch = compositionTracksToNodePatch([{
      nodeId: 'a1', type: 'audio', title: '旁白', url: '/a.wav', label: '音频',
      durationSec: 4, startSec: 2, sourceInSec: 1, sourceOutSec: 5,
      volume: 0.8, muted: false, audioTrackIndex: 1,
    }])
    expect(patch.tracks[0]).toMatchObject({
      sourceInSec: 1, sourceOutSec: 5, volume: 0.8, audioTrackIndex: 1,
    })
  })
})
