/**
 * D4 §4.5 判据的**前端消费端**（2026-10-09）。
 *
 * 🔴🔴 **本文件是对 PR #321 那次失败的直接补救**。当时的断言打在
 * `JSON.parse(res.content[0].text)`——**生产者自己写的字段**，从未验证它到达
 * 前端，所以 27/27 全绿而功能是死的。
 *
 * ⭐ 本文件断言的是**真实链路**：SSE `canvas_command` → `handleEvent` switch 分支
 * → `store.setPresentation` → 模板 `AgentSvgCard` / `AgentNodeGraph` 挂载点。
 * 消费端代码在 `AgentSideRail.vue:2224`（node_graph 分支）与 `:2243`（svg_card 分支），
 * 另见模板 `:2778` 的 `v-if / v-else-if` 顺序。
 *
 * ⛔ **变异纪律**：变异验证必须包含「删掉前端读preferred 的逻辑 ⇒ 必须转红」。
 * 若删掉它这组测试仍全绿，说明断言打错了地方（又一次锁了透传没锁效果）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { useAgentStore } from '@/stores/agent'
import AgentSideRail from './AgentSideRail.vue'
import AgentSvgCard from './presentation/AgentSvgCard.vue'
import AgentNodeGraph from './presentation/AgentNodeGraph.vue'

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

/** 见 AgentSideRail.svgCard.test.ts 的同款说明：useProviderBootstrap 的
 *  `.catch()` 会重新throw ⇒ jsdom 下变成 unhandled rejection 让 vitest 非零退出。 */
vi.mock('@/services/provider-api', () => ({
  providerApi: {
    bootstrap: vi.fn().mockResolvedValue({
      platformChannel: null,
      channels: [],
      preferences: null,
      webdav: null,
    }),
  },
}))

async function mountRail() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  // @vue-flow/core 在 onMounted 里 `new ResizeObserver(...)`，jsdom 没这个全局
  // ⇒ 不打这个桩会变成 unhandled rejection（"ResizeObserver is not defined"），
  // 让 vitest 整文件非零退出，即使断言全过。见 RefineOutpaintCanvas.test.ts 同款做法。
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
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
  await flushPromises()
  return w
}

function seedTurn(): ReturnType<typeof useAgentStore> {
  const agent = useAgentStore()
  agent.addUserMessage('给我看看画布')
  const msg = agent.startAssistantMessage()
  msg.content = '这是当前画布视图'
  return agent
}

type RailVm = { handleEvent: (event: { type: string; data: unknown }) => void }

function fire(w: ReturnType<typeof mount>, data: unknown): void {
  ;(w.vm as unknown as RailVm).handleEvent({ type: 'canvas_command', data })
}

const SVG = '<svg viewBox="0 0 10 10"><rect width="4" height="4" fill="#333"/></svg>'

/**
 * 一对带 `preferredKind` 的双写命令，形状与 `presentResultDual` 的产物一致。
 *
 * ⭐ **两条带同一个 winner 值**（不是一条 true 一条 false）——这是后端的真实契约，
 * 也是「两条都 false 的脏数据不会导致双双被跳过 ⇒ 静默空白」的关键。
 */
function dualCommands(preferredKind: 'svg_card' | 'node_graph') {
  return [
    {
      type: 'svg_card',
      title: '画布视图',
      svg: SVG,
      preferredKind,
    },
    {
      type: 'node_graph',
      title: '画布视图',
      nodes: [
        { id: 'n1', type: 'image', title: 'A', position: { x: 0, y: 0 } },
        { id: 'n2', type: 'image', title: 'B', position: { x: 10, y: 0 } },
      ],
      edges: [{ source: 'n1', target: 'n2' }],
      preferredKind,
    },
  ]
}

describe('AgentSideRail：读 command 上的 preferred（D4 §4.5 真实消费端）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('⛔ preferred=svg_card ⇒ 静态图上屏，节点图不上屏（severity 视觉不丢）', async () => {
    const w = await mountRail()
    seedTurn()

    // 按真实顺序连发两条（后端 canvasCommands 就是 [svg_card, node_graph]）
    for (const cmd of dualCommands('svg_card')) fire(w, cmd)
    await flushPromises()

    // —— 有效性断言：至少有一个真的挂上了（否则下面的「不上屏」是空集假绿）——
    expect(
      w.findComponent(AgentSvgCard).exists() || w.findComponent(AgentNodeGraph).exists(),
    ).toBe(true)
    expect(w.findComponent(AgentSvgCard).exists()).toBe(true)
    expect(w.findComponent(AgentNodeGraph).exists()).toBe(false)
    expect(w.find('[data-testid="svg-card"]').exists()).toBe(true)
  })

  it('preferred=node_graph ⇒ 节点图上屏，静态图不上屏', async () => {
    const w = await mountRail()
    seedTurn()

    for (const cmd of dualCommands('node_graph')) fire(w, cmd)
    await flushPromises()

    expect(
      w.findComponent(AgentNodeGraph).exists() || w.findComponent(AgentSvgCard).exists(),
    ).toBe(true)
    expect(w.findComponent(AgentNodeGraph).exists()).toBe(true)
    expect(w.findComponent(AgentSvgCard).exists()).toBe(false)
  })

  it('⛔ 反向顺序也成立（判据不依赖下发顺序）', async () => {
    const w = await mountRail()
    seedTurn()

    // 故意倒序发：先node_graph（preferred=false），后 svg_card（preferred=true）
    const cmds = dualCommands('svg_card')
    for (const cmd of [...cmds].reverse()) fire(w, cmd)
    await flushPromises()

    expect(w.findComponent(AgentSvgCard).exists()).toBe(true)
    expect(w.findComponent(AgentNodeGraph).exists()).toBe(false)
  })

  it('⛔ 无 preferred 字段（旧消息 / 重放路径）⇒ 沿用既有优先级，node_graph 赢', async () => {
    const w = await mountRail()
    seedTurn()

    // 老载荷形状：一个字段都不带。这是向后兼容的硬要求。
    fire(w, { type: 'svg_card', title: '画布视图', svg: SVG })
    fire(w, {
      type: 'node_graph',
      title: '画布视图',
      nodes: [{ id: 'n1', type: 'image', title: 'A', position: { x: 0, y: 0 } }],
      edges: [],
    })
    await flushPromises()

    //有效性：确实渲染了某个东西
    expect(
      w.findComponent(AgentSvgCard).exists() || w.findComponent(AgentNodeGraph).exists(),
    ).toBe(true)
    // 既有语义未被本次改动改变：node_graph 仍然赢
    expect(w.findComponent(AgentNodeGraph).exists()).toBe(true)
    expect(w.findComponent(AgentSvgCard).exists()).toBe(false)
  })

  it('⛔ preferredKind 是未知值 ⇒ 不判落选，退回既有优先级（绝不双双跳过变空白）', async () => {
    const w = await mountRail()
    seedTurn()

    // 脏数据 / 未来新增第三种呈现形态而后端忘了同步本仓白名单。
    // ⛔ 若isLoser 不认白名单，两条都会被判落选 ⇒ 界面空白且**无任何报错**。
    fire(w, { type: 'svg_card', svg: SVG, preferredKind: 'bogus_kind' })
    fire(w, {
      type: 'node_graph',
      nodes: [{ id: 'n1', type: 'image', title: 'A', position: { x: 0, y: 0 } }],
      edges: [],
      preferredKind: 'bogus_kind',
    })
    await flushPromises()

    // 必须渲染出**某个**东西（兜底生效），而不是两条都被跳过变成空白
    expect(
      w.findComponent(AgentSvgCard).exists() || w.findComponent(AgentNodeGraph).exists(),
    ).toBe(true)
    // 既有语义：node_graph 赢
    expect(w.findComponent(AgentNodeGraph).exists()).toBe(true)
  })

  it('⛔ node_graph 命令缺席时 svg_card 必须照常上屏（保底呈现不参与分工）', async () => {
    const w = await mountRail()
    seedTurn()

    // 真实场景：`preferredKind` 说该给 node_graph，但那条命令没到（nodeGraph 节点为空、
    // 或只收到 update 快照里的一条）。此时若 svg_card 侧也有「落选就跳过」的门禁，
    // **唯一的保底呈现会被一起跳掉 ⇒ 界面空白且无任何报错**。
    fire(w, { type: 'svg_card', svg: SVG, preferredKind: 'node_graph' })
    await flushPromises()

    expect(w.findComponent(AgentSvgCard).exists()).toBe(true)
    expect(w.find('[data-testid="svg-card"]').exists()).toBe(true)
  })

  it('⛔ node_graph 命令缺席 + 判据说svg_card ⇒ 仍上屏（无分歧也保底）', async () => {
    const w = await mountRail()
    seedTurn()

    fire(w, { type: 'svg_card', svg: SVG, preferredKind: 'svg_card' })
    await flushPromises()

    expect(w.findComponent(AgentSvgCard).exists()).toBe(true)
  })

  it('⛔ 只有一条带 preferredKind（另一条是旧格式）⇒ 那条照常上屏，不空白', async () => {
    const w = await mountRail()
    seedTurn()

    // 真实场景：滚动发布期新旧 runtime 混跑，或 update 快照与 end 事件形状不一致。
    fire(w, { type: 'svg_card', svg: SVG, preferredKind: 'node_graph' }) // 落选 → 跳过
    fire(w, {
      type: 'node_graph', // 旧格式：无 preferredKind ⇒ 不判落选
      nodes: [{ id: 'n1', type: 'image', title: 'A', position: { x: 0, y: 0 } }],
      edges: [],
    })
    await flushPromises()

    expect(w.findComponent(AgentNodeGraph).exists()).toBe(true)
    expect(w.findComponent(AgentSvgCard).exists()).toBe(false)
  })

  it('preferred=svg_card 时静态卡片的 svg / title 仍逐字段透传（判据不吞载荷）', async () => {
    const w = await mountRail()
    seedTurn()

    const [svgCmd] = dualCommands('svg_card')
    fire(w, { ...svgCmd, annotations: [{ nodeId: 'n1', text: '密度偏高', severity: 'warn' }] })
    await flushPromises()

    const card = w.findComponent(AgentSvgCard)
    expect(card.props('svg')).toContain('<rect')
    expect(card.props('title')).toBe('画布视图')
    expect(card.props('annotations')).toEqual([
      { nodeId: 'n1', text: '密度偏高', severity: 'warn' },
    ])
  })
})
