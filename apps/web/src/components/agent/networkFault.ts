/**
 * 请求错误的纯函数分类与文案映射（无 DOM 依赖，可单测）。
 *
 * 设计动机（2026-10-21）：移动端 fetch 在未拿到任何 HTTP 状态前抛出的
 * `TypeError: network error` / `Failed to fetch` 被原样拼进气泡透给用户，
 * 且既没进三色卡片体系、也没触发任何恢复提示。这里把「连接级 / 业务级 / 未知」
 * 三类错误归一化，供 `AgentSideRail` 做卡片分流与 `turnStatusBar.failureReason` 做人话。
 */

export type RequestErrorKind = 'network' | 'business' | 'unknown'

export interface RequestErrorClass {
  kind: RequestErrorKind
  /** 业务级错误的 HTTP 状态码（连接级/未知为 undefined） */
  status?: number
  /** 面向用户的人话摘要 */
  human: string
}

/**
 * 浏览器 fetch 在拿到响应前抛错：典型文案 `NetworkError` / `Failed to fetch` /
 * `Load failed` / `TypeError: network error`。注意空格：`network error` 与
 * `NetworkError` 都要覆盖（不同浏览器措辞不同）。
 */
const NETWORK_MESSAGE_RE = /network\s?error|failed to fetch|load failed|network request failed/i

/**
 * 判定错误是否属于「连接级失败」。
 *
 * 关键判据：**没有 HTTP 状态码**。只要错误对象带 `status` 或 `response.status`
 * 就一律视为业务/服务端错误（哪怕它是 5xx），因为那代表请求确实到达了后端。
 */
export function isNetworkError(err: unknown): boolean {
  const e = err as
    | { status?: number; response?: { status?: number }; message?: string; name?: string }
    | null
    | undefined
  if (!e) return false
  if (typeof e.status === 'number') return false
  if (typeof e.response?.status === 'number') return false
  const msg = (e.message ?? '').toString()
  const name = (e.name ?? '').toString()
  if (NETWORK_MESSAGE_RE.test(msg)) return true
  if (NETWORK_MESSAGE_RE.test(name)) return true
  return false
}

/** 业务级状态码 → 人话（与 `turnStatusBar.failureReason` 的映射保持一致） */
export function businessHuman(status: number): string {
  switch (status) {
    case 402:
      return '渠道余额不足'
    case 401:
      return '渠道密钥无效'
    case 403:
      return '渠道无权限'
    case 429:
      return '额度或频率受限'
    default:
      return `服务异常（${status}）`
  }
}

/**
 * 归一化任意请求错误。
 *
 * 业务级（带 status）优先，其次连接级，最后超时/未知兜底。
 * `human` 可直接作为卡片/状态行人话文案使用。
 */
export function classifyRequestError(err: unknown): RequestErrorClass {
  const e = err as { status?: number; response?: { status?: number }; message?: string } | null
  const status =
    typeof e?.status === 'number'
      ? e.status
      : typeof e?.response?.status === 'number'
        ? e.response.status
        : undefined
  if (typeof status === 'number' && status > 0) {
    return { kind: 'business', status, human: businessHuman(status) }
  }
  if (isNetworkError(err)) {
    return { kind: 'network', human: '网络连接不稳定，请检查网络后重试' }
  }
  const msg = (e?.message ?? '').toString()
  if (/timeout|timed?\s*out|abort/i.test(msg)) return { kind: 'unknown', human: '上游响应超时' }
  return { kind: 'unknown', human: '生成失败，请重试' }
}
