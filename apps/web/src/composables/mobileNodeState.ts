import {
  NODE_GENERATION_STATUS,
  NODE_PENDING_CONFIRM_STATUS,
  isNodeGenerating,
} from '@/constants/dockStudio'

/**
 * 移动端节点状态判据（D-C 五态归一，R3-T1）——单一真源。
 *
 * ⭐ 为什么需要它：R2 只落地了 `empty` 一行（D-C 状态机
 *   `empty → generating → pending → confirmed → error`）。移动端的状态呈现
 *   此前是**断的**：
 *   ① `NodeRenderer` 未向磁贴传 `:status` ⇒ `statusBadge()` 恒返回 null
 *      ⇒ 状态徽标当前根本不渲染；
 *   ② 徽标表只覆盖 2/5 态（image 的 `error` + video 的 `pending`），
 *      且那个 `pending` **不是** `pending_confirm`（值不同，桌面用后者）。
 *
 * 纯函数、零副作用：磁贴 / 徽标 / 壳层状态栏三处消费同一答案，不各写一遍。
 *
 * ⚠️ 判据优先级（**不可交换**）：generating > pending > error > 内容判定。
 *   否则「有 url 但仍在生成」会被误判成 confirmed（内容已就位 = 已完成），
 *   用户会以为生成完了。
 */
export type MobileNodeState = 'empty' | 'generating' | 'pending' | 'confirmed' | 'error'

export function resolveMobileNodeState(node: {
  type: string
  data?: Record<string, unknown> | null
}): MobileNodeState {
  const data = node.data ?? {}
  const status = String(data.status ?? '')

  // 1) 生成态优先（含 fallback_pending = 降级等待，仍是「在跑」）
  if (isNodeGenerating(status)) return 'generating'

  // 2) 待确认（agent 已提议，等用户在节点上确认/取消）——ADR-0011 的阻塞态
  if (status === NODE_PENDING_CONFIRM_STATUS) return 'pending'

  // 3) 失败态
  if (status === NODE_GENERATION_STATUS.error || status === NODE_GENERATION_STATUS.failed) {
    return 'error'
  }

  // 4) 内容判定：文本看 content，其余看 url
  if (node.type === 'text') {
    return String(data.content ?? '').trim() ? 'confirmed' : 'empty'
  }
  return String(data.url ?? '') ? 'confirmed' : 'empty'
}
