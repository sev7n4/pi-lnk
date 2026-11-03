import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { useAgentStore } from '@/stores/agent'
import { turnLiveStatus } from './activityLine'
import type { TimelinePart } from './turnTimeline'
import AgentSideRail from './AgentSideRail.vue'

/**
 * 2026-11-03 WorkBuddy 同款回合实时状态灰字（移动端复测追加需求）：
 * - 纯函数 `turnLiveStatus`：时间线 parts 尾扫派生全谱状态（等待模型响应 / 深度思考中 /
 *   生成回复中 / 正在<工具人话> / 正在生成产物 / 等待你确认）。
 * - 组件接线：状态行钉在积分常驻条上沿（agent-system-layer 内，data-testid=turn-live-status），
 *   显隐与积分条同口径（turn 活跃期），空闲不渲染。
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

describe('turnLiveStatus（时间线尾扫派生）', () => {
  it('无 parts / 段间静默 → 等待模型响应', () => {
    expect(turnLiveStatus(undefined)).toBe('等待模型响应')
    expect(turnLiveStatus([])).toBe('等待模型响应')
    expect(
      turnLiveStatus([{ kind: 'thinking', id: 't1', text: '', status: 'done', startedAt: 1 } as TimelinePart]),
    ).toBe('等待模型响应')
  })

  it('思考运行 → 深度思考中', () => {
    expect(
      turnLiveStatus([{ kind: 'thinking', id: 't1', text: '', status: 'running', startedAt: 1 } as TimelinePart]),
    ).toBe('深度思考中')
  })

  it('正文流式 → 生成回复中（尾扫优先于更早的思考段）', () => {
    const parts = [
      { kind: 'thinking', id: 't1', text: '', status: 'done', startedAt: 1, endedAt: 2 },
      { kind: 'text', id: 'x1', text: '你好', status: 'streaming' },
    ] as TimelinePart[]
    expect(turnLiveStatus(parts)).toBe('生成回复中')
  })

  it('工具运行 → 正在<注册表人话>（get_canvas_summary → 正在感知画布）', () => {
    const parts = [
      { kind: 'tool', id: 'k1', toolName: 'get_canvas_summary', status: 'running' },
    ] as TimelinePart[]
    expect(turnLiveStatus(parts)).toBe('正在感知画布')
  })

  it('未知工具落自曝兜底（running 带后缀，漏登一眼可见）', () => {
    const parts = [
      { kind: 'tool', id: 'k1', toolName: 'brand_new_tool', status: 'running' },
    ] as TimelinePart[]
    expect(turnLiveStatus(parts)).toBe('正在调用 brand_new_tool（执行中）')
  })

  it('产物生成 pending/running → 正在生成产物', () => {
    const parts = [
      { kind: 'artifact', id: 'a1', nodeId: 'n1', nodeType: 'image', title: '图', status: 'running' },
    ] as TimelinePart[]
    expect(turnLiveStatus(parts)).toBe('正在生成产物')
  })

  it('等待确认（proposal pending_confirm / question pending_answer）→ 等待你确认', () => {
    const proposal = [
      {
        kind: 'proposal', id: 'p1', toolName: 'propose_generation', title: '生成',
        status: 'pending_confirm', startedAt: 1,
      },
    ] as TimelinePart[]
    const question = [
      {
        kind: 'question', id: 'q1', title: '选风格', status: 'pending_answer',
        questions: [], startedAt: 1,
      },
    ] as TimelinePart[]
    expect(turnLiveStatus(proposal)).toBe('等待你确认')
    expect(turnLiveStatus(question)).toBe('等待你确认')
  })
})

async function mountRail() {
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
  await flushPromises()
  return w
}

describe('AgentSideRail 接线：实时状态灰字钉在积分条上沿', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.unstubAllGlobals())

  it('turn 活跃期：状态行显示（thinking → 深度思考中），且位于积分条之前', async () => {
    const w = await mountRail()
    const agent = useAgentStore()
    agent.messages.push({
      id: 'm-live',
      role: 'assistant',
      content: '',
      streaming: true,
      timeline: {
        turnStartedAt: 1,
        parts: [{ kind: 'thinking', id: 't1', text: '', status: 'running', startedAt: 1 }],
      },
    } as never)
    agent.isStreaming = true
    await flushPromises()

    const status = w.find('[data-testid="turn-live-status"]')
    expect(status.exists()).toBe(true)
    expect(status.text()).toBe('深度思考中')
    // 位置不变量：状态行在积分常驻条上沿（WorkBuddy 同位）
    const html = w.html()
    expect(html.indexOf('turn-live-status')).toBeLessThan(html.indexOf('session-credits-line'))
  })

  it('空闲期：状态行与积分条都不渲染（不盯死）', async () => {
    const w = await mountRail()
    await flushPromises()
    expect(w.find('[data-testid="turn-live-status"]').exists()).toBe(false)
    expect(w.find('[data-testid="session-credits-line"]').exists()).toBe(false)
  })
})

describe('AgentSideRail 接线：每轮 agent 回复抬头（徽章 + lnk π，WorkBuddy 同款）', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.unstubAllGlobals())

  it('assistant turn 起点有抬头（徽章图 + lnk π），用户轮无抬头', async () => {
    const w = await mountRail()
    const agent = useAgentStore()
    agent.messages.push({ id: 'm-u1', role: 'user', content: '画一只兔子' } as never)
    agent.messages.push({ id: 'm-a1', role: 'assistant', content: '好的', streaming: false } as never)
    await flushPromises()

    const heads = w.findAll('[data-testid="turn-head"]')
    expect(heads).toHaveLength(1)
    expect(heads[0]!.text()).toContain('lnk π')
    expect(heads[0]!.find('img').exists()).toBe(true)
  })

  it('连续 assistant 消息属同一轮：不重复抬头；新一轮（user 之后）重新抬头', async () => {
    const w = await mountRail()
    const agent = useAgentStore()
    agent.messages.push({ id: 'm-a1', role: 'assistant', content: '第一轮' } as never)
    agent.messages.push({ id: 'm-a2', role: 'assistant', content: '续同一轮' } as never)
    agent.messages.push({ id: 'm-u1', role: 'user', content: '继续' } as never)
    agent.messages.push({ id: 'm-a3', role: 'assistant', content: '第二轮' } as never)
    await flushPromises()

    const heads = w.findAll('[data-testid="turn-head"]')
    expect(heads).toHaveLength(2)
  })
})
