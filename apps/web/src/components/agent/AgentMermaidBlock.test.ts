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

  // M-1 补：Review Focus #5 直接覆盖——非法 mermaid 源码 → 降级 pre 持续保留、svg 不出现
  // mermaid 动态 import 在 vitest jsdom 下较慢，给 60s timeout（实测 ~36s）
  it('非法 mermaid 源码渲染失败后保持 fallback pre，svg 不出现', async () => {
    const w = mount(AgentMermaidBlock, { props: { source: '!!!invalid mermaid syntax!!!' } })
    // 让 onMounted 的动态 import + render 完成（render 会抛 → catch → rendered 保持 false）
    await new Promise((r) => setTimeout(r, 200))
    expect(w.find('[data-testid="mermaid-fallback"]').exists()).toBe(true)
    expect(w.find('[data-testid="mermaid-fallback"]').text()).toContain('!!!invalid')
    // rendered=false 时 mermaid-svg 节点 v-show=false → isVisible()=false
    expect(w.find('[data-testid="mermaid-svg"]').isVisible()).toBe(false)
  }, 60000)
})

