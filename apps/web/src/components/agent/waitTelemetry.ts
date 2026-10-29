/**
 * 等待态可观测打点（根治规格 2026-10-28 T4）。
 *
 * 事件源 = 时间线 part 单一真相（不另建并行遥测状态）：
 * - `agent_wait_started`：`waiting_user{propose_generation}` / `ask_user` 事件收敛成
 *   pending part 时上报；callId 为幂等键，事件 upsert 重放只报一次；
 * - `agent_wait_resolved`：part 翻终态（confirmed / answered / skipped）时上报，
 *   `durationMs` 取自 part.startedAt —— 时长承载在单一真相上，遥测层不另记时钟。
 *
 * V1 实现与 selectionBatchTelemetry 同型：console.debug（dev）+ stub（prod），
 * 后续接 analytics 平台只改这一处。
 */

export type WaitKind = 'proposal' | 'question'
/** proposal 翻 confirmed（resolved 事件）；question 翻 answered / declined（skipped）。 */
export type WaitOutcome = 'confirmed' | 'answered' | 'skipped'

export type WaitEvent =
  | {
      name: 'agent_wait_started'
      payload: { kind: WaitKind; callId: string; nodeId?: string | null; timeoutMs?: number | null }
    }
  | {
      name: 'agent_wait_resolved'
      payload: { kind: WaitKind; callId: string; outcome: WaitOutcome; durationMs: number | null }
    }

/** 已上报 started 的 (kind, callId)：waiting_user / ask_user upsert 重放只报一次。 */
const reportedStarted = new Set<string>()

function startedKey(kind: WaitKind, callId: string): string {
  return `${kind}:${callId}`
}

export function reportWaitStarted(
  kind: WaitKind,
  callId: string,
  opts?: { nodeId?: string | null; timeoutMs?: number | null },
): void {
  if (!callId) return
  const key = startedKey(kind, callId)
  if (reportedStarted.has(key)) return
  reportedStarted.add(key)
  emit({
    name: 'agent_wait_started',
    payload: { kind, callId, nodeId: opts?.nodeId ?? null, timeoutMs: opts?.timeoutMs ?? null },
  })
}

export function reportWaitResolved(
  kind: WaitKind,
  callId: string,
  outcome: WaitOutcome,
  startedAt?: number,
): void {
  if (!callId) return
  const durationMs =
    typeof startedAt === 'number' && startedAt > 0 ? Math.max(0, Date.now() - startedAt) : null
  emit({ name: 'agent_wait_resolved', payload: { kind, callId, outcome, durationMs } })
  // 终态后清理幂等键：同 callId 若再来一轮等待（防御性）可重新计 started。
  reportedStarted.delete(startedKey(kind, callId))
}

function emit(event: WaitEvent): void {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.debug('[telemetry]', event.name, event.payload)
  }
  // prod 路径：V1 dev-only stub — 无 prod channel（与 selectionBatchTelemetry 一致）。
}
