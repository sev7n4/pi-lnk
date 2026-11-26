import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import VideoTimelineCard from './VideoTimelineCard.vue'
import type { VideoTimeline } from '@lnkpi/shared'

const timeline: VideoTimeline = {
  version: 1,
  clipCount: 2,
  trackOrder: ['v1', 'i1'],
  tracks: [
    { nodeId: 'v1', type: 'video', title: '镜头1', url: '/api/uploads/u1/a.mp4', durationSec: 2, startSec: 0 },
    { nodeId: 'i1', type: 'image', title: '图1', url: '/api/uploads/u1/b.png', durationSec: 3, startSec: 0 },
    { nodeId: 'a1', type: 'audio', title: '配乐', url: '/api/uploads/u1/c.wav', durationSec: 4, startSec: 1, audioTrackIndex: 0 },
  ],
  export: { fileName: '成片.mp4', resolution: '1080p', format: 'mp4', volume: 1, muted: false, keepFullAudioTail: false },
}

function mountCard(renderEnabled = true) {
  return mount(VideoTimelineCard, {
    props: { nodeId: 'vt_1', timeline, status: 'draft', renderEnabled },
  })
}

describe('VideoTimelineCard', () => {
  it('展示视觉轨总时长并按 trackOrder 排列片段', () => {
    const wrapper = mountCard()
    expect(wrapper.text()).toContain('00:05/00:05')
    const clips = wrapper.findAll('[data-timeline-clip]')
    expect(clips).toHaveLength(2)
    expect(clips[0]!.text()).toContain('镜头1')
    expect(clips[1]!.text()).toContain('图1')
  })

  it('P0 编辑按钮禁用且提示用 agent 编辑', () => {
    const wrapper = mountCard()
    const edit = wrapper.get('[data-timeline-edit]')
    expect(edit.attributes('disabled')).toBeDefined()
    expect(edit.attributes('title')).toContain('agent')
  })

  it('渲染未启用时导出按钮禁用并说明原因', () => {
    const wrapper = mountCard(false)
    const exportBtn = wrapper.get('[data-timeline-export]')
    expect(exportBtn.attributes('disabled')).toBeDefined()
    expect(exportBtn.attributes('title')).toContain('渲染未启用')
  })

  it('渲染启用时点击导出发出 request-render', async () => {
    const wrapper = mountCard()
    await wrapper.get('[data-timeline-export]').trigger('click')
    expect(wrapper.emitted('request-render')).toHaveLength(1)
  })
})
