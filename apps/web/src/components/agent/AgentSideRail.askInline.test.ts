import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { useAgentStore } from '@/stores/agent'
import AgentSideRail from './AgentSideRail.vue'

/**
 * 根治规格（2026-10-28）：ask_user 等待的单一真相 = 时间线 question part。
 *
 * 背景：ask 的题面此前由组件级 `pendingAskUser` ref 驱动、贴在 composer 之上（对话流外），
 * 与对话流内联卡、状态行三处表达同一事实 ⇒ desync。根治后题面收敛进 question part，
 * `AskUserCard` 与对话流内联卡都只读它，composer 之上的对话流外卡整体下线。
 *
 * 断言落在 DOM / 出网 body 出口，不碰源码字符串。
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

const answersRequests: string[] = []

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url)
    if (u.includes('/answers')) {
      answersRequests.push(String(init?.body ?? ''))
      return { ok: true, status: 200, json: async () => ({ data: { ok: true, deduped: false } }) }
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }) }
  }))
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

/** 单一真相端到端种子：流式 assistant 消息 + ask_user 事件 ⇒ 时间线 question part。 */
function seedTimelineQuestion() {
  const agent = useAgentStore()
  agent.messages.push({
    id: 'm-live',
    role: 'assistant',
    content: '',
    streaming: true,
  } as never)
  agent.isStreaming = true
  agent.trackAskUser({
    callId: 'ask-1',
    title: '风格选择',
    questions: [
      {
        id: 'q1',
        question: '选风格？',
        options: [
          { label: '皮克斯', value: 'pixar' },
          { label: '写实', value: 'realistic' },
        ],
        multiSelect: false,
        allowOther: false,
      },
    ],
  })
}

describe('根治规格：ask_user 等待的单一真相 = 时间线 question part', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    answersRequests.length = 0
    stubFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('对话流内联卡出现（题面 + 选项），且 composer 之上的对话流外卡已删除', async () => {
    const w = await mountRail()
    seedTimelineQuestion()
    await flushPromises()

    // 内联 AskUserCard：题面与选项都可见（在对话流里，不飘在 composer 顶）
    const text = w.text()
    expect(text).toContain('选风格？')
    expect(text).toContain('皮克斯')
    // 对话流外 composer 卡已删除：AgentSideRail 模板不再直接挂 <AskUserCard
    expect(w.html()).not.toContain('<ask-user-card')
  })

  it('resolved（answered）翻转后内联卡收起为只读小结（不再可点选项）', async () => {
    const w = await mountRail()
    seedTimelineQuestion()
    await flushPromises()
    expect(w.text()).toContain('选风格？')

    const agent = useAgentStore()
    agent.resolveQuestionPart('ask-1', 'answered')
    await flushPromises()

    const text = w.text()
    expect(text).not.toContain('选风格？')
    expect(text).toContain('已回答')
  })

  it('点选项 ⇒ POST /answers 带 callId 与答案，内联卡收起', async () => {
    const w = await mountRail()
    seedTimelineQuestion()
    await flushPromises()

    const optionBtn = w.findAll('button').find((b) => b.text().trim() === '皮克斯')
    expect(optionBtn, '选项按钮在内联卡上').toBeTruthy()
    await optionBtn!.trigger('click')
    await flushPromises()

    expect(answersRequests).toHaveLength(1)
    const body = JSON.parse(answersRequests[0]) as Record<string, unknown>
    expect(body.callId).toBe('ask-1')
    expect((body.answers as Record<string, string[]>).q1).toEqual(['pixar'])
    // 乐观置位：卡收起为只读小结
    const text = w.text()
    expect(text).not.toContain('选风格？')
    expect(text).toContain('已回答')
  })

  it('取消 ⇒ POST /answers 带空 answers（全部 skipped 语义），内联卡收起为「已跳过」', async () => {
    const w = await mountRail()
    seedTimelineQuestion()
    await flushPromises()

    const cancelBtn = w.findAll('button').find((b) => b.text().trim() === '都不合适？改用文字描述')
    expect(cancelBtn, '取消入口在内联卡上').toBeTruthy()
    await cancelBtn!.trigger('click')
    await flushPromises()

    expect(answersRequests).toHaveLength(1)
    const body = JSON.parse(answersRequests[0]) as Record<string, unknown>
    // ask 取消沿用既有契约：空 answers = 全部 skipped（模型视作未作答继续），不发送 decision
    // （decision=decline 是 propose 取消的专属信号，不在 ask 通道，避免改 wire 契约）。
    expect(body.decision).toBeUndefined()
    expect(body.answers).toEqual({})
    expect(body.callId).toBe('ask-1')
    const text = w.text()
    expect(text).not.toContain('选风格？')
    expect(text).toContain('已跳过')
  })
})
