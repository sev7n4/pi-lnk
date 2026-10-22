import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeEditorSheet from './MobileNodeEditorSheet.vue'

describe('MobileNodeEditorSheet', () => {
  const baseNode = { id: 'n1', type: 'image', data: { url: 'x.png' } } as any

  it('挂载 DockStudioRouter 且不因缺上下文报错（R1 防删 Dock 后编辑断链）', () => {
    const w = mount(MobileNodeEditorSheet, { props: { node: baseNode } })
    expect(w.findComponent({ name: 'DockStudioRouter' }).exists()).toBe(true)
  })

  it('关闭按钮 emit close', async () => {
    const w = mount(MobileNodeEditorSheet, { props: { node: baseNode } })
    await w.find('[data-action="close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('内部 Router emit patch 向上透传', async () => {
    const w = mount(MobileNodeEditorSheet, { props: { node: baseNode } })
    // 直接触发透传通道，验证 editor sheet 不吞掉 patch
    const router = w.findComponent({ name: 'DockStudioRouter' })
    router.vm.$emit('patch', { title: 'hi' })
    expect(w.emitted('patch')).toEqual([[{ title: 'hi' }]])
  })
})
