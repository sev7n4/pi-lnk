/**
 * E2-a 回合产物幽灵摘要 —— 派生纯函数（规格 docs/superpowers/specs/2026-11-04-e2a-ghost-delivery-summary-design.md §3）。
 *
 * D-a：只读消费 timeline parts，输出渲染期派生清单；同输入两次调用同输出；
 *      不 mutate 入参、不新增 part kind、不落 executionEvents——历史重放/快照重建结果一致。
 * D-b：N=0 由调用方整行隐藏（本模块以空数组表达）；failed / pending 不计入；
 *      计数文案 >9 收敛为「9+」。
 */
import type { TimelinePart } from '@/components/agent/turnTimeline'

export interface DeliveryItem {
  nodeId: string
  nodeType: string
  title: string
}

/** 本回合可交付产物清单：done 且有 nodeId 的 artifact part，事件到达序保序。 */
export function turnDeliveryItems(parts: readonly TimelinePart[]): DeliveryItem[] {
  const items: DeliveryItem[] = []
  for (const p of parts) {
    if (p.kind !== 'artifact' || p.status !== 'done') continue
    items.push({ nodeId: p.nodeId, nodeType: p.nodeType, title: p.title })
  }
  return items
}

/** 回合态判定（D-b）：存在 running artifact ⇒ 回合进行中，幽灵行不渲染。 */
export function hasRunningGeneration(parts: readonly TimelinePart[]): boolean {
  return parts.some((p) => p.kind === 'artifact' && p.status === 'running')
}

/** 计数文案（D-b）：0 → 空串；超过 9 收敛「9+」。 */
export function deliveryCountLabel(n: number): string {
  if (n <= 0) return ''
  if (n > 9) return '9+'
  return String(n)
}
