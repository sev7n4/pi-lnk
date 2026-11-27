import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VideoTimeline } from '@lnkpi/shared'

// NodeTileView 保持纯渲染（零 store/router 依赖）；其 timeline 分支渲染的自包含
// tile 会调 store/router/submit，这里 mock 掉外部依赖，专测「分支接线」本身。
vi.mock('@/stores/canvasEditor', () => ({ useCanvasEditorStore: () => ({ openMediaPreview: vi.fn() }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { sessionId: 's1' } }) }))
vi.mock('@/composables/useVideoTimelineEdit', () => ({ submitTimelineOps: vi.fn().mockResolvedValue({ ok: true }) }))

import NodeTileView from './NodeTileView.vue'

const timeline: VideoTimeline = {
  version: 1,
  clipCount: 1,
  trackOrder: ['v1'],
  tracks: [
    { nodeId: 'v1', type: 'video', title: '镜头A', url: '/u/a.mp4', durationSec: 2, startSec: 0 },
  ],
  export: { fileName: '成片.mp4', resolution: '720p', format: 'mp4', volume: 1, muted: false, keepFullAudioTail: false },
}

describe('NodeTileView timeline 分支（P1.5 移动端接入）', () => {
  it('video 节点带 data.timeline ⇒ 渲染列表式 tile，且不落普通视频/空占位分支', () => {
    const w = mount(NodeTileView, {
      props: { id: 'vt_1', type: 'video', data: { timeline, status: 'completed' } },
    })
    expect(w.find('[data-mvt]').exists()).toBe(true)
    expect(w.find('[data-mvt-item]').exists()).toBe(true)
    expect(w.text()).toContain('镜头A')
    expect(w.find('video.mobile-node-media').exists()).toBe(false)
    expect(w.find('.mobile-node-placeholder').exists()).toBe(false)
  })

  it('video 节点无 timeline（普通成片）⇒ 仍走 video 媒体分支，不回归', () => {
    const w = mount(NodeTileView, {
      props: { id: 'v2', type: 'video', data: { url: '/u/b.mp4', status: 'completed' } },
    })
    expect(w.find('video.mobile-node-media').exists()).toBe(true)
    expect(w.find('[data-mvt]').exists()).toBe(false)
  })

  it('data.timeline 结构非法 ⇒ 守卫拒绝，不渲染 tile（不猜不占位）', () => {
    const w = mount(NodeTileView, {
      props: { id: 'v3', type: 'video', data: { timeline: { version: 2, tracks: [] }, status: 'completed' } },
    })
    expect(w.find('[data-mvt]').exists()).toBe(false)
  })
})
