// 「槽位排满时点按钮不得中止正在跑的那一轮 turn」（2026-10-21 hotfix 回归锁）。
//
// 缺陷（生产已上线）：`send()` 写的是
//   if (await queueDraftAsPending()) return
//   await cancelActiveStream()
// 而 `queueDraftAsPending()` 的 boolean 返回有**两个** false 出口：
//   ① 无草稿        → 中止 turn 是**正确**语义（底部按钮此时就是「停止」态）
//   ② 槽位已满      → 中止 turn 是**缺陷**（草稿已保留并如实告知，不该动用户那一轮）
// 二者混成同一个 false ⇒ 排满 5 条后再点发送，会把用户正在跑的那一轮 turn 停掉 ——
// 恰好是「流式中可插话」这条链路最初要根治的行为。
//
// ⭐ 断言粒度落在**可观测出口**（出网 body + 组件状态），不是源码字符串：
//   既有守卫 `AgentSideRail.composerSteerButton.test.ts` 只在**函数体内**做静态断言，
//   缺陷在**调用点** ⇒ 那种断言天然照不到这里（见 AGENTS.md 沙箱假阴性纪律）。
//
// 为什么要挂载组件跑：调用点的行为无法从函数体文本推出。挂载后直接驱动
// `send()`，观测「有没有向 /api/agent/runs/cancel 出网」。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { useAgentStore } from '@/stores/agent'
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

// mermaid 是侧栏里的动态 import，jsdom 下不需要真包。
vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '' }) },
}))

/** 指向「中止当前 run」的出网请求 —— 本用例的核心观测点。 */
const cancelRequests: string[] = []

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      const u = String(url)
      if (u.includes('/api/agent/runs/cancel')) {
        cancelRequests.push(String(init?.body ?? ''))
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { ok: true, completedTasks: 0, totalTasks: 0 } }),
        }
      }
      // 其余请求一律回**数组**：bootstrapThread → resolveBootstrapThreadId 要的是可迭代数组，
      // 回对象会在 onMounted 里抛 unhandled rejection（即使用例 passed，vitest 仍非零退出）。
      return { ok: true, status: 200, json: async () => ({ data: [] }) }
    }),
  )
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
  await flushPromises()
  return w
}

/**
 * 取组件内部绑定。
 *
 * ⚠️ `<script setup>` 的顶层绑定在运行时都在 `instance.setupState` 里，但**类型上**
 * 只有 `defineExpose` 暴露出来的成员才出现在 `wrapper.vm` 的类型里 ——
 * `send` / `queuedSlots` / `input` 都没 expose，直接写 `w.vm.send` 会被
 * `vue-tsc` 判为「属性不存在」（本仓 web 的 tsconfig 覆盖 src 下的全部 .ts
 * ⇒ 测试文件会被类型检查，vitest 本身不检查 ⇒ 本地跑绿不代表 TS 过）。
 *
 * 故显式声明形状 + 运行时取不到就抛：**绝不静默通过**（见 AGENTS.md 沙箱假阴性纪律）。
 */
interface RailInternals {
  send: () => Promise<void>
  queuedSlots: Array<{ id: string; text: string }>
  input: string
  setComposerInput: (text: string) => void
}

function railInternals(w: { vm: object }): RailInternals {
  // ⛔ 经 `unknown` 中转：目标形状与组件公共实例类型不重叠，直接 as 会被 vue-tsc 判为
  // 「转换可能出错」。web 的 tsconfig 覆盖 src 下全部 .ts ⇒ 测试文件会被类型检查。
  const vm = w.vm as unknown as { $?: { setupState?: RailInternals } }
  const st = vm.$?.setupState
  if (!st) throw new Error('取不到组件内部 setupState（script setup 绑定未暴露）')
  return st
}

describe('插话槽位排满时不得中止 turn（2026-10-21 hotfix）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    cancelRequests.length = 0
    stubFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('排满 5 条后再点发送：不发中止请求、草稿仍在、槽位数不变', async () => {
    const w = await mountRail()
    const rail = railInternals(w)
    const agent = useAgentStore()
    // turn 进行中（底部按钮此时是「发送插话」态，不是「停止」态）
    agent.isStreaming = true
    await flushPromises()

    // 先把 5 个槽位排满
    for (let i = 1; i <= 5; i++) {
      rail.setComposerInput(`第 ${i} 条补充`)
      await rail.send()
    }
    await flushPromises()

    // ⭐ 有效性配对（防空集假绿）：槽位确实排满了，且排槽位过程没有中止过 turn
    expect(rail.queuedSlots.length, '槽位未排满 ⇒ 本用例的前提不成立，断言无意义').toBe(5)
    expect(cancelRequests.length, '排槽位阶段就发出了中止请求 ⇒ 挂起链路本身有问题').toBe(0)

    // 第 6 条：槽位已满
    rail.setComposerInput('第 6 条补充')
    await rail.send()
    await flushPromises()

    // ⭐ 核心契约：不得中止用户正在跑的那一轮 turn
    expect(
      cancelRequests.length,
      '槽位已满时点按钮把用户正在跑的那一轮 turn 停掉了 —— ' +
        '「full」必须与「empty」分流，只有无草稿才允许中止',
    ).toBe(0)

    // 草稿必须还在（排满只该如实告知，不该吞掉文字）
    expect(rail.input, '排满时草稿被吞了 ⇒ 又一次「消息凭空消失」').toBe('第 6 条补充')

    // 槽位数不变（没有挂上第 6 条）
    expect(rail.queuedSlots.length).toBe(5)
  })

  it('流式中**无草稿**时点按钮仍然中止 turn（不许把「停止」语义一起改掉）', async () => {
    const w = await mountRail()
    const rail = railInternals(w)
    const agent = useAgentStore()
    agent.isStreaming = true
    await flushPromises()

    // 无草稿 ⇒ 按钮是「停止」态 ⇒ 点它必须真的中止
    rail.setComposerInput('')
    await rail.send()
    await flushPromises()

    expect(
      cancelRequests.length,
      '无草稿时点按钮没有中止 turn ⇒ 「停止」按钮失效了（本次修复不得误伤）',
    ).toBe(1)
  })
})
