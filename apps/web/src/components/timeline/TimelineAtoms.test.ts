import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { TimelineTrack } from '@lnkpi/shared'
import { useTimelineAxis } from './useTimelineAxis'
import TimelineRuler from './TimelineRuler.vue'
import TimelinePlayhead from './TimelinePlayhead.vue'
import TimelineClip from './TimelineClip.vue'
import TimelineAudioLane from './TimelineAudioLane.vue'

const axisOf = (totalSec = 20) => useTimelineAxis({
  totalSec: () => totalSec,
  viewportWidth: () => 720,
})

/** jsdom 无布局：给元素一个可控 rect，验证 clientX → 内容坐标映射。 */
function stubRect(el: Element, left: number, width = 9999) {
  el.getBoundingClientRect = () => ({
    left, top: 0, right: left + width, bottom: 100, width, height: 100, x: left, y: 0, toJSON: () => ({}),
  }) as DOMRect
}

afterEach(() => { document.body.innerHTML = '' })

/** jsdom 的 PointerEvent.clientX 只读：用可定义属性的 Event 注入，绕开 trigger 的赋值限制。 */
function dispatchPointer(el: Element, type: string, clientX: number, pointerId = 1) {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clientX', { value: clientX })
  Object.defineProperty(ev, 'pointerId', { value: pointerId })
  el.dispatchEvent(ev)
}

describe('TimelineRuler', () => {
  it('按 px/sec 铺刻度、点击定位（含滚动偏移由 rect.left 吸收）', async () => {
    const axis = axisOf(10)
    const w = mount(TimelineRuler, { props: { axis, tickSec: 5 }, attachTo: document.body })
    const ticks = w.findAll('[data-tl-ruler] .tl-ruler-tick')
    expect(ticks.map((t) => t.text())).toEqual(['00:00', '00:05', '00:10'])
    expect((ticks[1]!.element as HTMLElement).style.left).toBe(`${axis.secToPx(5)}px`) // 5*24=120px
    const ruler = w.get('[data-tl-ruler]').element
    stubRect(ruler, 100) // 容器已向左滚 100px ⇒ rect.left=100
    dispatchPointer(ruler, 'click', 100 + axis.secToPx(4)) // 内容 x=96 → 4s
    expect(w.emitted('seek')?.[0]).toEqual([4])
    w.unmount()
  })
})

describe('TimelinePlayhead', () => {
  it('竖线位置 = sec * pxPerSec，pointerdown 定位 + 拖动改 seek', async () => {
    const axis = axisOf(10)
    const w = mount(TimelinePlayhead, {
      props: { axis, sec: 2, height: 100 },
      attachTo: document.body,
    })
    const ph = w.get('[data-tl-playhead]').element as HTMLElement
    expect(ph.style.left).toBe('48px') // 2*24
    // 播放头 parentElement 是 wrapper 的挂载容器；给它设 rect
    stubRect(ph.parentElement!, 0)
    dispatchPointer(ph, 'pointerdown', axis.secToPx(3), 1)
    expect(w.emitted('seek')?.[0]).toEqual([3])
    dispatchPointer(ph, 'pointermove', axis.secToPx(4.5), 1)
    expect(w.emitted('seek')?.[1]).toEqual([4.5])
    w.unmount()
  })

  it('snapEdges：6px 内吸附、越界不吸附', async () => {
    const axis = axisOf(10) // 24px/s → 6px = 0.25s
    const w = mount(TimelinePlayhead, {
      props: { axis, sec: 1, snapEdges: [2, 5], height: 100 },
      attachTo: document.body,
    })
    const ph = w.get('[data-tl-playhead]').element as HTMLElement
    stubRect(ph.parentElement!, 0)
    dispatchPointer(ph, 'pointerdown', axis.secToPx(1.9), 1)
    expect(w.emitted('seek')?.[0]).toEqual([2]) // 0.1s = 2.4px < 6px → 吸附
    dispatchPointer(ph, 'pointerdown', axis.secToPx(2.9), 2)
    expect(w.emitted('seek')?.[1]).toEqual([2.9]) // 距 2 为 0.9s=21.6px>6px，距5更远 → 不吸附
    w.unmount()
  })

  it('pointerdown 夹在 [0,totalSec]，不越界', async () => {
    const axis = axisOf(10)
    const w = mount(TimelinePlayhead, { props: { axis, sec: 0, height: 100 }, attachTo: document.body })
    const ph = w.get('[data-tl-playhead]').element as HTMLElement
    stubRect(ph.parentElement!, 0)
    dispatchPointer(ph, 'pointerdown', -100, 1)
    expect(w.emitted('seek')?.[0]).toEqual([0])
    dispatchPointer(ph, 'pointerdown', 9999, 2)
    expect(w.emitted('seek')?.[1]).toEqual([10])
    w.unmount()
  })
})

describe('TimelineClip', () => {
  const track: TimelineTrack = {
    nodeId: 'v1', type: 'video', title: '镜头1', url: '/u/a.mp4',
    durationSec: 3, startSec: 0, sourceInSec: 0, sourceOutSec: 3,
  }

  it('按 startSec 定位、clipDurationSec 定宽，选中态白框', () => {
    const axis = axisOf()
    const w = mount(TimelineClip, { props: { axis, track, startSec: 2, index: 0, selected: true } })
    const el = w.get('[data-tl-clip]').element as HTMLElement
    expect(el.style.left).toBe('48px') // 2*24
    expect(el.style.width).toBe('72px') // clipDurationSec=3 → 3*24
    expect(el.classList.contains('is-selected')).toBe(true)
    w.unmount()
  })

  it('点击选中、两端手柄发 trim', async () => {
    const axis = axisOf()
    const w = mount(TimelineClip, { props: { axis, track, startSec: 0, index: 0 } })
    await w.get('[data-tl-clip]').trigger('click')
    expect(w.emitted('select')?.[0]).toEqual(['v1'])
    await w.get('[data-tl-trim-in]').trigger('click')
    expect(w.emitted('trim')?.[0]).toEqual([{ nodeId: 'v1', edge: 'in', deltaSec: 0.5 }])
    await w.get('[data-tl-trim-out]').trigger('click')
    expect(w.emitted('trim')?.[1]).toEqual([{ nodeId: 'v1', edge: 'out', deltaSec: -0.5 }])
    w.unmount()
  })
})

describe('TimelineAudioLane', () => {
  const a1: TimelineTrack = {
    nodeId: 'a1', type: 'audio', title: '配乐', url: '/u/a.wav',
    durationSec: 4, startSec: 2, audioTrackIndex: 0,
  }

  it('按 audioTrackIndex 过滤、按 startSec/durationSec 定位，复用波形组件', () => {
    const axis = axisOf()
    const w = mount(TimelineAudioLane, {
      props: {
        axis, index: 0,
        tracks: [a1, { ...a1, nodeId: 'a2', audioTrackIndex: 1, startSec: 0 }],
      },
    })
    const clips = w.findAll('[data-tl-audio-clip]')
    expect(clips).toHaveLength(1) // 只要 A1
    const el = clips[0]!.element as HTMLElement
    expect(el.style.left).toBe('48px') // 2*24
    expect(el.style.width).toBe('96px') // 4*24
    expect(w.findComponent({ name: 'MobileNodeWaveform' }).exists()).toBe(true)
    w.unmount()
  })

  it('波形绝不编造：占位态由组件 data-source 标注', () => {
    const axis = axisOf()
    const w = mount(TimelineAudioLane, { props: { axis, index: 0, tracks: [a1] } })
    // useNodeWaveform 解码失败（jsdom 无 AudioContext）⇒ 保持 placeholder
    const wf = w.find('[data-testid="mobile-node-waveform"]')
    expect(wf.exists()).toBe(true)
    expect(['placeholder', 'real']).toContain(wf.attributes('data-source'))
    w.unmount()
  })
})
