import { apiUrl } from '@/services/api-base'
import { lastThreadStorageKey } from '@/utils/formatSessionTime'
import { randomId } from '@/utils/randomId'

/**
 * Stream recovery utilities for frontend agent-side-rail.
 *
 * Provides:
 * - SSE abnormal-end detection (streamEndedNormally flag)
 * - Runtime health polling decision logic
 * - Idempotency key generation
 */

export const RUNTIME_UNREACHABLE_SNIPPET = '生成服务暂时不可达'
export const STREAM_STALE_MS = 30_000

/** W12: true when no SSE activity (incl. ping) for longer than STREAM_STALE_MS. */
export function isStreamStale(lastActivityAt: number, now = Date.now()): boolean {
  return now - lastActivityAt > STREAM_STALE_MS
}

/** P1#11：reconcile 轮询续停判定——thread-state 回合终态优先，缺失时按上限兜底。 */
export const RECONCILE_MAX_POLLS = 36

export function shouldKeepReconciling(
  threadState: { finished?: boolean | null } | null,
  polls: number,
): boolean {
  if (threadState?.finished) return false
  return polls < RECONCILE_MAX_POLLS
}

/**
 * Thread suffix for pi-runtime threads（老 LangGraph runtime 已退役，thread 语义保留）。
 * crypto.randomUUID requires a secure context (HTTPS/localhost); production CVM is HTTP.
 */
export function randomThreadSuffix(): string {
  return randomId()
}

/** Build a session-scoped agent thread id (never reuse `:main`). */
export function createAgentThreadId(sessionId: string): string {
  return `${sessionId}:${randomThreadSuffix()}`
}

/**
 * Pick thread to restore after canvas refresh.
 * Avoids blank UI when localStorage points at an empty thread (e.g. after「新建对话」).
 */
export async function resolveBootstrapThreadId(
  sessionId: string,
  opts: {
    cachedThreadId: string | null
    threads: Array<{ id: string }>
    messageCountFor: (threadId: string) => Promise<number>
  },
): Promise<string> {
  const { cachedThreadId, threads, messageCountFor } = opts

  if (cachedThreadId) {
    const cachedCount = await messageCountFor(cachedThreadId)
    if (cachedCount > 0) return cachedThreadId
  }

  for (const th of threads) {
    const count = await messageCountFor(th.id)
    if (count > 0) return th.id
  }

  if (cachedThreadId) return cachedThreadId
  if (threads[0]?.id) return threads[0].id
  return createAgentThreadId(sessionId)
}

export function persistActiveThreadId(sessionId: string, threadId: string) {
  localStorage.setItem(lastThreadStorageKey(sessionId), threadId)
}

/** Generate an idempotency key for POST /api/agent/chat/conversation. */
export function buildIdempotencyKey(threadId: string): string {
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 6)
  return `ik_${threadId}_${ts}_${rand}`
}

/**
 * Decide whether the frontend should poll runtime health (pi-runtime) after SSE ends.
 * Returns true when the assistant content suggests generation is still in progress
 * and hasn't reached a terminal state.
 */
export function shouldPollRuntimeHealth(assistantContent: string): boolean {
  const BUSY_SNIPPETS = ['上一轮仍在处理中', '出图仍在进行中', '正在', '请稍候']
  const DONE_SNIPPETS = ['出图成功', '已将确认的主文案', '自动出图', '已完成']

  const hasBusy = BUSY_SNIPPETS.some((s) => assistantContent.includes(s))
  const hasDone = DONE_SNIPPETS.some((s) => assistantContent.includes(s))

  // Poll when: busy indicators present AND no completion indicators
  return hasBusy && !hasDone
}

/**
 * Check runtime health via Nest proxy endpoint（心跳探的是 pi-runtime）。
 * Returns { ok: boolean, latencyMs?: number } or null on network failure.
 */
export async function checkRuntimeHealthViaNest(): Promise<{ ok: boolean; latencyMs?: number } | null> {
  try {
    const res = await fetch(apiUrl('/agent/runtime-health'), {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      code?: number
      data?: { ok?: boolean; latencyMs?: number }
    }
    const data = json?.data
    if (!data || data.ok === undefined) return null
    return { ok: data.ok, latencyMs: data.latencyMs }
  } catch {
    return null
  }
}
