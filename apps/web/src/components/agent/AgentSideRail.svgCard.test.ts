import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { useAgentStore } from '@/stores/agent'
import AgentSideRail from './AgentSideRail.vue'
import AgentSvgCard from './presentation/AgentSvgCard.vue'

vi.mock('@/services/sessions-api', () => ({
  sessionsApi: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({ messages: [] }),
  },
}))

vi.mock('@/services/api-base', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/api-base')>()),
  apiUrl: (p: string) => p,
}))

async function mountRail() {
  // jsdom 无 matchMedia，useAgentMobileLayout 在 setup 里就调它
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  const w = mount(AgentSideRail, {
    global: { plugins: [router] },
    props: { sessionId: 's1' },
  })
  // onMounted 的 bootstrapThread → loadHistory 会整体替换 messages，
  // 必须在它落定之后才 seed，否则种子消息被冲掉（挂载点断言恒空）。
  await flushPromises()
  return w
}

/**
 * seed 一轮「用户提问 + 助手回文」并返回 store。
 *
 * `content` 必须非空：整个卡片区（含 AgentSvgCard）挂在 `shouldShowMessageBubbleText`
 * 门禁内 —— 这是既成设计（AgentCanvasOutputs / AgentExecutionTrace / Host / toolCalls
 * 同样在门禁内），不是本次接线引入的。零文本轮次不渲染任何卡片。
 */
function seedTurn(): ReturnType<typeof useAgentStore> {
  const agent = useAgentStore()
  agent.addUserMessage('给我看看画布')
  const msg = agent.startAssistantMessage()
  msg.content = '这是当前画布视图'
  return agent
}

/** `handleEvent` 是 <script setup> 内部函数，不在组件公开实例类型上；测试按事件形状直投。 */
type RailVm = { handleEvent: (event: { type: string; data: unknown }) => void }

function fire(w: ReturnType<typeof mount>, data: unknown): void {
  ;(w.vm as unknown as RailVm).handleEvent({ type: 'canvas_command', data })
}

/**
 * 走真实链路：SSE `canvas_command` 事件 → handleEvent switch → store.setPresentation
 * → 模板挂载点渲染 AgentSvgCard。断言的是「卡片真的上屏 + payload 逐字段透传」，
 * 不是 store 内部状态（store 侧已由 agent.setPresentation.test.ts 锁）。
 */
describe('AgentSideRail：canvas_command svg_card 上屏', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('渲染 AgentSvgCard 并透传 svg / title / annotations', async () => {
    const w = await mountRail()
    seedTurn()

    fire(w, {
      type: 'svg_card',
      title: '画布视图',
      svg: '<svg viewBox="0 0 10 10"><rect width="4" height="4" fill="#333"/></svg>',
      annotations: [{ nodeId: 'n1', text: '此处密度偏高', severity: 'warn' }],
    })
    await flushPromises()

    const card = w.findComponent(AgentSvgCard)
    expect(card.exists()).toBe(true)
    expect(card.props('svg')).toContain('<rect')
    expect(card.props('title')).toBe('画布视图')
    expect(card.props('annotations')).toEqual([
      { nodeId: 'n1', text: '此处密度偏高', severity: 'warn' },
    ])
    // 真实上屏（净化后注入画布区），不只是 props 通了
    expect(w.find('[data-testid="svg-card"]').exists()).toBe(true)
    expect(w.text()).toContain('此处密度偏高')
  })

  it('svg_card 不进 AgentPresentationHost（无空 stepper）', async () => {
    const w = await mountRail()
    const agent = seedTurn()
    fire(w, { type: 'svg_card', svg: '<svg viewBox="0 0 10 10"><rect/></svg>' })
    // 结束流：historyPresentation 才会被模板读到
    agent.finishStreaming()
    await flushPromises()

    expect(w.find('[data-testid="agent-presentation-host"]').exists()).toBe(false)
    expect(w.findComponent(AgentSvgCard).exists()).toBe(true)
  })

  it('非 svg_card 的 canvas_command 不误挂卡片', async () => {
    const w = await mountRail()
    const agent = seedTurn()
    fire(w, { type: 'undo' })
    await flushPromises()

    expect(w.findComponent(AgentSvgCard).exists()).toBe(false)
    expect(agent.messages[agent.messages.length - 1].presentation).toBeUndefined()
  })

  it('svg: ""（服务端超限丢弃）仍上屏，走 AgentSvgCard 的「已丢弃」降级文案', async () => {
    const w = await mountRail()
    seedTurn()
    fire(w, { type: 'svg_card', svg: '' })
    await flushPromises()

    expect(w.findComponent(AgentSvgCard).exists()).toBe(true)
    expect(w.find('[data-testid="svg-card-discarded"]').exists()).toBe(true)
  })
})
