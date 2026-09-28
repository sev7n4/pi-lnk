import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentMermaidBlock from './AgentMermaidBlock.vue'

describe('AgentMermaidBlock（P2#8 mermaid 渲染）', () => {
  it('SVG 渲染成功前显示源码（降级形态衔接旧行为）', async () => {
    const w = mount(AgentMermaidBlock, { props: { source: 'graph TD; A-->B' } })
    // onMounted 的动态 import 为异步：首次断言时渲染尚未完成 → 源码可见
    expect(w.find('[data-testid="mermaid-fallback"]').text()).toContain('graph TD')
    await new Promise((r) => setTimeout(r, 0))
  })
})

