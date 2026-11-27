import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import VideoTimelineEditorOverlay from './VideoTimelineEditorOverlay.vue'
import type { VideoTimeline } from '@lnkpi/shared'

const base = (): VideoTimeline => ({
  version: 1,
  clipCount: 2,
  trackOrder: ['v1', 'i1'],
  tracks: [
    { nodeId: 'v1', type: 'video', title: '镜头1', url: '/api/uploads/u1/a.mp4', durationSec: 4, startSec: 0, sourceInSec: 0, sourceOutSec: 4 },
    { nodeId: 'i1', type: 'image', title: '图1', url: '/api/uploads/u1/b.png', durationSec: 3, startSec: 0 },
  ],
  export: { fileName: '成片.mp4', resolution: '720p', format: 'mp4', volume: 1, muted: false, keepFullAudioTail: false },
})

/**
 * 浮层 Teleport 到 body，wrapper.html 只有占位符 ⇒ 一律用 document 查询 DOM 事实
 * （Vue 事件监听绑在真实 DOM 上，dispatchEvent 可触发）。
 */
function mountOverlay() {
  const w = mount(VideoTimelineEditorOverlay, { props: { nodeId: 'vt_1', timeline: base() }, attachTo: document.body })
  return {
    w,
    q: (sel: string) => document.querySelector(sel) as HTMLElement | null,
    qa: (sel: string) => Array.from(document.querySelectorAll(sel)) as HTMLElement[],
    click: (sel: string) => { (document.querySelector(sel) as HTMLElement)?.click() },
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  document.querySelectorAll('[data-vt-overlay]').forEach((n) => n.remove())
})

describe('VideoTimelineEditorOverlay（P1.4 就地浮层）', () => {
  it('Teleport 到 body，渲染时间轴片段与操作行', () => {
    const h = mountOverlay()
    expect(h.q('[data-vt-overlay]')).not.toBeNull()
    expect(h.qa('[data-vt-clip]')).toHaveLength(2)
    for (const sel of ['[data-vt-undo]', '[data-vt-redo]', '[data-vt-commit]', '[data-vt-split]', '[data-vt-remove]']) {
      expect(h.q(sel), sel).not.toBeNull()
    }
    h.w.unmount()
  })

  it('选中片段→分割→预览 3 段 + op 摘要，撤销回退、重做恢复（DOM 事实）', async () => {
    const h = mountOverlay()
    h.qa('[data-vt-clip]')[0]!.click() // 选中 v1
    await tick()
    const head = h.q('[data-vt-playhead]') as HTMLInputElement
    head.value = '2'
    head.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    h.click('[data-vt-split]')
    await tick()
    expect(h.q('[data-vt-summary]')!.textContent).toContain('1 项')
    expect(h.qa('[data-vt-clip]')).toHaveLength(3)
    h.click('[data-vt-undo]')
    await tick()
    expect(h.qa('[data-vt-clip]')).toHaveLength(2)
    h.click('[data-vt-redo]')
    await tick()
    expect(h.qa('[data-vt-clip]')).toHaveLength(3)
    h.w.unmount()
  })

  it('删除选中片段→预览少一条、撤销恢复', async () => {
    const h = mountOverlay()
    h.qa('[data-vt-clip]')[1]!.click()
    await tick()
    h.click('[data-vt-remove]')
    await tick()
    expect(h.qa('[data-vt-clip]')).toHaveLength(1)
    h.click('[data-vt-undo]')
    await tick()
    expect(h.qa('[data-vt-clip]')).toHaveLength(2)
    h.w.unmount()
  })

  it('完成只提交一次 commit，ops 为当前 cursor 前的序列', async () => {
    const h = mountOverlay()
    h.qa('[data-vt-clip]')[1]!.click()
    await tick()
    h.click('[data-vt-remove]')
    await tick()
    h.click('[data-vt-commit]')
    await tick()
    const emitted = h.w.emitted('commit')!
    expect(emitted).toHaveLength(1)
    expect(emitted[0]![0]).toEqual([{ op: 'remove', node_id: 'i1' }])
    h.w.unmount()
  })

  it('无可提交 op 时完成按钮禁用', () => {
    const h = mountOverlay()
    expect((h.q('[data-vt-commit]') as HTMLButtonElement).disabled).toBe(true)
    h.w.unmount()
  })
})

describe('VideoTimelineEditorOverlay（P2.3 贯穿播放头 + 横滑 + 坐标转换）', () => {
  it('贯穿竖线存在、位置随 playheadSec、点击 ruler 定位', async () => {
    const h = mountOverlay()
    const ph = h.q('[data-tl-playhead]')!
    expect(ph).not.toBeNull()
    expect((ph as HTMLElement).style.left).toBe('0px') // playheadSec 初始 0
    const head = h.q('[data-vt-playhead]') as HTMLInputElement
    head.value = '3'
    head.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    expect((h.q('[data-tl-playhead]') as HTMLElement).style.left).toBe('72px') // 3*24
    expect(h.q('[data-vt-time]')!.textContent).toContain('00:03')
    h.w.unmount()
  })

  it('横滑容器存在，缩放按钮改 contentWidth（纯 UI 态不改 op）', async () => {
    const t = base()
    t.tracks[0]!.durationSec = 40; t.tracks[0]!.sourceOutSec = 40 // 总长 43s → 43*24=1032 > 视口 720
    const w = mount(VideoTimelineEditorOverlay, { props: { nodeId: 'vt_1', timeline: t }, attachTo: document.body })
    const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
    expect(q('[data-vt-timeline-scroll]')).not.toBeNull()
    const content = q('.vtm-timeline-content') as HTMLElement
    const w0 = content.style.width
    q('[data-vt-zoom-in]')!.click()
    await tick()
    expect((q('.vtm-timeline-content') as HTMLElement).style.width).not.toBe(w0)
    expect(q('[data-vt-summary]')!.textContent).toContain('暂无') // 缩放不写 op
    w.unmount()
  })

  it('完成后提交的 split op 的 at_sec 是源内坐标（非全局）', async () => {
    const t = base()
    t.tracks[1]!.sourceInSec = 2; t.tracks[1]!.sourceOutSec = 6; t.tracks[1]!.durationSec = 4
    const w = mount(VideoTimelineEditorOverlay, { props: { nodeId: 'vt_1', timeline: t }, attachTo: document.body })
    const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
    const qa = (sel: string) => Array.from(document.querySelectorAll(sel)) as HTMLElement[]
    qa('[data-vt-clip]')[1]!.click()
    await tick()
    const head = q('[data-vt-playhead]') as HTMLInputElement
    head.value = '6' // 全局 6 = i1 全局起点 4 + 偏移 2 → 源内 2+2=4
    head.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    q('[data-vt-split]')!.click()
    await tick()
    expect(qa('[data-tl-clip]')).toHaveLength(3) // split 成功（若传全局 6 会 > sourceOut 6 被拒）
    q('[data-vt-commit]')!.click()
    await tick()
    const ops = w.emitted('commit')![0]![0] as Array<Record<string, unknown>>
    expect(ops).toContainEqual({ op: 'split', node_id: 'i1', at_sec: 4 })
    w.unmount()
  })
})
