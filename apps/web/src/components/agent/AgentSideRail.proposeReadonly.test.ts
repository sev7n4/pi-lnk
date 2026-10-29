import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { useAgentStore } from '@/stores/agent'
import AgentSideRail from './AgentSideRail.vue'

/**
 * 根治规格（2026-10-28）：等待态单一真相 = 时间线 proposal part。
 *
 * 背景（Q1/Q2 漂移）：propose 的 pending_confirm 态此前由**对话流外浮卡**
 * （.agent-system-layer 内 propose-wait-hint）+ `blockingWait`/`proposePendingConfirm`
 * 两套 store 态各自表达——决策点脱离对话时序（Q1），状态行经 executionTrace 抢跑
 * （Q2：tool_result 先更新 trace，waiting_user 晚到 ⇒ 状态条说「等待」而对话流没显示）。
 *
 * 根治后：
 * - 对话流外浮卡**整体下线**（决策点 = 时间线内联卡 + 画布节点浮层）；
 * - 状态行与内联卡同读一份 proposal part（`resolveWaitingFromTimeline`）。
 *
 * 断言落在 DOM testid 出口，不碰源码字符串。
 */

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

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '' }) },
}))

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })))
}

async function mountRail(extraProps: Record<string, unknown> = {}) {
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
    props: { sessionId: 's1', ...extraProps },
  })
  await flushPromises()
  return w
}

/** 单一真相端到端种子：流式 assistant 消息 + waiting_user 事件 ⇒ 时间线 proposal part。 */
function seedTimelineProposal() {
  const agent = useAgentStore()
  agent.messages.push({
    id: 'm1',
    role: 'assistant',
    content: '',
    streaming: true,
  } as never)
  agent.isStreaming = true
  agent.trackWaitingUser({
    status: 'waiting',
    toolName: 'propose_generation',
    callId: 'call-1',
    nodeId: 'node-1',
  })
}

describe('根治规格：propose 等待的单一真相 = 时间线 proposal part', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('对话流外浮卡已下线：propose-wait-* 选择器不再存在于 DOM（决策点回归对话流+画布）', async () => {
    const w = await mountRail({ mobileCanvasView: true })
    await flushPromises()

    expect(w.find('[data-testid="propose-wait-hint"]').exists()).toBe(false)
    expect(w.find('[data-testid="propose-wait-actions"]').exists()).toBe(false)
    expect(w.find('[data-testid="propose-wait-locate"]').exists()).toBe(false)
    expect(w.find('[data-testid="propose-wait-cancel"]').exists()).toBe(false)
  })

  it('纯对话视图（桌面）同样无浮卡（下线不分形态）', async () => {
    const w = await mountRail({ mobileCanvasView: false })
    await flushPromises()

    expect(w.find('[data-testid="propose-wait-hint"]').exists()).toBe(false)
    expect(w.find('[data-testid="propose-wait-locate"]').exists()).toBe(false)
    expect(w.find('[data-testid="propose-wait-cancel"]').exists()).toBe(false)
  })

  it('单一真相端到端：trackWaitingUser ⇒ 状态行与内联卡同显（都不读 blockingWait/trace）', async () => {
    const w = await mountRail()
    seedTimelineProposal()
    await flushPromises()

    // 状态行：从 proposal part 派生（未置位任何 store 镜像 ⇒ 同显即同源证据）
    const statusLine = w.find('[data-testid="turn-status-line"]')
    expect(statusLine.exists()).toBe(true)
    expect(statusLine.text()).toContain('等待你在画布上确认生成')

    // 对话流内联卡：决策点在时间线内（title + 确认按钮）
    expect(w.text()).toContain('提议生成')
    const confirmBtn = w.findAll('button').find((b) => b.text() === '确认生成')
    expect(confirmBtn).toBeTruthy()
  })

  it('resolved 翻转后状态行与内联卡同步解除（不再有「状态条说等待、流里看不到」的 desync）', async () => {
    const w = await mountRail()
    seedTimelineProposal()
    await flushPromises()
    expect(w.find('[data-testid="turn-status-line"]').text()).toContain('等待你在画布上确认生成')

    const agent = useAgentStore()
    agent.trackWaitingUser({ status: 'resolved', toolName: 'propose_generation' })
    await flushPromises()

    expect(w.find('[data-testid="turn-status-line"]').exists()).toBe(false)
    expect(w.findAll('button').map((b) => b.text())).not.toContain('确认生成')
  })
})
