/**
 * T12 行为级：历史失败节点的「忽略 / 不再提示」按钮。
 *
 * ⚠️ 断言落在真实 DOM 与注入回调的可观测行为上：
 * - 按错 nodeId / 不调用 / 对错误 scope 显示按钮，都必须转红（§11 M7）；
 * - 不落生产 DB，只测组件把「用户意图」交给页面级 provider 的这一段。
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('@vue-flow/core', () => ({
  useNodeId: () => 'node-42',
}))
vi.mock('@/composables/useMediaInspector', () => ({
  useMediaInspector: () => ({ openInspector: vi.fn() }),
}))

import NodeTaskCornerActions from './NodeTaskCornerActions.vue'
import { CANVAS_NODE_DISMISS_FAILURE_KEY } from '@/composables/canvasNodeActions'

type ActionsProps = {
  status?: unknown
  failureScope?: unknown
  errorMessage?: string
  errorCode?: string
  errorDetail?: 'row' | 'status-icon'
}

function mountActions(props: ActionsProps, dismiss = vi.fn()) {
  return mount(NodeTaskCornerActions, {
    props,
    global: {
      provide: { [CANVAS_NODE_DISMISS_FAILURE_KEY as symbol]: dismiss },
    },
  })
}

describe('T12 历史失败「忽略」按钮（行为级）', () => {
  it('⭐ historical 失败终态 ⇒ 显示「忽略」，点击以当前 nodeId 调注入回调', async () => {
    const dismiss = vi.fn()
    const w = mountActions({ status: 'failed', failureScope: 'historical' }, dismiss)
    const btn = w.find('.neo-task-dismiss-btn')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toBe('忽略')
    await btn.trigger('click')
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(dismiss).toHaveBeenCalledWith('node-42')
  })

  it('error 终态同属历史失败 ⇒ 也可忽略', async () => {
    const dismiss = vi.fn()
    const w = mountActions({ status: 'error', failureScope: 'historical' }, dismiss)
    await w.find('.neo-task-dismiss-btn').trigger('click')
    expect(dismiss).toHaveBeenCalledWith('node-42')
  })

  it('dismissed ⇒ 无按钮（用户已忽略，不重复打扰）', () => {
    const w = mountActions({ status: 'failed', failureScope: 'dismissed' })
    expect(w.find('.neo-task-dismiss-btn').exists()).toBe(false)
  })

  it('scope 缺省 / active ⇒ 无按钮（本次真实失败由 toast + 重试承担）', () => {
    expect(mountActions({ status: 'failed' }).find('.neo-task-dismiss-btn').exists()).toBe(false)
    expect(
      mountActions({ status: 'failed', failureScope: 'active' }).find('.neo-task-dismiss-btn').exists(),
    ).toBe(false)
  })

  it('非失败终态 + historical ⇒ 无按钮（生成中 / 已完成不可忽略）', () => {
    expect(
      mountActions({ status: 'generating', failureScope: 'historical' }).find('.neo-task-dismiss-btn').exists(),
    ).toBe(false)
    expect(
      mountActions({ status: 'completed', failureScope: 'historical' }).find('.neo-task-dismiss-btn').exists(),
    ).toBe(false)
  })

  it('dismissed ⇒ 隐藏活跃错误条（即使仍残留 errorMessage）', () => {
    const w = mountActions({
      status: 'failed',
      failureScope: 'dismissed',
      errorMessage: '上游超时，请稍后重试',
    })
    expect(w.find('.neo-task-error-wrap').exists()).toBe(false)
  })

  it('未注入 provider 时点击 fail-soft（不抛错）', async () => {
    const w = mount(NodeTaskCornerActions, {
      props: { status: 'failed', failureScope: 'historical' },
    })
    await expect(w.find('.neo-task-dismiss-btn').trigger('click')).resolves.toBeUndefined()
  })
})
