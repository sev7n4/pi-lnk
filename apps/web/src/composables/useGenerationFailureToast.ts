import { ElMessage } from 'element-plus'
import { h, onScopeDispose } from 'vue'

interface NodeErrorLike {
  status?: unknown
  errorMessage?: unknown
}

/** 取消是用户动作不是故障：errorMessage 以「已取消」开头的不 toast。 */
function isCancellation(node: NodeErrorLike): boolean {
  const msg = typeof node.errorMessage === 'string' ? node.errorMessage : ''
  return msg.startsWith('已取消')
}

/**
 * 失败 toast 的转移判据（spec §4.1，PR1 Task1 纯函数）。
 *
 * 只对「本次转移到 error」的边为真，快照相等/重复轮询/终态改挂均不为真：
 * - 轮询会把同一 error 态反复推进来，见边就 toast 会刷屏；
 * - completed → error 是节点被改挂，不是这次生成失败。
 */
export function shouldToastForFailure(
  prev: NodeErrorLike | null | undefined,
  next: NodeErrorLike | null | undefined,
): boolean {
  if (!next || next.status !== 'error') return false
  if (isCancellation(next)) return false
  if (prev?.status === 'error') return false
  if (prev?.status === 'completed') return false
  return true
}

export interface FailureToastNode {
  id: string
  title?: string
  status?: unknown
  errorMessage?: unknown
}

export interface FailureToastOptions {
  /** 点击 toast 打开该节点诊断抽屉（CanvasPage 提供）。 */
  onOpenDetail: (nodeId: string) => void
}

/**
 * 节点失败 toast：同一 nodeId 只 toast 一次，直到该节点重新开始生成
 * （调用方在 → generating 边上调 clearNodeDedupe）。「失败→重试→再失败」
 * 必须第二次也 toast，所以去重键不是永久的。
 */
export function useGenerationFailureToast(opts: FailureToastOptions) {
  const toasted = new Set<string>()

  function onNodeError(node: FailureToastNode): void {
    if (toasted.has(node.id)) return
    toasted.add(node.id)
    const title = node.title?.trim() || '节点'
    const msg =
      typeof node.errorMessage === 'string' && node.errorMessage ? node.errorMessage : '生成失败'
    // ElMessage 选项类型没有顶层 onClick：可点击消息用 message VNode 承载点击
    ElMessage({
      type: 'warning',
      duration: 8000,
      message: h(
        'span',
        {
          class: 'gen-failure-toast-link',
          style: 'cursor:pointer',
          onClick: () => opts.onOpenDetail(node.id),
        },
        `${title} 生成失败：${msg}`,
      ),
    })
  }

  /** 重试开始（节点 → generating）时调用：解除该节点去重。 */
  function clearNodeDedupe(nodeId: string): void {
    toasted.delete(nodeId)
  }

  onScopeDispose(() => toasted.clear())

  return { onNodeError, clearNodeDedupe }
}
