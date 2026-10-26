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
 * I-2 修复：reconcile 循环内 thread-state 连续读取失败达阈值 → 判定 pi-runtime 不可达。
 * 3 次 ≈ 15s（每次 fetch 失败约 5s timeout）。达阈值后由调用方注入 RUNTIME_UNREACHABLE_SNIPPET 并 break，
 * 复刻 Task 11 前旧 reconcile 在 30s 后注入告警的行为，避免长时间静默轮询。
 */
export const RECONCILE_NULL_THRESHOLD = 3

/**
 * 线程终态读取结果。`ok:false` 仅代表「这次状态读取失败」，**不等价于 runtime 宕机**（见下）。
 */
export type ThreadStateRead =
  | { ok: true; state: { finished?: boolean | null } | null }
  | { ok: false }

/**
 * thread-state 安全拉取（reconcile 终态判定用）。
 *
 * `cache:'no-store'` 是硬要求：默认缓存策略下浏览器会带 If-None-Match，Nest 回 304 空体，
 * `res.json()` 抛错 → 被读成「读取失败」（2026-10-01 生产误报事故根因之一）。
 */
export async function fetchThreadStateSafe(threadId: string): Promise<ThreadStateRead> {
  try {
    const token = localStorage.getItem('token')
    const res = await fetch(
      apiUrl(`/api/agent/thread-state?threadId=${encodeURIComponent(threadId)}`),
      { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
    )
    if (!res.ok) return { ok: false }
    const json = (await res.json()) as { data?: { finished?: boolean | null } | null }
    return { ok: true, state: json?.data ?? null }
  } catch {
    return { ok: false }
  }
}

/**
 * 是否注入「生成服务暂时不可达」告警。
 *
 * 判据必须是**真实健康探测结果**，不能只看状态读取失败次数：
 * 状态读取失败可能来自 304 / 网络抖动 / 单次 5xx，与服务可达无关
 * （2026-10-01：thread-state 连续 3 次 304 空体 → 误报「生成服务暂时不可达」，而出图其实成功了）。
 *
 * @param consecutiveNulls 连续读取失败次数
 * @param health 真实健康探测结果（checkRuntimeHealthViaNest）；缺省 null = 未探测/探测本身失败
 *               → 无法确认健康，按不可达处理（保留 I-2 想要的宕机可见性）
 */
export function shouldInjectUnreachableSnippet(
  consecutiveNulls: number,
  health: { ok: boolean } | null = null,
): boolean {
  if (consecutiveNulls < RECONCILE_NULL_THRESHOLD) return false
  return health?.ok !== true
}

/**
 * Thread suffix for pi-runtime threads（老 LangGraph runtime 已退役，thread 语义保留）。
 * crypto.randomUUID requires a secure context (HTTPS/localhost); production CVM is HTTP.
 */
export function randomThreadSuffix(): string {
  return randomId()
}

/**
 * 多端共享对话（2026-10-26）：threadId 由 sessionId **确定派生**，不再随机。
 *
 * 同一画布在任意设备登录都收敛到同一条 threadId ⇒ 跨设备实时同步（observer SSE /
 * 历史接口 / 共享订阅频道均以 threadId 为键）与续聊自然成立。
 * 推翻 2026-08-07「重进生成新 threadId」的隔离语义（详见
 * docs/superpowers/specs/2026-10-21-multi-device-consistency-design.md §4.1 / 证据报告）。
 *
 * ⚠️ 不要再加随机后缀：那是「每端各玩各的」的根因。需要多条对话时另行设计，
 * 而非回到随机 threadId。
 */
export function createAgentThreadId(sessionId: string): string {
  return sessionId
}

/**
 * 多端共享对话（2026-10-26）：bootstrap 始终收敛到确定式共享 threadId，
 * 忽略本地缓存与历史列表——旧逻辑优先缓存/首个有消息的 thread，会让每端各玩各的。
 *
 * 任一端打开画布都进入同一条对话，是跨设备实时 + 续聊的前提。
 * `opts` 保留签名以兼容调用方（AgentSideRail.bootstrapThread），但不再参与判定。
 */
export async function resolveBootstrapThreadId(
  sessionId: string,
  _opts: {
    cachedThreadId: string | null
    threads: Array<{ id: string }>
    messageCountFor: (threadId: string) => Promise<number>
  },
): Promise<string> {
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
