import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import {
  CANVAS_MULTI_SELECT_ACTIVE_KEY,
  CANVAS_NODE_ADD_AGENT_KEY,
  CANVAS_NODE_CLICK_GUARD_KEY,
  CANVAS_NODE_OPEN_CONTEXT_MENU_KEY,
  CANVAS_NODE_RENAME_KEY,
  CANVAS_NODE_RENAME_REQUEST_KEY,
} from '@/composables/canvasNodeActions'

vi.mock('@vue-flow/core', async () => {
  const { defineComponent, h } = await import('vue')
  const Handle = defineComponent({
    name: 'Handle',
    setup: (_, { slots }) => () => h('div', { class: 'mock-handle' }, slots.default?.()),
  })
  return {
    Handle,
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    useNode: () => ({ id: 'node-1' }),
    useVueFlow: () => ({ updateNodeData: vi.fn() }),
  }
})

import NeoBaseNode from './NeoBaseNode.vue'

/**
 * 长按链路（2026-10-19 D-6）：长按节点 → 打开上下文菜单（页面级出 sheet）+
 * 标记 click 抑制窗；位移超限/提前松手不触发；多选态渲染勾选徽标。
 */
describe('NeoBaseNode：长按上下文菜单 + 多选徽标（PR1）', () => {
  const openContextMenu = vi.fn()
  const markSuppressed = vi.fn()
  const multiSelectActive = ref(false)

  function mountNode(selected = false) {
    return mount(NeoBaseNode, {
      props: { nodeType: 'image', data: {}, selected },
      global: {
        provide: {
          [CANVAS_NODE_RENAME_KEY as symbol]: vi.fn(),
          [CANVAS_NODE_ADD_AGENT_KEY as symbol]: vi.fn(),
          [CANVAS_NODE_OPEN_CONTEXT_MENU_KEY as symbol]: openContextMenu,
          [CANVAS_NODE_CLICK_GUARD_KEY as symbol]: { markSuppressed, shouldSuppress: () => false },
          [CANVAS_MULTI_SELECT_ACTIVE_KEY as symbol]: multiSelectActive,
          [CANVAS_NODE_RENAME_REQUEST_KEY as symbol]: ref(null),
        },
      },
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    openContextMenu.mockClear()
    markSuppressed.mockClear()
    multiSelectActive.value = false
  })
  afterEach(() => vi.useRealTimers())

  function touch(target: Element, type: string, x = 0, y = 0) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', {
      value: [{ clientX: x, clientY: y }],
    })
    Object.defineProperty(event, 'target', { value: target })
    target.dispatchEvent(event)
    return event
  }

  it('长按 400ms 触发上下文菜单 + 标记 click 抑制', async () => {
    const w = mountNode()
    const wrapper = w.find('.neo-node-wrapper').element
    touch(wrapper, 'touchstart')
    vi.advanceTimersByTime(399)
    expect(openContextMenu, '400ms 前不触发').not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(openContextMenu).toHaveBeenCalledWith('node-1')
    expect(markSuppressed, '触发即标记抑制窗（防松手又选中）').toHaveBeenCalled()
    w.unmount()
  })

  it('位移超 10px 取消（用户在平移画布，不长按）', () => {
    const w = mountNode()
    const wrapper = w.find('.neo-node-wrapper').element
    touch(wrapper, 'touchstart', 0, 0)
    vi.advanceTimersByTime(200)
    touch(wrapper, 'touchmove', 40, 0)
    vi.advanceTimersByTime(1000)
    expect(openContextMenu).not.toHaveBeenCalled()
    w.unmount()
  })

  it('触摸起点在引用钮（button）上不长按——保留子控件点击语义', () => {
    const w = mountNode(true)
    const btn = w.find('.neo-node-agent-add--title').element
    touch(btn, 'touchstart')
    vi.advanceTimersByTime(1000)
    expect(openContextMenu).not.toHaveBeenCalled()
    w.unmount()
  })

  it('多选态 + 选中 → 渲染勾选徽标；非多选态不渲染', async () => {
    const w = mountNode(true)
    expect(w.find('.neo-node-multi-badge').exists(), '非多选态无徽标').toBe(false)
    multiSelectActive.value = true
    await w.vm.$nextTick()
    expect(w.find('.neo-node-multi-badge').exists(), '多选态选中节点应有勾选徽标').toBe(true)
    w.unmount()
  })

  it('行内重命名请求（长按 sheet「重命名」）打开输入框', async () => {
    const renameRequest = ref<string | null>(null)
    const w = mount(NeoBaseNode, {
      props: { nodeType: 'image', data: {} },
      global: {
        provide: {
          [CANVAS_NODE_RENAME_KEY as symbol]: vi.fn(),
          [CANVAS_NODE_OPEN_CONTEXT_MENU_KEY as symbol]: openContextMenu,
          [CANVAS_NODE_CLICK_GUARD_KEY as symbol]: { markSuppressed, shouldSuppress: () => false },
          [CANVAS_MULTI_SELECT_ACTIVE_KEY as symbol]: multiSelectActive,
          [CANVAS_NODE_RENAME_REQUEST_KEY as symbol]: renameRequest,
        },
      },
    })
    renameRequest.value = 'node-1'
    await w.vm.$nextTick()
    const input = w.find('.neo-node-rename-input')
    expect(input.exists(), '重命名请求应打开行内输入框').toBe(true)
    expect(renameRequest.value, '节点消费后清空请求').toBeNull()
    w.unmount()
  })
})
