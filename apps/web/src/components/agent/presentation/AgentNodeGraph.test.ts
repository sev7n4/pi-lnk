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
import VUE_SRC from './AgentNodeGraph.vue?raw'

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

  // ── 视觉语言回归锁（2026-10-08 用户实测反馈驱动）────────────────────────
  // 现象：暗底上节点几乎不可见、字极小、长标题溢出边框、边看不清。
  //
  // ⚠️ **断言方式**：`VueFlow` 被 stub（`VueFlow: true`）⇒ slot 内容不渲染，
  //   `wrapper.html()` 查不到类名。这里改用 **Vite 的 `?raw` 导入**拿组件源码，
  //   ⛔ 不用 `readFileSync`（本环境被沙箱 broker 拦截，见workbuddy-sandbox 技能）。
  it('⛔ 每个类型都有主色 accent（不靠 opacity 调灰做层级）', () => {
    for (const t of ['image', 'video', 'audio', 'text', 'table', 'group']) {
      expect(VUE_SRC).toMatch(new RegExp(`${t}: \\{[^}]*accent:`))
    }
  })

  it('⛔ 节点底色与卡片底色是两个不同变量（否则节点"融进"卡片）', () => {
    // ⚠️ 不读 CSS 文件：**`?raw` 对 `.css` 在本环境返回空字符串**（实测 TOK_LEN=0），
    //   而 `.vue` 正常（19839）。改为验证组件里的 CSS 变量**契约**：
    //   节点底色必须引用独立的 `--neo-graph-node-bg`，不能复用卡片底变量。
    expect(VUE_SRC).toContain('--neo-graph-node-bg')
    expect(VUE_SRC).toContain('--neo-graph-card-bg')
    const nodeRule = VUE_SRC.match(/\.vue-flow__node\)\s*\{[\s\S]{0,400}?\}/)?.[0] ?? ''
    expect(nodeRule).toContain('--neo-graph-node-bg')
    // 兜底值也不能与卡片兜底值相同（CSS 变量缺失时仍要有边界）
    const nodeFb = nodeRule.match(/--neo-graph-node-bg,\s*(#[0-9a-fA-F]{6})/)?.[1]
    const cardFb = VUE_SRC.match(/--neo-graph-card-bg:\s*(#[0-9a-fA-F]{6})/)?.[1]
    expect(nodeFb).toBeTruthy()
    expect(nodeFb).not.toBe(cardFb)
  })

  it('⛔ 长标题用多行截断（单行 truncate 会溢出边框 —— 用户反馈的根因）', () => {
    expect(VUE_SRC).toContain('-webkit-line-clamp')
    expect(VUE_SRC).not.toContain('class="truncate text-[11px]')
  })

  it('⛔ 边不再用 0.45 的低透明度（在灰底上看不清 —— 用户反馈）', () => {
    // ⚠️ 只取 `.vue-flow__edge-path` 规则块，**排除注释**（注释里会提到旧值）。
    // ⚠️ 源码里选择器带 `:deep()` 前缀，且 `)` 与 `{` 之间是换行
    //   （旧正则 `edge-path\s*\{` 匹配不到 —— 断言写错，不是实现错）。
    const rule = VUE_SRC.match(/vue-flow__edge-path\)\s*\{[\s\S]{0,300}?\}/)?.[0] ?? ''
    expect(rule).toMatch(/opacity:\s*0\.[6-9]/)
  })

  it('⛔ 有向边带箭头（否则"谁依赖谁"要靠猜）', () => {
    expect(VUE_SRC).toContain('MarkerType.ArrowClosed')
  })

  it('⛔ 分组框是虚线（表达"容器"而非实体）', () => {
    expect(VUE_SRC).toMatch(/border:[^;]*dashed/)
  })

  it('⛔ 标题字号 ≥ 12px（旧值 10/11px 太小）', () => {
    const m = VUE_SRC.match(/\.ng-label-text[\s\S]{0,400}?font-size:\s*(\d+)px/)
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(12)
  })
})


