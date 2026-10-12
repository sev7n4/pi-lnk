import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

import CanvasFloatingChrome from './CanvasFloatingChrome.vue'

/**
 * 入口迁移回归锁（2026-10-12 用户口径）：导入/导出工作流是非高频操作，
 * 从右上角常驻按钮收敛进左上角画布名称后的「...」菜单，画布保持简洁。
 * 锁定：「...」菜单含两项且点击 emit 对应事件并收起菜单。
 */
function mountChrome() {
  return mount(CanvasFloatingChrome, {
    props: { title: '我的画布' },
  })
}

describe('CanvasFloatingChrome：导入/导出迁入「...」菜单', () => {
  it('有效性前置：菜单默认收起，展开后含保存/分镜板/发布（既有项不回归）', async () => {
    const w = mountChrome()
    expect(w.find('.neo-popover').exists()).toBe(false)
    await w.find('.chrome-more-btn').trigger('click')
    const text = w.find('.neo-popover').text()
    for (const item of ['保存画布', '分镜板', '发布作品']) {
      expect(text).toContain(item)
    }
    w.unmount()
  })

  it('菜单含「导入工作流」「导出工作流」，点击 emit importWorkflow/exportWorkflow 并收起', async () => {
    const w = mountChrome()
    await w.find('.chrome-more-btn').trigger('click')
    const items = w.findAll('.neo-popover-item')
    const importBtn = items.find((b) => b.text() === '导入工作流')
    const exportBtn = items.find((b) => b.text() === '导出工作流')
    expect(importBtn, '导入工作流菜单项').toBeTruthy()
    expect(exportBtn, '导出工作流菜单项').toBeTruthy()
    await importBtn!.trigger('click')
    expect(w.emitted('importWorkflow')).toHaveLength(1)
    expect(w.find('.neo-popover').exists(), '点击后菜单应收起').toBe(false)
    await w.find('.chrome-more-btn').trigger('click')
    await exportBtn!.trigger('click')
    expect(w.emitted('exportWorkflow')).toHaveLength(1)
    w.unmount()
  })
})
