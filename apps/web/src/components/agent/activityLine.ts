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

/**
 * 回合实时状态灰字（WorkBuddy 同款，2026-11-03 移动端复测）：从时间线 parts 尾扫派生。
 *
 * 与 describeActivityFromTimeline 的分工：那个只回答「最近一次工具在干嘛」（tool-only），
 * 这个回答「此刻整个回合在干嘛」——覆盖 WorkBuddy 状态行全谱：
 * 正文流式 → 生成回复中；思考运行 → 深度思考中；工具运行 → 正在<人话>（注册表同源）；
 * 产物生成 pending/running → 正在生成产物；等待确认（proposal/question pending）→ 等待你确认；
 * 段间静默 / 回合起步（无 parts 或无活跃段）→ 等待模型响应。
 * 纯函数、只读时间线单一真相（与对话流内联卡同源），刷新后可从持久化 parts 重建。
 */
export function turnLiveStatus(parts?: TimelinePart[]): string {
  for (let i = (parts?.length ?? 0) - 1; i >= 0; i -= 1) {
    const p = parts![i]!
    if (p.kind === 'text' && p.status === 'streaming') return '生成回复中'
    if (p.kind === 'thinking' && p.status === 'running') return '深度思考中'
    if (p.kind === 'tool' && p.status === 'running') {
      return `正在${presentToolStep({
        label: p.toolName,
        kind: 'tool',
        status: p.status,
        meta: { toolName: p.toolName, args: p.args },
      }).label}`
    }
    if (p.kind === 'artifact' && (p.status === 'pending' || p.status === 'running')) {
      return '正在生成产物'
    }
    if (
      (p.kind === 'proposal' && p.status === 'pending_confirm') ||
      (p.kind === 'question' && p.status === 'pending_answer')
    ) {
      return '等待你确认'
    }
  }
  return '等待模型响应'
}
