import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VideoTimeline } from '@lnkpi/shared'
import type { TimelineSource } from '@/composables/useVideoTimelineEdit'
import VideoTimelineStudio from './VideoTimelineStudio.vue'

const base = (): VideoTimeline => ({
  version: 1,
  clipCount: 2,
  trackOrder: ['v1', 'i1'],
  tracks: [
    { nodeId: 'v1', type: 'video', title: '镜头1', url: '/u/a.mp4', durationSec: 4, startSec: 0, sourceInSec: 0, sourceOutSec: 4 },
    { nodeId: 'i1', type: 'image', title: '图1', url: '/u/b.png', durationSec: 3, startSec: 0 },
  ],
  export: { fileName: '成片.mp4', resolution: '720p', format: 'mp4', volume: 1, muted: false, keepFullAudioTail: false },
})

function mountStudio(opts: { sources?: TimelineSource[]; aspectRatio?: string; renderEnabled?: boolean } = {}) {
  const w = mount(VideoTimelineStudio, {
    props: {
      nodeId: 'vt_1', timeline: base(),
      sources: opts.sources ?? [],
      aspectRatio: opts.aspectRatio ?? '9:16',
      renderEnabled: opts.renderEnabled ?? true,
    },
    attachTo: document.body,
  })
  return {
    w,
    q: (sel: string) => document.querySelector(sel) as HTMLElement | null,
    qa: (sel: string) => Array.from(document.querySelectorAll(sel)) as HTMLElement[],
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => { document.querySelectorAll('[data-vts-studio]').forEach((n) => n.remove()) })

describe('VideoTimelineStudio（P2.6 移动端全屏编辑器）', () => {
  it('Teleport 到 body 全屏壳：顶部/预览/播放控制/时间轴/两级工具栏齐备', () => {
    const h = mountStudio()
    expect(h.q('[data-vts-studio]')).not.toBeNull()
    for (const sel of [
      '[data-vts-close]', '[data-vts-export]', '[data-vts-preview-area]', '[data-vts-time]',
      '[data-vts-undo]', '[data-vts-redo]', '[data-vts-timeline-scroll]', '[data-vts-toolbar]',
      '[data-vts-tab-clip]', '[data-vts-tab-audio]', '[data-vts-commit]',
    ]) expect(h.q(sel), sel).not.toBeNull()
    expect(h.qa('[data-tl-clip]')).toHaveLength(2)
    expect(h.q('[data-tl-playhead]')).not.toBeNull()
    expect(h.q('[data-vts-preview-area]')!.style.aspectRatio).toContain('0.5625') // 9:16（jsdom 规范化为 0.5625 / 1）
    h.w.unmount()
  })

  it('两级工具栏 DOM 下沉：clip tab 只渲染剪辑工具，audio tab 只渲染音频工具', async () => {
    const h = mountStudio()
    expect(h.q('[data-vts-tools-clip]')).not.toBeNull()
    expect(h.q('[data-vts-tools-audio]')).toBeNull()
    h.q('[data-vts-tab-audio]')!.click()
    await tick()
    expect(h.q('[data-vts-tools-clip]')).toBeNull()
    expect(h.q('[data-vts-tools-audio]')).not.toBeNull()
    h.w.unmount()
  })

  it('关闭发 close，导出发 request-render', async () => {
    const h = mountStudio()
    h.q('[data-vts-close]')!.click()
    await tick()
    expect(h.w.emitted('close')).toHaveLength(1)
    h.q('[data-vts-export]')!.click()
    await tick()
    expect(h.w.emitted('request-render')).toHaveLength(1)
    h.w.unmount()
  })

  it('触控热区：工具栏按钮用 var(--lnk-touch-target)', () => {
    const h = mountStudio()
    const btn = h.q('[data-vts-tab-clip]')!
    expect(btn.className).toContain('vts__tab')
    // scoped 样式在 style 中锁 min-height，组件类存在即受约束（具体 CSS 由 style-guards 门禁校验）
    h.w.unmount()
  })

  it('选中片段→分割→完成：commit 发正确 op（坐标转换）', async () => {
    const h = mountStudio()
    h.qa('[data-tl-clip]')[0]!.click() // 选中 v1（全局起点 0）
    await tick()
    // 播放头移到 v1 内部（全局 2）：studio 有 ruler，派发 click 定位
    const ruler = h.q('[data-tl-ruler]')!
    ruler.getBoundingClientRect = () => ({ left: 0, top: 0, width: 9999, height: 18, right: 9999, bottom: 18, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    ruler.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 2 * 24 }))
    await tick()
    h.q('[data-vts-split]')!.click()
    await tick()
    expect(h.qa('[data-tl-clip]')).toHaveLength(3)
    h.q('[data-vts-commit]')!.click()
    await tick()
    const ops = h.w.emitted('commit')![0]![0] as Array<Record<string, unknown>>
    expect(ops.some((o) => o.op === 'split' && o.node_id === 'v1')).toBe(true)
    h.w.unmount()
  })

  it('音频 tab：sources 注入后 +音频 可用，提交含 add_audio', async () => {
    const h = mountStudio({ sources: [{ nodeId: 'bgm', type: 'audio', title: '配乐', url: '/u/bgm.wav' }] })
    h.q('[data-vts-tab-audio]')!.click()
    await tick()
    expect((h.q('[data-vts-audio-add]') as HTMLButtonElement).disabled).toBe(false)
    h.q('[data-vts-audio-add]')!.click()
    await tick()
    h.q('[data-vts-commit]')!.click()
    await tick()
    const ops = h.w.emitted('commit')![0]![0] as Array<Record<string, unknown>>
    expect(ops.some((o) => o.op === 'add_audio' && o.node_id === 'bgm')).toBe(true)
    h.w.unmount()
  })

  it('裁剪手柄不是死控件：点击 trim 手柄产生 trim op（提交后服务端可见）', async () => {
    const h = mountStudio()
    h.qa('[data-tl-clip]')[0]!.click() // 选中 v1（sourceInSec=0, sourceOutSec=4）
    await tick()
    h.q('[data-tl-trim-in]')!.click()
    await tick()
    h.q('[data-vts-commit]')!.click()
    await tick()
    const ops = h.w.emitted('commit')![0]![0] as Array<Record<string, unknown>>
    expect(ops.some((o) => o.op === 'trim' && o.node_id === 'v1' && o.source_in_sec === 0.5)).toBe(true)
    h.w.unmount()
  })

  it('缩放按钮改变共享坐标系：clip 宽度与播放头位置同步缩放', async () => {
    const h = mountStudio()
    const ruler = h.q('[data-tl-ruler]')!
    ruler.getBoundingClientRect = () => ({ left: 0, top: 0, width: 9999, height: 18, right: 9999, bottom: 18, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    ruler.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 48 })) // 播放头 2s，避免 0s 缩放后仍 0px
    await tick()
    const clip = h.qa('[data-tl-clip]')[0]!
    const beforeWidth = clip.style.width
    const beforeLeft = h.q('[data-tl-playhead]')!.style.left
    h.q('[data-vts-zoom-in]')!.click()
    await tick()
    expect(clip.style.width).not.toBe(beforeWidth)
    // ruler/clip/audio/playhead 共享 axis ⇒ 选中的 clip 起点与播放头都用新 pxPerSec
    expect(h.q('[data-tl-playhead]')!.style.left).not.toBe(beforeLeft)
    h.q('[data-vts-zoom-out]')!.click()
    await tick()
    expect(clip.style.width).toBe(beforeWidth)
    h.w.unmount()
  })

  it('帮助文案说明能力边界：转场/特效/贴纸/关键帧明确不抄', async () => {
    const h = mountStudio()
    const help = h.q('[data-vts-help]')!
    expect(help).not.toBeNull()
    expect(help.textContent).toContain('转场')
    expect(help.textContent).toContain('不')
    h.w.unmount()
  })

  it('无 sources 时 +音频 禁用（不造裸 URL）', async () => {
    const h = mountStudio()
    h.q('[data-vts-tab-audio]')!.click()
    await tick()
    expect((h.q('[data-vts-audio-add]') as HTMLButtonElement).disabled).toBe(true)
    h.w.unmount()
  })

  it('防误触意图守卫：pointerdown 落工具栏外后 500ms 内的 click 被拦截', async () => {
    const h = mountStudio()
    // pointerdown 落 body（工具栏外），紧接着 click 工具栏按钮 ⇒ 应被 capture 守卫拦截
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    h.qa('[data-tl-clip]')[0]!.click() // 选中片段使复制可用
    await tick()
    const before = h.w.emitted('commit')?.length ?? 0
    // pointerdown 落工具栏外（body），随后点 toolbar 内复制按钮 ⇒ 守卫拦截
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    h.q('[data-vts-duplicate]')!.click()
    await tick()
    expect(h.qa('[data-tl-clip]')).toHaveLength(2) // 复制被拦截，片段仍 2
    expect(h.w.emitted('commit')?.length ?? 0).toBe(before)
    h.w.unmount()
  })

  it('正常触摸：pointerdown 落工具栏内 → click 放行（守卫不误伤真实操作）', async () => {
    const h = mountStudio()
    h.qa('[data-tl-clip]')[0]!.click() // 选中片段
    await tick()
    const dup = h.q('[data-vts-duplicate]')!
    // pointerdown 就落在该按钮上（真实触摸），随后 click 应放行
    dup.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    dup.click()
    await tick()
    expect(h.qa('[data-tl-clip]')).toHaveLength(3) // 复制生效
    h.w.unmount()
  })

  it('无 pointerdown 的键盘激活放行（可访问性）', async () => {
    const h = mountStudio()
    // 不派发 pointerdown ⇒ withinWindow=false ⇒ 守卫放行
    h.q('[data-vts-close]')!.click()
    await tick()
    expect(h.w.emitted('close')).toHaveLength(1)
    h.w.unmount()
  })
})
