import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

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
  it('T-6 触控：移动端按钮 44px（PC 保持 28px），栏高同步 40→56', () => {
    // 2026-10-20 真机走查：确认/编辑/取消 三按钮真机实测仅 28px 高 < 44px（T-6 不达标）。
    // 契约钉死：移动端提至 44px 且栏高常量同步；**PC 基础样式逐字不动**（形态不动纪律）。
    const sfc = readFileSync(join(here, 'ProposeConfirmOverlay.vue'), 'utf8')

    // ① 移动端媒体查询内按钮 44px
    expect(sfc, '移动端须把按钮提到 44px').toMatch(
      /@media \(max-width: 767px\)[\s\S]*?\.propose-confirm-btn \{[\s\S]*?height: 44px/,
    )
    // ② PC 基础仍是 28px（有效性配对：确保不是把 PC 也改了）
    const base = sfc.match(/\.propose-confirm-btn \{[^}]*\}/)?.[0] ?? ''
    expect(base, 'PC 基础按钮高度须保持 28px').toContain('height: 28px')
    // ③ 栏高常量随断点切换，且上方翻转判定读的是 computed 值
    expect(sfc, '移动端栏高常量须为 56').toContain('BAR_HEIGHT_MOBILE = 56')
    expect(sfc, 'PC 栏高常量须保持 40').toContain('BAR_HEIGHT_PC = 40')
    expect(sfc, '布局计算须读 BAR_HEIGHT.value（否则移动端留白用错常量）').toContain(
      'BAR_HEIGHT.value',
    )
  })

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

  it('P0.1 part 锚：proposeWaiting=true 时 draft 节点也渲染（等待期 status 迟到不吞确认面）', () => {
    // §14 F1：等待期 update_node{pending_confirm} 随 tool_result 迟到 ⇒ status 仍 draft。
    // host 已按 deriveProposeConfirmAnchor 双源选出节点；part 锚定命中必须立即可见。
    const wrapper = mountOverlay({
      node: { id: 'n1', data: { status: 'draft' } },
      proposeWaiting: true,
    })
    expect(wrapper.find('[data-testid="propose-confirm-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="propose-confirm-confirm"]').exists()).toBe(true)
    wrapper.unmount()
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
