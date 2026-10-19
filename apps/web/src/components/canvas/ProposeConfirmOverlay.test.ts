import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

// 可变 mock 帧：默认单节点 200×200 位于 (100,100)——minY=100、bottomY=312（含 +12）、centerX=200
const frameMock = ref({
  minX: 100,
  minY: 100,
  maxX: 300,
  maxY: 300,
  centerX: 200,
  centerY: 200,
  bottomY: 312,
  connectX: 300,
  connectY: 200,
})

vi.mock('@vue-flow/core', () => ({
  useVueFlow: () => ({
    viewport: ref({ x: 0, y: 0, zoom: 1 }),
    nodes: ref([]),
    findNode: () => undefined,
  }),
}))
vi.mock('@/composables/useCanvasGrouping', () => ({
  getSelectionFrame: () => frameMock.value,
}))

import ProposeConfirmOverlay from './ProposeConfirmOverlay.vue'

function mountOverlay(props: Record<string, unknown> = {}) {
  return mount(ProposeConfirmOverlay, {
    props: {
      node: { id: 'n1', data: { status: 'pending_confirm' } },
      ...props,
    },
  })
}

describe('ProposeConfirmOverlay（ADR-0011 T1 节点内联确认面）', () => {
  it('pending_confirm 节点渲染确认 / 编辑 / 取消三动作', () => {
    const wrapper = mountOverlay()
    expect(wrapper.find('[data-testid="propose-confirm-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="propose-confirm-confirm"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="propose-confirm-edit"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="propose-confirm-cancel"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('三动作各 emit 对应事件并携带 nodeId', async () => {
    const wrapper = mountOverlay()
    await wrapper.get('[data-testid="propose-confirm-confirm"]').trigger('click')
    await wrapper.get('[data-testid="propose-confirm-edit"]').trigger('click')
    await wrapper.get('[data-testid="propose-confirm-cancel"]').trigger('click')
    expect(wrapper.emitted('confirm')).toEqual([['n1']])
    expect(wrapper.emitted('edit')).toEqual([['n1']])
    expect(wrapper.emitted('cancel')).toEqual([['n1']])
    wrapper.unmount()
  })

  it('非待确认态（draft / generating / completed / 空节点）不渲染', () => {
    for (const status of ['draft', 'generating', 'completed', undefined]) {
      const wrapper = mountOverlay({ node: { id: 'n1', data: { status } } })
      expect(wrapper.find('[data-testid="propose-confirm-overlay"]').exists()).toBe(false)
      wrapper.unmount()
    }
    const empty = mountOverlay({ node: null })
    expect(empty.find('[data-testid="propose-confirm-overlay"]').exists()).toBe(false)
    empty.unmount()
  })

  it('默认锚节点上方（above）；顶部空间不足翻转为下方（below）', async () => {
    // minY=100 ⇒ aboveTop = 100-40-8 = 52 ≥ 8 ⇒ above，top=52px
    const above = mountOverlay()
    const aboveEl = above.get('[data-testid="propose-confirm-overlay"]')
    expect(aboveEl.attributes('data-anchor')).toBe('above')
    expect(aboveEl.attributes('style')).toContain('top: 52px')
    above.unmount()

    // 节点贴顶（minY=20）⇒ aboveTop = -28 < 8 ⇒ 翻转到下方 bottomY=232
    frameMock.value = { ...frameMock.value, minY: 20, maxY: 220, bottomY: 232 }
    const below = mountOverlay()
    const belowEl = below.get('[data-testid="propose-confirm-overlay"]')
    expect(belowEl.attributes('data-anchor')).toBe('below')
    expect(belowEl.attributes('style')).toContain('top: 232px')
    below.unmount()

    frameMock.value = {
      minX: 100,
      minY: 100,
      maxX: 300,
      maxY: 300,
      centerX: 200,
      centerY: 200,
      bottomY: 312,
      connectX: 300,
      connectY: 200,
    }
  })
})
