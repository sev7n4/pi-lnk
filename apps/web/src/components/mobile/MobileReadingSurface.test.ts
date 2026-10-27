// 共享「全屏文本阅读面」（规格 §4.8.1，2026-10-27 S1 批次）：
// 手势仲裁与 MobileNodeViewer 同判据（§6.2 退出表 + 回归⑤双向关闭）；
// TTS 文本源参数化（speechText prop 注入，⛔ 共享面不摸 data.content）。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileReadingSurface from './MobileReadingSurface.vue'

beforeEach(() => {
  vi.restoreAllMocks()
  // jsdom 无 speechSynthesis / SpeechSynthesisUtterance —— 挂最小 stub，
  // 否则 composable 内 new SpeechSynthesisUtterance 抛错被 try/catch 静默吞掉
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    configurable: true,
    value: class {
      text: string
      constructor(text: string) {
        this.text = text
      }
    },
  })
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      cancel: vi.fn(),
      speak: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  })
})

function mountSurface(overrides: Record<string, unknown> = {}) {
  return mount(MobileReadingSurface, {
    props: { title: '提示词 · 封面图', speechText: '一段可朗读的提示词', ...overrides },
    slots: {
      default: '<p class="fake-content">正文内容</p>',
      actions: '<button class="fake-action">编辑</button>',
    },
    attachTo: document.body,
  })
}

describe('MobileReadingSurface 渲染（§4.8.1 共享壳）', () => {
  it('标题 + slot 正文 + 动作 slot 渲染', () => {
    const w = mountSurface()
    expect(w.find('[data-testid="mobile-reading-title"]').text()).toBe('提示词 · 封面图')
    expect(w.find('.fake-content').exists()).toBe(true)
    expect(w.find('.fake-action').exists()).toBe(true)
    w.unmount()
  })

  it('speechText 空 → 朗读按钮不渲染（动作 slot 仍在）', () => {
    const w = mountSurface({ speechText: '' })
    expect(w.find('[data-testid="mobile-reading-tts"]').exists()).toBe(false)
    expect(w.find('.fake-action').exists()).toBe(true)
    w.unmount()
  })

  it('X 关闭 → emit close', async () => {
    const w = mountSurface()
    await w.find('[data-testid="mobile-reading-close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })
})

describe('MobileReadingSurface 退出手势仲裁（与 viewer 同判据）', () => {
  it('顶部下拉 ≥100px（scrollTop=0）⇒ 关闭（§6.2 退出表）', async () => {
    const w = mountSurface()
    const root = w.get('[data-testid="mobile-reading-surface"]')
    await root.trigger('touchstart', { touches: [{ clientY: 150 }] })
    await root.trigger('touchmove', { touches: [{ clientY: 300 }] })
    await root.trigger('touchend')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('滚动途中（scrollTop>0）下拉不关闭（W-30 长文误关）', async () => {
    const w = mountSurface()
    ;(w.get('[data-testid="mobile-reading-body"]').element as HTMLElement).scrollTop = 500
    const root = w.get('[data-testid="mobile-reading-surface"]')
    await root.trigger('touchstart', { touches: [{ clientY: 150 }] })
    await root.trigger('touchmove', { touches: [{ clientY: 300 }] })
    await root.trigger('touchend')
    expect(w.emitted('close')).toBeFalsy()
    w.unmount()
  })

  it('无滚动内容时上滑任意位置 ⇒ 关闭（回归⑤双向关闭）', async () => {
    const w = mountSurface()
    const root = w.get('[data-testid="mobile-reading-surface"]')
    await root.trigger('touchstart', { touches: [{ clientY: 300 }] })
    await root.trigger('touchmove', { touches: [{ clientY: 100 }] })
    await root.trigger('touchend')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('gestureLocked（标注/编辑态）⇒ 手势全部不触发关闭（评审 C1 同款）', async () => {
    const w = mountSurface({ gestureLocked: true })
    const root = w.get('[data-testid="mobile-reading-surface"]')
    await root.trigger('touchstart', { touches: [{ clientY: 150 }] })
    await root.trigger('touchmove', { touches: [{ clientY: 300 }] })
    await root.trigger('touchend')
    await root.trigger('touchstart', { touches: [{ clientY: 300 }] })
    await root.trigger('touchmove', { touches: [{ clientY: 100 }] })
    await root.trigger('touchend')
    expect(w.emitted('close')).toBeFalsy()
    w.unmount()
  })
})

describe('MobileReadingSurface 朗读（TTS 文本源参数化）', () => {
  it('朗读按钮 → speechSynthesis.speak(speechText)；再点 → cancel（可停）', async () => {
    const speak = vi.fn()
    const cancel = vi.fn()
    ;(window.speechSynthesis as unknown as { speak: typeof speak; cancel: typeof cancel }).speak = speak
    ;(window.speechSynthesis as unknown as { speak: typeof speak; cancel: typeof cancel }).cancel = cancel
    const w = mountSurface()
    const btn = w.find('[data-testid="mobile-reading-tts"]')
    expect(btn.text()).toBe('朗读')
    await btn.trigger('click')
    // composable 传的是 SpeechSynthesisUtterance 实例（.text 承载朗读文本）
    expect(speak).toHaveBeenCalledTimes(1)
    expect((speak.mock.calls[0]![0] as { text: string }).text).toBe('一段可朗读的提示词')
    expect(w.find('[data-testid="mobile-reading-tts"]').text()).toBe('停止')
    await w.find('[data-testid="mobile-reading-tts"]').trigger('click')
    expect(cancel).toHaveBeenCalled()
    w.unmount()
  })

  it('X 关闭时朗读立即停止（退出即停，P3）', async () => {
    const cancel = vi.fn()
    ;(window.speechSynthesis as unknown as { cancel: typeof cancel }).cancel = cancel
    const w = mountSurface()
    await w.find('[data-testid="mobile-reading-tts"]').trigger('click')
    await w.find('[data-testid="mobile-reading-close"]').trigger('click')
    expect(cancel).toHaveBeenCalled()
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })
})
