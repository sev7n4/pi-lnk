// ① 切项目必须真的换画布（2026-10-25 生产实证：回访用户点锚进入后，
//    在对话页点【历史项目】进另一个项目 ⇒ 画布仍是旧项目的内容）。
//
// 根因（两层，缺一不可）：
//   ① App.vue 的 `<RouterView>` **没有 :key** ⇒ 同路由换参（/workflow/a → /workflow/b）
//      时 Vue Router **复用组件实例** ⇒ onMounted 不再跑 ⇒ `loadSession()` 不再执行
//      ⇒ 画布停在旧项目。
//   ② 即便补了触发，CanvasPage 的 `loadSession()` 是**合并**语义
//      （`mergeCanvasNodesFromServer(nodes.value, serverNodes)`）⇒ 两个项目的节点会被并起来。
//      ⇒ 切项目必须是**全新实例**（干净 nodes ⇒ 走替换分支）。
//
// 本测试用**真实 router + 真实 App.vue** 断言「换 sessionId ⇒ 页面组件被重新创建」，
// 而不是只断言模板里有 key（静态断言挡不住"key 写错来源"这类退化）。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { h } from 'vue'
import App from '../App.vue'

const { restoreSession } = vi.hoisted(() => ({ restoreSession: vi.fn() }))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    restoreSession,
    isLoggedIn: false,
    user: null,
  }),
}))

/** 探针：每次实例创建计数，用来判定「是否重新挂载」 */
let mountCount = 0
const Probe = {
  name: 'Probe',
  setup() {
    mountCount += 1
    return () => h('div', { class: 'probe' }, `probe#${mountCount}`)
  },
}

const stubs = {
  AppHeader: true,
  LoginDialog: true,
}

describe('切项目必须换画布（①：RouterView 必须按 path 加 key）', () => {
  beforeEach(() => {
    mountCount = 0
    restoreSession.mockReset()
    setActivePinia(createPinia())
  })

  it('换 sessionId ⇒ 页面组件被重新创建（不是复用实例）', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/workflow', component: Probe },
        { path: '/workflow/:sessionId', name: 'canvas', component: Probe },
      ],
    })
    await router.push('/workflow/proj-a')
    await router.isReady()

    const wrapper = mount(App, { global: { plugins: [router], stubs } })
    await flushPromises()
    expect(mountCount, '首个项目应挂载一次').toBe(1)

    // 切到另一个项目（同路由、只换 param）
    await router.push('/workflow/proj-b')
    await flushPromises()

    expect(
      mountCount,
      '切项目必须重新创建页面组件（复用实例 ⇒ onMounted 不再跑 ⇒ 画布停在旧项目）',
    ).toBe(2)
    wrapper.unmount()
  })

  it('只改 query（focusNode 被消费）**不得**触发重挂载（否则消费循环）', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/workflow', component: Probe },
        { path: '/workflow/:sessionId', name: 'canvas', component: Probe },
      ],
    })
    await router.push('/workflow/proj-a?focusNode=n1')
    await router.isReady()

    const wrapper = mount(App, { global: { plugins: [router], stubs } })
    await flushPromises()
    expect(mountCount).toBe(1)

    // focusNode 消费后 router.replace({ query }) ⇒ 若 key 用 fullPath 就会重挂载 ⇒ 消费循环
    await router.replace({ query: {} })
    await flushPromises()

    expect(mountCount, '仅 query 变化不得重挂载（focusNode 消费会自改 query）').toBe(1)
    wrapper.unmount()
  })

  it('key 不得取自 fullPath（静态守卫：防止有人把 key 改成 fullPath）', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, '..', 'App.vue'), 'utf8')
    const tag = src.match(/<RouterView[^>]*>/)?.[0] ?? ''
    expect(tag, '必须能定位 RouterView 开标签').toContain(':key=')
    expect(tag, 'key 不得用 fullPath（focusNode 消费改 query ⇒ 重挂载 ⇒ 消费循环）').not.toContain(
      'fullPath',
    )
  })
})
