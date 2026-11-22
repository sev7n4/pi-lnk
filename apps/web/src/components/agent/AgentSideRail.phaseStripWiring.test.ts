import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import AgentSideRail from './AgentSideRail.vue'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import { useAgentStore } from '@/stores/agent'

/**
 * 2026-11-22 临时阶段条接线（spec 2026-11-22-turn-phase-progress-design.md AD7）：
 * taskProgress 是会话级单例，必须只挂最新活跃轮（isLiveTurnMessage 门禁），历史轮为
 * undefined——否则历史轮会冒出当前任务的 detail（第二状态面矛盾）。
 * mocks 与 mountRail 形态复用 AgentSideRail.turnLiveStatus.test.ts（同族契约）。
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

describe('阶段条接线：只挂最新活跃轮，灰字不回退', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.unstubAllGlobals())

  it('最新 streaming 轮拿到 taskProgress，历史轮为 undefined', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {},
    }))
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    await router.isReady()
    const w = mount(AgentSideRail, { global: { plugins: [router] }, props: { sessionId: 's1' } })
    await flushPromises()
    const agent = useAgentStore()
    agent.messages.push({
      id: 'm-old', role: 'assistant', content: '', streaming: false,
      timeline: { turnStartedAt: 1, parts: [
        { kind: 'notice', id: 'notice:turn-summary', text: '已生成 1 张', tone: 'info' },
      ] },
    } as never)
    agent.messages.push({
      id: 'm-live', role: 'assistant', content: '', streaming: true,
      timeline: { turnStartedAt: 2, parts: [
        { kind: 'tool', id: 'k1', toolName: 'get_canvas_summary', status: 'done', ms: 800 },
      ] },
    } as never)
    agent.isStreaming = true
    await flushPromises()

    const timelines = w.findAllComponents(AgentTurnTimeline)
    expect(timelines).toHaveLength(2)
    expect(timelines[0]!.props('taskProgress')).toBeUndefined()
    expect(timelines[1]!.props('taskProgress')).toBeDefined()
    // 阶段条只出现在活跃轮（历史轮 0 条）
    expect(w.findAll('[data-testid="turn-phase-strip"]')).toHaveLength(1)
    // composer 灰字不回退：仍按 turnLiveStatus 渲染
    expect(w.find('[data-testid="turn-live-status"]').exists()).toBe(true)
  })
})
