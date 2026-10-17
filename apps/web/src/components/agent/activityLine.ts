/**
 * 「正在做什么」人话（P0 决策 3 + 决策 5 兜底）。
 *
 * 唯一数据源 = 现有 executionTrace 步骤，Web 侧现算，**不新增协议事件**；
 * 浮层与对话流同源（见 composer-overlay-trace-boundary 设计），不走 runtime activity 双源。
 */
import type { ExecutionStep } from '@/components/agent/executionTraceReducer'
import { presentToolStep } from '@/components/agent/toolPresentation'

/**


 * 最新一步的人话（跳过 phase 门控步；phase 只是「等什么」的提示，不是用户在读的动作）。
 * 拿不到任何步 → 返回 null，由 turnStatusBar 降级为 GENERIC_ACTIVITY「处理中」。
 */
export function describeActivity(steps?: ExecutionStep[]): string | null {
  if (!steps || steps.length === 0) return null
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    if (step.kind === 'phase' && step.status !== 'waiting_user') continue
    return presentToolStep(step).label
  }
  return null
}
