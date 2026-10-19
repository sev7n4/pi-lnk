import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { useAgentStore } from '@/stores/agent'
import AgentSideRail from './AgentSideRail.vue'

/**
 * ADR-0011（2026-10-19，T2）：对话流 propose 卡在**画布上下文**下降权为只读。
 *
 * 背景：一次 propose 的 pending_confirm 态曾被渲染成「对话卡 + 画布节点 + 自动 dock」
 * 三带叠罗汉。收敛后对话流卡片在画布可见上下文（mobileCanvasView=true）只作提示，
 * 定位 / 取消按钮收起——确认 / 取消归节点内联面 / dock，避免同一态双份可操作入口。
 * 纯对话视图（mobileCanvasView=false，含桌面）维持可操作卡不变（2026-10-06 两处确认入口拍板）。
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

function seedProposeWait() {
  const agent = useAgentStore()
  agent.blockingWait = {
    toolName: 'propose_generation',
    callId: 'call-1',
    nodeId: 'node-1',
  } as never
}

describe('ADR-0011 T2：propose 卡在画布上下文降权为只读', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mobileCanvasView=true（画布上下文）：hint 仍在，但定位 / 取消按钮收起（只读）', async () => {
    const w = await mountRail({ mobileCanvasView: true })
    seedProposeWait()
    await flushPromises()

    // 提示横幅保留（回答"在等什么"），失败警示安全层也保留
    const hint = w.find('[data-testid="propose-wait-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('已在画布上待确认')
    // 可操作入口全部收起——不再与画布节点 / dock 双份可操作
    expect(w.find('[data-testid="propose-wait-actions"]').exists()).toBe(false)
    expect(w.find('[data-testid="propose-wait-locate"]').exists()).toBe(false)
    expect(w.find('[data-testid="propose-wait-cancel"]').exists()).toBe(false)
  })

  it('mobileCanvasView=false（纯对话视图 / 桌面）：维持可操作卡（定位 + 取消）', async () => {
    const w = await mountRail({ mobileCanvasView: false })
    seedProposeWait()
    await flushPromises()

    const hint = w.find('[data-testid="propose-wait-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('锚定画布')
    // 既有可操作入口不变
    expect(w.find('[data-testid="propose-wait-actions"]').exists()).toBe(true)
    expect(w.find('[data-testid="propose-wait-locate"]').exists()).toBe(true)
    expect(w.find('[data-testid="propose-wait-cancel"]').exists()).toBe(true)
  })

  it('省略 mobileCanvasView（默认未传）等同纯对话视图，按钮保留（向后兼容）', async () => {
    const w = await mountRail()
    seedProposeWait()
    await flushPromises()

    expect(w.find('[data-testid="propose-wait-locate"]').exists()).toBe(true)
    expect(w.find('[data-testid="propose-wait-cancel"]').exists()).toBe(true)
  })
})
