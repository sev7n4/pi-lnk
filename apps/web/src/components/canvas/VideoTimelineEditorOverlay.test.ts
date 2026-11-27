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
