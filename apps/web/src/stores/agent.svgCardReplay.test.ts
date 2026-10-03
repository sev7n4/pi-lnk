/**
 * svg_card 刷新恢复（spec §4.6 第 3 跳）。
 *
 * 链路：服务端把 `canvas_command{type:'svg_card'}` 落进 `metadata.executionEvents`
 * → 前端 `loadHistory` 从事件序列重放出 `msg.presentation` → 挂载点渲染 AgentSvgCard。
 *
 * 本文件只锁「重放 → 挂到消息上」这一跳；实时路径由
 * `AgentSideRail.svgCard.test.ts` 锁，`setPresentation` 的单值语义由
 * `agent.setPresentation.test.ts` 锁。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  replaySvgCardPresentation,
} from '@/components/agent/executionTraceReducer'
import { useAgentStore } from '@/stores/agent'

/**
 * `loadHistory` 的入参形状（结构上等价于 `AgentChatMessage`）。
 *
 * 刻意不 `import type { AgentChatMessage } from '@lnkpi/shared'`：本仓
 * `apps/web/node_modules/@lnkpi/shared` 软链指向另一个仓，web 的 `vue-tsc` 对该
 * specifier 报不出类型（既存 177 条类型错误的同源问题）。这里用局部最小结构，
 * 既让本文件的类型判据干净，也不去动 tsconfig / package.json。
 */
type PersistedMessage = {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  metadata?: string | null
}

const SVG = '<svg viewBox="0 0 10 10"><rect width="4" height="4" fill="#333"/></svg>'

/** 一条 assistant 消息，metadata 里只放给定的 executionEvents。 */
function assistantWith(
  events: Array<{ type: string; data: unknown }>,
  overrides: Partial<PersistedMessage> = {},
): PersistedMessage {
  return {
    id: 'm1',
    sessionId: 's1',
    role: 'assistant',
    content: '这是当前画布视图',
    createdAt: '2026-10-03T00:00:00.000Z',
    metadata: JSON.stringify({ executionEvents: events }),
    ...overrides,
  }
}

describe('replaySvgCardPresentation（纯函数）', () => {
  it('产出与实时路径同形的 envelope（kind/stepper/title/body 逐字段）', () => {
    const env = replaySvgCardPresentation([
      {
        type: 'canvas_command',
        data: {
          type: 'svg_card',
          svg: SVG,
          title: '画布视图',
          annotations: [{ nodeId: 'n1', text: '此处密度偏高', severity: 'warn' }],
        },
      },
    ])

    expect(env).toEqual({
      kind: 'svg_card',
      stepper: { current: '', completed: [] },
      title: '画布视图',
      body: {
        svg: SVG,
        annotations: [{ nodeId: 'n1', text: '此处密度偏高', severity: 'warn' }],
      },
    })
  })

  it('无 svg_card 时返回 undefined（不凭空造卡）', () => {
    expect(replaySvgCardPresentation([])).toBeUndefined()
    expect(
      replaySvgCardPresentation([{ type: 'tool_call', data: { name: 'gen' } }]),
    ).toBeUndefined()
  })

  it('Ruling 3：非 svg_card 的 canvas_command（focus_node / ask_user）不误挂卡片', () => {
    expect(
      replaySvgCardPresentation([
        { type: 'canvas_command', data: { type: 'focus_node', nodeId: 'n1' } },
        { type: 'canvas_command', data: { type: 'ask_user', callId: 'c1', questions: [] } },
      ]),
    ).toBeUndefined()
  })

  it('svg 字段缺失的 svg_card 不恢复（与实时分支 cmd.svg !== undefined 同判据）', () => {
    expect(
      replaySvgCardPresentation([
        { type: 'canvas_command', data: { type: 'svg_card', title: '无 svg 字段' } },
      ]),
    ).toBeUndefined()
  })

  it('svg: ""（服务端超限丢弃）仍恢复：那张卡有专属「已丢弃」可见文案', () => {
    // 真值门禁会把这条降级分支整条吞掉 —— 与 hasRenderableSvgCard 同因
    const env = replaySvgCardPresentation([
      { type: 'canvas_command', data: { type: 'svg_card', svg: '' } },
    ])
    expect(env?.kind).toBe('svg_card')
    expect(env?.body?.svg).toBe('')
  })

  it('单值语义：同轮多卡取最后一张（与 setPresentation 的覆盖顺序一致）', () => {
    const env = replaySvgCardPresentation([
      { type: 'canvas_command', data: { type: 'svg_card', svg: '<svg id="first"/>' } },
      { type: 'canvas_command', data: { type: 'svg_card', svg: '<svg id="second"/>' } },
    ])
    expect(env?.body?.svg).toContain('id="second"')
  })

  it('跳过尾随的非 svg_card 事件，取到真正最后那张卡', () => {
    const env = replaySvgCardPresentation([
      { type: 'canvas_command', data: { type: 'svg_card', svg: '<svg id="only"/>' } },
      { type: 'canvas_command', data: { type: 'undo' } },
      { type: 'tool_call', data: { name: 'gen' } },
    ])
    expect(env?.body?.svg).toContain('id="only"')
  })

  it('不改动入参（纯函数：事件数组保持原样）', () => {
    const events = [
      { type: 'canvas_command', data: { type: 'svg_card', svg: '<svg/>' } },
    ]
    const snapshot = JSON.stringify(events)
    replaySvgCardPresentation(events)
    expect(JSON.stringify(events)).toBe(snapshot)
  })
})

/**
 * Ruling 2：`loadHistory` 是 `messages.value = history.map(...)`，消息在 map 内
 * 一次性构造 ⇒ 重放与消息创建同 tick，无时序竞态。
 *
 * 「无竞态」若只靠读代码推理就是空话 —— 这组用例把「重放产出的卡片**确实挂在
 * assistant 消息上**」锁成事实：断的是挂载关系本身，不是时序。
 */
describe('loadHistory：svg_card 从 executionEvents 恢复到 assistant 消息', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('卡片挂到了 assistant 消息上（refresh 后可渲染的那条）', () => {
    const store = useAgentStore()
    store.loadHistory([
      { id: 'u1', sessionId: 's1', role: 'user', content: '给我看看画布', createdAt: '2026-10-03T00:00:00.000Z' },
      assistantWith([
        { type: 'canvas_command', data: { type: 'svg_card', svg: SVG, title: '画布视图' } },
      ]),
    ])

    const assistant = store.messages[1]
    expect(assistant.role).toBe('assistant')
    expect(assistant.presentation?.kind).toBe('svg_card')
    expect(assistant.presentation?.body?.svg).toBe(SVG)
    expect(assistant.presentation?.title).toBe('画布视图')
  })

  it('用户消息不带卡片（卡片只属助手轮次）', () => {
    const store = useAgentStore()
    store.loadHistory([
      {
        id: 'u1',
        sessionId: 's1',
        role: 'user',
        content: '给我看看画布',
        createdAt: '2026-10-03T00:00:00.000Z',
        metadata: JSON.stringify({
          executionEvents: [{ type: 'canvas_command', data: { type: 'svg_card', svg: SVG } }],
        }),
      },
      assistantWith([{ type: 'tool_call', data: { name: 'gen' } }]),
    ])

    expect(store.messages[0].presentation).toBeUndefined()
    expect(store.messages[1].presentation).toBeUndefined()
  })

  it('与 trace 重放共存：既有 executionTrace 恢复行为不受影响', () => {
    const store = useAgentStore()
    store.loadHistory([
      assistantWith([
        { type: 'canvas_command', data: { type: 'svg_card', svg: SVG } },
        { type: 'task_list', data: { items: [{ id: 'plan-1', title: '起稿', status: 'running' }] } },
        { type: 'task_update', data: { id: 'plan-1', status: 'done' } },
      ]),
    ])

    const msg = store.messages[0]
    expect(msg.presentation?.kind).toBe('svg_card')
    expect(msg.executionTrace?.steps.find((s) => s.kind === 'task')?.status).toBe('done')
  })

  it('带 executionTrace 快照的老消息也恢复卡片（快照优先那道门不拦 presentation）', () => {
    const store = useAgentStore()
    const trace = { steps: [{ id: 'tool-1', kind: 'tool', label: '调用 gen', status: 'done' }], collapsed: true, turnStartedAt: 1 }
    store.loadHistory([
      {
        id: 'm1',
        sessionId: 's1',
        role: 'assistant',
        content: '看图',
        createdAt: '2026-10-03T00:00:00.000Z',
        metadata: JSON.stringify({
          executionTrace: trace,
          executionEvents: [{ type: 'canvas_command', data: { type: 'svg_card', svg: SVG } }],
        }),
      },
    ])

    const msg = store.messages[0]
    expect(msg.executionTrace?.steps[0]?.label).toBe('调用 gen')
    expect(msg.presentation?.body?.svg).toBe(SVG)
  })

  it('metadata.presentation 优先于事件重放（既有行为不变）', () => {
    const store = useAgentStore()
    store.loadHistory([
      {
        id: 'm1',
        sessionId: 's1',
        role: 'assistant',
        content: '方案已就绪',
        createdAt: '2026-10-03T00:00:00.000Z',
        metadata: JSON.stringify({
          presentation: { kind: 'macro_select', stepper: { current: 'macro_select', completed: [] } },
          executionEvents: [{ type: 'canvas_command', data: { type: 'svg_card', svg: SVG } }],
        }),
      },
    ])

    expect(store.messages[0].presentation?.kind).toBe('macro_select')
  })

  it('无 metadata / metadata 非法 JSON 时不造卡也不抛错', () => {
    const store = useAgentStore()
    expect(() =>
      store.loadHistory([
        { id: 'm1', sessionId: 's1', role: 'assistant', content: 'x', createdAt: '2026-10-03T00:00:00.000Z' },
        { id: 'm2', sessionId: 's1', role: 'assistant', content: 'y', createdAt: '2026-10-03T00:00:00.000Z', metadata: '{bad json' },
      ]),
    ).not.toThrow()
    expect(store.messages[0].presentation).toBeUndefined()
    expect(store.messages[1].presentation).toBeUndefined()
  })
})
