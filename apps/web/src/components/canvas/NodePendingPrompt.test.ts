import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import NodePendingPrompt from './NodePendingPrompt.vue'

function mountPrompt(props: Record<string, unknown> = {}) {
  return mount(NodePendingPrompt, {
    props: { prompt: '一只在雨中的柴犬，电影感侧光', status: 'pending_confirm', ...props },
  })
}

describe('NodePendingPrompt（ADR-0011 决定 1 节点内联提示词摘要）', () => {
  it('待确认态渲染摘要：待确认徽标 + 提示词正文 + 编辑提示', () => {
    const wrapper = mountPrompt()
    expect(wrapper.find('[data-testid="node-pending-prompt"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="node-pending-prompt-chip"]').text()).toBe('待确认')
    expect(wrapper.get('[data-testid="node-pending-prompt-text"]').text()).toBe('一只在雨中的柴犬，电影感侧光')
    // 决策面收归对话页（2026-11-22）：画布不再有编辑/确认入口，引导文案指向对话卡
    expect(wrapper.text()).toContain('在对话卡上调整后确认')
    expect(wrapper.text()).not.toContain('可在提示词卡片上「编辑」后确认')
    wrapper.unmount()
  })

  it('P0-2 part 锚：proposeWaiting=true 时 draft 节点也渲染摘要（等待期 status 迟到不吞状态展示）', () => {
    // 2026-10-30 §4.3：等待期 update_node{pending_confirm} 随 tool_result 迟到 ⇒
    // status 仍 draft。此判据原在已删除的节点内联确认面测试，
    // 决策面收归后由本组件承接（状态面唯一载体）。
    const wrapper = mountPrompt({ status: 'draft', proposeWaiting: true })
    expect(wrapper.find('[data-testid="node-pending-prompt"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="node-pending-prompt-text"]').text()).toBe('一只在雨中的柴犬，电影感侧光')
    wrapper.unmount()
  })

  it('非待确认态（draft / generating / completed）不渲染', () => {
    for (const status of ['draft', 'generating', 'completed', 'uploading', undefined]) {
      const wrapper = mountPrompt({ status })
      expect(wrapper.find('[data-testid="node-pending-prompt"]').exists()).toBe(false)
      wrapper.unmount()
    }
  })

  it('待确认但提示词为空 / 纯空白 ⇒ 不渲染（不出现空摘要块）', () => {
    for (const prompt of ['', '   ', undefined]) {
      const wrapper = mountPrompt({ prompt })
      expect(wrapper.find('[data-testid="node-pending-prompt"]').exists()).toBe(false)
      wrapper.unmount()
    }
  })

  it('有 label 时在正文上方渲染上下文行；无 label 不渲染该行', () => {
    const withLabel = mountPrompt({ label: '封面图' })
    expect(withLabel.text()).toContain('封面图')
    withLabel.unmount()

    const noLabel = mountPrompt()
    expect(noLabel.find('.node-pending-prompt-label').exists()).toBe(false)
    noLabel.unmount()
  })
})
