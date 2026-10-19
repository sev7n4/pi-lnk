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
    expect(wrapper.text()).toContain('可在提示词卡片上「编辑」后确认')
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
