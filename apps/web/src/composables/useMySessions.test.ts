import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Session } from '@lnkpi/shared'
import { useMySessions } from './useMySessions'

const { sessionsList, sessionsCreate, sessionsUpdate, sessionsDuplicate, sessionsRemove, sessionsRemoveMany, confirmImpl, promptImpl, pushMock, authState } =
  vi.hoisted(() => ({
    sessionsList: vi.fn(),
    sessionsCreate: vi.fn(),
    sessionsUpdate: vi.fn(),
    sessionsDuplicate: vi.fn(),
    sessionsRemove: vi.fn(),
    sessionsRemoveMany: vi.fn(),
    confirmImpl: vi.fn(),
    promptImpl: vi.fn(),
    pushMock: vi.fn(),
    // 注意：vi.hoisted 回调在 import 之前执行，此处不能用 ref（未初始化）。
    // 用普通对象承载可变状态，mock 里用 getter 读。
    authState: { isLoggedIn: true },
  }))

vi.mock('@/services/sessions-api', () => ({
  sessionsApi: {
    list: sessionsList,
    create: sessionsCreate,
    update: sessionsUpdate,
    duplicate: sessionsDuplicate,
    remove: sessionsRemove,
    removeMany: sessionsRemoveMany,
  },
}))

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn() },
  ElMessageBox: {
    confirm: (...args: unknown[]) => confirmImpl(...args),
    prompt: (...args: unknown[]) => promptImpl(...args),
  },
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushMock }) }))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ get isLoggedIn() { return authState.isLoggedIn }, openLogin: vi.fn() }),
}))

// 注意：必须返回完整 Session —— vue-tsc -b 会检查夹具是否满足 Session 类型
function makeSessions(n: number): Session[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    title: `画布${i}`,
    userId: 'u_1',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }))
}

function makeSession(id: string, title: string): Session {
  return {
    id,
    title,
    userId: 'u_1',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }
}

describe('useMySessions', () => {
  beforeEach(() => {
    sessionsList.mockReset()
    sessionsCreate.mockReset()
    sessionsUpdate.mockReset()
    sessionsDuplicate.mockReset()
    sessionsRemove.mockReset()
    sessionsRemoveMany.mockReset()
    confirmImpl.mockReset()
    promptImpl.mockReset()
    pushMock.mockReset()
    authState.isLoggedIn = true
  })

  it('未登录时 fetch 得到空列表且不发请求', async () => {
    authState.isLoggedIn = false
    const s = useMySessions()
    await s.fetch()
    expect(sessionsList).not.toHaveBeenCalled()
    expect(s.mySessions.value).toEqual([])
  })

  it('登录态 fetch 拉取列表', async () => {
    sessionsList.mockResolvedValue({ data: { data: makeSessions(3) } })
    const s = useMySessions()
    await s.fetch()
    expect(sessionsList).toHaveBeenCalled()
    expect(s.mySessions.value).toHaveLength(3)
    expect(s.loading.value).toBe(false)
  })

  it('visibleSessions 按 limit 截断；hasMoreSessions 相应为 true（返回普通值，不写 .value）', async () => {
    sessionsList.mockResolvedValue({ data: { data: makeSessions(8) } })
    const s = useMySessions()
    await s.fetch()
    expect(s.visibleSessions(5)).toHaveLength(5)
    expect(s.hasMoreSessions(5)).toBe(true)
    expect(s.visibleSessions(100)).toHaveLength(8)
    expect(s.hasMoreSessions(100)).toBe(false)
  })

  it('搜索时按标题过滤，且搜索态下 hasMoreSessions 为 false（结果已全部展示）', async () => {
    sessionsList.mockResolvedValue({ data: { data: makeSessions(8) } })
    const s = useMySessions()
    await s.fetch()
    s.sessionSearch.value = '画布1'
    expect(s.filteredSessions.value.map((x) => x.id)).toEqual(['s1'])
    // 搜索态不限流：visibleSessions 直接给全部过滤结果
    expect(s.visibleSessions(5).map((x) => x.id)).toEqual(['s1'])
    expect(s.hasMoreSessions(5)).toBe(false)
  })

  it('visibleSessions 连续两次调用返回等值但不同引用（纯函数语义，不新建 computed）', async () => {
    sessionsList.mockResolvedValue({ data: { data: makeSessions(3) } })
    const s = useMySessions()
    await s.fetch()
    const a = s.visibleSessions(5)
    const b = s.visibleSessions(5)
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })

  it('batchDelete 成功后清空选择、退出管理模式并重新 fetch', async () => {
    sessionsList.mockResolvedValue({ data: { data: makeSessions(3) } })
    const s = useMySessions()
    await s.fetch()
    // 顺序要紧：toggleManage 本身会清空选择（进管理模式即重置），
    // 所以必须先 enter 管理模式、再选。
    s.toggleManage()
    s.toggleSelect('s0')
    s.toggleSelect('s1')
    expect(s.selectedSessionIds.value).toEqual(['s0', 's1'])
    confirmImpl.mockResolvedValue(true)
    sessionsRemoveMany.mockResolvedValue({ data: { data: { deleted: 2 } } })
    await s.batchDelete()
    expect(sessionsRemoveMany).toHaveBeenCalledWith(['s0', 's1'])
    expect(s.selectedSessionIds.value).toEqual([])
    expect(s.manageSessions.value).toBe(false)
    expect(sessionsList).toHaveBeenCalledTimes(2)
  })

  it('batchDelete 被取消时不调用 removeMany', async () => {
    sessionsList.mockResolvedValue({ data: { data: makeSessions(3) } })
    const s = useMySessions()
    await s.fetch()
    s.toggleManage()
    s.toggleSelect('s0')
    confirmImpl.mockRejectedValue(new Error('cancel'))
    await s.batchDelete()
    expect(sessionsRemoveMany).not.toHaveBeenCalled()
    expect(s.selectedSessionIds.value).toEqual(['s0'])
  })

  it('batchDelete 无选中时直接返回（不发请求也不弹确认）', async () => {
    const s = useMySessions()
    await s.fetch()
    await s.batchDelete()
    expect(confirmImpl).not.toHaveBeenCalled()
    expect(sessionsRemoveMany).not.toHaveBeenCalled()
  })

  it('remove 被用户取消时不调用 sessionsApi.remove', async () => {
    sessionsList.mockResolvedValue({ data: { data: makeSessions(2) } })
    const s = useMySessions()
    await s.fetch()
    confirmImpl.mockRejectedValue(new Error('cancel'))
    await s.remove(makeSession('s0', '画布0'))
    expect(sessionsRemove).not.toHaveBeenCalled()
  })

  it('remove 成功后重新 fetch', async () => {
    sessionsList.mockResolvedValue({ data: { data: makeSessions(2) } })
    const s = useMySessions()
    await s.fetch()
    confirmImpl.mockResolvedValue(true)
    sessionsRemove.mockResolvedValue({ data: { data: {} } })
    await s.remove(makeSession('s0', '画布0'))
    expect(sessionsRemove).toHaveBeenCalledWith('s0')
    expect(sessionsList).toHaveBeenCalledTimes(2)
  })

  it('rename 提交新标题；名称未变时不发请求', async () => {
    sessionsList.mockResolvedValue({ data: { data: makeSessions(2) } })
    const s = useMySessions()
    await s.fetch()
    promptImpl.mockResolvedValue({ value: '新名字' })
    sessionsUpdate.mockResolvedValue({ data: { data: {} } })
    await s.rename(makeSession('s0', '画布0'))
    expect(sessionsUpdate).toHaveBeenCalledWith('s0', { title: '新名字' })

    promptImpl.mockResolvedValue({ value: '画布0' })
    await s.rename(makeSession('s0', '画布0'))
    expect(sessionsUpdate).toHaveBeenCalledTimes(1)
  })

  it('rename 被取消时不发请求', async () => {
    sessionsList.mockResolvedValue({ data: { data: makeSessions(2) } })
    const s = useMySessions()
    await s.fetch()
    promptImpl.mockRejectedValue(new Error('cancel'))
    await s.rename(makeSession('s0', '画布0'))
    expect(sessionsUpdate).not.toHaveBeenCalled()
  })

  it('duplicate 成功后跳转到副本画布', async () => {
    sessionsList.mockResolvedValue({ data: { data: makeSessions(2) } })
    const s = useMySessions()
    await s.fetch()
    sessionsDuplicate.mockResolvedValue({ data: { data: { id: 's_new' } } })
    await s.duplicate(makeSession('s0', '画布0'))
    expect(sessionsDuplicate).toHaveBeenCalledWith('s0')
    expect(pushMock).toHaveBeenCalledWith('/workflow/s_new')
  })

  it('toggleMenu 幂等切换、closeMenu 复位', async () => {
    const s = useMySessions()
    s.toggleMenu('s0')
    expect(s.openMenuId.value).toBe('s0')
    s.toggleMenu('s0')
    expect(s.openMenuId.value).toBe(null)
    s.toggleMenu('s1')
    s.closeMenu()
    expect(s.openMenuId.value).toBe(null)
  })

  it('toggleManage 进出管理模式并清空选择', () => {
    const s = useMySessions()
    s.toggleSelect('s0')
    s.toggleManage()
    expect(s.manageSessions.value).toBe(true)
    expect(s.selectedSessionIds.value).toEqual([])
  })

  it('toggleSelect 可反选', () => {
    const s = useMySessions()
    s.toggleSelect('s0')
    s.toggleSelect('s1')
    expect(s.selectedSessionIds.value).toEqual(['s0', 's1'])
    s.toggleSelect('s0')
    expect(s.selectedSessionIds.value).toEqual(['s1'])
  })

  it('fetch 失败时列表置空而非抛错', async () => {
    sessionsList.mockRejectedValue(new Error('network'))
    const s = useMySessions()
    await s.fetch()
    expect(s.mySessions.value).toEqual([])
    expect(s.loading.value).toBe(false)
  })
})
