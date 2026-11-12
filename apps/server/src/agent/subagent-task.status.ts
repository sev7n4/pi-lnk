/**
 * D2 子任务终态单一判据（spec §5.4 / §6）。
 *
 * ⚠️ 判据只陈述可观测事实：Nest 侧从 tool_execution_end.result.details 读到的
 * 4 态 outcome，或「本流没收到权威收束 / 租约过期」。禁止把 pod 重启、nginx
 * 掐断、客户端断网写成 reason —— 那些在 Nest 侧无法确证。
 * ⚠️ 不存 report 全文（P1c 530KB/行债），只留数值摘要。
 */

export type SubagentTerminalStatus =
  | 'completed' | 'failed' | 'timeout' | 'budget_exceeded' | 'interrupted'
export type SubagentTaskStatus = 'spawned' | SubagentTerminalStatus

export interface SubagentTaskOutcome {
  status: SubagentTerminalStatus
  reason: string
  summary: { turns?: number; durationMs?: number; reportChars?: number }
}

const TERMINAL = new Set<SubagentTerminalStatus>([
  'completed', 'failed', 'timeout', 'budget_exceeded',
])

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>) : null
}

/** tool_result.result.details 的形态（spawn-subagent.ts textResult 的 data）。 */
export function parseSubagentOutcome(result: unknown): SubagentTaskOutcome | null {
  const root = asRecord(result)
  if (!root) return null
  const details = asRecord(root.details)
  if (!details) return null
  const usage = asRecord(details.usage)
  const raw = usage?.status ?? (
    typeof details.error === 'string' && details.error.startsWith('subagent_')
      ? details.error.slice('subagent_'.length) : undefined
  )
  if (typeof raw !== 'string' || !TERMINAL.has(raw as SubagentTerminalStatus)) return null
  const status = raw as SubagentTerminalStatus
  const summary: SubagentTaskOutcome['summary'] = {}
  if (typeof usage?.turns === 'number') summary.turns = usage.turns
  if (typeof usage?.durationMs === 'number') summary.durationMs = usage.durationMs
  if (typeof details.report === 'string') summary.reportChars = details.report.length
  return { status, reason: status, summary }
}

export function interruptedOutcome(
  reason: 'no_terminal_event' | 'lease_expired',
): SubagentTaskOutcome {
  return { status: 'interrupted', reason, summary: {} }
}

/** 漏斗只认 spawn_subagent 的 tool_call/tool_result，其余帧零副作用。 */
export function isSpawnToolFrame(ev: { type: string; data?: unknown }): boolean {
  if (ev.type !== 'tool_call' && ev.type !== 'tool_result') return false
  const d = asRecord(ev.data)
  return d?.name === 'spawn_subagent' || d?.toolName === 'spawn_subagent'
}
