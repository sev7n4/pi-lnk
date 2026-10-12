import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { useAgentStore } from '@/stores/agent'
import type { SidebarAttachment } from '@lnkpi/shared'
import AgentSideRail from './AgentSideRail.vue'

/**
 * 二次编辑卡「只留编辑卡」回归锁（2026-10-12）。
 *
 * 改动前（用户口径）：点「编辑」后，编辑卡下方**照旧**渲染该消息的两块静态展示 ——
 * 同一段历史正文再来一遍（与 textarea 内容重复）+ 编辑/复制/复用本轮 三个图标按钮，
 * 把二次编辑的简洁性淹掉。
 * 改动后：编辑态 = 该条消息的**历史正文**与**操作行（编辑/复制/复用本轮）**退场，
 * 编辑卡下面直接收尾；取消编辑后原样恢复。
 *
 * ⚠️ 范围边界：用户点名的是「按钮 + 历史文字」。**引用条 / 指代回执**（同为静态展示，
 * 但承载「这条消息当时带了哪些素材」的信息）本次**刻意保留**，见最后一组断言 ——
 * 若将来要一并隐藏，请连同本断言一起改，不要悄悄漂移。
 *
 * 断言刻意落在 **DOM 出口**（类名 / 元素位置 / 可见文本），不落在源码字符串 ——
 * 源码断言会被注释命中（本文件注释里就写着这些类名），起不到回归锁作用。
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

const DRAFT = '再生成一个蚂蚁的视频，皮克斯风格，专业分镜提示词，要有声音对话，BGM，环境音'

// 历史正文段落的选择器：编辑卡本身也是 `<p class="agent-edit-card whitespace-pre-wrap">`，
// 用 `:not(.agent-edit-card)` 排除，否则编辑态下会把编辑卡误算成「还在的历史正文」。
const HIST_TEXT = '.agent-bubble-user p.whitespace-pre-wrap:not(.agent-edit-card)'

const IMAGE_REF: SidebarAttachment = {
  id: 'ref-1',
  mediaType: 'image',
  sourceKind: 'upload',
  label: 'clipboard-screenshot.png',
  url: 'https://cdn.example.com/clipboard-screenshot.png',
}

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

/** seed 一条带引用素材的历史用户消息，并把「展示态确实齐全」作为前置证据返回。 */
async function seedHistoryUserMessage() {
  const w = await mountRail()
  useAgentStore().addUserMessage(DRAFT, { attachments: [IMAGE_REF] })
  await flushPromises()

  const bubble = w.find('.agent-bubble-user')
  const row = w.find('.agent-msg-actions')
  const historyText = w.find(HIST_TEXT)

  // ⚠️ 有效性断言先行（空集假绿防线）：先证明展示态的每一块真的渲染出来了，
  //    否则下面所有否定式断言都会在空 DOM 上假绿。
  expect(bubble.exists(), '用户气泡必须渲染').toBe(true)
  expect(historyText.exists(), '历史正文段落必须渲染').toBe(true)
  expect(historyText.text()).toContain(DRAFT)
  expect(row.exists(), '操作行必须渲染').toBe(true)
  expect(row.findAll('button').length, '操作行按钮数（编辑 / 复制 / 复用）').toBe(3)
  expect(w.find('[data-testid="reuse-turn-btn"]').exists(), '复用入口必须存在').toBe(true)
  expect(
    w.find('.agent-ref-strip--in-user-bubble').exists(),
    '引用条必须渲染（否则「编辑时引用条退场」这条断言是在空集上通过）',
  ).toBe(true)

  return { w, bubble, row }
}

describe('二次编辑卡：编辑态下气泡只留编辑卡', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('进入编辑态后，历史正文 / 操作行 / 引用条 / 复用入口全部退场', async () => {
    const { w, row } = await seedHistoryUserMessage()

    const editBtn = row.findAll('button').find((b) => b.attributes('title') === '编辑')
    expect(editBtn, '操作行里必须有「编辑」按钮').toBeTruthy()
    await editBtn!.trigger('click')
    await flushPromises()

    // ① 编辑卡本身在位，且预填原文
    const card = w.find('.agent-bubble-user .agent-edit-card')
    expect(card.exists(), '编辑卡必须渲染').toBe(true)
    const textarea = card.find('textarea')
    expect(textarea.exists(), '编辑卡里必须有 textarea').toBe(true)
    expect((textarea.element as HTMLTextAreaElement).value).toBe(DRAFT)
    const cardBtnTexts = card.findAll('button').map((b) => b.text())
    expect(cardBtnTexts, '编辑卡按钮应为「取消 / 发送」').toEqual(['取消', '发送'])

    // ② 历史正文退场（不再与 textarea 内容重复）
    expect(
      w.findAll(HIST_TEXT).length,
      '编辑态下不应再有历史正文段落',
    ).toBe(0)

    // ③ 操作行（编辑 / 复制 / 复用本轮）退场
    expect(w.findAll('.agent-msg-actions').length, '编辑态下不应再有消息操作行').toBe(0)
    expect(w.findAll('[data-testid="reuse-turn-btn"]').length, '复用入口应一并退场').toBe(0)

    // ④ 范围边界：引用条本次刻意保留（用户点名的是「按钮 + 历史文字」）——
    //    这条断言同时证明 ② 的「正文消失」不是因为整颗气泡被拆掉。
    expect(
      w.findAll('.agent-ref-strip--in-user-bubble').length,
      '引用条本次范围外，应仍在位（若将来要隐藏，请连同本断言一起改）',
    ).toBe(1)
  })

  it('取消编辑后，历史正文 / 操作行 / 引用条原样恢复', async () => {
    const { w, row } = await seedHistoryUserMessage()

    await row.findAll('button').find((b) => b.attributes('title') === '编辑')!.trigger('click')
    await flushPromises()
    await w.find('.agent-edit-card button:not(.agent-edit-btn--primary)').trigger('click')
    await flushPromises()

    expect(w.find('.agent-edit-card').exists(), '取消后编辑卡应消失').toBe(false)
    const historyText = w.find(HIST_TEXT)
    expect(historyText.exists(), '取消后历史正文应恢复').toBe(true)
    expect(historyText.text()).toContain(DRAFT)
    const rowAfter = w.find('.agent-msg-actions')
    expect(rowAfter.exists(), '取消后操作行应恢复').toBe(true)
    expect(rowAfter.findAll('button').length).toBe(3)
    expect(w.find('.agent-ref-strip--in-user-bubble').exists(), '取消后引用条应恢复').toBe(true)
  })

  it('编辑态只作用于被编辑的那条消息（其他消息的操作行不受影响）', async () => {
    const { w } = await seedHistoryUserMessage()
    useAgentStore().addUserMessage('第二条消息')
    await flushPromises()

    const rows = w.findAll('.agent-msg-actions')
    expect(rows.length, '此时应有两条用户消息、两行操作').toBe(2)
    await rows[0].findAll('button').find((b) => b.attributes('title') === '编辑')!.trigger('click')
    await flushPromises()

    const rowsAfter = w.findAll('.agent-msg-actions')
    expect(rowsAfter.length, '只有被编辑的那条让出操作行').toBe(1)
    expect(rowsAfter[0].findAll('button').length).toBe(3)
    expect(w.findAll(HIST_TEXT).length).toBe(1)
    expect(w.find('.agent-edit-card').exists()).toBe(true)
  })
})
