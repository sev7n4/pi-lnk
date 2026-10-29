/**
 * 「正在做什么」人话（P0 决策 3 + 决策 5 兜底）。
 *
 * 根治规格（2026-10-28）：从时间线 `parts` 派生，而非直连 `executionTrace.steps`——
 * 时间线是等待态 + 执行态的**单一真相**，状态行与对话流内联卡读同一份，结构性消除「状态行抢跑」。
 * 浮层与对话流同源（见 composer-overlay-trace-boundary 设计），不走 runtime activity 双源。
 */
import type { TimelinePart } from '@/components/agent/turnTimeline'
import { presentToolStep } from '@/components/agent/toolPresentation'

/**
 * 从时间线 parts 取「正在做什么」人话：最后一个非失败 tool part 的现话标签。
 * 拿不到 → 返回 null，由 turnStatusBar 降级为 GENERIC_ACTIVITY「处理中」。
 */
export function describeActivityFromTimeline(parts?: TimelinePart[]): string | null {
  if (!parts || parts.length === 0) return null
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const p = parts[i]!
    if (p.kind !== 'tool') continue
    if (p.status === 'failed') continue
    return presentToolStep({
      label: p.toolName,
      kind: 'tool',
      status: p.status,
      meta: { toolName: p.toolName, args: p.args },
    }).label
  }
  return null
}
