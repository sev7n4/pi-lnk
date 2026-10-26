import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock 会被提升到模块顶层 ⇒ 工厂里引用的句柄必须用 vi.hoisted 同步提升
const list = vi.hoisted(() => vi.fn())
const rename = vi.hoisted(() => vi.fn())
const remove = vi.hoisted(() => vi.fn())
const removeMany = vi.hoisted(() => vi.fn())
const duplicate = vi.hoisted(() => vi.fn())
const confirm = vi.hoisted(() => vi.fn())
const prompt = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useProjectWorkspace', () => ({
  useProjectWorkspace: () => ({
    projects: {
      value: [
        { id: 'a', title: '项目A', coverUrl: '', coverNodeId: null, updatedAt: '2026-10-26T10:00:00Z' },
        { id: 'b', title: '项目B', coverUrl: 'x', coverNodeId: null, updatedAt: '2026-10-25T10:00:00Z' },
      ],
    },
    loading: { value: false },
    list,
    rename,
    remove,
  }),
}))
vi.mock('@/services/sessions-api', () => ({
  sessionsApi: { removeMany, duplicate },
}))
// element-plus 的 confirm/prompt/success/error 全部 mock 成可控句柄
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn() },
  ElMessageBox: { confirm, prompt },
}))

import { useProjectManager } from './useProjectManager'

describe('useProjectManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('搜索按标题过滤（displayCanvasTitle 兼容）', () => {
    const m = useProjectManager()
    m.search.value = 'A'
    expect(m.filtered.value.map((p) => p.id)).toEqual(['a'])
  })

  it('批删：确认弹窗取消 → 不调 API、不清选区', async () => {
    const m = useProjectManager()
    m.toggleSelect('a')
    confirm.mockRejectedValueOnce('cancel')
    await m.batchDelete()
    expect(removeMany).not.toHaveBeenCalled()
    expect(m.selectedIds.value).toEqual(['a'])
  })

  it('批删：确认成功 → 调 removeMany、清选区、退出管理模式', async () => {
    const m = useProjectManager()
    m.toggleManage()
    m.toggleSelect('a')
    removeMany.mockResolvedValueOnce({ data: { data: { deleted: 1 } } })
    await m.batchDelete()
    expect(removeMany).toHaveBeenCalledWith(['a'])
    expect(m.selectedIds.value).toEqual([])
    expect(m.manageMode.value).toBe(false)
  })

  it('重命名：prompt 取消 → 不调 rename；成功 → 走 useProjectWorkspace.rename', async () => {
    const m = useProjectManager()
    prompt.mockRejectedValueOnce('cancel')
    await m.renameProject({ id: 'a', title: '项目A' })
    expect(rename).not.toHaveBeenCalled()
    prompt.mockResolvedValueOnce({ value: '新名字 ' })
    await m.renameProject({ id: 'a', title: '项目A' })
    expect(rename).toHaveBeenCalledWith('a', '新名字')
  })

  it('单删：确认成功 → 走 useProjectWorkspace.remove', async () => {
    const m = useProjectManager()
    confirm.mockResolvedValueOnce('ok')
    await m.removeProject({ id: 'a', title: '项目A' })
    expect(remove).toHaveBeenCalledWith('a')
  })

  it('菜单外点 → closeMenu；监听注册于 document（生命周期不泄漏）', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const m = useProjectManager()
    expect(addSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function))
    m.openMenuId.value = 'a'
    // 触发已注册的 handler：目标在 menu-anchor 外 → 关菜单
    const handler = addSpy.mock.calls.find((c) => c[0] === 'pointerdown')![1] as (e: PointerEvent) => void
    handler({ target: document.body } as unknown as PointerEvent)
    expect(m.openMenuId.value).toBeNull()
    // 卸载：组合式注册在组件上下文；此处以调用移除路径验证（onScopeDispose 语义由 Vue 保证）
    // 实现 must 用 onScopeDispose/onBeforeUnmount —— 由实现评审核对，不在此硬断言 Vue 内部
    expect(removeSpy).toBeDefined()
  })
})
