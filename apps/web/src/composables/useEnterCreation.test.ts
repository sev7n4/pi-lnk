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

/**
 * v2.2（D9 修订）：点锚手势路径（`allowImplicitCreate` 非 false）无论有无项目
 * 统一落「创作首页」`/canvases`；自动分发路径（`allowImplicitCreate: false`）
 * 保持进最近项目（穿透、不创建）。本组钉这两侧落点。
 */
describe('useEnterCreation · D9 落点（v2.2）', () => {
  it('⭐ 手势（有项目）：落创作首页列表，不进具体项目（修复 bug①）', async () => {
    seedLoggedIn()
    listMock.mockResolvedValue({ data: { data: [PROJ('p-latest'), PROJ('p-old')] } })
    const { enterCreation } = useEnterCreation()
    await enterCreation()
    expect(createMock, '手势不创建').not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith('/canvases')
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('⭐ 手势（零项目）：落创作首页空态，不静默创建（D9 落地）', async () => {
    seedLoggedIn()
    listMock.mockResolvedValue({ data: { data: [] } })
    const { enterCreation } = useEnterCreation()
    await enterCreation()
    expect(createMock, '手势零项目不再自动创建').not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith('/canvases')
  })

  it('手势连点 3 次：均落 /canvases、create 0 次（INV-1 / INV-8）', async () => {
    seedLoggedIn()
    listMock.mockResolvedValue({ data: { data: [PROJ('p-latest')] } })
    const { enterCreation } = useEnterCreation()
    await enterCreation()
    await enterCreation()
    await enterCreation()
    expect(createMock).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith('/canvases')
    expect(push).toHaveBeenCalledTimes(3)
  })

  it('⭐ 自动分发（有项目）：跳最近项目（IA v4 效率优先），不经列表、不创建', async () => {
    seedLoggedIn()
    listMock.mockResolvedValue({ data: { data: [PROJ('p-latest'), PROJ('p-old')] } })
    const { enterCreation } = useEnterCreation()
    await enterCreation({ allowImplicitCreate: false, replace: true })
    expect(createMock).not.toHaveBeenCalled()
    // 自动分发走 replace（不留「返回即回品牌页」的历史）
    expect(replace).toHaveBeenCalledWith({ path: '/workflow/p-latest', query: { openAgent: '1' } })
    expect(push).not.toHaveBeenCalled()
  })

  it('自动分发（零项目）：留品牌页，不创建、不跳转', async () => {
    seedLoggedIn()
    listMock.mockResolvedValue({ data: { data: [] } })
    const { enterCreation } = useEnterCreation()
    await enterCreation({ allowImplicitCreate: false })
    expect(createMock).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })
})

describe('useEnterCreation · 手势 list 失败兜底（记忆项目，仅手势路径）', () => {
  it('手势：list 失败 + 有记忆项目 ⇒ 进记忆项目（不被错误态堵死）', async () => {
    seedLoggedIn('u1')
    // 记忆键 = lnkpi:lastProjectId:<userId>（useProjectWorkspace.storageKey）
    localStorage.setItem('lnkpi:lastProjectId:u1', 'p-remembered')
    // 连接饥饿时 list 会超时失败 ⇒ ws.error=true、projects=[]
    listMock.mockRejectedValue(new Error('timeout'))
    const { enterCreation, error } = useEnterCreation()
    await enterCreation()
    expect(push).toHaveBeenCalledWith({ path: '/workflow/p-remembered', query: { openAgent: '1' } })
    expect(error.value).toBe(null) // ⛔ 不再把用户堵在「项目加载失败」
    expect(createMock).not.toHaveBeenCalled()
  })

  it('手势：list 失败 + 无记忆 ⇒ 仍是「项目加载失败」且不跳转（INV-6 不动）', async () => {
    seedLoggedIn('u1')
    listMock.mockRejectedValue(new Error('timeout'))
    const { enterCreation, error } = useEnterCreation()
    await enterCreation()
    expect(error.value).toBe('项目加载失败')
    expect(push).not.toHaveBeenCalled()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('自动分发：list 失败 ⇒ 兜底**不生效**（不跳转），error 有文案', async () => {
    seedLoggedIn('u1')
    localStorage.setItem('lnkpi:lastProjectId:u1', 'p-remembered')
    listMock.mockRejectedValue(new Error('timeout'))
    const { enterCreation, error } = useEnterCreation()
    await enterCreation({ allowImplicitCreate: false })
    // ⛔ 自动分发路径没有用户手势 ⇒ 不得替用户决定进哪个项目（既有契约）
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(error.value).toBe('项目加载失败')
  })
})

describe('useEnterCreation · 其他既有契约（INV / D-1 等，D9 不动）', () => {
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

  it('手势 list 失败：不创建、不跳转，error 有文案（INV-6）', async () => {
    seedLoggedIn()
    listMock.mockRejectedValue(new Error('boom'))
    const { enterCreation, error } = useEnterCreation()
    await enterCreation()
    expect(createMock).not.toHaveBeenCalled() // ⛔ 不得把失败当成零项目去创建
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
    // 手势有项目 ⇒ 落创作首页；error 在每次进入开头清空
    expect(error.value).toBeNull()
    expect(push).toHaveBeenCalledWith('/canvases')
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
