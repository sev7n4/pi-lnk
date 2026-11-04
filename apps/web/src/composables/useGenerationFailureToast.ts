import { ElMessage } from 'element-plus'
import { h, onScopeDispose } from 'vue'

interface NodeErrorLike {
  status?: unknown
  errorMessage?: unknown
  errorCode?: unknown
  generationRecordId?: unknown
}

/**
 * 取消是用户动作不是故障（规格 2026-11-04-generation-terminal-projection §5.3）：
 * 判据 = errorCode === 'cancelled'（结构化语义，一等判据）；
 * `errorMessage` 以「已取消」开头是**旧数据兼容分支**（存量记录 metadata 无
 * errorCode 时由旧写者落下的文案），存量画布被对账收敛后可退役。
 * ⛔ 不再只靠文案判据——2026-11-04 刷屏事故里轮询写者把取消渲染成
 * 「生成失败，N 积分已返回」，字符串嗅探即被击穿。
 */
function isCancellation(node: NodeErrorLike): boolean {
  if (node.errorCode === 'cancelled') return true
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
  errorCode?: unknown
  generationRecordId?: unknown
}

export interface FailureToastOptions {
  /** 点击 toast 打开该节点诊断抽屉（CanvasPage 提供）。 */
  onOpenDetail: (nodeId: string) => void
}

/**
 * 节点失败 toast 去重：键 = 生成记录维度（`rec:<recordId>`，无 recordId 的旧数据
 * 退 `node:<nodeId>`），直到新一轮生成（新 recordId 绑定节点）才可能再 toast。
 *
 * ⭐ 2026-11-04 刷屏根治：键从 nodeId 升级为 recordId，且 **record 键永不因
 * 「→generating 边」清除**——重载把服务端陈旧 generating 快照拉回来再轮询写
 * error，同一 record 的第二次到达会被去重吃掉（此前 nodeId 键 + generating 边
 * 清键 = 弹窗数等于重载数）。「失败→重试→再失败」第二次必须 toast 的既有契约
 * 保留：重试 = 新 recordId = 新去重键。
 */
export function useGenerationFailureToast(opts: FailureToastOptions) {
  const toasted = new Set<string>()

  function dedupeKeyOf(node: FailureToastNode): string {
    const recordId =
      typeof node.generationRecordId === 'string' && node.generationRecordId
        ? node.generationRecordId
        : ''
    return recordId ? `rec:${recordId}` : `node:${node.id}`
  }

  function onNodeError(node: FailureToastNode): void {
    const key = dedupeKeyOf(node)
    if (toasted.has(key)) return
    toasted.add(key)
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

  /**
   * 重试开始（节点 → generating，且 recordId 未变）时调用：解除该节点的
   * **node 维度**去重（无 recordId 的旧数据路径）。rec 维度键不受影响。
   */
  function clearNodeDedupe(nodeId: string): void {
    toasted.delete(`node:${nodeId}`)
  }

  onScopeDispose(() => toasted.clear())

  return { onNodeError, clearNodeDedupe }
}
