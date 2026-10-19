import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useLongPress } from './useLongPress'

/** 构造最小 TouchEvent（vitest node 环境无 DOM TouchEvent 构造器） */
function touchEvent(type: string, x = 0, y = 0, touches = 1): TouchEvent {
  const list = Array.from({ length: touches }, () => ({ clientX: x, clientY: y }))
  return {
    type,
    touches: list,
    target: {},
    preventDefault: vi.fn(),
  } as unknown as TouchEvent
}

describe('useLongPress (D-6)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('400ms 按住触发一次回调', () => {
    const cb = vi.fn()
    const { bindings } = useLongPress(cb)
    bindings.onTouchstart(touchEvent('touchstart'))
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(399)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('提前松手不触发', () => {
    const cb = vi.fn()
    const { bindings } = useLongPress(cb)
    bindings.onTouchstart(touchEvent('touchstart'))
    vi.advanceTimersByTime(200)
    bindings.onTouchend(touchEvent('touchend'))
    vi.advanceTimersByTime(1000)
    expect(cb).not.toHaveBeenCalled()
  })

  it('位移超 10px 取消（用户在平移画布）', () => {
    const cb = vi.fn()
    const { bindings } = useLongPress(cb)
    bindings.onTouchstart(touchEvent('touchstart', 0, 0))
    vi.advanceTimersByTime(200)
    bindings.onTouchmove(touchEvent('touchmove', 30, 0))
    vi.advanceTimersByTime(1000)
    expect(cb).not.toHaveBeenCalled()
  })

  it('touchcancel（浏览器接管为滚动）取消', () => {
    const cb = vi.fn()
    const { bindings } = useLongPress(cb)
    bindings.onTouchstart(touchEvent('touchstart'))
    vi.advanceTimersByTime(200)
    bindings.onTouchcancel()
    vi.advanceTimersByTime(1000)
    expect(cb).not.toHaveBeenCalled()
  })

  it('多指（捏合）不触发', () => {
    const cb = vi.fn()
    const { bindings } = useLongPress(cb)
    bindings.onTouchstart(touchEvent('touchstart', 0, 0, 2))
    vi.advanceTimersByTime(1000)
    expect(cb).not.toHaveBeenCalled()
  })

  it('触发后 touchend 抑制合成 click + consumeSuppression 双保险', () => {
    const cb = vi.fn()
    const { bindings, consumeSuppression } = useLongPress(cb)
    bindings.onTouchstart(touchEvent('touchstart'))
    vi.advanceTimersByTime(400)
    expect(cb).toHaveBeenCalledTimes(1)

    const end = touchEvent('touchend')
    bindings.onTouchend(end)
    expect(end.preventDefault).toHaveBeenCalled()
    // 一次性旗标：消费一次后不再抑制后续正常 click
    expect(consumeSuppression()).toBe(true)
    expect(consumeSuppression()).toBe(false)
  })

  it('触摸起点在 button 内不触发（子控件保留自己的点击语义）', () => {
    const cb = vi.fn()
    const { bindings } = useLongPress(cb)
    const event = touchEvent('touchstart')
    ;(event as unknown as { target: HTMLElement }).target = {
      closest: (sel: string) => (sel.includes('button') ? {} : null),
    } as unknown as HTMLElement
    bindings.onTouchstart(event)
    vi.advanceTimersByTime(1000)
    expect(cb).not.toHaveBeenCalled()
  })

  it('isPressing 在按下到触发前为 true', async () => {
    const cb = vi.fn()
    const { bindings, isPressing } = useLongPress(cb)
    expect(isPressing.value).toBe(false)
    bindings.onTouchstart(touchEvent('touchstart'))
    await nextTick()
    expect(isPressing.value).toBe(true)
    vi.advanceTimersByTime(400)
    expect(isPressing.value).toBe(false)
  })

  it('自定义 delay/moveTolerance 生效', () => {
    const cb = vi.fn()
    const { bindings } = useLongPress(cb, { delay: 100, moveTolerance: 50 })
    bindings.onTouchstart(touchEvent('touchstart'))
    vi.advanceTimersByTime(99)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(cb).toHaveBeenCalledTimes(1)
    // 100ms 已触发，再移动不取消已完成的触发
    bindings.onTouchmove(touchEvent('touchmove', 200, 200))
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
