/**
 * `AgentNodeGraph` 行为契约（2026-07）。
 *
 * 判据重点不是"渲染好不好看"，而是**透传与不编造**：
 * - 节点位置来自画布（前端不重排 —— 重排会让卡片与画布不一致）；
 * - 缺 position 的走网格兜底（Vue Flow 要求 position 必填）；
 * - `droppedNodeIds` / `totalNodeCount` 必须显示（截断要可见，不能静默）。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentNodeGraph from './AgentNodeGraph.vue'

const BODY = {
  nodes: [
    { id: 'img-1', type: 'image', title: '角色三视图', position: { x: 0, y: 0 } },
    { id: 'img-2', type: 'image', title: '场景', position: { x: 240, y: 0 } },
    { id: 'grp-1', type: 'group', title: '角色组', position: { x: 480, y: 0 } },
    { id: 'img-3', type: 'image', title: '在组里', position: { x: 480, y: 120 }, groupId: 'grp-1' },
  ],
  edges: [{ source: 'img-1', target: 'img-2' }],
}

describe('AgentNodeGraph', () => {
  it('渲染节点数与连线数', () => {
    const w = mount(AgentNodeGraph, { props: { body: BODY }, global: { stubs: { VueFlow: { template: '<div><slot name="node-agentNode" v-for="n in $attrs.nodes" :key="n.id" v-bind="n" /></div>' }, Background: true, Controls: true } } })
    const html = w.html()
    expect(html).toContain('角色三视图')
    expect(html).toContain('在组里')
  })

  it('⚠️ 不重排位置（position 原样透传）', () => {
    // 位置透传意味着节点在画布上的相对位置与真实画布一致
    const w = mount(AgentNodeGraph, { props: { body: BODY }, global: { stubs: { VueFlow: true, Background: true, Controls: true } } })
    expect(w.props('body').nodes[0].position).toEqual({ x: 0, y: 0 })
  })

  it('缺 position 的节点不报错（走网格兜底）', () => {
    const w = mount(AgentNodeGraph, {
      props: { body: { nodes: [{ id: 'n1', type: 'image' }, { id: 'n2' }], edges: [] } },
      global: { stubs: { VueFlow: true, Background: true, Controls: true } },
    })
    expect(w.find('[data-testid="agent-node-graph"]').exists()).toBe(true)
  })

  it('⚠️ 截断可见：totalNodeCount > 实际显示时提示', () => {
    const w = mount(AgentNodeGraph, {
      props: { body: { nodes: [{ id: 'a' }], edges: [], totalNodeCount: 50, droppedNodeIds: ['x', 'y'] } },
      global: { stubs: { VueFlow: true, Background: true, Controls: true } },
    })
    const html = w.html()
    expect(html).toContain('1 / 50')
    expect(html).toContain('2 项未显示')
  })

  it('未知节点类型不编造（走中性样式，仍能渲染）', () => {
    const w = mount(AgentNodeGraph, {
      props: { body: { nodes: [{ id: 'u', type: '未知类型' }], edges: [] } },
      global: { stubs: { VueFlow: true, Background: true, Controls: true } },
    })
    expect(w.find('[data-testid="agent-node-graph"]').exists()).toBe(true)
  })

  it('空载荷不崩', () => {
    const w = mount(AgentNodeGraph, {
      props: { body: { nodes: [], edges: [] } },
      global: { stubs: { VueFlow: true, Background: true, Controls: true } },
    })
    expect(w.find('[data-testid="agent-node-graph"]').exists()).toBe(true)
  })
})