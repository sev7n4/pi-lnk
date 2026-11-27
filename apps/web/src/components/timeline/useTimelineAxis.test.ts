import { describe, expect, it } from 'vitest'
import {
  TIMELINE_BASE_PX_PER_SEC,
  TIMELINE_MAX_ZOOM,
  TIMELINE_MIN_ZOOM,
  useTimelineAxis,
} from './useTimelineAxis'

const axisOf = (totalSec = 20, viewportWidth = 720) =>
  useTimelineAxis({ totalSec: () => totalSec, viewportWidth: () => viewportWidth })

describe('useTimelineAxis（ruler/视频/音轨/播放头共享的唯一坐标系）', () => {
  it('pxPerSec = 24 × zoom，sec↔px 互逆', () => {
    const a = axisOf()
    expect(a.pxPerSec.value).toBe(TIMELINE_BASE_PX_PER_SEC)
    expect(a.secToPx(2)).toBe(48)
    expect(a.pxToSec(48)).toBe(2)
    a.zoom.value = 2
    expect(a.pxPerSec.value).toBe(48)
    expect(a.secToPx(2)).toBe(96)
  })

  it('zoom 夹在 0.5~8，缩放改变 contentWidth 但不改秒值语义', () => {
    const a = axisOf(40) // 内容宽 40*24=960 > 视口 720，缩放真实改变 contentWidth
    a.zoom.value = 100
    expect(a.zoom.value).toBe(TIMELINE_MAX_ZOOM)
    a.zoom.value = 0.01
    expect(a.zoom.value).toBe(TIMELINE_MIN_ZOOM)
    a.zoom.value = 1
    const w1 = a.contentWidth.value
    a.zoomIn()
    expect(a.contentWidth.value).toBeGreaterThan(w1)
    a.zoomOut()
    expect(a.contentWidth.value).toBeCloseTo(w1)
  })

  it('fit 用视口宽度反算 zoom，使 full timeline 恰好铺满', () => {
    const a = axisOf(30, 720)
    a.fit()
    // 720 / (30 * 24) = 1
    expect(a.zoom.value).toBeCloseTo(1)
    expect(a.contentWidth.value).toBeCloseTo(720)
    expect(a.secToPx(30)).toBeCloseTo(720)
  })

  it('scrollLeft 是纯 UI 态、夹下界，不影响 sec↔px 映射', () => {
    const a = axisOf()
    const before = a.secToPx(5)
    a.setScrollLeft(120)
    expect(a.scrollLeft.value).toBe(120)
    a.setScrollLeft(-10)
    expect(a.scrollLeft.value).toBe(0)
    expect(a.secToPx(5)).toBe(before)
  })

  it('snapSec：6px 内吸附到最近边缘，超阈值保持原值', () => {
    const a = axisOf() // 24 px/s → 6px = 0.25s
    expect(a.snapSec(1.9, [2, 5])).toBe(2)   // 0.1s = 2.4px < 6px
    expect(a.snapSec(2.1, [2, 5])).toBe(2)
    expect(a.snapSec(2.4, [2, 5])).toBe(2.4) // 0.4s = 9.6px > 6px
    expect(a.snapSec(5.05, [2, 5])).toBe(5)
  })

  it('snapSec 忽略 NaN/Infinity 边缘，空 edges 原值返回', () => {
    const a = axisOf()
    expect(a.snapSec(1.9, [Number.NaN, Number.POSITIVE_INFINITY, 2])).toBe(2)
    expect(a.snapSec(3.3, [])).toBe(3.3)
  })
})
