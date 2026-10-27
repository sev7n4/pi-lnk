import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import NodeRenderer from './NodeRenderer.vue'
import CanvasNodeImage from './CanvasNodeImage.vue'
import { MOBILE_NODE_OPEN_PROMPT_REVIEW_KEY } from '@/composables/canvasNodeActions'

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

  // G1/S1（§4.7.1，2026-10-27）：磁贴 chips 单击 → 经注入键上抛页面层（与 tap 同分层）
  it('移动态磁贴 open-prompt-review → 注入回调收到节点（id/type/data）', async () => {
    setMobile(true)
    const openPromptReview = vi.fn()
    const w = shallowMount(NodeRenderer, {
      props: { id: 'n1', type: 'image', data: { url: 'x.png', prompt: '词' } },
      global: {
        provide: { [MOBILE_NODE_OPEN_PROMPT_REVIEW_KEY as symbol]: openPromptReview },
      },
    })
    const tile = w.findComponent({ name: 'MobileNodeTile' })
    expect(tile.exists()).toBe(true)
    await tile.vm.$emit('open-prompt-review')
    expect(openPromptReview).toHaveBeenCalledWith({
      id: 'n1',
      type: 'image',
      data: { url: 'x.png', prompt: '词' },
    })
    w.unmount()
  })
})
