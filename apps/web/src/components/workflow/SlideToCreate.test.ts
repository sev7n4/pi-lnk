import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SlideToCreate from './SlideToCreate.vue'

/**
 * SlideToCreate 边界测试（2026-10-25 PR-0 补）。
 *
 * 为什么补：本组件是移动端**主路径**（移动端没有 hover，滑动是主要触发方式），
 * 逻辑却不平凡 —— pointer capture / knobX 计算 / UNLOCK_RATIO 阈值 / pointercancel /
 * disabled 守卫。此前只有 2 条经 SignatureHero 的集成级间接覆盖，
 * 「拖一半松手」「创作进行中误触」这类边界没有直覆 ⇒ 并发创建会话的回归抓不到。
 *
 * 常量（与组件内保持一致）：KNOB=48、TRACK_PADDING=8、UNLOCK_RATIO=0.72。
 * jsdom 下 trackEl.clientWidth 为 0 ⇒ maxSpan = max(1, 0-48-8) = 1 ⇒ 阈值 = 0.72px。
 * 为让断言可读，这里显式 stub clientWidth 为 320 ⇒ maxSpan = 264、阈值 = 190.08px。
 */
const TRACK_WIDTH = 320
const MAX_SPAN = TRACK_WIDTH - 48 - 8 // 264
const UNLOCK_AT = MAX_SPAN * 0.72 // 190.08

function mountSlide(props: { disabled?: boolean } = {}) {
  const wrapper = mount(SlideToCreate, { props })
  // stub clientWidth：jsdom 默认 0，会让 maxSpan 退化成 1、阈值退化成 0.72px
  Object.defineProperty(wrapper.find('.lnk-slide').element, 'clientWidth', {
    configurable: true,
    value: TRACK_WIDTH,
  })
  return wrapper
}

/**
 * ⚠️ 事件构造方式（踩过的坑）：`wrapper.trigger('pointerdown', { clientX })` 走的是
 * `Object.assign(event, opts)`，而 MouseEvent 的 `clientX` 是 **getter-only** ⇒
 * 严格模式下抛 "Cannot set property clientX of #<MouseEvent>"。
 * 这个报错是**测试脚手架的问题，不是组件的问题** —— 若当时误判为"组件坏了"就会去改生产代码。
 * 正确做法：自建事件 + `Object.defineProperty` 注入只读属性，再 `dispatchEvent`。
 */
function firePointer(el: Element, type: string, clientX: number) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clientX', { value: clientX })
  Object.defineProperty(ev, 'pointerId', { value: 1 })
  el.dispatchEvent(ev)
}

function fireKey(el: Element, key: string) {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  el.dispatchEvent(ev)
}

describe('SlideToCreate 边界', () => {
  it('拖到一半松手（未过阈值）：不触发 create，把手回中位', async () => {
    const wrapper = mountSlide()
    const track = wrapper.find('.lnk-slide').element
    firePointer(track, 'pointerdown', 0)
    firePointer(track, 'pointermove', 100) // 100 < 190.08
    firePointer(track, 'pointerup', 0)
    await flushPromises()
    expect(wrapper.emitted('create')).toBeUndefined()
    // 回中位：位移归零（否则把手卡在中途，用户不知道还能不能再拖）
    expect(wrapper.find('.lnk-slide__knob').attributes('style') ?? '').toContain('translateX(0px)')
  })

  it('过阈值松手：触发 create 且只触发一次', async () => {
    const wrapper = mountSlide()
    const track = wrapper.find('.lnk-slide').element
    firePointer(track, 'pointerdown', 0)
    firePointer(track, 'pointermove', UNLOCK_AT + 20)
    firePointer(track, 'pointerup', 0)
    await flushPromises()
    expect(wrapper.emitted('create')).toHaveLength(1)
    // 连续再拖一次：unlocked 未复位前不得二次触发（防并发创建多个会话）
    firePointer(track, 'pointerdown', 0)
    firePointer(track, 'pointermove', UNLOCK_AT + 20)
    firePointer(track, 'pointerup', 0)
    await flushPromises()
    expect(wrapper.emitted('create')).toHaveLength(1)
  })

  it('pointercancel：不触发 create，把手回中位', async () => {
    const wrapper = mountSlide()
    const track = wrapper.find('.lnk-slide').element
    firePointer(track, 'pointerdown', 0)
    firePointer(track, 'pointermove', UNLOCK_AT + 20)
    // 系统打断（来电 / 手势接管）走 pointercancel，与 pointerup 同一处理器
    firePointer(track, 'pointercancel', 0)
    await flushPromises()
    expect(wrapper.emitted('create')).toBeUndefined()
    expect(wrapper.find('.lnk-slide__knob').attributes('style') ?? '').toContain('translateX(0px)')
  })

  it('disabled 时拖动与键盘都不触发（创作进行中）', async () => {
    const wrapper = mountSlide({ disabled: true })
    const track = wrapper.find('.lnk-slide').element
    firePointer(track, 'pointerdown', 0)
    firePointer(track, 'pointermove', UNLOCK_AT + 20)
    firePointer(track, 'pointerup', 0)
    await flushPromises()
    expect(wrapper.emitted('create')).toBeUndefined()

    const knob = wrapper.find('.lnk-slide__knob').element
    fireKey(knob, 'Enter')
    fireKey(knob, ' ')
    await flushPromises()
    expect(wrapper.emitted('create')).toBeUndefined()
  })

  it('把手是真 button：键盘可达（Enter / Space 可触发同一个 create）', async () => {
    const wrapper = mountSlide()
    const knob = wrapper.find('.lnk-slide__knob')
    expect(knob.element.tagName).toBe('BUTTON')
    fireKey(knob.element, 'Enter')
    await flushPromises()
    expect(wrapper.emitted('create')).toHaveLength(1)
  })

  it('解锁后 650ms 自动归位（与 stamp 微时刻对齐，不留永久锁定态）', async () => {
    vi.useFakeTimers()
    const wrapper = mountSlide()
    const track = wrapper.find('.lnk-slide').element
    firePointer(track, 'pointerdown', 0)
    firePointer(track, 'pointermove', UNLOCK_AT + 20)
    firePointer(track, 'pointerup', 0)
    await flushPromises()
    expect(wrapper.emitted('create')).toHaveLength(1)
    expect(wrapper.find('.lnk-slide').classes()).toContain('lnk-slide--unlocked')
    vi.advanceTimersByTime(650)
    await flushPromises()
    expect(wrapper.find('.lnk-slide').classes()).not.toContain('lnk-slide--unlocked')
  })
})
