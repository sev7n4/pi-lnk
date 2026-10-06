import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { useAgentStore } from '@/stores/agent'
import AgentSideRail from './AgentSideRail.vue'

/**
 * 确认卡片下线 + propose「取消」显式回传的回归锁（2026-10-06）。
 *
 * 背景（生产事故 cmus6ha64001dk601lzsymqfa）：
 *  ① 提议生成后点「取消」，dock 里冒出「确认出图 / 写入主文案 / 要改拓扑」三连 + copy 行
 *     —— 触发源是 `agentChipSet.ts` 对**助手文案裸串**的片段嗅探（模型收尾句里出现
 *     「确认出图」就命中 topo）。这些确认卡片现已整体下线，**任何文案都不该再产出按钮**。
 *  ② 取消此前只写画布 SSOT（节点回 draft），工具侧靠轮询推断 ⇒ 模型不知道用户按了取消，
 *     回「请你在画布节点上点一下确认」。现在取消必须**显式** POST
 *     `/answers { decision: "decline" }`，让 runtime 以 aborted 交还。
 *
 * 断言粒度刻意落在「可观测出口」上（DOM testid + 出网 body），而不是源码字符串 ——
 * 源码断言会被注释命中，起不到回归锁作用。
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

/**
 * mermaid 在侧栏里是 `AgentMermaidBlock.vue` 的**动态** import，jsdom 下既不渲染也不需要。
 * 本机依赖树未安装 mermaid（`node_modules/.pnpm` 里没有该包）⇒ 不 stub 就连测试文件都
 * 收集不到（vite:import-analysis 直接报 Failed to resolve import）。
 * CI 装了真包，此处 stub 只是让「和 mermaid 无关」的断言能在任何环境下跑起来。
 */
vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '' }) },
}))

/**
 * 采集指向 /answers 的请求体；其余请求一律返回空 `data` **数组**。
 *
 * ⚠️ 别回 `{ data: {} }`：`bootstrapThread` → `resolveBootstrapThreadId(threads)` 要的是
 * 可迭代数组，拿到对象会在 onMounted 里抛 unhandled rejection ⇒ 即使全部用例 passed，
 * vitest 仍以非零码退出（`Errors N errors`）。
 */
const answersRequests: string[] = []

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url)
    if (u.includes('/answers')) {
      answersRequests.push(String(init?.body ?? ''))
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { ok: true, deduped: false } }),
      }
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }) }
  }))
}

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
  // onMounted 的 bootstrapThread → loadHistory 会整体替换 messages，必须等它落定再 seed
  await flushPromises()
  return w
}

/** 确认型卡片的 DOM 出口（全部应与本次下线一起消失）。 */
const CONFIRM_CARD_SELECTORS = [
  '[data-testid="next-chips"]',
  '[data-testid="image-qa-gate"]',
  '[data-testid="retake-pending-callout"]',
  '[data-testid="retake-continue-chip"]',
  '[data-testid="macro-style-callout"]',
  '[data-testid="macro-conflict-callout"]',
  '[data-testid="macro-footer-hint"]',
  '[data-testid="atomic-confirm-dock"]',
  '[data-testid="atomic-confirm-cancel"]',
  '[data-testid="recipe-promote-variant"]',
  '[data-testid="recipe-promote-new"]',
  '[data-testid="recipe-promote-seed-confirm"]',
  '[data-testid="recipe-promote-variant-confirm"]',
]

const CONFIRM_CARD_LABELS = [
  '确认出图',
  '写入主文案',
  '要改拓扑',
  '确认生成',
  '确认方案',
  '换方向',
  '先不改',
  '确认落到画布',
  '确认所选变体',
  '确认宏观方案',
]

describe('① 确认型确认卡片全下线（回归锁）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    answersRequests.length = 0
    stubFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('助手收尾文案含「确认出图 / 写入主文案 / 要改拓扑」也不再产出任何卡片或按钮', async () => {
    const w = await mountRail()
    const agent = useAgentStore()
    agent.addUserMessage('帮我把这张图生成出来')
    const msg = agent.startAssistantMessage()
    // 事故原文的近似复刻：模型收尾句里出现裸串「确认出图」
    msg.content = '画布尚未确认出图，请你在画布节点上点一下确认。也可以选择写入主文案或者告诉我要改拓扑。'
    agent.finishStreaming()
    await flushPromises()

    for (const sel of CONFIRM_CARD_SELECTORS) {
      expect(w.find(sel).exists(), `不该再出现 ${sel}`).toBe(false)
    }
    for (const label of CONFIRM_CARD_LABELS) {
      const hit = w.findAll('button').some((b) => b.text().trim() === label)
      expect(hit, `不该再出现「${label}」按钮`).toBe(false)
    }
  })

  it('阻塞等待 propose 时只保留「定位该节点 / 取消」两个动作，不掺确认型卡片', async () => {
    const w = await mountRail()
    const agent = useAgentStore()
    agent.blockingWait = {
      toolName: 'propose_generation',
      callId: 'call-1',
      nodeId: 'node-1',
    } as never
    await flushPromises()

    expect(w.find('[data-testid="propose-wait-hint"]').exists()).toBe(true)
    expect(w.find('[data-testid="propose-wait-cancel"]').exists()).toBe(true)
    for (const sel of CONFIRM_CARD_SELECTORS) {
      expect(w.find(sel).exists(), `不该再出现 ${sel}`).toBe(false)
    }
  })
})

describe('② propose「取消」走显式 decline（回归锁）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    answersRequests.length = 0
    stubFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('点取消 → POST /answers 带 decision=decline 与 callId，并回落画布收敛事件', async () => {
    const w = await mountRail()
    const agent = useAgentStore()
    agent.blockingWait = {
      toolName: 'propose_generation',
      callId: 'call-1',
      nodeId: 'node-1',
    } as never
    await flushPromises()

    await w.find('[data-testid="propose-wait-cancel"]').trigger('click')
    await flushPromises()

    expect(answersRequests).toHaveLength(1)
    const body = JSON.parse(answersRequests[0]) as Record<string, unknown>
    // 这一键是「用户点了取消」变成确定性事实的唯一载体，不能丢、不能改名
    expect(body.decision).toBe('decline')
    expect(body.callId).toBe('call-1')
    // 画布侧仍必须收敛（节点回 draft），不因网络层失败而残留琥珀卡
    expect(w.emitted('clearProposeGeneration')).toEqual([['node-1']])
  })

  it('callId 缺席（blocking 关闭的旧等待）不再发 decline，但仍要收敛画布', async () => {
    const w = await mountRail()
    const agent = useAgentStore()
    agent.blockingWait = {
      toolName: 'propose_generation',
      nodeId: 'node-9',
    } as never
    await flushPromises()

    await w.find('[data-testid="propose-wait-cancel"]').trigger('click')
    await flushPromises()

    expect(answersRequests).toHaveLength(0)
    expect(w.emitted('clearProposeGeneration')).toEqual([['node-9']])
  })

  it('decline 请求失败不阻断画布收敛（幂等端点 + 轮询兜底）', async () => {
    const w = await mountRail()
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.includes('/answers')) {
        answersRequests.push('attempted')
        return { ok: false, status: 500, json: async () => ({}) }
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) }
    }))
    const agent = useAgentStore()
    agent.blockingWait = {
      toolName: 'propose_generation',
      callId: 'call-err',
      nodeId: 'node-err',
    } as never
    await flushPromises()

    await w.find('[data-testid="propose-wait-cancel"]').trigger('click')
    await flushPromises()

    expect(answersRequests).toHaveLength(1)
    expect(w.emitted('clearProposeGeneration')).toEqual([['node-err']])
  })
})
