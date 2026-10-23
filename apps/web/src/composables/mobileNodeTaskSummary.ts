import { resolveMobileNodeState } from '@/composables/mobileNodeState'

/**
 * 移动端壳层任务聚合（R3-T4）——纯函数。
 *
 * D-C 状态机的「壳层聚合进度条」：把散落在各节点上的**生成中 / 待确认**
 * 收敛成一条——用户不必逐个节点去看就知道整体在干什么。
 *
 * ⭐ 判据复用 `resolveMobileNodeState`（R3-T1）⇒ 与磁贴 / 徽标消费同一答案，
 * 三处不各写一遍。
 * ⭐ **不假造进度**：本函数只给「数量」+「最早起始时间」，百分比无从谈起
 *   （全仓无生成进度字段）——由调用方渲染成「N 个生成中 · 1:23」。
 */

export interface MobileNodeTaskInput {
  id: string
  type: string
  data?: Record<string, unknown> | null
  title?: string
}

export interface MobilePendingNode {
  id: string
  title?: string
}

export interface MobileNodeTaskSummary {
  /** 正在生成的节点数 */
  generatingCount: number
  /** 待确认节点（id + 标题） */
  pendingNodes: MobilePendingNode[]
  /** 最早那批生成任务的起始时间（计时基准；无则 undefined = 不显示计时） */
  earliestStartedAt?: string
}

export function summarizeMobileNodeTasks(
  nodes: readonly MobileNodeTaskInput[],
): MobileNodeTaskSummary {
  let generatingCount = 0
  const pendingNodes: MobilePendingNode[] = []
  let earliestMs = Number.POSITIVE_INFINITY
  let earliestStartedAt: string | undefined

  for (const node of nodes) {
    const state = resolveMobileNodeState({ type: node.type, data: node.data })
    if (state === 'generating') {
      generatingCount += 1
      const startedAt = (node.data as { generationStartedAt?: unknown } | undefined)?.generationStartedAt
      if (typeof startedAt === 'string' && startedAt) {
        const ms = Date.parse(startedAt)
        if (!Number.isNaN(ms) && ms < earliestMs) {
          earliestMs = ms
          earliestStartedAt = startedAt
        }
      }
    } else if (state === 'pending') {
      pendingNodes.push({ id: node.id, title: node.title })
    }
  }

  return { generatingCount, pendingNodes, earliestStartedAt }
}
