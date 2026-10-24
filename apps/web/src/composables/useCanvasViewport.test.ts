import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createViewportRestorer,
  createViewportTracker,
  normalizeViewportPayload,
} from './useCanvasViewport'

describe('SP-C：视口恢复 —— restoreViewport（N5/N6）', () => {
  it('可用视口 ⇒ setViewport 带 clamp 值与 duration: 0（打开即在位，不二次动画）', () => {
    const calls: Array<{ vp: unknown; opts: unknown }> = []
    const restore = createViewportRestorer(() => ({
      setViewport: (vp, opts) => calls.push({ vp, opts }),
    }))
    expect(restore({ x: -120, y: 33, zoom: 1.25 })).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.vp).toEqual({ x: -120, y: 33, zoom: 1.25 })
    expect(calls[0]!.opts).toEqual({ duration: 0 })
  })

  it('zoom 越界 ⇒ 收敛到 [0.1, 2]，x/y 不动（N5）', () => {
    const calls: Array<{ x: number; y: number; zoom: number }> = []
    const restore = createViewportRestorer(() => ({
      setViewport: (vp) => calls.push(vp),
    }))
    restore({ x: 5, y: 6, zoom: 0.001 })
    restore({ x: 5, y: 6, zoom: 99 })
    expect(calls[0]).toEqual({ x: 5, y: 6, zoom: 0.1 })
    expect(calls[1]).toEqual({ x: 5, y: 6, zoom: 2 })
  })

  it('脏值 / 缺字段 ⇒ 不调用 setViewport，返回 false（回落默认 fitView，N1）', () => {
    const setViewport = vi.fn()
    const restore = createViewportRestorer(() => ({ setViewport }))
    expect(restore(undefined)).toBe(false)
    expect(restore({ x: NaN, y: 0, zoom: 1 })).toBe(false)
    expect(restore({ x: 0, y: 0 })).toBe(false)
    expect(setViewport).not.toHaveBeenCalled()
  })
})

describe('SP-C：视口采集 —— 防抖落库（N4）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('连续 10 次视口变化 ⇒ 落库只触发 1 次（不逐事件落库）', () => {
    const onPersist = vi.fn()
    const tracker = createViewportTracker({ onPersist })
    for (let i = 0; i < 10; i++) tracker.note({ x: i, y: i, zoom: 1 })
    expect(onPersist).not.toHaveBeenCalled()
    vi.advanceTimersByTime(400)
    expect(onPersist).toHaveBeenCalledTimes(1)
  })

  it('窗口内又变化 ⇒ 计时重置，仍然只落库 1 次', () => {
    const onPersist = vi.fn()
    const tracker = createViewportTracker({ onPersist })
    tracker.note({ x: 0, y: 0, zoom: 1 })
    vi.advanceTimersByTime(200)
    tracker.note({ x: 10, y: 10, zoom: 1 })
    vi.advanceTimersByTime(200)
    expect(onPersist).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(onPersist).toHaveBeenCalledTimes(1)
  })

  it('pending 始终是最新视口；脏值不污染 pending', () => {
    const tracker = createViewportTracker({ onPersist: vi.fn() })
    tracker.note({ x: 1, y: 2, zoom: 1 })
    tracker.note({ x: 9, y: 9, zoom: 1.5 })
    expect(tracker.pending).toEqual({ x: 9, y: 9, zoom: 1.5 })
    tracker.note(undefined)
    tracker.note({ x: NaN, y: 0, zoom: 1 })
    expect(tracker.pending).toEqual({ x: 9, y: 9, zoom: 1.5 })
  })

  it('flush 立即结算未触发的窗口；无待触发则 no-op', () => {
    const onPersist = vi.fn()
    const tracker = createViewportTracker({ onPersist })
    tracker.flush()
    expect(onPersist).not.toHaveBeenCalled()
    tracker.note({ x: 1, y: 1, zoom: 1 })
    tracker.flush()
    expect(onPersist).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(onPersist).toHaveBeenCalledTimes(1)
  })
})

describe('SP-C：viewportChange 载荷归一化（不赌事件签名）', () => {
  it('裸 {x,y,zoom} 与 {viewport:{…}} 两路都收', () => {
    expect(normalizeViewportPayload({ x: 1, y: 2, zoom: 1 })).toEqual({ x: 1, y: 2, zoom: 1 })
    expect(
      normalizeViewportPayload({ viewport: { x: 3, y: 4, zoom: 1 }, prevViewport: { x: 0, y: 0, zoom: 1 } }),
    ).toEqual({ x: 3, y: 4, zoom: 1 })
  })

  it('非法载荷 ⇒ null', () => {
    expect(normalizeViewportPayload(undefined)).toBeNull()
    expect(normalizeViewportPayload({})).toBeNull()
    expect(normalizeViewportPayload({ viewport: null })).toBeNull()
  })
})
