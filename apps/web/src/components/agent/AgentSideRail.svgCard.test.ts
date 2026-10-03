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
 * `content` 非空时，助手有可见文本，走 `hasBubbleContent` 既有路径。
 * 零文本 + svg_card 的组合由下面的「气泡门禁」describe 单独覆盖。
 */
function seedTurn(): ReturnType<typeof useAgentStore> {
  const agent = useAgentStore()
  agent.addUserMessage('给我看看画布')
  const msg = agent.startAssistantMessage()
  msg.content = '这是当前画布视图'
  return agent
}

/**
 * seed 一轮「只有卡片、没有助手文本」的轮次：svg_card 就是该轮的**全部**产出。
 * 若气泡门禁不放行，这条轮次在界面上什么都不渲染（PR #65 同类静默失效）。
 */
function seedCardOnlyTurn(): ReturnType<typeof useAgentStore> {
  const agent = useAgentStore()
  agent.addUserMessage('给我看看画布')
  const msg = agent.startAssistantMessage()
  msg.content = ''
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

/**
 * 气泡门禁（`shouldShowMessageBubbleText`）放行规则。
 *
 * 整块卡片区（含 AgentSvgCard）都挂在该门禁的 `v-if` 内（`AgentSideRail.vue:3033` 开、
 * `:3134` 闭）。门禁判据是「有可见文本」，所以**只有卡片、没有助手文本**的轮次，
 * 若门禁不放行 ⇒ 卡片是那一轮的全部产出却什么都不渲染（PR #65 同类静默失效）。
 *
 * 边界：既放行卡片，又必须保住 P0 决策 2「零内容不渲染气泡」——
 * 无文本且无卡片的轮次（典型是 waiting_user 阻塞期）仍不得产生空白气泡。
 */
describe('AgentSideRail：svg_card 轮次的气泡门禁', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('有 svg_card 但零助手文本：卡片仍上屏（不放行就等于卡片不可见）', async () => {
    const w = await mountRail()
    seedCardOnlyTurn()

    fire(w, { type: 'svg_card', svg: '<svg viewBox="0 0 10 10"><rect/></svg>' })
    await flushPromises()

    const card = w.findComponent(AgentSvgCard)
    expect(card.exists()).toBe(true)
    expect(w.find('[data-testid="svg-card"]').exists()).toBe(true)
  })

  it('零文本 + svg: ""（超限丢弃）：降级文案也必须可见', async () => {
    const w = await mountRail()
    seedCardOnlyTurn()

    fire(w, { type: 'svg_card', svg: '' })
    await flushPromises()

    expect(w.find('[data-testid="svg-card-discarded"]').exists()).toBe(true)
  })

  it('P0 回归：零文本且无卡片仍不渲染气泡（waiting_user 白块修复不得回退）', async () => {
    const w = await mountRail()
    const agent = seedCardOnlyTurn()

    expect(agent.messages[agent.messages.length - 1].presentation).toBeUndefined()
    await flushPromises()

    // 只看助手轮次（用户轮次的 `.agent-bubble` 与本断言无关）：
    // 助手轮不出现气泡容器 ⇒ 不存在空白气泡 + 闪烁光标。
    const assistantTurns = w.findAll('.agent-turn--assistant')
    expect(assistantTurns).toHaveLength(1)
    expect(assistantTurns[0].find('.agent-bubble').exists()).toBe(false)
    expect(w.findComponent(AgentSvgCard).exists()).toBe(false)
  })
})
