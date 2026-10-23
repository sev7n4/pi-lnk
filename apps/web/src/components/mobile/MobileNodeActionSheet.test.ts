import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeActionSheet from './MobileNodeActionSheet.vue'

describe('MobileNodeActionSheet', () => {
  const baseNode = { id: 'n1', type: 'image', data: { url: 'x.png' } }

  it('渲染管理动作列表（重命名/引用/副本/多选/编辑/删除）', () => {
    const w = mount(MobileNodeActionSheet, { props: { node: baseNode } })
    expect(w.text()).toContain('重命名')
    expect(w.text()).toContain('引用')
    expect(w.text()).toContain('副本')
    expect(w.text()).toContain('多选')
    expect(w.text()).toContain('编辑')
    expect(w.text()).toContain('删除')
  })

  it('点击「编辑」emit action(edit)', async () => {
    const w = mount(MobileNodeActionSheet, { props: { node: baseNode } })
    await w.find('[data-action="edit"]').trigger('click')
    expect(w.emitted('action')).toEqual([['edit']])
  })

  it('点击「删除」emit action(delete)', async () => {
    const w = mount(MobileNodeActionSheet, { props: { node: baseNode } })
    await w.find('[data-action="delete"]').trigger('click')
    expect(w.emitted('action')).toEqual([['delete']])
  })

  it('点击取消 emit close', async () => {
    const w = mount(MobileNodeActionSheet, { props: { node: baseNode } })
    await w.find('[data-action="cancel"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })
})
