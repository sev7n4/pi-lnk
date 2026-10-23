import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { useAgentStore } from '@/stores/agent'
import AgentSideRail from './AgentSideRail.vue'

/**
 * 2026-10-23 用户反馈（移动端）：用户气泡常驻「编辑 / 复制 / 复用本轮（或引用）」
 * 三个图标，把卡片撑得很高，挤压对话流。
 * 改动：移动端默认收起这三个图标，**点气泡**后浮出在卡片下方；
 *       桌面（hover 语义可用）维持常驻弱显不变。
 *
 * 行为级守卫（非静态字符串）：挂载组件 + 注入 mock（isMobileLayout）+ 断言可观测出口
 * （`.agent-msg-actions.is-open` 类出现 / 消失）。桌面侧做否定式守卫，防止「移动端改动
 * 悄悄泄漏到桌面」。
 *
 * ⚠️ 移动端 `panelTeleported=true` ⇒ 面板 Teleport 到 body，VTU `wrapper.find` 看不到，
 *    故统一 `attachTo: document.body` 后用 `document.querySelector` 取真实 DOM 出口。
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

const DRAFT = '再生成一个蚂蚁的视频，皮克斯风格，专业分镜提示词'

/** matches=true 时，移动端布局 composable 会读到 isMobileLayout=true。 */
function stubMatchMedia(mobile: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: mobile && query.includes('max-width: 767'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  }))
}

let lastWrapper: ReturnType<typeof mount> | null = null

async function mountRail(mobile: boolean) {
  stubMatchMedia(mobile)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  const w = mount(AgentSideRail, {
    global: { plugins: [router] },
    props: { sessionId: 's1' },
    attachTo: document.body,
  })
  // onMounted 的 bootstrapThread → loadHistory 会整体替换 messages，必须等它落定再 seed
  await flushPromises()
  lastWrapper = w
  return w
}

/** seed 一条历史用户消息，并先行证明展示态齐全（空集假绿防线）。 */
async function seedHistoryUserMessage(mobile: boolean) {
  await mountRail(mobile)
  useAgentStore().addUserMessage(DRAFT, {})
  await flushPromises()

  const bubble = document.querySelector('.agent-turn--user .agent-bubble-user')
  const row = document.querySelector('.agent-turn--user .agent-msg-actions')

  // ⚠️ 有效性断言先行（空集假绿防线）
  expect(bubble, '用户气泡必须渲染').not.toBeNull()
  expect(row, '操作行必须渲染').not.toBeNull()
  expect(
    row!.querySelectorAll('button').length,
    '操作行按钮数（编辑 / 复制 / 复用）',
  ).toBe(3)

  return {
    bubble: bubble as HTMLElement,
    row: row as HTMLElement,
  }
}

function isOpen() {
  return document.querySelector('.agent-turn--user .agent-msg-actions.is-open')
}

describe('移动端用户气泡：点卡片浮出三图标', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    })))
    // 移动端布局下组件会 new ResizeObserver 量 dock 高度；jsdom 无此全局，必须 stub。
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })
  afterEach(() => {
    lastWrapper?.unmount()
    lastWrapper = null
    vi.unstubAllGlobals()
  })

  it('移动端：默认收起（is-open 不出现），点气泡后浮出，再点收起', async () => {
    const { row, bubble } = await seedHistoryUserMessage(true)

    // 默认：操作行存在但没被「打开」
    expect(row.classList.contains('is-open'), '默认不应带 is-open').toBe(false)

    // 点气泡 → 浮出
    await new DOMWrapper(bubble).trigger('click')
    await flushPromises()
    expect(isOpen(), '点气泡后操作行应浮出（is-open）').not.toBeNull()

    // 再点 → 收起（toggle 语义）
    await new DOMWrapper(bubble).trigger('click')
    await flushPromises()
    expect(isOpen(), '再次点气泡应收起（is-open 消失）').toBeNull()
  })

  it('桌面：点气泡不应触发浮出（移动端改动不泄漏到桌面）', async () => {
    await seedHistoryUserMessage(false)

    const bubble = document.querySelector('.agent-turn--user .agent-bubble-user') as HTMLElement
    await new DOMWrapper(bubble).trigger('click')
    await flushPromises()
    expect(isOpen(), '桌面点气泡不应出现 is-open').toBeNull()
  })
})
