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
 *
 * thread-state 已随 H1-c 退役（规格 2026-10-28 §5.2）：安全拉取函数、
 * 读取类型与 I-2 不可达判定均已删除，死端点一并下线、前端调用清零。
 */

export const RUNTIME_UNREACHABLE_SNIPPET = '生成服务暂时不可达'
export const STREAM_STALE_MS = 30_000

/** W12: true when no SSE activity (incl. ping) for longer than STREAM_STALE_MS. */
export function isStreamStale(lastActivityAt: number, now = Date.now()): boolean {
  return now - lastActivityAt > STREAM_STALE_MS
}

/**
 * P1#11：reconcile 轮询续停判定。
 * H1-c（规格 2026-10-28 §5.2）：状态读取退役后调用方恒传 null ⇒ 按上限兜底，
 * 与退役前「恒返 null 的生产现状」行为一致。终态判定待 H3 seq 游标窗重接 turnState（规格 §12）。
 */
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
 * 多端共享对话（2026-10-26）：bootstrap 默认收敛到确定式共享 threadId（= sessionId），
 * 跨设备实时 + 续聊成立。
 *
 * ⚠️ 但与「③ 重跑」共存：re-run 会把活跃线程切到 pi fork 出的分支线程（newKey）并持久化。
 * 若一律回落共享线程，重跑结果在刷新后丢失（Phase 1 曾引入此回归）。
 * 故优先恢复专用 fork key 记录的分支线程（仅当其确有消息），否则回落共享线程。
 * 用专用 key 而非复用 normal key / 解析 newKey 格式：彻底绕开格式猜测，
 * 也避免旧隔离时代 sessionId:random 随机线程（陈旧缓存）回潮成「每端各玩各的」。
 */
export async function resolveBootstrapThreadId(
  sessionId: string,
  opts: {
    /**
     * threads 行（含服务端 messageCount，H1-b）；**null = 拉取失败**。
     * fail-open（K3/D3）：失败时保留 fork key 现场（不清、不覆盖），渲染层由 H0-d 重试卡兜底。
     * 旧 `messageCountFor`（全量下载 user/messages 只为数数）与死参数 `cachedThreadId`（D4）一并退役。
     * messageCount 允许缺省（AgentThreadRow 可选字段，旧响应/裁剪行按 0 处理）。
     */
    threads: Array<{ id: string; messageCount?: number }> | null
  },
): Promise<string> {
  const shared = createAgentThreadId(sessionId)
  const forked = getForkedThreadId(sessionId)
  if (opts.threads === null) {
    return forked ?? shared
  }
  if (forked && forked !== shared) {
    const count = opts.threads.find((t) => t.id === forked)?.messageCount ?? 0
    if (count > 0) return forked
    clearForkedThreadId(sessionId) // 分支线程已空（异常/竞态）→ 清陈旧 fork key，回落共享
  }
  return shared
}

export function persistActiveThreadId(sessionId: string, threadId: string) {
  localStorage.setItem(lastThreadStorageKey(sessionId), threadId)
}

/**
 * ③ 重跑分支线程专用持久化 key。
 *
 * 多端共享对话下，普通活跃线程恒为确定式共享线程 `sessionId`（见 createAgentThreadId）。
 * 但「③ 重跑」会 fork 出一条 pi 分支线程（newKey）作为新活跃线程，必须单独持久化，
 * 否则刷新后 bootstrap 回落共享线程会把重跑结果丢掉（Phase 1 曾引入此回归）。
 *
 * 不写入普通 `lastThreadStorageKey`（那是共享线程的键，写它会与 legacy 随机线程混淆），
 * 也不解析 newKey 字符串格式（pi 的 key 格式不稳定），专用一把 key 记录「当前激活的分支线程」。
 */
export function lastForkedThreadStorageKey(sessionId: string) {
  return `lnkpi:agentThreadFork:${sessionId}`
}
export function getForkedThreadId(sessionId: string): string | null {
  return localStorage.getItem(lastForkedThreadStorageKey(sessionId))
}
export function persistForkedThreadId(sessionId: string, threadId: string) {
  localStorage.setItem(lastForkedThreadStorageKey(sessionId), threadId)
}
export function clearForkedThreadId(sessionId: string) {
  localStorage.removeItem(lastForkedThreadStorageKey(sessionId))
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
