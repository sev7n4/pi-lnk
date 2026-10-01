/**
 * 「正在做什么」人话（P0 决策 3 + 决策 5 兜底）。
 *
 * 数据源 = 现有 executionTrace 步骤，Web 侧现算，**不新增协议事件**；
 * 决策 8 的 runtime `activity` 事件（带 done/total 进度）是 P1 增强，用来补进度条语义。
 */
import type { ExecutionStep } from '@/components/agent/executionTraceReducer'
import { presentToolStep } from '@/components/agent/toolPresentation'

/**
 * runtime `activity` 事件载荷（决策 8）—— 与 store.agent.activity 同形。
 * 中文由本文件出（查 TOOL_PRESENTATION 目录）；runtime 侧刻意只给英文工具名，不翻文案。
 */
export interface RuntimeActivity {
  toolName?: string;
  done?: number;
}

/**
 * runtime activity → 人话。返回 null = 这条事件不可用（缺工具名），交回调用方走 trace 兜底。
 *
 * 「第 N 步」只在 N ≥ 2 时追加：第 1 步说「第 1 步」是废话，反而稀释动词。
 * 分母（total）在 runtime 侧无源（见 ActivityData 注释），绝不渲染任何假进度。
 */
export function describeRuntimeActivity(activity?: RuntimeActivity | null): string | null {
  if (!activity?.toolName) return null;
  const { label } = presentToolStep({ label: '', meta: { toolName: activity.toolName } });
  if (!label) return null;
  return typeof activity.done === 'number' && activity.done >= 2 ? `${label} · 第 ${activity.done} 步` : label;
}

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
