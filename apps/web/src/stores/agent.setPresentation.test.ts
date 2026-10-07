import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAgentStore } from './agent'

const env = (kind: string, svg: string) => ({
  kind,
  stepper: { current: '', completed: [] },
  body: { svg },
})

describe('setPresentation', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('写入最后一条 assistant 消息的 presentation', () => {
    const s = useAgentStore()
    s.addUserMessage('hi')
    s.startAssistantMessage()
    s.setPresentation(env('svg_card', '<svg/>') as never)
    expect(s.messages[s.messages.length - 1].presentation?.kind).toBe('svg_card')
  })

  it('Review Focus #3：同轮第二张卡覆盖第一张（最后一张胜出）', () => {
    const s = useAgentStore()
    s.addUserMessage('hi')
    s.startAssistantMessage()
    s.setPresentation(env('svg_card', '<svg id="a"/>') as never)
    s.setPresentation(env('svg_card', '<svg id="b"/>') as never)
    expect(s.messages[s.messages.length - 1].presentation?.body?.svg).toContain('id="b"')
  })

  it('无 assistant 消息时不抛错（静默忽略）', () => {
    const s = useAgentStore()
    expect(() => s.setPresentation(env('svg_card', '<svg/>') as never)).not.toThrow()
  })

  it('写入不误伤更早的 assistant 消息（只动最后一条）', () => {
    const s = useAgentStore()
    s.addUserMessage('turn 1')
    s.startAssistantMessage()
    s.setPresentation(env('svg_card', '<svg id="first"/>') as never)
    s.finishStreaming()
    s.addUserMessage('turn 2')
    s.startAssistantMessage()
    s.setPresentation(env('svg_card', '<svg id="second"/>') as never)
    expect(s.messages[1].presentation?.body?.svg).toContain('id="first"')
    expect(s.messages[3].presentation?.body?.svg).toContain('id="second"')
  })

  // ── 2026-07-23：node_graph 双写被 svg_card 覆盖（A 方案在实时路径失效）────────
  // 🔴 这组是**线上 bug 的回归锁**：`render_canvas_view` 双写两个 command，
  //   实时路径依次 setPresentation(node_graph) → setPresentation(svg_card)，
  //   而 presentation 是**单值**字段 ⇒ svg_card 把 node_graph 覆盖掉，
  //   ⇒ 用户看到的仍是静态 SVG（截图证实：卡片里有 SVG 内部文字与图例）。
  const graphEnv = () => ({
    kind: 'node_graph',
    stepper: { current: '', completed: [] },
    body: { graph_nodes: [{ id: 'n1', type: 'image', title: 'a' }], graph_edges: [] },
  })

  it('⚠️ node_graph 之后来的 svg_card **不得**覆盖它（双写期优先级）', () => {
    const s = useAgentStore()
    s.addUserMessage('hi')
    s.startAssistantMessage()
    s.setPresentation(graphEnv() as never)
    s.setPresentation(env('svg_card', '<svg id="static"/>') as never)
    expect(s.messages[s.messages.length - 1].presentation?.kind).toBe('node_graph')
  })

  it('反向也成立：svg_card 先到、node_graph 后到 ⇒ 升级为 node_graph', () => {
    const s = useAgentStore()
    s.addUserMessage('hi')
    s.startAssistantMessage()
    s.setPresentation(env('svg_card', '<svg id="static"/>') as never)
    s.setPresentation(graphEnv() as never)
    expect(s.messages[s.messages.length - 1].presentation?.kind).toBe('node_graph')
  })

  it('⚠️ 同 kind 仍是后者覆盖前者（既有语义不被优先级机制破坏）', () => {
    const s = useAgentStore()
    s.addUserMessage('hi')
    s.startAssistantMessage()
    s.setPresentation(graphEnv() as never)
    s.setPresentation({
      kind: 'node_graph',
      stepper: { current: '', completed: [] },
      body: { graph_nodes: [{ id: 'n2', type: 'image', title: 'b' }], graph_edges: [] },
    } as never)
    const body = s.messages[s.messages.length - 1].presentation?.body as { graph_nodes?: Array<{ id: string }> }
    expect(body.graph_nodes?.[0]?.id).toBe('n2')
  })

  it('svg_card 之间仍然互相覆盖（同 rank，语义不变）', () => {
    const s = useAgentStore()
    s.addUserMessage('hi')
    s.startAssistantMessage()
    s.setPresentation(env('svg_card', '<svg id="a"/>') as never)
    s.setPresentation(env('svg_card', '<svg id="b"/>') as never)
    expect(s.messages[s.messages.length - 1].presentation?.body?.svg).toContain('id="b"')
  })
})
