import { computed, nextTick, onScopeDispose, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { sessionsApi } from '@/services/sessions-api'
import { useProjectWorkspace } from '@/composables/useProjectWorkspace'
import { displayCanvasTitle } from '@/utils/displayCanvasTitle'

/**
 * 创作首页管理器（规格 v2 §6.2）：搜索 / 多选批删 / 重命名 / 复制 / 删除。
 * 数据面 = useProjectWorkspace（INV-10 唯一 canvasApi.list）；本组合式不持有列表状态，
 * 只持管理 UI 状态。rename/remove 直接走 useProjectWorkspace（原地更新，免重拉）。
 *
 * ⚠️ 通道边界（承 useProjectWorkspace 文件头）：removeMany/duplicate 只存在于
 *    sessions 端（canvas 侧无对应端点），故这两条管理动作直接走 sessionsApi——
 *    这不是双源回归：list 已单源化，此处只借删除/复制端点。
 */
export function useProjectManager() {
  const router = useRouter()
  const { projects, loading, list, rename, remove } = useProjectWorkspace()

  const search = ref('')
  const openMenuId = ref<string | null>(null)
  const manageMode = ref(false)
  const selectedIds = ref<string[]>([])
  /** 行内重命名（2026-11-20）：菜单只发起编辑，名称在卡片上原地改，不再弹 prompt 卡 */
  const editingId = ref<string | null>(null)
  const editingTitle = ref('')

  const filtered = computed(() => {
    const q = search.value.trim().toLowerCase()
    if (!q) return projects.value
    return projects.value.filter((p) => displayCanvasTitle(p.title).toLowerCase().includes(q))
  })

  function toggleMenu(id: string): void {
    openMenuId.value = openMenuId.value === id ? null : id
  }
  function closeMenu(): void {
    openMenuId.value = null
  }
  function toggleManage(): void {
    manageMode.value = !manageMode.value
    selectedIds.value = []
    closeMenu()
  }
  function toggleSelect(id: string): void {
    const set = new Set(selectedIds.value)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    selectedIds.value = [...set]
  }

  async function batchDelete(): Promise<void> {
    if (!selectedIds.value.length) return
    try {
      await ElMessageBox.confirm(
        `确定删除选中的 ${selectedIds.value.length} 个项目？此操作不可恢复。`,
        '批量删除',
        { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
      )
    } catch {
      return
    }
    try {
      const { data } = await sessionsApi.removeMany(selectedIds.value)
      await list()
      selectedIds.value = []
      manageMode.value = false
      ElMessage.success(`已删除 ${data.data.deleted} 个项目`)
    } catch {
      ElMessage.error('批量删除失败，请稍后重试')
    }
  }

  function startRename(p: { id: string; title: string }): void {
    closeMenu()
    editingId.value = p.id
    editingTitle.value = displayCanvasTitle(p.title)
    // 两端同一 testid：同一时刻最多一张卡处于编辑态，直接聚焦即可
    void nextTick(() => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="project-rename-input"]')
      input?.focus()
      input?.select()
    })
  }

  function cancelRename(): void {
    editingId.value = null
    editingTitle.value = ''
  }

  async function commitRename(): Promise<void> {
    const id = editingId.value
    if (!id) return // Enter 提交后 blur 再触发一次时直接退场
    const value = editingTitle.value.trim()
    editingId.value = null
    if (!value) return
    const current = projects.value.find((p) => p.id === id)
    if (current && displayCanvasTitle(current.title) === value) return
    try {
      await rename(id, value)
      ElMessage.success('已重命名')
    } catch {
      ElMessage.error('重命名失败，请稍后重试')
    }
  }

  async function duplicateProject(id: string): Promise<string | undefined> {
    closeMenu()
    try {
      const { data } = await sessionsApi.duplicate(id)
      await list()
      ElMessage.success('已复制副本')
      router.push(`/workflow/${data.data.id}`)
      return data.data.id
    } catch {
      ElMessage.error('复制失败，请稍后重试')
      return undefined
    }
  }

  async function removeProject(p: { id: string; title: string }): Promise<void> {
    closeMenu()
    try {
      await ElMessageBox.confirm(
        `确定删除「${displayCanvasTitle(p.title)}」？此操作不可恢复。`,
        '删除项目',
        { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
      )
    } catch {
      return
    }
    try {
      await remove(p.id)
      ElMessage.success('已删除')
    } catch {
      ElMessage.error('删除失败，请稍后重试')
    }
  }

  // 卡片菜单外点关闭。⚠️ 直接注册（不在 onMounted 里）：组合式可能在无组件
  // 上下文被实例化（单测），onMounted 的回调那时不会执行 ⇒ 监听凭空消失。
  // 生命周期对齐用 onScopeDispose：组件 setup 中调用 = 卸载时移除（等价原实现）。
  function onDocumentPointerDown(event: PointerEvent) {
    if (!openMenuId.value) return
    const target = event.target as HTMLElement
    if (!target.closest('.session-card-menu-anchor')) closeMenu()
  }
  document.addEventListener('pointerdown', onDocumentPointerDown)
  onScopeDispose(() => document.removeEventListener('pointerdown', onDocumentPointerDown))

  return {
    projects, loading, search, openMenuId, manageMode, selectedIds, filtered,
    toggleMenu, closeMenu, toggleManage, toggleSelect,
    batchDelete, editingId, editingTitle, startRename, cancelRename, commitRename,
    duplicateProject, removeProject,
  }
}
