import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import NodeRenderer from './NodeRenderer.vue'
import CanvasNodeImage from './CanvasNodeImage.vue'

function setMobile(on: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: on,
    media: q,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as any
}

describe('NodeRenderer', () => {
  beforeEach(() => setMobile(false))
  afterEach(() => vi.restoreAllMocks())

  it('桌面态渲染 legacy CanvasNodeImage 并透传 data', () => {
    const w = shallowMount(NodeRenderer, {
      props: { id: 'n1', type: 'image', data: { url: 'x.png' } },
    })
    const legacy = w.findComponent(CanvasNodeImage)
    expect(legacy.exists()).toBe(true)
    expect(legacy.props('data')).toMatchObject({ url: 'x.png' })
  })

  it('移动态渲染 MobileNodeTile（不渲染 legacy）', () => {
    setMobile(true)
    const w = shallowMount(NodeRenderer, {
      props: { id: 'n1', type: 'image', data: { url: 'x.png' } },
    })
    expect(w.findComponent({ name: 'MobileNodeTile' }).exists()).toBe(true)
    expect(w.findComponent(CanvasNodeImage).exists()).toBe(false)
  })
})
