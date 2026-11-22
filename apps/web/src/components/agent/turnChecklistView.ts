import type { TimelinePart } from './turnTimeline'
import type { AgentTaskProgressState } from './agentTaskProgress'

const STATUS_LABEL: Record<string, string> = {
  pending: '等待中', running: '进行中', retrying: '重试中', done: '完成',
  failed: '失败', needs_user: '需你处理', skipped: '已跳过',
}

export interface TurnChecklistItem {
  id: string
  title: string
  statusLabel: string
  glyph: '✓' | '□'
  activeForm?: string
  nodeId?: string
  errorHint?: string
  done: boolean
}

// Codex TUI plans.rs:290-292/329-331 —— 进行中优先、完成沉底、完成项打钩。
const STATUS_RANK: Record<string, number> = {
  running: 0, retrying: 0,
  pending: 1, failed: 1, needs_user: 1,
  done: 2, skipped: 2,
}

export interface TurnChecklistView {
  items: TurnChecklistItem[]
  doneCount: number
  total: number
}

export function isTurnFinalized(parts: TimelinePart[]): boolean {
  return parts.some((p) => p.kind === 'notice' && p.id === 'notice:turn-summary')
}

export function deriveTurnChecklistView(
  progress: AgentTaskProgressState | null | undefined,
): TurnChecklistView | null {
  const items = progress?.items ?? []
  if (!items.length) return null
  const rank = new Map(items.map((it) => [it.id, STATUS_RANK[it.status] ?? 1]))
  const view = items.map((it) => {
    const done = it.status === 'done' || it.status === 'skipped'
    return {
      id: it.id,
      title: it.title,
      statusLabel: STATUS_LABEL[it.status] ?? it.status,
      glyph: (done ? '✓' : '□') as '✓' | '□',
      ...(it.activeForm ? { activeForm: it.activeForm } : {}),
      ...(it.nodeId ? { nodeId: it.nodeId } : {}),
      ...(it.errorHint ? { errorHint: it.errorHint } : {}),
      done,
    }
  }).sort((a, b) => (rank.get(a.id) ?? 1) - (rank.get(b.id) ?? 1))
  return { items: view, doneCount: view.filter((i) => i.done).length, total: view.length }
}
