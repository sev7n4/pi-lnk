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

function mountCard(renderEnabled = true, portrait = false, t: VideoTimeline = timeline) {
  return mount(VideoTimelineCard, {
    props: { nodeId: 'vt_1', timeline: t, status: 'draft', renderEnabled, portrait },
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

  it('总时长走 clipDurationSec 真相源（裁剪后不读 durationSec 原值）', () => {
    const trimmed: VideoTimeline = {
      ...timeline,
      tracks: [
        { ...timeline.tracks[0]!, durationSec: 99, sourceInSec: 1, sourceOutSec: 3 }, // 实际 2s
        timeline.tracks[1]!, // 3s
      ],
    }
    const wrapper = mountCard(true, false, trimmed)
    expect(wrapper.text()).toContain('00:05/00:05') // 2+3，不是 99+3
  })

  it('P1.3 编辑按钮可点、发出 request-edit、提示与 agent 共用操作', async () => {
    const wrapper = mountCard()
    const edit = wrapper.get('[data-timeline-edit]')
    expect(edit.attributes('disabled')).toBeUndefined()
    expect(edit.attributes('title')).toContain('agent')
    await edit.trigger('click')
    expect(wrapper.emitted('request-edit')).toHaveLength(1)
  })

  it('P1.3 播放钮常驻 DOM（不依赖 hover），点击发出 request-play 带真实 url', async () => {
    const wrapper = mountCard()
    const play = wrapper.get('[data-timeline-play]') // get 已断言存在
    expect(play.attributes('title')).toContain('镜头1')
    await play.trigger('click')
    const emitted = wrapper.emitted('request-play')!
    expect(emitted).toHaveLength(1)
    expect(emitted[0]![0]).toMatchObject({ url: '/api/uploads/u1/a.mp4' })
  })

  it('无 video 轨（纯图/音频）时不显示播放钮', () => {
    const imageOnly: VideoTimeline = {
      ...timeline,
      tracks: [{ nodeId: 'i1', type: 'image', title: '图1', url: '/api/uploads/u1/b.png', durationSec: 3, startSec: 0 }],
      trackOrder: ['i1'],
    }
    const wrapper = mountCard(true, false, imageOnly)
    expect(wrapper.find('[data-timeline-play]').exists()).toBe(false)
  })

  it('竖屏比例加 is-portrait class 以切换纵向堆叠布局', () => {
    expect(mountCard(true, false).classes()).not.toContain('vt-card--portrait')
    const portrait = mountCard(true, true)
    expect(portrait.classes()).toContain('vt-card--portrait')
    // 片段时长百分比走 --vt-pct：横屏作 width、竖屏 CSS 改写为 height，同一真相源
    const clip = portrait.get('[data-timeline-clip]')
    expect(clip.attributes('style')).toContain('--vt-pct')
  })

  it('保持根节点 nodrag（卡片区不拖节点，防误触）', () => {
    expect(mountCard().classes()).toContain('nodrag')
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
