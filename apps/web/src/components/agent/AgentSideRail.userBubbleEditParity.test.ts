import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useAgentStore } from '@/stores/agent'
import AgentSideRail from './AgentSideRail.vue'

/**
 * 「编辑态 = 同一张卡片，只是底部按钮不同」回归锁（2026-10-12 二次口径）。
 *
 * 用户口径（原话骨架）：历史消息气泡是对的；点「编辑」进了编辑态之后，
 * **卡片样式/背景宽度都变了，像换了一张卡**。诉求是同一张卡片的不同状态，
 * 底部图标从「编辑 / 复制 / 复用本轮」换成「取消 / 发送」，仅此不同。
 *
 * 实测根因有两条，本文件两条都锁：
 *   ① **宽度**：.agent-bubble-user 是 max-width:88% + 内容撑满（长文案取满 88%），
 *      编辑态内容换成一张 textarea，比正文窄 ⇒ shrink-to-fit 把卡片收窄到 ~288px；
 *      ⇒ 编辑态补 .agent-bubble-user--editing { width: 88% }，两态同一外形。
 *   ② **卡中卡**：原 textarea 自带 rounded-md + border + bg + p-2，
 *      在用户卡片里又套出一层「卡」，且文字起点与展示态正文错位；
 *      ⇒ 改成无缝（transparent / border:0 / padding:0 / display:block）。
 *   ③ **同槽**：原按钮行是右对齐 flex（justify-end），展示态图标行是左对齐；
 *      ⇒ 换成 .agent-edit-actions，与 .agent-msg-actions 同为左对齐 + margin-top: 8px。
 *
 * 断言分两层，各补各的盲区：
 *   · **DOM 出口层**（真挂载）：气泡只有一颗、编辑卡在它内部、textarea 不带卡中卡类、
 *     按钮行带同槽类且不是右对齐。jsdom **没有布局引擎** ⇒ 宽度本身只能靠第二层锁。
 *   · **CSS 规则层**（读 .vue 源码的规则体）：两态宽度基准同源（88%）、textarea 确为无缝、
 *     两个行容器同为左对齐 + 同 margin-top。选择器锚定「后紧跟 `{`」⇒ 注释命中不了，
 *     不会像朴素 toContain 那样被本文件的注释骗过。
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

const RAIL_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'AgentSideRail.vue'), 'utf8')

/**
 * 取某条 CSS 规则的声明体。
 * ⛔ 不用 `src.includes(...)`：本文件的注释里就写着这些选择器与属性名，会被假命中。
 *    这里要求选择器**后面紧跟** `{`（注释里的出现后面是中文/反引号），并对 `[^}]*` 取体。
 */
function cssRuleBody(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(RAIL_SRC)
  expect(m, `源码里找不到 CSS 规则 ${selector}（改名了就该同步改这条锁）`).toBeTruthy()
  return m![1]!
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [] }),
  })))
}

/** 挂载侧栏（onMounted 的 bootstrapThread → loadHistory 会整体替换 messages）。 */
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

type Rail = Awaited<ReturnType<typeof mountRail>>
type RailEl = ReturnType<Rail['find']>

/** seed 一条历史用户消息，返回挂载器与「展示态确实完整」的前置证据。 */
async function seedHistoryUserMessage(): Promise<{ w: Rail; bubble: RailEl; row: RailEl }> {
  const w = await mountRail()
  useAgentStore().addUserMessage(DRAFT)
  await flushPromises()

  // ⚠️ 有效性断言先行（空集假绿防线）：先证展示态的每一块真的在，
  //    否则下面所有否定式断言都会在空 DOM 上假绿。
  const bubble = w.find('.agent-bubble-user')
  expect(bubble.exists(), '用户气泡必须渲染').toBe(true)
  expect(bubble.classes(), '展示态不该带编辑态宽度类').not.toContain('agent-bubble-user--editing')
  expect(
    bubble.find('p.whitespace-pre-wrap').text(),
    '展示态正文必须渲染（否则「编辑态退场」类断言是在空集上通过）',
  ).toContain(DRAFT)
  const row = bubble.find('.agent-msg-actions')
  expect(row.exists(), '展示态操作行必须渲染').toBe(true)
  expect(row.findAll('button').length, '操作行按钮数（编辑 / 复制 / 复用）').toBe(3)

  return { w, bubble, row }
}

/** 点开该条用户消息的「编辑」，进入编辑态。 */
async function enterEdit(row: RailEl) {
  const editBtn = row.findAll('button').find((b) => b.attributes('title') === '编辑')
  expect(editBtn, '操作行里必须有「编辑」按钮').toBeTruthy()
  await editBtn!.trigger('click')
  await flushPromises()
}

describe('编辑态与展示态是同一张用户卡片', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('气泡自始至终只有一颗，编辑卡挂在它**内部**（不是另起一张卡）', async () => {
    const { w, row } = await seedHistoryUserMessage()
    expect(w.findAll('.agent-bubble-user').length, '展示态只有一个用户气泡').toBe(1)

    await enterEdit(row)

    expect(w.findAll('.agent-bubble-user').length, '编辑态仍是同一颗气泡，没有多出第二张卡').toBe(1)
    expect(
      w.find('.agent-bubble-user > .agent-edit-card').exists(),
      '编辑卡必须是用户气泡的直接子级（在外面就是换了张卡）',
    ).toBe(true)
  })

  it('进入编辑态给同一颗气泡补上宽度基准类，取消后摘掉', async () => {
    const { w, bubble, row } = await seedHistoryUserMessage()

    await enterEdit(row)
    expect(
      bubble.classes(),
      '编辑态气泡必须带 --editing（宽度基准；缺失即回到「被 shrink-to-fit 收窄」的旧形态）',
    ).toContain('agent-bubble-user--editing')

    await w.find('.agent-edit-actions button:not(.agent-edit-btn--primary)').trigger('click')
    await flushPromises()
    expect(w.find('.agent-edit-card').exists(), '取消后编辑卡应消失').toBe(false)
    expect(w.find('.agent-bubble-user').classes(), '取消后宽度基准类应摘掉').not.toContain(
      'agent-bubble-user--editing',
    )
  })

  it('textarea 无缝：不得再把「卡中卡」三件套带回来', async () => {
    const { w, row } = await seedHistoryUserMessage()
    await enterEdit(row)

    const ta = w.find('.agent-edit-card textarea')
    expect(ta.exists(), '编辑卡里必须有 textarea').toBe(true)
    const cls = ta.classes()
    expect(cls, '有效性：取到的确实是那张编辑 textarea').toContain('agent-edit-textarea')
    expect(cls, 'textarea 不得再自带底色（会在用户卡片里套出第二层卡）').not.toContain(
      'bg-[var(--neo-surface-card)]',
    )
    expect(cls, 'textarea 不得再自带描边').not.toContain('border')
    expect(cls, 'textarea 不得再自带圆角').not.toContain('rounded-md')
    expect(cls, 'textarea 不得再自带内边距（文字起点会与展示态正文错位）').not.toContain('p-2')
  })

  it('底部一排仍在卡片内、与展示态图标行同槽（左对齐，不是原来的右对齐）', async () => {
    const { w, row } = await seedHistoryUserMessage()
    await enterEdit(row)

    const card = w.find('.agent-bubble-user > .agent-edit-card')
    const actions = card.find('.agent-edit-actions')
    expect(actions.exists(), '编辑态底部一排必须落在卡片内且带同槽类').toBe(true)
    expect(actions.classes(), '不得右对齐 —— 展示态图标行是左对齐').not.toContain('justify-end')
    expect(actions.findAll('button').map((b) => b.text()), '仅按钮不同：取消 / 发送').toEqual([
      '取消',
      '发送',
    ])
  })
})

describe('CSS 规则层：两态外形同源（jsdom 无布局引擎，只能在这一层锁）', () => {
  it('宽度基准同源：展示态 max-width 88% ⇄ 编辑态 width 88%', () => {
    expect(cssRuleBody('.agent-bubble-user'), '展示态宽度上限').toMatch(/max-width\s*:\s*88%/)
    expect(cssRuleBody('.agent-bubble-user--editing'), '编辑态取满同宽').toMatch(/width\s*:\s*88%/)
  })

  it('textarea 规则确为无缝（transparent / 无描边 / 零内边距 / 继承文字色）', () => {
    const body = cssRuleBody('.agent-edit-textarea')
    expect(body).toMatch(/background\s*:\s*transparent/)
    expect(body).toMatch(/border\s*:\s*0/)
    expect(body).toMatch(/padding\s*:\s*0/)
    expect(body).toMatch(/color\s*:\s*inherit/)
  })

  it('编辑态按钮行与展示态图标行同为左对齐 + 同 margin-top', () => {
    const editRow = cssRuleBody('.agent-edit-actions')
    const msgRow = cssRuleBody('.agent-msg-actions')
    // 有效性：两条规则真的带上了布局属性，否则下面的否定断言是在空串上通过
    expect(editRow).toMatch(/display\s*:\s*flex/)
    expect(msgRow).toMatch(/display\s*:\s*flex/)
    expect(editRow).toMatch(/margin-top\s*:\s*8px/)
    expect(msgRow).toMatch(/margin-top\s*:\s*8px/)
    expect(editRow, '编辑态按钮行不得右对齐').not.toMatch(/justify-content\s*:\s*flex-end/)
    expect(msgRow, '展示态图标行本就不右对齐（对照组）').not.toMatch(/justify-content\s*:\s*flex-end/)
  })
})
