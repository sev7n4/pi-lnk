import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentSelectionBindingChip from './AgentSelectionBindingChip.vue'

const nodes = [
  { id: 'a', type: 'image', title: '小柚定妆照' },
  { id: 'b', type: 'prompt', title: '第3镜' },
]

describe('AgentSelectionBindingChip（SEL-REF R-S8 确定性回执）', () => {
  it('显示「已绑定 N 个选中节点」', () => {
    const w = mount(AgentSelectionBindingChip, { props: { nodeIds: ['a', 'b'], nodes } })
    expect(w.text()).toContain('已绑定 2 个选中节点')
  })

  it('展开后逐条列出 id · type · 标题', async () => {
    const w = mount(AgentSelectionBindingChip, { props: { nodeIds: ['a', 'b'], nodes } })
    await w.find('[data-testid="binding-toggle"]').trigger('click')
    expect(w.text()).toContain('a · image · 小柚定妆照')
    expect(w.text()).toContain('b · prompt · 第3镜')
  })

  it('id 不在 nodes 里时仍显示该 id，类型标未知、标题留空', async () => {
    const w = mount(AgentSelectionBindingChip, { props: { nodeIds: ['zz'], nodes } })
    await w.find('[data-testid="binding-toggle"]').trigger('click')
    expect(w.text()).toContain('zz')
    expect(w.text()).toContain('未知')
  })

  it('Review Focus #5：用**本轮发出的 id 集合**渲染，不受发送后选中态变化影响', async () => {
    const w = mount(AgentSelectionBindingChip, { props: { nodeIds: ['a'], nodes } })
    // 模拟"发送后用户改选"：nodes 变成只剩 b，但回执仍按冻结的 id 渲染
    await w.setProps({ nodes: [{ id: 'b', type: 'prompt', title: '第3镜' }] })
    await w.find('[data-testid="binding-toggle"]').trigger('click')
    expect(w.text()).toContain('a')
    expect(w.text()).not.toContain('b ·')
  })

  it('nodeIds 为空时不渲染任何东西', () => {
    const w = mount(AgentSelectionBindingChip, { props: { nodeIds: [], nodes } })
    expect(w.find('[data-testid="selection-binding-chip"]').exists()).toBe(false)
  })
})
