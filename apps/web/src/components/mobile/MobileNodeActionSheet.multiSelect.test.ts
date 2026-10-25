import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeActionSheet from './MobileNodeActionSheet.vue'

/**
 * 走查①（2026-10-24）：长按弹出两张重复的动作卡 ⇒ 删掉 CanvasContextMenu 的
 * 移动端 sheet 分支，本 sheet 成为移动端长按**唯一**入口。
 *
 * 随之迁移过来的还有 2026-10-21 走查的三态文案判据（长按第二张图时是
 * 「加入/移出」而不是重置整份选区）——入口可以合并，判据不能丢。
 */
describe('MobileNodeActionSheet 多选文案三态（随走查①迁移）', () => {
  function labelFor(node: {
    id: string
    type: string
    multiSelectActive?: boolean
    multiSelectSelected?: boolean
  }) {
    // ⚠️ 2026-10-25（§4.11 Menu 化）：走 `MobileSheet` 基座 ⇒ 必须 stub teleport
    const w = mount(MobileNodeActionSheet, { props: { node }, global: { stubs: { teleport: true } } })
    const btn = w.find('[data-action="multi-select"]')
    const text = btn.text()
    w.unmount()
    return text
  }

  it('未进多选态 ⇒「多选」（进入多选）', () => {
    expect(labelFor({ id: 'n1', type: 'image' })).toBe('多选')
    expect(labelFor({ id: 'n1', type: 'image', multiSelectActive: false })).toBe('多选')
  })

  it('多选态 + 该节点不在选区内 ⇒「加入多选」（累加，不重置）', () => {
    expect(labelFor({ id: 'n1', type: 'image', multiSelectActive: true, multiSelectSelected: false })).toBe(
      '加入多选',
    )
  })

  it('多选态 + 该节点已在选区内 ⇒「移出多选」', () => {
    expect(labelFor({ id: 'n1', type: 'image', multiSelectActive: true, multiSelectSelected: true })).toBe(
      '移出多选',
    )
  })

  it('文案是计算属性（态变化时按钮文案随之变，不是挂载时定死）', async () => {
    const w = mount(MobileNodeActionSheet, {
      props: { node: { id: 'n1', type: 'image', multiSelectActive: false } },
      global: { stubs: { teleport: true } },
    })
    expect(w.find('[data-action="multi-select"]').text()).toBe('多选')
    await w.setProps({ node: { id: 'n1', type: 'image', multiSelectActive: true, multiSelectSelected: true } })
    expect(w.find('[data-action="multi-select"]').text()).toBe('移出多选')
    w.unmount()
  })
})
