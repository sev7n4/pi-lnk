import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentSelectionBindingChip from './AgentSelectionBindingChip.vue'

const nodes = [
  { id: 'a', type: 'image', title: '小柚定妆照' },
  { id: 'b', type: 'prompt', title: '第3镜' },
]

describe('AgentSelectionBindingChip（SEL-REF R-S8 确定性回执）', () => {
  it('显示「已绑定 N 个选中节点」', () => {
    const w = mount(AgentSelectionBindingChip, { props: { nodeIds: ['a', 'b'], nodes, confirmed: nodes } })
    expect(w.text()).toContain('已绑定 2 个选中节点')
  })

  it('展开后逐条列出 id · type · 标题', async () => {
    const w = mount(AgentSelectionBindingChip, { props: { nodeIds: ['a', 'b'], nodes, confirmed: nodes } })
    await w.find('[data-testid="binding-toggle"]').trigger('click')
    expect(w.text()).toContain('a · image · 小柚定妆照')
    expect(w.text()).toContain('b · prompt · 第3镜')
  })

  it('id 未被服务端确认时不渲染该行（不再「猜」类型与标题）', async () => {
    const w = mount(AgentSelectionBindingChip, { props: { nodeIds: ['zz'], nodes, confirmed: nodes } })
    await w.find('[data-testid="binding-toggle"]').trigger('click')
    expect(w.text()).not.toContain('zz')
    expect(w.text()).not.toContain('未知')
  })

  it('Review Focus #5：按**服务端确认的冻结事实**渲染，不受发送后选中态变化影响', async () => {
    const w = mount(AgentSelectionBindingChip, {
      props: { nodeIds: ['a'], nodes, confirmed: [{ id: 'a', type: 'image', title: '小柚定妆照' }] },
    })
    // 模拟"发送后用户改选"：实时 nodes 变成只剩 b，但回执仍按 confirmed 渲染
    await w.setProps({ nodes: [{ id: 'b', type: 'prompt', title: '第3镜' }] })
    await w.find('[data-testid="binding-toggle"]').trigger('click')
    expect(w.text()).toContain('a · image · 小柚定妆照')
    expect(w.text()).not.toContain('b ·')
  })

  it('nodeIds 为空时不渲染任何东西', () => {
    const w = mount(AgentSelectionBindingChip, { props: { nodeIds: [], nodes, confirmed: [] } })
    expect(w.find('[data-testid="selection-binding-chip"]').exists()).toBe(false)
  })
})

// ── 评审 C1 + Important #1：回执的数据源必须是「服务端确认」而非本地推定 ──────
describe('AgentSelectionBindingChip · 服务端确认驱动（评审 C1）', () => {
  const confirmed = [
    { id: 'a', type: 'image', title: '小柚定妆照' },
    { id: 'b', type: 'prompt', title: '第3镜' },
  ]

  it('confirmed 为空（服务端未确认 = 开关关着/节点全失效）→ 整块不渲染', () => {
    const w = mount(AgentSelectionBindingChip, { props: { nodeIds: ['a'], nodes, confirmed: [] } })
    expect(w.find('[data-testid="selection-binding-chip"]').exists()).toBe(false)
  })

  it('confirmed 有值才渲染，且计数取 confirmed 而非 nodeIds', () => {
    // 场景：用户选了 3 个，其中 1 个在发送瞬间被删 ⇒ 服务端只确认 2 个。
    // 若计数显示 3，就是回执在说谎。
    const w = mount(AgentSelectionBindingChip, {
      props: { nodeIds: ['a', 'b', 'ghost'], nodes, confirmed },
    })
    expect(w.text()).toContain('已绑定 2 个选中节点')
    expect(w.text()).not.toContain('已绑定 3 个')
  })

  it('title/type 取自 confirmed（服务端冻结的事实），不取发送后的实时 nodes', async () => {
    const w = mount(AgentSelectionBindingChip, { props: { nodeIds: ['a'], nodes, confirmed } })
    // 发送后节点被改名 ⇒ 实时 nodes 与 confirmed 不一致
    await w.setProps({ nodes: [{ id: 'a', type: 'image', title: '改名后' }] })
    await w.find('[data-testid="binding-toggle"]').trigger('click')
    expect(w.text()).toContain('a · image · 小柚定妆照')
    expect(w.text()).not.toContain('改名后')
  })

  it('未被确认的 id 不出现在展开列表里（与 digest 剔除规则一致）', async () => {
    const w = mount(AgentSelectionBindingChip, {
      props: { nodeIds: ['a', 'ghost'], nodes: [...nodes, { id: 'ghost', type: 'image', title: 'X' }], confirmed },
    })
    await w.find('[data-testid="binding-toggle"]').trigger('click')
    expect(w.text()).not.toContain('ghost')
  })
})
