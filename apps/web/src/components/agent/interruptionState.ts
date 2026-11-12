/**
 * W1c（D1=A）：刷新 / 重连后从服务端 `interruption` 摘要重建 ask_user 卡。
 *
 * 与 P0 单一真相原则一致：卡的权威状态以服务端 `PendingInterruption` 表最新一条为准，
 * 前端只做「消费 + 校正」，不自己造状态。本模块只负责「取」（网络 + 鉴权 + 形态归一），
 * 决策逻辑在 `turnTimeline.ts#reconcileTimelineInterruption`（纯函数、可单测、可离线重放）。
 *
 * 设计纪律（spec §4 / 计划 §3 Task 2）：
 * - fail-open：非 200 / json 解析失败 / 形态不符 / 抛错 ⇒ 一律返回 null，**绝不抛异常**，
 *   让调用方回落「现有 question part 现状」（W1c-3b 不回归旧行为）。
 * - `cache:'no-store'`：与 loadHistory 同源（ETag 304 空体曾致白屏），避免读到陈旧门状态。
 * - 新端点 `/api/agent/threads/:id/state`（不含 `thread-state` 字面量），不撞 H1-c 退役守卫。
 */
import { apiUrl } from '@/services/api-base'
import type { InterruptionSummary } from '@/components/agent/turnTimeline'

export interface InterruptionStateFetchOptions {
  /** 注入 fetch 实现（测试用）；默认全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 注入 token 提供方（测试用）；默认读 localStorage 的 `token`（与 AgentSideRail authHeaders 同源）。 */
  tokenProvider?: () => string | null
  /** 注入 AbortSignal（测试用）；默认 10s 超时。 */
  signal?: AbortSignal
}

interface RawStateResponse {
  code?: number
  data?: {
    interruption?: {
      callId?: unknown
      kind?: unknown
      questions?: unknown
      expiresAt?: unknown
      status?: unknown
    } | null
  } | null
}

function asInterruptionSummary(data: NonNullable<RawStateResponse['data']>): InterruptionSummary | null {
  const raw = data.interruption
  if (!raw || typeof raw.callId !== 'string') return null
  const status = raw.status
  if (
    status !== 'pending' &&
    status !== 'answered' &&
    status !== 'expired' &&
    status !== 'aborted'
  ) {
    return null
  }
  return {
    callId: raw.callId,
    kind: typeof raw.kind === 'string' ? raw.kind : 'ask_user',
    questions: Array.isArray(raw.questions) ? raw.questions : [],
    expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : 0,
    status,
  }
}

/**
 * 拉取线程的 `interruption` 摘要；任何异常 / 非权威形态 ⇒ null（fail-open）。
 * 调用方据此决定是否把现有 question part 翻终态，或保持其当前可点状态。
 */
export async function fetchInterruptionState(
  threadId: string,
  options: InterruptionStateFetchOptions = {},
): Promise<InterruptionSummary | null> {
  const fetchImpl = options.fetchImpl ?? fetch
  const tokenProvider =
    options.tokenProvider ??
    (() => (typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null))
  if (!threadId) return null
  const url = apiUrl(`/agent/threads/${encodeURIComponent(threadId)}/state`)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = tokenProvider()
  if (token) headers.Authorization = `Bearer ${token}`
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal: options.signal ?? AbortSignal.timeout(10_000),
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  let body: RawStateResponse
  try {
    body = (await res.json()) as RawStateResponse
  } catch {
    return null
  }
  if (!body || body.code !== 0 || !body.data) return null
  return asInterruptionSummary(body.data)
}
