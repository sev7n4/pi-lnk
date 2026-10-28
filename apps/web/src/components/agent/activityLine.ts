/**
 * 「正在做什么」人话（P0 决策 3 + 决策 5 兜底）。
 *
 * 根治规格（2026-10-28）：从时间线 `parts` 派生，而非直连 `executionTrace.steps`——
 * 时间线是等待态 + 执行态的**单一真相**，状态行与对话流内联卡读同一份，结构性消除「状态行抢跑」。
 * 浮层与对话流同源（见 composer-overlay-trace-boundary 设计），不走 runtime activity 双源。
 */
import type { ExecutionStep } from '@/components/agent/executionTraceReducer'
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

/**


 * 最新一步的人话（跳过 phase 门控步；phase 只是「等什么」的提示，不是用户在读的动作）。
 * 拿不到任何步 → 返回 null，由 turnStatusBar 降级为 GENERIC_ACTIVITY「处理中」。
 * @deprecated 由 describeActivityFromTimeline 取代（根治规格）——保留以兼容旧调用方。
 */
export function describeActivity(steps?: ExecutionStep[]): string | null {
  if (!steps || steps.length === 0) return null
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]!
    if (step.kind === 'phase' && step.status !== 'waiting_user') continue
    return presentToolStep(step).label
  }
  return null
}
