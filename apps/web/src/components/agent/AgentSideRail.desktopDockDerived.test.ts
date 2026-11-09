/**
 * 路线 ③ 第一批：isMobileLayout 逐处搬的行为级契约。
 *
 * 背景：21 点有效读取中的 7 处模板 `!isMobileLayout` 收敛为单一语义派生
 * `isDesktopDock`。本测试**真实挂载** AgentSideRail，在 PC / 移动两端断言
 * 7 处锚点对应的 DOM 形态，证明搬迁前后渲染形态一致（零行为变更）。
 *
 * ⭐ 面板用 `v-show`（不是 v-if）且 Teleport 到 body ⇒ 子元素始终在 DOM 中，
 * 因此查询必须覆盖 document.body；PC 端先做有效性断言，防「两端都不存在」假绿。
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

/** 7 处模板否定读取中可直接观测的 3 个 DOM 锚点。 */
const DESKTOP_ONLY_SELECTORS = [
  '.agent-resize-handle',
  '.agent-subtitle',
  '[title="收起助手"]',
] as const

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

function railSource(): string {
  return readFileSync(resolve(__dirname, 'AgentSideRail.vue'), 'utf8')
}

function templatePart(src: string): string {
  const i = src.indexOf('<template>')
  return i < 0 ? '' : src.slice(i)
}

describe('路线 ③ 第一批：7 处模板否定读取收敛为 isDesktopDock', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('① PC 端（matchMedia=false）：三个桌面专属 DOM 锚点均存在（有效性断言）', async () => {
    const w = await mountRail(false)
    const hits = DESKTOP_ONLY_SELECTORS.map((s) => queryAll(s).length)
    expect(hits, 'PC 端三项必须各 1，否则是空集假绿').toEqual([1, 1, 1])
    expect(queryAll('.agent-subtitle')[0]?.textContent).toContain('lnk·π agent')
    w.unmount()
  })

  it('② 移动端（matchMedia=true）：三个桌面专属 DOM 锚点均不渲染', async () => {
    const w = await mountRail(true)
    const hits = DESKTOP_ONLY_SELECTORS.map((s) => queryAll(s).length)
    expect(hits, '移动端三项必须各 0').toEqual([0, 0, 0])
    w.unmount()
  })

  it('③ 源码契约：派生定义是纯否定，模板区不再出现 !isMobileLayout', () => {
    const src = railSource()
    expect(src).toMatch(
      /const isDesktopDock = computed\(\(\) => !isMobileLayout\.value\)/,
    )
    const tpl = templatePart(src)
    expect(tpl, '模板区必须扫到主体，防空集假绿').toContain('agent-panel-header')
    expect(tpl, '模板区不得残留 !isMobileLayout').not.toMatch(/!isMobileLayout/)
    expect((tpl.match(/isDesktopDock/g) ?? []).length).toBeGreaterThanOrEqual(7)
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
})
