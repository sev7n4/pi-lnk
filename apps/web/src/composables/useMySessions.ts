import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { sessionsApi } from '@/services/sessions-api'
import { useAuthStore } from '@/stores/auth'
import { displayCanvasTitle } from '@/utils/displayCanvasTitle'
import type { Session } from '@lnkpi/shared'

/**
 * 「我的项目」会话管理器（2026-10-21 P1 从 WorkflowPage 整体迁出；
 * 2026-10-23 IA v4 收口「项目」语义）。
 *
 * 主页只留compact 区（5 个 + 「查看全部」），完整管理器能力（搜索/多选/批删/
 * 重命名/复制/删除）落在 /canvases。两页共用本组合式，逻辑单点维护。
 *
 * 返回面形态（钉死，消费方勿改）：
 * - 状态是 `Ref`，消费方写 `.value`；
 * - `visibleSessions(limit)` / `hasMoreSessions(limit)` 返回**普通值**
 *   （`Session[]` / `boolean`），调用处**不写 `.value`**。若在函数里包
 *   `computed()` 再返回，模板每次渲染都会新建 computed 实例（churn + 语义误导）。
 */
export function useMySessions() {
  const router = useRouter()
  const auth = useAuthStore()

  const mySessions = ref<Session[]>([])
  const loading = ref(false)
  const sessionSearch = ref('')
  const openMenuId = ref<string | null>(null)
  const manageSessions = ref(false)
  const selectedSessionIds = ref<string[]>([])

  const filteredSessions = computed(() => {
    const q = sessionSearch.value.trim().toLowerCase()
    if (!q) return mySessions.value
    return mySessions.value.filter((s) => displayCanvasTitle(s.title).toLowerCase().includes(q))
  })

  /** 搜索态不做截断（用户主动筛选，要看全结果）；非搜索态按 limit 截断。 */
  function visibleSessions(limit: number): Session[] {
    if (sessionSearch.value.trim()) return filteredSessions.value
    return filteredSessions.value.slice(0, limit)
  }

  /** 搜索态恒false —— 搜索结果已全部展示，不存在「还有更多」。 */
  function hasMoreSessions(limit: number): boolean {
    if (sessionSearch.value.trim()) return false
    return filteredSessions.value.length > limit
  }

  async function fetch(): Promise<void> {
    if (!auth.isLoggedIn) {
      mySessions.value = []
      return
    }
    loading.value = true
    try {
      const { data } = await sessionsApi.list()
      mySessions.value = data.data
    } catch {
      mySessions.value = []
    } finally {
      loading.value = false
    }
  }

  function toggleMenu(sessionId: string): void {
    openMenuId.value = openMenuId.value === sessionId ? null : sessionId
  }

  function closeMenu(): void {
    openMenuId.value = null
  }

  function toggleManage(): void {
    manageSessions.value = !manageSessions.value
    selectedSessionIds.value = []
    closeMenu()
  }

  function toggleSelect(sessionId: string): void {
    const set = new Set(selectedSessionIds.value)
    if (set.has(sessionId)) set.delete(sessionId)
    else set.add(sessionId)
    selectedSessionIds.value = [...set]
  }

  async function batchDelete(): Promise<void> {
    if (!selectedSessionIds.value.length) return
    try {
      await ElMessageBox.confirm(
        `确定删除选中的 ${selectedSessionIds.value.length} 个项目？此操作不可恢复。`,
        '批量删除',
        { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
      )
    } catch {
      return
    }
    try {
      const { data } = await sessionsApi.removeMany(selectedSessionIds.value)
      await fetch()
      selectedSessionIds.value = []
      manageSessions.value = false
      ElMessage.success(`已删除 ${data.data.deleted} 个项目`)
    } catch {
      ElMessage.error('批量删除失败，请稍后重试')
    }
  }

  async function rename(session: Session): Promise<void> {
    closeMenu()
    let value: string
    try {
      const result = await ElMessageBox.prompt('输入新的项目名称', '重命名', {
        inputValue: displayCanvasTitle(session.title),
        inputPattern: /\S/,
        inputErrorMessage: '名称不能为空',
        confirmButtonText: '保存',
        cancelButtonText: '取消',
      })
      value = result.value.trim()
    } catch {
      return
    }
    if (!value || value === session.title) return
    try {
      await sessionsApi.update(session.id, { title: value })
      await fetch()
      ElMessage.success('已重命名')
    } catch {
      ElMessage.error('重命名失败，请稍后重试')
    }
  }

  async function duplicate(session: Session): Promise<void> {
    closeMenu()
    try {
      const { data } = await sessionsApi.duplicate(session.id)
      await fetch()
      ElMessage.success('已复制副本')
      router.push(`/workflow/${data.data.id}`)
    } catch {
      ElMessage.error('复制失败，请稍后重试')
    }
  }

  async function remove(session: Session): Promise<void> {
    closeMenu()
    try {
      await ElMessageBox.confirm(
        `确定删除「${displayCanvasTitle(session.title)}」？此操作不可恢复。`,
        '删除项目',
        { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
      )
    } catch {
      return
    }
    try {
      await sessionsApi.remove(session.id)
      await fetch()
      ElMessage.success('已删除')
    } catch {
      ElMessage.error('删除失败，请稍后重试')
    }
  }

  function onDocumentPointerDown(event: PointerEvent) {
    if (!openMenuId.value) return
    const target = event.target as HTMLElement
    if (!target.closest('.session-card-menu-anchor')) closeMenu()
  }

  onMounted(() => {
    document.addEventListener('pointerdown', onDocumentPointerDown)
  })

  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onDocumentPointerDown)
  })

  return {
    // 状态
    mySessions,
    filteredSessions,
    loading,
    sessionSearch,
    openMenuId,
    manageSessions,
    selectedSessionIds,
    // 派生（普通值，非 Ref）
    visibleSessions,
    hasMoreSessions,
    // 动作
    fetch,
    toggleMenu,
    closeMenu,
    toggleManage,
    toggleSelect,
    batchDelete,
    rename,
    duplicate,
    remove,
  }
}
