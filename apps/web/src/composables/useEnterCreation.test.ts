import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

/**
 * ⚠️ mock 句柄走 `vi.hoisted`：`vi.mock` 工厂会被提升到 import 之前，
 * 工厂里直接引用顶层 const 会撞 TDZ（Task 1 踩过，报 "error when mocking a module"）。
 */
const { push, replace, listMock, createMock, removeMock } = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  listMock: vi.fn(),
  createMock: vi.fn(),
  removeMock: vi.fn(),
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ push, replace }) }))
vi.mock('@/services/canvas-api', () => ({
  canvasApi: { list: () => listMock(), create: () => createMock(), update: vi.fn() },
}))
vi.mock('@/services/sessions-api', () => ({ sessionsApi: { remove: removeMock } }))
vi.mock('@/services/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }))

import { useEnterCreation } from './useEnterCreation'
import { useAuthStore } from '@/stores/auth'

const PROJ = (id: string) => ({ id, title: 't', updatedAt: '', coverUrl: null, coverNodeId: null })

/**
 * ⚠️ 必须**同时**设 token 与 user：`isLoggedIn` 是 computed
 * （`!!token && !!user`），直接 `auth.isLoggedIn = true` 对 computed 赋值不生效
 * （brief 初版那么写 ⇒ 所有"已登录"用例会静默走进未登录分支）。
 */
function seedLoggedIn(id = 'u1') {
  const auth = useAuthStore()
  auth.token = 'test-token'
  auth.user = { id } as never
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  push.mockReset()
  replace.mockReset()
  listMock.mockReset()
  createMock.mockReset()
})

describe('useEnterCreation', () => {
  it('回访用户连点 3 次：create 0 次，落在最近项目（INV-1 / Review Focus #1）', async () => {
    seedLoggedIn()
    listMock.mockResolvedValue({ data: { data: [PROJ('p-latest'), PROJ('p-old')] } })
    createMock.mockResolvedValue({ data: { data: PROJ('p-new') } })
    const { enterCreation } = useEnterCreation()
    await enterCreation()
    await enterCreation()
    await enterCreation()
    expect(createMock).not.toHaveBeenCalled()
    // ⚠️ 对象形式（带 openAgent）—— 这条断言在 brief 初版里是字符串形式，
    //    与其余用例矛盾；实现统一为对象，故此处同步。
    expect(push).toHaveBeenCalledWith({ path: '/workflow/p-latest', query: { openAgent: '1' } })
    expect(push).toHaveBeenCalledTimes(3)
  })

  it('零项目：首次建 1 个，第二次复用（例外条款 / Review Focus #3）', async () => {
    seedLoggedIn()
    listMock.mockResolvedValue({ data: { data: [] } })
    createMock.mockResolvedValue({ data: { data: PROJ('p-new') } })
    const { enterCreation } = useEnterCreation()
    await enterCreation()
    expect(createMock).toHaveBeenCalledTimes(1)
    // 第二次：list 已能返回刚建的项目 ⇒ 不再创建
    listMock.mockResolvedValue({ data: { data: [PROJ('p-new')] } })
    await enterCreation()
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('未登录：弹登录，不创建、不自动进项目（D-1）', async () => {
    const auth = useAuthStore()
    auth.isLoggedIn // computed：只读，确认可访问
    expect(auth.isLoggedIn).toBe(false)
    const openLogin = vi.spyOn(auth, 'openLogin')
    const { enterCreation } = useEnterCreation()
    await enterCreation()
    expect(openLogin).toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled() // ⛔ 不自动进项目（与 pendingIntent 形态的差别）
    expect(createMock).not.toHaveBeenCalled()
  })

  it('穿透路径零项目：不创建、不跳转（allowImplicitCreate:false / INV-7c）', async () => {
    seedLoggedIn()
    listMock.mockResolvedValue({ data: { data: [] } })
    const { enterCreation } = useEnterCreation()
    await enterCreation({ allowImplicitCreate: false })
    expect(createMock).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it('点锚路径零项目：创建 1 个并带 openAgent=1（D-3 / INV-9）', async () => {
    seedLoggedIn()
    listMock.mockResolvedValue({ data: { data: [] } })
    createMock.mockResolvedValue({ data: { data: PROJ('p-new') } })
    const { enterCreation } = useEnterCreation()
    await enterCreation({ allowImplicitCreate: true })
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith({
      path: '/workflow/p-new',
      query: { openAgent: '1' },
    })
  })

  it('进入既有项目也带 openAgent=1（INV-9：与新建路径对话态一致）', async () => {
    seedLoggedIn()
    listMock.mockResolvedValue({ data: { data: [PROJ('p-latest')] } })
    const { enterCreation } = useEnterCreation()
    await enterCreation()
    expect(createMock).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith({
      path: '/workflow/p-latest',
      query: { openAgent: '1' },
    })
  })

  it('entering 期间再次调用直接 return（INV-8 防连点）', async () => {
    seedLoggedIn()
    let resolveList: (v: unknown) => void = () => {}
    listMock.mockReturnValue(new Promise((r) => { resolveList = r }))
    const { enterCreation, entering } = useEnterCreation()
    const first = enterCreation()
    expect(entering.value).toBe(true)
    await enterCreation() // 第二次：应直接 return
    expect(listMock).toHaveBeenCalledTimes(1) // 没有第二次 list
    resolveList({ data: { data: [PROJ('p-latest')] } })
    await first
    expect(entering.value).toBe(false)
  })

  it('list 失败：不创建、不跳转，error 有文案（INV-6）', async () => {
    seedLoggedIn()
    listMock.mockRejectedValue(new Error('boom'))
    const { enterCreation, error } = useEnterCreation()
    await enterCreation()
    expect(createMock).not.toHaveBeenCalled() // ⛔ 不得把失败当成零项目去创建
    expect(push).not.toHaveBeenCalled()
    expect(error.value).toBeTruthy()
  })

  it('create 失败：不跳转、不进 demo-，error 有文案（spec §3.6）', async () => {
    seedLoggedIn()
    listMock.mockResolvedValue({ data: { data: [] } })
    createMock.mockRejectedValue(new Error('boom'))
    const { enterCreation, error } = useEnterCreation()
    await enterCreation()
    expect(push).not.toHaveBeenCalled()
    expect(error.value).toBeTruthy()
  })

  it('第二次进入时 error 被清空（失败不是粘滞状态）', async () => {
    seedLoggedIn()
    listMock.mockRejectedValueOnce(new Error('boom'))
    const { enterCreation, error } = useEnterCreation()
    await enterCreation()
    expect(error.value).toBeTruthy()
    listMock.mockResolvedValue({ data: { data: [PROJ('p-latest')] } })
    await enterCreation()
    expect(error.value).toBeNull()
  })

  it('replace:true 走 router.replace，且不碰 push（自动分发不留历史，INV-7b 配套）', async () => {
    seedLoggedIn()
    listMock.mockResolvedValue({ data: { data: [PROJ('p-latest')] } })
    const { enterCreation } = useEnterCreation()
    await enterCreation({ allowImplicitCreate: false, replace: true })
    expect(replace).toHaveBeenCalledWith({
      path: '/workflow/p-latest',
      query: { openAgent: '1' },
    })
    // ⛔ 2026-10-24 性能修复的结论：push 会让用户按返回键又弹回品牌页
    expect(push).not.toHaveBeenCalled()
  })

  it('默认走 router.push（用户手势理应能返回）', async () => {
    seedLoggedIn()
    listMock.mockResolvedValue({ data: { data: [PROJ('p-latest')] } })
    const { enterCreation } = useEnterCreation()
    await enterCreation()
    expect(push).toHaveBeenCalledTimes(1)
    expect(replace).not.toHaveBeenCalled()
  })
})
