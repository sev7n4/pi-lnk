// 2026-10-19 真机事故回归（移动端 ≡ 抽屉「项目清单看不到」）：
// 账号 165 项目时，抽屉项目区只剩一排 ~25px 等距的 1px 细线（像素实锤：线间距
// ≈ 8px flex gap + 1px 边框，标题/时间/图标/卡片底色全部不可见）。
// 根因：抽屉是**定高** flex 列容器（position:absolute; top:0; bottom:0），
// 项目卡带 overflow:hidden ⇒ flex 规范 §4.5「自动最小尺寸」对 overflow≠visible
// 的项归零 ⇒ flex-shrink 合法地把全部项目卡压到 0 高度；而 164 条 gap×8px 的
// 总量已超抽屉高度 ⇒ 内容永远滚动不尽。create-card/caption 只因 overflow 可见
// 才靠 min-height:auto 幸存——不可依赖。
// 修复：抽屉（及同族 thread-history-sheet）直接子项一律 flex-shrink:0，
// 溢出交还 overflow-y:auto。
// jsdom 不计算布局 ⇒ 布局类断言只能落在 SFC 样式块契约上（与 theme-usage /
// bareBar 测试同族），否定断言一律配有效性断言（防空集假绿）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')
const style = sfc.slice(sfc.indexOf('<style'), sfc.lastIndexOf('</style>'))

describe('mobile session drawer: project cards must not be shrunk into hairlines (2026-10-19 incident)', () => {
  it('drawer direct children are shrink-proof (root cause: overflow:hidden zeroes auto min size)', () => {
    const rule = style.match(/\.session-drawer\s*>\s*\*\s*\{[^}]*\}/)?.[0]
    expect(rule, '抽屉直接子项缺少 flex-shrink:0 保护——项目卡会被压成 1px 细线').toBeTruthy()
    expect(rule).toContain('flex-shrink: 0')
  })

  it('same guard on the sibling thread-history sheet (same accident family)', () => {
    const rule = style.match(/\.thread-history-sheet\s*>\s*\*\s*\{[^}]*\}/)?.[0]
    expect(rule, '对话历史浮层直接子项缺少 flex-shrink:0 保护').toBeTruthy()
    expect(rule).toContain('flex-shrink: 0')
  })

  it('paired: hazard neutralized, not deleted — overflow:hidden stays, scroll strategy stays', () => {
    // 有效性配对①：圆角裁剪仍靠 overflow:hidden（不允许靠删 hazard 来"修"）
    expect(style).toMatch(/\.project-card\s*\{[^}]*overflow:\s*hidden/)
    // 有效性配对②：溢出策略仍是抽屉滚动，而不是把子项压扁
    expect(style).toMatch(/\.session-drawer\s*\{[^}]*overflow-y:\s*auto/)
    // 有效性配对③：保护规则确实挂在抽屉容器下（规则存在但选择器写错 = 没生效）
    expect(style).toContain('.session-drawer > *')
  })
})

// ---- 数据通路（挂载级）：抽屉开的瞬间项目卡必须真的渲染出来 ----
// 样式契约防「压扁」，这里防「压根没渲染」——两者都发生过用户可见的「清单看不到」。

vi.mock('@/services/canvas-api', () => ({
  canvasApi: {
    list: vi.fn().mockResolvedValue({
      data: {
        data: [
          { id: 's1', title: '漫剧主线', updatedAt: '2026-10-19T10:00:00.000Z' },
          { id: 's2', title: '产品图实验', updatedAt: '2026-10-18T10:00:00.000Z' },
          { id: 's3', title: '', updatedAt: '2026-10-17T10:00:00.000Z' },
        ],
      },
    }),
    create: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('@/services/sessions-api', () => ({
  sessionsApi: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({ messages: [] }),
    remove: vi.fn(),
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

async function mountRail() {
  const { mount, flushPromises } = await import('@vue/test-utils')
  const { createPinia, setActivePinia } = await import('pinia')
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const AgentSideRail = (await import('./AgentSideRail.vue')).default

  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })),
  )
  setActivePinia(createPinia())
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

describe('mobile session drawer: project list data path', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('openSessionDrawer renders one card per project (title fallback + is-current accent)', async () => {
    const w = await mountRail()
    w.vm.openSessionDrawer()
    const { flushPromises } = await import('@vue/test-utils')
    await flushPromises()

    // 抽屉 Teleport 到 body——查询 document 而非 wrapper
    const cards = document.body.querySelectorAll('.project-card')
    expect(cards.length).toBe(3)
    expect(cards[0].textContent).toContain('漫剧主线')
    expect(cards[1].textContent).toContain('产品图实验')
    // 空标题走「未命名项目」兜底
    expect(cards[2].textContent).toContain('未命名项目')
    // 当前项目卡带 is-current（accent 边框）
    expect(cards[0].classList.contains('is-current')).toBe(true)
    expect(cards[1].classList.contains('is-current')).toBe(false)
    // 每卡都有可操作入口（打开 + 重命名 + 删除）——细线态下这些全被裁没
    expect(document.body.querySelectorAll('.project-card__main').length).toBe(3)
    expect(document.body.querySelectorAll('.project-card__more').length).toBe(6)
  })
})
