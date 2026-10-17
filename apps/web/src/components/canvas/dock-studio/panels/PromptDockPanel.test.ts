import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { EditableFlowNode } from '@/composables/useSelectedNodeEditor'
import PromptDockPanel from './PromptDockPanel.vue'

function createNode(data: Record<string, unknown> = {}): EditableFlowNode {
  return { id: 'prompt-1', type: 'prompt', position: { x: 0, y: 0 }, data }
}

function mountPanel(node: EditableFlowNode) {
  return mount(PromptDockPanel, {
    props: {
      node,
      upstream: {} as never,
      refs: [],
    },
  })
}

/**
 * 🔴 2026-10-17 prompt 节点下线：面板降级为存量只读查看器。
 * 编辑与生成能力（输入框 / DockGenerateButton / DockCreditBadge）已全部移除；
 * 这组断言锁住「只读 + 不再出现任何可触发生成的动作」。
 */
describe('PromptDockPanel 存量只读（2026-10-17 prompt 节点下线）', () => {
  it('渲染只读提示与节点 prompt 文本，不渲染生成按钮 / 输入框 / 积分徽标', () => {
    const wrapper = mountPanel(createNode({ prompt: '生成一份商业品牌分镜表' }))
    const text = wrapper.text()

    expect(text).toContain('提示词节点已下线')
    expect(text).toContain('生成一份商业品牌分镜表')
    expect(wrapper.find('textarea, input[type="text"]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'DockGenerateButton' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'DockCreditBadge' }).exists()).toBe(false)
  })

  it('历史 promptMode 以中文徽标展示', () => {
    const wrapper = mountPanel(
      createNode({ prompt: '分镜表', promptMode: 'commercial_storyboard' }),
    )
    expect(wrapper.text()).toContain('商业品牌分镜')
  })

  it('无 prompt 数据时空态兜底', () => {
    const wrapper = mountPanel(createNode({}))
    expect(wrapper.text()).toContain('（无内容）')
  })
})
