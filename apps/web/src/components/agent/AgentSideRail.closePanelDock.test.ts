/**
 * 路线 ③ 第三批（D 类第一批，第 5 刀）：closePanel 内 `if (isMobileLayout.value) return`
 * 收敛为 `if (!isDesktopDock.value) return` 的行为级契约。
 *
 * 背景：第一批把 7 处模板否定读取收敛为 `isDesktopDock = computed(() => !isMobileLayout.value)`，
 * 上限 21→15；第二批把模板区 3 处肯定读取改成 `!isDesktopDock`，上限 15→12；本刀是 D 类
 * 脚本逻辑读取的第一刀，取 1 处最干净、完全自包含、非冻结、非 composable 传参、非 watch/computed
 * 的函数内条件（closePanel），上限 12→11。
 *
 * 等价关系：`!isDesktopDock === isMobileLayout.value`（派生 computed 无副作用）⇒ 改写零行为变更。
 *
 * ⭐ 面板用 v-show（不是 v-if）且 Teleport 到 body ⇒ 子元素常在 DOM，查询必须覆盖 document.body；
 * PC 端先做有效性断言，防「两端都不存在」假绿。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import AgentSideRail from './AgentSideRail.vue'

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

/** 第一批已建立的桌面专属锚点，用作两端形态的有效性断言。 */
const DESKTOP_ONLY_SELECTORS = [
  '.agent-resize-handle',
  '.agent-subtitle',
  '[title="收起助手"]',
] as const

/** defineExpose 冻结契约 11 项。 */
const EXPOSE_KEYS = [
  'newAgentSession', 'openThreadHistory', 'closeThreadHistory', 'openPanel',
  'closePanel', 'setComposerInput', 'addAttachment', 'reconcileFromNodes',
  'confirmProposeWait', 'cancelProposeForNode', 'addFromCanvasNodes',
] as const

function queryAll(sel: string): Element[] {
  // Teleport 到 body + attachTo body ⇒ 统一从 body 查询，wrapper 查询会漏 teleport 内容
  return Array.from(document.body.querySelectorAll(sel))
}

async function mountRail(matches: boolean) {
  // 移动端分支的 useAgentDock 会建 ResizeObserver；jsdom 无此全局，需 stub。
  // 这是测试环境补齐，不改变产品代码语义。
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ data: [] }),
  })))
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  const w = mount(AgentSideRail, {
    attachTo: document.body,
    global: { plugins: [router] },
    props: { sessionId: 's1' },
  })
  await flushPromises()
  return w
}

/** 打开移动端对话历史抽屉。fetchThreads 的网络结果不影响「抽屉是否渲染」这一形态判据。 */
async function openHistory(w: { vm: unknown; unmount: () => void }) {
  const vm = w.vm as { openThreadHistory: () => Promise<void> }
  await vm.openThreadHistory().catch(() => {})
  await flushPromises()
}

function railSource(): string {
  return readFileSync(resolve(__dirname, 'AgentSideRail.vue'), 'utf8')
}

function stripVueComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

describe('路线 ③ 第三批（D 类第一批）：closePanel 改用 !isDesktopDock', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('① PC 端（matchMedia=false）：桌面形态在位，移动 dock 与移动历史抽屉均不出现', async () => {
    const w = await mountRail(false)
    const hits = DESKTOP_ONLY_SELECTORS.map((s) => queryAll(s).length)
    expect(hits, 'PC 端三项必须各 1，否则是空集假绿').toEqual([1, 1, 1])
    expect(queryAll('.agent-panel-mobile-dock').length, 'PC 不得套移动 dock 形态').toBe(0)
    await openHistory(w)
    expect(queryAll('.thread-history-layer').length, 'PC 不得渲染移动历史抽屉').toBe(0)
    w.unmount()
  })

  it('② 移动端（matchMedia=true）：移动 dock 形态与移动历史抽屉均在位，桌面锚点全隐', async () => {
    const w = await mountRail(true)
    const hits = DESKTOP_ONLY_SELECTORS.map((s) => queryAll(s).length)
    expect(hits, '移动端三项必须各 0').toEqual([0, 0, 0])
    expect(queryAll('.agent-panel-mobile-dock').length, '移动端必须套 dock 形态').toBe(1)
    await openHistory(w)
    expect(queryAll('.thread-history-layer').length, '移动端必须能打开对话历史抽屉').toBe(1)
    w.unmount()
  })

  it('③ 源码契约：closePanel 改用 !isDesktopDock，派生定义仍是纯否定，SFC 读取点恰 11', () => {
    const src = railSource()
    expect(src).toMatch(
      /const isDesktopDock = computed\(\(\) => !isMobileLayout\.value\)/,
    )
    const m = src.match(/function closePanel\(\)\s*\{[\s\S]*?\n\}/)
    expect(m, 'closePanel 必须存在').toBeTruthy()
    const body = m![0]
    expect(body, 'closePanel 不得直接读 isMobileLayout').not.toMatch(/\bisMobileLayout\b/)
    expect(body, 'closePanel 必须走 !isDesktopDock 派生')
      .toMatch(/if\s*\(\s*!isDesktopDock\.value\s*\)\s*return/)
    const stripped = stripVueComments(src)
    expect((stripped.match(/\bisMobileLayout\b/g) ?? []).length, 'SFC isMobileLayout 读取点必须恰好 11')
      .toBe(11)
    expect((src.match(/\bisDesktopDock\b/g) ?? []).length, 'isDesktopDock 总消费须 14（13 + closePanel 1）')
      .toBeGreaterThanOrEqual(14)
  })

  it('④ 冻结边界：defineExpose 11 项与 getIsMobileLayout 契约零改写', () => {
    const src = railSource()
    const start = src.indexOf('defineExpose({')
    const end = src.indexOf('</script>', start)
    expect(start, '必须扫到 defineExpose').toBeGreaterThan(-1)
    expect(end, '必须扫到 script 结束').toBeGreaterThan(start)
    const expose = src.slice(start, end)
    for (const key of EXPOSE_KEYS) {
      expect(expose, `defineExpose 缺项 ${key}`).toMatch(new RegExp(`\\b${key}\\b`))
    }
    expect(src).toMatch(/getIsMobileLayout:\s*\(\)\s*=>\s*isMobileLayout\.value/)
    expect(src).toContain('sendMessage')
    expect(src).toContain('handleEvent')
    expect(src).toContain('canvas_command')
  })

  it('⑤ closePanel 行为：移动端早返回（不 emit expandedChange=false），桌面端关闭（emit expandedChange=false）', async () => {
    // 移动端
    const m = await mountRail(true)
    ;(m.vm as { closePanel: () => void }).closePanel()
    await flushPromises()
    expect(
      (m.emitted('expandedChange') ?? []).some((a) => (a as unknown[])[0] === false),
      '移动端 closePanel 不得 emit 关闭',
    ).toBe(false)
    m.unmount()
    // 桌面端
    const d = await mountRail(false)
    ;(d.vm as { closePanel: () => void }).closePanel()
    await flushPromises()
    expect(
      (d.emitted('expandedChange') ?? []).some((a) => (a as unknown[])[0] === false),
      '桌面端 closePanel 必须 emit 关闭',
    ).toBe(true)
    d.unmount()
  })
})
