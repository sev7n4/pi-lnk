import { describe, it, expect, vi } from 'vitest'

// Phase 3：AgentSideRail 消息渲染判据抽到纯模块后，对其组合逻辑做单测。
// 外部纯依赖（bubbleVisibility / agentInterruptGate / systemEventRender / schemeDraftProse）
// 全部打桩，确保只验证本模块的编排，不耦合实现细节。
vi.mock('@/components/agent/bubbleVisibility', () => ({
  hasBubbleContent: vi.fn(() => false),
  hasBubbleText: vi.fn(() => false),
  hasActionableWait: vi.fn(() => false),
}))
vi.mock('@/components/agent/agentInterruptGate', () => ({
  filterAssistantVisibleText: (s: string) => `A:${s}`,
  filterUserVisibleText: (s: string) => `U:${s}`,
}))
vi.mock('@/components/agent/systemEventRender', () => ({
  isSystemEventText: (s: string) => s.startsWith('SYS:'),
}))
vi.mock('@/components/agent/presentation/schemeDraftProse', () => ({
  splitAssistantDraftMessage: (s: string) => ({ prose: s, rest: '' }),
  hasSchemeDraftSections: (p: string) => p.includes('SECTION'),
}))

import {
  hasRenderableSvgCard,
  hasRenderableNodeGraph,
  nodeGraphPayload,
  shouldShowMessageBubbleText,
  isPreparingPlaceholder,
  useTimeline,
  shouldRenderSchemeDraftProse,
  canReuseTurn,
  isUserSystemEvent,
  visibleAssistantContent,
  visibleUserContent,
} from './agentMessageRender'

type Msg = any

function msg(partial: Partial<Msg> = {}): Msg {
  return {
    role: 'assistant',
    content: '',
    presentation: undefined,
    timeline: undefined,
    executionTrace: undefined,
    streaming: false,
    attachments: [],
    ...partial,
  }
}

describe('agentMessageRender', () => {
  it('hasRenderableSvgCard：svg_card 收窄（含 svg:"" 视为有，undefined 视为无）', () => {
    expect(hasRenderableSvgCard(msg({ role: 'user' }))).toBe(false)
    const ok = msg({ presentation: { kind: 'svg_card', body: { svg: 'X' } } })
    expect(hasRenderableSvgCard(ok)).toBe(true)
    expect(hasRenderableSvgCard(msg({ presentation: { kind: 'svg_card', body: { svg: '' } } }))).toBe(true)
    expect(hasRenderableSvgCard(msg({ presentation: { kind: 'svg_card', body: {} } }))).toBe(false)
    // 类型收窄后 body.svg 为 string
    if (hasRenderableSvgCard(ok)) expect(ok.presentation.body.svg).toBe('X')
    else throw new Error('expected svg card')
  })

  it('hasRenderableNodeGraph：仅 assistant 且 graph_nodes 为数组', () => {
    expect(hasRenderableNodeGraph(msg({ presentation: { kind: 'node_graph', body: { graph_nodes: [] } } }))).toBe(true)
    expect(hasRenderableNodeGraph(msg({ presentation: { kind: 'node_graph', body: {} } }))).toBe(false)
    expect(hasRenderableNodeGraph(msg({ role: 'user', presentation: { kind: 'node_graph', body: { graph_nodes: [] } } }))).toBe(false)
  })

  it('nodeGraphPayload：取载荷并对缺失字段兜底空数组', () => {
    const p = nodeGraphPayload(msg({
      presentation: { kind: 'node_graph', body: { graph_nodes: [{ id: 1 }], graph_edges: [{ a: 2 }], nodeGraphTitle: 'T' } },
    }))
    expect(p).toEqual({ nodes: [{ id: 1 }], edges: [{ a: 2 }], title: 'T' })
    const p2 = nodeGraphPayload(msg({}))
    expect(p2).toEqual({ nodes: [], edges: [], title: undefined })
  })

  it('useTimeline：仅 assistant 且有 timeline', () => {
    expect(useTimeline(msg({ timeline: {} }))).toBe(true)
    expect(useTimeline(msg({ timeline: undefined }))).toBe(false)
    expect(useTimeline(msg({ role: 'user', timeline: {} }))).toBe(false)
  })

  it('shouldShowMessageBubbleText：streaming / timeline / trace / 卡片 任一即放行', () => {
    expect(shouldShowMessageBubbleText(msg())).toBe(false)
    expect(shouldShowMessageBubbleText(msg({ streaming: true }))).toBe(true)
    expect(shouldShowMessageBubbleText(msg({ timeline: { parts: [{ x: 1 }] } }))).toBe(true)
    expect(shouldShowMessageBubbleText(msg({ executionTrace: { steps: [{ y: 1 }] } }))).toBe(true)
    expect(shouldShowMessageBubbleText(msg({ presentation: { kind: 'svg_card', body: { svg: 'X' } } }))).toBe(true)
  })

  it('isPreparingPlaceholder：仅 live 且零可见产出', async () => {
    expect(isPreparingPlaceholder(msg({ streaming: true }))).toBe(true)
    // 有可见正文（hasBubbleText=true）⇒ 不是占位（判据走 hasBubbleText 而非 content）
    const bv = await import('@/components/agent/bubbleVisibility')
    ;(bv.hasBubbleText as unknown as { mockReturnValue: (v: boolean) => void }).mockReturnValue(true)
    expect(isPreparingPlaceholder(msg({ streaming: true, content: 'hi' }))).toBe(false)
    ;(bv.hasBubbleText as unknown as { mockReturnValue: (v: boolean) => void }).mockReturnValue(false)
    expect(isPreparingPlaceholder(msg({ streaming: false }))).toBe(false)
    expect(isPreparingPlaceholder(msg({ streaming: true, timeline: {} }))).toBe(false)
    expect(isPreparingPlaceholder(msg({ role: 'user', streaming: true }))).toBe(false)
  })

  it('shouldRenderSchemeDraftProse：assistant 非流式且有结构化小节', () => {
    expect(shouldRenderSchemeDraftProse(msg({ content: 'has SECTION' }))).toBe(true)
    expect(shouldRenderSchemeDraftProse(msg({ content: 'no' }))).toBe(false)
    expect(shouldRenderSchemeDraftProse(msg({ streaming: true, content: 'has SECTION' }))).toBe(false)
    expect(shouldRenderSchemeDraftProse(msg({ role: 'user', content: 'has SECTION' }))).toBe(false)
  })

  it('canReuseTurn：仅 user 且有正文或引用', () => {
    expect(canReuseTurn(msg({ role: 'user', content: 'hi' }))).toBe(true)
    expect(canReuseTurn(msg({ role: 'user', attachments: [{ id: 'a' }] }))).toBe(true)
    expect(canReuseTurn(msg({ role: 'user' }))).toBe(false)
    expect(canReuseTurn(msg({ role: 'assistant', content: 'hi' }))).toBe(false)
  })

  it('isUserSystemEvent：user 且内容命中系统前缀', () => {
    expect(isUserSystemEvent(msg({ role: 'user', content: 'SYS:foo' }))).toBe(true)
    expect(isUserSystemEvent(msg({ role: 'user', content: 'bar' }))).toBe(false)
    expect(isUserSystemEvent(msg({ role: 'assistant', content: 'SYS:foo' }))).toBe(false)
  })

  it('visible*Content：按角色走对应可见性过滤', () => {
    expect(visibleAssistantContent(msg({ role: 'assistant', content: 'X' }))).toBe('A:X')
    expect(visibleAssistantContent(msg({ role: 'user', content: 'X' }))).toBe('X')
    expect(visibleUserContent(msg({ role: 'user', content: 'X' }))).toBe('U:X')
    expect(visibleUserContent(msg({ role: 'assistant', content: 'X' }))).toBe('X')
  })
})
