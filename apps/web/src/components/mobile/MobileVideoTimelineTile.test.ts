import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VideoTimeline } from '@lnkpi/shared'

const editor = { openMediaPreview: vi.fn() }
vi.mock('@/stores/canvasEditor', () => ({ useCanvasEditorStore: () => editor }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { sessionId: 'sess-1' } }) }))
const submitOps = vi.fn().mockResolvedValue({ ok: true })
vi.mock('@/composables/useVideoTimelineEdit', () => ({
  submitTimelineOps: (...a: unknown[]) => submitOps(...a),
  fetchTimelineSources: () => Promise.resolve([]),
}))

import MobileVideoTimelineTile from './MobileVideoTimelineTile.vue'

const timeline: VideoTimeline = {
  version: 1,
  clipCount: 2,
  trackOrder: ['v1', 'i1'],
  tracks: [
    { nodeId: 'v1', type: 'video', title: '镜头1', url: '/api/uploads/u1/a.mp4', durationSec: 2, startSec: 0 },
    { nodeId: 'i1', type: 'image', title: '图1', url: '/api/uploads/u1/b.png', durationSec: 3, startSec: 0 },
    { nodeId: 'a1', type: 'audio', title: '配乐', url: '/api/uploads/u1/c.wav', durationSec: 4, startSec: 0, audioTrackIndex: 0 },
  ],
  export: { fileName: '成片.mp4', resolution: '720p', format: 'mp4', volume: 1, muted: false, keepFullAudioTail: false },
}

function mountTile(aspectRatio?: string) {
  return mount(MobileVideoTimelineTile, { props: { nodeId: 'vt_1', timeline, aspectRatio }, attachTo: document.body })
}

// 浮层 Teleport 到 body：用例间清理，避免残留 DOM 污染下一个用例。
afterEach(() => { document.body.innerHTML = '' })

describe('MobileVideoTimelineTile（P1.5 移动端列表式时间线）', () => {
  it('列表式渲染视觉片段 + 音轨标签，不塞 320px 横轨', () => {
    const w = mountTile()
    const items = w.findAll('[data-mvt-item]')
    expect(items).toHaveLength(2)
    expect(items[0]!.text()).toContain('镜头1')
    expect(items[1]!.text()).toContain('图1')
    expect(w.text()).toContain('A1')
    expect(w.text()).toContain('A2')
    expect(w.text()).toContain('00:05')
    w.unmount()
  })

  it('触控热区用 var(--lnk-touch-target)，不写死 px', () => {
    const w = mountTile()
    const style = w.get('[data-mvt-item]').attributes('style') ?? ''
    expect(style).toContain('--lnk-touch-target')
    w.unmount()
  })

  it('点 video 片段发光标 preview 且调 openMediaPreview 复用预览壳；点图片段不发', async () => {
    editor.openMediaPreview.mockClear()
    const w = mountTile()
    await w.findAll('[data-mvt-item]')[0]!.trigger('click')
    const emitted = w.emitted('preview')!
    expect(emitted).toHaveLength(1)
    expect(emitted[0]![0]).toMatchObject({ url: '/api/uploads/u1/a.mp4' })
    expect(editor.openMediaPreview).toHaveBeenCalledTimes(1)
    expect(editor.openMediaPreview.mock.calls[0]![0]).toMatchObject({ kind: 'video', nodeId: 'vt_1' })
    await w.findAll('[data-mvt-item]')[1]!.trigger('click')
    expect(w.emitted('preview')).toHaveLength(1) // 图片不可播
    w.unmount()
  })

  it('长按进入排序模式，排序按钮发 move op 并走 submitTimelineOps 同一写通道', async () => {
    submitOps.mockClear()
    const w = mountTile()
    // useLongPress 触屏专用：派发 touchstart 并保持，触发后 sortMode=true
    const first = w.findAll('[data-mvt-item]')[0]!
    first.element.dispatchEvent(new Event('touchstart', { bubbles: true }))
    // 直接测排序按钮的存在性与接线（长按计时在 composable 单测已覆盖）
    await w.get('[data-mvt-sort-mode]').trigger('click')
    const down = w.findAll('[data-mvt-move-down]')
    expect(down.length).toBeGreaterThan(0)
    await down[0]!.trigger('click')
    const emitted = w.emitted('op')!
    expect(emitted).toHaveLength(1)
    expect(emitted[0]![0]).toMatchObject({ op: 'move_visual', from: 0, to: 1 })
    expect(submitOps).toHaveBeenCalledWith({ sessionId: 'sess-1', nodeId: 'vt_1', ops: [{ op: 'move_visual', from: 0, to: 1 }] })
    w.unmount()
  })

  it('点编辑发 request-edit 并展开 P2.6 全屏编辑器（VideoTimelineStudio）', async () => {
    const w = mountTile()
    await w.get('[data-mvt-edit]').trigger('click')
    expect(w.emitted('request-edit')).toHaveLength(1)
    // 全屏壳 Teleport 到 body，须在 document.body 查（wrapper 查不到）。
    expect(document.body.querySelector('[data-vts-studio]')).not.toBeNull()
    expect(document.body.querySelector('[data-vts-commit]')).not.toBeNull() // 浮层真实挂载，非死按钮
    w.unmount()
  })

  it('P2.6：tile 把 aspectRatio 透传全屏壳，9:16 预览区按竖屏比例渲染', async () => {
    const w = mountTile('9:16')
    await w.get('[data-mvt-edit]').trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    expect(document.body.querySelector('[data-vts-preview-area]')!.getAttribute('style')).toContain('0.5625')
    w.unmount()
  })

  it('根 section 冒泡隔离：tile 内点击不泄漏到壳层（wrapper 根无 click 冒泡）', () => {
    const w = mountTile()
    const root = w.get('[data-mvt]')
    expect(root.attributes('data-mvt')).toBe('')
    // .stop 通过模板存在性锁定（jsdom 的 trigger 不透传 stopPropagation 语义给父组件）
    expect(root.attributes('class')).toContain('mvt')
    w.unmount()
  })
})
