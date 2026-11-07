import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, ref, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useAgentDock, PANEL_MIN_W, PANEL_MAX_W, clamp } from './useAgentDock'

class MockResizeObserver {
  static last: MockResizeObserver | null = null
  observed: Element[] = []
  private cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
    MockResizeObserver.last = this
  }
  observe(el: Element) { this.observed.push(el) }
  unobserve(el: Element) { this.observed = this.observed.filter((e) => e !== el) }
  disconnect() { this.observed = [] }
  trigger(height: number) {
    this.cb([{ contentRect: { height } } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver

function makeDock(opts: {
  open?: boolean
  floating?: boolean
  panelWidth?: number
  isMobileLayout?: boolean
  bareBarEl?: HTMLElement | null
} = {}) {
  const open = ref(opts.open ?? true)
  const floating = ref(opts.floating ?? false)
  const panelWidth = ref(opts.panelWidth ?? 480)
  const floatWidth = ref(opts.panelWidth ?? 480)
  const floatPos = ref({ x: 0, y: 0 })
  const dragging = ref(false)
  const resizing = ref(false)
  const bareBarRef = ref<HTMLElement | null>(opts.bareBarEl ?? null)
  const panelShellRef = ref<HTMLElement | null>(null)
  const isMobileLayout = ref(opts.isMobileLayout ?? false)
  let dock!: ReturnType<typeof useAgentDock>
  const Cmp = defineComponent({
    setup() {
      dock = useAgentDock({
        open, floating, panelWidth, floatWidth, floatPos,
        dragging, resizing, bareBarRef, panelShellRef, isMobileLayout,
      })
      return {}
    },
    render: () => h('div'),
  })
  const wrapper = mount(Cmp)
  return { wrapper, dock, open, floating, panelWidth, floatWidth, floatPos, isMobileLayout, bareBarRef }
}

describe('useAgentDock', () => {
  beforeEach(() => {
    MockResizeObserver.last = null
    document.documentElement.style.setProperty('--lnk-agent-dock-h', '0px')
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true })
  })
  afterEach(() => {
    document.documentElement.style.removeProperty('--lnk-agent-dock-h')
  })

  it('clamp 与面板宽度常量', () => {
    expect(clamp(100, 420, 760)).toBe(420)
    expect(clamp(999, 420, 760)).toBe(760)
    expect(clamp(500, 420, 760)).toBe(500)
    expect(PANEL_MIN_W).toBe(420)
    expect(PANEL_MAX_W).toBe(760)
  })

  it('panelTeleported：浮窗或移动端须 Teleport 到 body', () => {
    const { dock, floating, isMobileLayout } = makeDock()
    expect(dock.panelTeleported.value).toBe(false)
    floating.value = true
    expect(dock.panelTeleported.value).toBe(true)
    floating.value = false
    isMobileLayout.value = true
    expect(dock.panelTeleported.value).toBe(true)
  })

  it('asidePanelWidth：非展开/浮窗/移动端均塌缩为 0px', () => {
    const { dock, open, floating, isMobileLayout } = makeDock({ panelWidth: 480 })
    expect(dock.asidePanelWidth.value).toBe('480px')
    open.value = false
    expect(dock.asidePanelWidth.value).toBe('0px')
    open.value = true
    floating.value = true
    expect(dock.asidePanelWidth.value).toBe('0px')
    floating.value = false
    isMobileLayout.value = true
    expect(dock.asidePanelWidth.value).toBe('0px')
    isMobileLayout.value = false
    expect(dock.asidePanelWidth.value).toBe('480px')
  })

  it('toggleFloating：桌面切换并定位到右侧；移动端 no-op', async () => {
    const { dock, floating, floatWidth, floatPos, isMobileLayout } = makeDock({ panelWidth: 480 })
    dock.toggleFloating()
    expect(floating.value).toBe(true)
    expect(floatWidth.value).toBe(480) // clamp(480, 420, 1024-48=976)
    expect(floatPos.value).toEqual({ x: Math.max(16, 1024 - 480 - 40), y: 56 })
    dock.toggleFloating()
    expect(floating.value).toBe(false)

    isMobileLayout.value = true
    floating.value = false
    dock.toggleFloating()
    expect(floating.value).toBe(false) // 移动端无浮窗概念
  })

  it('startResize：桌面更新 panelWidth 并钳制边界；移动端 no-op', async () => {
    const { dock, panelWidth, isMobileLayout, wrapper } = makeDock({ panelWidth: 480 })
    const before = panelWidth.value
    dock.startResize(new MouseEvent('mousedown') as MouseEvent)
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    expect(panelWidth.value).toBe(420) // clamp(200, 420, 760) = 420
    expect(panelWidth.value).not.toBe(before)
    void wrapper

    isMobileLayout.value = true
    const w2 = panelWidth.value
    dock.startResize(new MouseEvent('mousedown') as MouseEvent)
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 900 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    expect(panelWidth.value).toBe(w2) // 移动端 no-op
  })

  it('移动端裸条高度：isMobileLayout 时发布 CSS 变量；非移动端归零', async () => {
    const div = document.createElement('div')
    div.getBoundingClientRect = () => ({ height: 88 } as DOMRect)
    const { isMobileLayout, wrapper } = makeDock({ isMobileLayout: true, bareBarEl: div })
    await nextTick()
    // 挂载时 bareBarRef 已在 mobileDockRO 建立前求值 ⇒ 尚未发布；须待 RO 回调。
    expect(document.documentElement.style.getPropertyValue('--lnk-agent-dock-h')).toBe('0px')
    MockResizeObserver.last?.trigger(88)
    expect(document.documentElement.style.getPropertyValue('--lnk-agent-dock-h')).toBe('88px')
    isMobileLayout.value = false
    await nextTick()
    expect(document.documentElement.style.getPropertyValue('--lnk-agent-dock-h')).toBe('0px')
    wrapper.unmount()
  })
})
