import { apiUrl } from '@/services/api-base'

/** 设备无关的鉴权头：与 AgentSideRail 内联 `authHeaders` 同源口径（读 localStorage token）。 */
function authHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem('token')
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch {
    return {}
  }
}

async function authedPost(
  path: string,
  body: unknown,
  opts: { signal?: AbortSignal; timeoutMs?: number; idempotencyKey?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeaders(),
  }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey
  // 给了 timeoutMs 就用一次性超时信号；否则透传调用方 signal（如流式 abort）。
  const signal = opts.timeoutMs != null ? AbortSignal.timeout(opts.timeoutMs) : opts.signal
  return fetch(apiUrl(path), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })
}

/**
 * L1 指令客户端（SSE 统一规格 Phase 2，§5.2 / §6.2 / §8）。
 *
 * 把 `AgentSideRail` 内联的指令回写（chat/conversation、runs/steer|followup、
 * runs/cancel、runs/queue/cancel、chat/user/entry-id）上收为**设备无关**客户端，
 * PC 与移动 chat 共用。各方法返回原始 `Response`，调用方保留原有的
 * `res.ok` / `res.json()` / `parseQueueDelivery` 处理——属于近 1:1 替换，行为不变。
 *
 * 之所以返回 `Response` 而非解析后的体：调用方对响应有差异化处理
 * （deliverQueued 抽 `entryId`、withdrawQueued 读 `data.outcome`、conversation 走流式/ack 分派），
 * 把解析留在调用侧可零改动复用既有逻辑。
 */

/** 发起一轮对话（流式 / ack 双模式由服务端响应头分派）。 */
export function postConversation(
  payload: Record<string, unknown>,
  opts: { signal: AbortSignal; idempotencyKey: string },
): Promise<Response> {
  return authedPost('/api/agent/chat/conversation', payload, opts)
}

/** 流式中插话：steer（顺当前 run 边界接住）或 followup（尾随通道）。 */
export function postSteerFollowup(
  intent: 'steer' | 'followup',
  payload: Record<string, unknown>,
  opts: { signal?: AbortSignal } = {},
): Promise<Response> {
  const path = intent === 'steer' ? '/api/agent/runs/steer' : '/api/agent/runs/followup'
  return authedPost(path, payload, { ...opts, timeoutMs: 5000 })
}

/** 中止当前 run。 */
export function postCancelRun(
  body: Record<string, unknown>,
  opts: { signal?: AbortSignal } = {},
): Promise<Response> {
  return authedPost('/api/agent/runs/cancel', body, { ...opts, timeoutMs: 3000 })
}

/** 从 vendor 队列撤回已入队的插话。 */
export function postCancelQueued(
  payload: Record<string, unknown>,
  opts: { signal?: AbortSignal } = {},
): Promise<Response> {
  return authedPost('/api/agent/runs/queue/cancel', payload, { ...opts, timeoutMs: 5000 })
}

/** 把 pi 回传的 entryId 回填到服务端已落库的那条 user 消息（增强重跑切点）。 */
export function postPersistEntryId(
  payload: Record<string, unknown>,
  opts: { signal?: AbortSignal } = {},
): Promise<Response> {
  return authedPost('/api/agent/chat/user/entry-id', payload, { ...opts, timeoutMs: 5000 })
}
