import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileConnectModeOverlay from './MobileConnectModeOverlay.vue'
import {
  useMobileNodeConnect,
  __resetMobileConnectForTest,
} from '@/composables/useMobileNodeConnect'

/**
 * 连线模式浮层守卫。
 * ⭐ 变异自检：断言精确——pendingSource 为空时不渲染（删 v-if ⇒ RED）、
 * 提示文案/取消按钮缺失 ⇒ RED；点取消后 pendingSource 归零（按钮绑错方法 ⇒ RED）。
 */
describe('MobileConnectModeOverlay（点选式连线提示 + 取消）', () => {
  beforeEach(() => __resetMobileConnectForTest())

  it('pendingSource 非空时浮出「选择要连接的目标」提示 + 取消按钮', () => {
    const connect = useMobileNodeConnect()
    connect.enter('a')
    const w = mount(MobileConnectModeOverlay)
    expect(w.find('[data-testid="connect-mode-overlay"]').exists()).toBe(true)
    expect(w.text()).toContain('选择要连接的目标')
    expect(w.find('[data-testid="connect-mode-cancel"]').exists()).toBe(true)
    w.unmount()
  })

  it('pendingSource 为空时不渲染（非连线态零干扰）', () => {
    const w = mount(MobileConnectModeOverlay)
    expect(w.find('[data-testid="connect-mode-overlay"]').exists()).toBe(false)
    w.unmount()
  })

  it('点取消 ⇒ cancel() 清空 pending（R-C4 三选一之一）', async () => {
    const connect = useMobileNodeConnect()
    connect.enter('a')
    expect(connect.pendingSource.value).toBe('a')
    const w = mount(MobileConnectModeOverlay)
    await w.find('[data-testid="connect-mode-cancel"]').trigger('click')
    expect(connect.pendingSource.value).toBeNull()
    w.unmount()
  })
})
