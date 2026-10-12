import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { useAgentStore } from '@/stores/agent'
import AgentSideRail from './AgentSideRail.vue'

/**
 * 「复用本轮（提示词 + 引用）」入口的**位置 + 形态**回归锁（2026-10-12）。
 *
 * 改动前：一颗虚线胶囊文字按钮独占用户气泡正文中段（`↺ 复用本轮（提示词 + 引用）`），
 * 占掉气泡内部空间、且同行里只有它是文字按钮。
 * 改动后：收敛为**图标**，与底部 编辑/复制 同排（`.agent-msg-actions`）。
 *
 * 断言刻意落在 **DOM 出口**（testid / class / 树位置），不落在源码字符串 ——
 * 源码断言会被注释命中（本文件的注释里就写着旧类名），起不到回归锁作用。
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

/** 本机依赖树未装 mermaid（是动态 import），不 stub 连测试文件都收集不到。 */
vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '' }) },
}))

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [] }),
  })))
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

describe('「复用本轮」入口：与 编辑/复制 同排 + 只保留图标', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('用户气泡里复用入口落在操作行内，且行内只有图标按钮', async () => {
    const w = await mountRail()
    useAgentStore().addUserMessage('再生成一个蚂蚁的视频，皮克斯风格，专业分镜提示词')
    await flushPromises()

    // ⚠️ 有效性断言先行：先证明「用户气泡 + 操作行」真的渲染出来了，
    //    否则下面所有否定式断言都会在空 DOM 上假绿（空集假绿防线）。
    const row = w.find('.agent-msg-actions')
    expect(row.exists(), '用户气泡的操作行必须渲染').toBe(true)
    const btns = row.findAll('button')
    expect(btns.length, '操作行按钮数（编辑 / 复制 / 复用）').toBe(3)

    const reuse = w.find('[data-testid="reuse-turn-btn"]')
    expect(reuse.exists(), '复用入口必须存在').toBe(true)

    // ① 位置：复用入口是操作行的后代（与 编辑/复制 并列），不再独占气泡正文中段
    expect(reuse.element.closest('.agent-msg-actions')).not.toBeNull()

    // ② 形态：只保留图标 —— 无可读文本，语义移入 title / aria-label
    expect(reuse.text().trim()).toBe('')
    expect(reuse.find('svg').exists()).toBe(true)
    expect(reuse.attributes('title')).toContain('复用本轮')
    expect(reuse.attributes('aria-label')).toContain('复用本轮')

    // ③ 旧胶囊文字按钮不得复活
    expect(w.findAll('.agent-bubble-reuse-btn').length).toBe(0)
    expect(w.findAll('.agent-bubble-reuse').length).toBe(0)
  })
})
