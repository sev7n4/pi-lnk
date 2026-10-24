import { ref } from 'vue'
import {
  useSidebarAttachments,
  type CanvasRefAddResult,
  type FocusNodeLike,
} from './useSidebarAttachments'

/**
 * 画布「引用拾取 / 加入对话」写入与反馈的单一真源。
 *
 * 历史坑（2026-10-23 取证）：引用写入此前只走 `agentRailRef.value?.addFromCanvasNodes`，
 * 移动端 AgentSideRail 为 null ⇒ 整条静默——引用既没写入、也没有任何提示。
 * 这里改为直接写 `useSidebarAttachments` 模块级单例（与 AgentSideRail 共享同一份
 * pendingAttachments），不再依赖侧栏实例；拾取结束的反馈走画布窗态专属 toast，
 * 与 ElMessage 隔离，移动端不会被 veiled 态裁掉。
 */
export function useCanvasRefPickAdd() {
  const sidebar = useSidebarAttachments()

  // 一次拾取会话内成功加入的引用数（完成态 toast 用）
  const sessionAdded = ref(0)
  // 画布窗态 toast：只承载「已引用 N 个节点」，移动端贴底容器/veiled 态下仍可见
  const refPickToast = ref<{ count: number; token: number } | null>(null)
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  let toastToken = 0

  function addNodesToRefs(nodes: FocusNodeLike[]): CanvasRefAddResult {
    return sidebar.addFromCanvasNodesDetailed(nodes)
  }

  function bumpSessionAdded(n: number) {
    if (n > 0) sessionAdded.value += n
  }

  function resetSessionAdded() {
    sessionAdded.value = 0
  }

  function showRefPickToast(count: number) {
    if (count <= 0) return
    toastToken += 1
    const token = toastToken
    refPickToast.value = { count, token }
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      if (refPickToast.value?.token === token) refPickToast.value = null
    }, 2200)
  }

  return {
    addNodesToRefs,
    bumpSessionAdded,
    resetSessionAdded,
    showRefPickToast,
    sessionAdded,
    refPickToast,
  }
}
