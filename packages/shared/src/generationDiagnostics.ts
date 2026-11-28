export type ErrorCode =
  | 'insufficient_points'
  | 'upstream_timeout'
  | 'interrupted'
  | 'upstream_error'
  | 'rate_limited'
  | 'cancelled'
  | 'invalid_input'
  | 'model_unavailable'
  | 'upload_required'
  | 'fallback_pending'
  | 'unknown'

export type TaskKind = 'generation' | 'material'

export interface GenerationDiagnostic {
  userMessage: string
  code: ErrorCode
  taskKind: TaskKind
  taskId: string
  nodeId?: string
  nodeLabel?: string
  sessionId?: string
  model?: string | null
  channelId?: string | null
  apiFormat?: string | null
  httpStatus?: number | null
  occurredAt: string
  providerSnippet: string | null
  hint?: string
  /**
   * 退款三字段（S2-3 退款透明化）：只从 GenerationRecord.metadata 透传，⛔ 不重算。
   * 缺字段（undefined）＝该记录无退款语义，消费方不得渲染任何退款 UI。
   */
  chargedPoints?: number
  refundedPoints?: number
  refundReason?: string
}

const BEARER_PATTERN = /Bearer\s+\S+/gi
const SK_KEY_PATTERN = /sk-[A-Za-z0-9_-]{8,}/g
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const PHONE_PATTERN = /\b1[3-9]\d{9}\b/g
const SENSITIVE_QUERY_PARAM_PATTERN =
  /([?&](?:key|token|signature)=)([^&\s]+)/gi

function redactSensitiveValues(text: string): string {
  return text
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(SK_KEY_PATTERN, 'sk-[REDACTED]')
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
    .replace(PHONE_PATTERN, '[REDACTED_PHONE]')
    .replace(SENSITIVE_QUERY_PARAM_PATTERN, '$1[REDACTED]')
}

export function redactProviderSnippet(raw: string, maxLen = 2048): string {
  let text = redactSensitiveValues(raw)

  if (text.length <= maxLen) {
    return text
  }

  return `${text.slice(0, maxLen)}\n…(truncated)`
}

function isPresent(value: unknown): value is string | number {
  return value !== undefined && value !== null && value !== ''
}

function formatProviderSnippetBlock(snippet: string): string {
  const lines = snippet.split('\n')
  if (lines.length === 1) {
    return `providerSnippet: |\n  ${lines[0]}`
  }
  return `providerSnippet: |\n${lines.map((line) => `  ${line}`).join('\n')}`
}

export function formatDiagnosticCopy(d: GenerationDiagnostic): string {
  const lines = ['lnkpi diagnostic', `code: ${d.code}`, `userMessage: ${d.userMessage}`, `taskKind: ${d.taskKind}`, `taskId: ${d.taskId}`]

  if (isPresent(d.nodeId)) lines.push(`nodeId: ${d.nodeId}`)
  if (isPresent(d.nodeLabel)) lines.push(`nodeLabel: ${d.nodeLabel}`)
  if (isPresent(d.sessionId)) lines.push(`sessionId: ${d.sessionId}`)
  if (isPresent(d.model)) lines.push(`model: ${d.model}`)
  if (isPresent(d.channelId)) lines.push(`channelId: ${d.channelId}`)
  if (isPresent(d.apiFormat)) lines.push(`apiFormat: ${d.apiFormat}`)
  if (isPresent(d.httpStatus)) lines.push(`httpStatus: ${d.httpStatus}`)
  if (isPresent(d.occurredAt)) lines.push(`occurredAt: ${d.occurredAt}`)
  if (isPresent(d.hint)) lines.push(`hint: ${d.hint}`)
  // S2-3 退款行（缺字段不渲染；refundedPoints ≤ 0 视为无退款语义）：
  // `refund: charged 5 → refunded 5 (platform_failed)`；chargedPoints 缺失时省略 charged 段。
  if (typeof d.refundedPoints === 'number' && d.refundedPoints > 0) {
    const chargedPart = typeof d.chargedPoints === 'number' ? `charged ${d.chargedPoints} → ` : ''
    const reasonPart = d.refundReason ? ` (${d.refundReason})` : ''
    lines.push(`refund: ${chargedPart}refunded ${d.refundedPoints}${reasonPart}`)
  }

  if (d.providerSnippet != null && d.providerSnippet !== '') {
    lines.push(formatProviderSnippetBlock(d.providerSnippet))
  }

  return lines.join('\n')
}

/**
 * 队列满形态正则（2026-11-28 生产取证的两种字面形态）：
 * - agnes 上游 JSON：`{"code":"video_queue_full","message":"video queue is full, ..."}`
 * - 裸文案：`video queue is full, please retry later` / `video_queue_full`
 * SSOT：mapMessageToErrorCode（→rate_limited）与 server 侧延迟重提判定共用同一正则。
 */
export const VIDEO_QUEUE_FULL_MESSAGE_RE = /video[_ ]queue[_ ]full|video queue is full/i

export function isVideoQueueFullMessage(text: string): boolean {
  return VIDEO_QUEUE_FULL_MESSAGE_RE.test(text)
}

/** 错误对象形态的谓词（server 侧 completeVideo 重提判定入口）。 */
export function isVideoQueueFullError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return isVideoQueueFullMessage(msg)
}

export function mapMessageToErrorCode(message: string): ErrorCode {
  const text = message.trim()
  if (!text) return 'unknown'

  if (text.includes('积分不足')) return 'insufficient_points'
  if (/timeout/i.test(text) || text.includes('ETIMEDOUT')) return 'upstream_timeout'
  // 限流（2026-10-12 信号层 P1 配套工单，spec §6）：此前 429 全落 unknown ⇒ pi-runtime
  // 信号层只能 hedge。归类 rate_limited 后错误文本含 "rate_limited"，vendor 分类器
  // （RETRYABLE_PROVIDER_ERROR_PATTERN 的 "rate.?limit"）自动判 retryable:true → 退避提示。
  // ⚠️ 排在 timeout 之后：'timeout waiting, then 429' 混合文本保持既有 upstream_timeout
  // 分类不变（vendor 看全文仍判可重试，行为不受影响）。
  // 2026-11-28 生产取证：agnes-video-2.5-flash 近 30 天 15 次 503 队列满
  // （`{"code":"video_queue_full","message":"video queue is full, please retry later"}`）
  // 全落 unknown ⇒ UI 与信号层都看不到可重试信号。队列满本质是上游容量限流，
  // 复用 rate_limited（UI 文案 / vendor 分类器 / hint 均已接好），不新增错误码。
  // ⚠️ 排在 timeout 之后：混合文本保持既有 upstream_timeout 分类不变。
  if (/\b429\b|rate.?limit|too many requests/i.test(text) || isVideoQueueFullMessage(text)) {
    return 'rate_limited'
  }
  // 分发渠道无可用渠道（2026-10-09 生产 503 model_not_found 事故）：\b 防止误伤 model_not_found_x 类近似串
  if (/model_not_found\b|No available channel/i.test(text)) return 'model_unavailable'
  if (text.includes('已取消')) return 'cancelled'
  if (text.includes('参考图尚未上传')) return 'upload_required'
  if (text.includes('模型') && text.includes('停用')) return 'model_unavailable'
  // 参数类 4xx（2026-11-28 生产取证：会话 cmx05m9d2 的 23 张图全失败于
  // `Image API 400: n must be 1`（type/code 均为 invalid_request），却全落 unknown）。
  // 排在限流/超时/无可用渠道之后：这些更早的规则语义更强，不被参数类抢走。
  // ⚠️ 只认明确的 invalid_request 字面量或 n must be 1，普通 400 仍保持 unknown。
  if (/\binvalid_request\b/i.test(text) || /n must be 1/i.test(text)) return 'invalid_input'

  return 'unknown'
}

/**
 * 把上游 provider 的常见「账户/网络」失败翻译成用户能看懂的中文提示。
 * 未命中返回 undefined，调用方回落到原有文案。
 * 已知线上实例（2026-09-26）：
 * - fal.ai 欠费锁定：`Segment API 403: {"detail":"User is locked. Reason: TOP_UP."}`
 * - apimart 欠费：`Image edit API 402: ... insufficient balance (current: 0.013570 USD, required: 0.050000 USD)`
 * - CVM DNS 污染：`fetch failed`（undici UND_ERR_CONNECT_TIMEOUT）
 * - 分发渠道无可用渠道（2026-10-09）：`Text API 503: {"error":{"code":"model_not_found",...}}`
 */
export function translateUpstreamFailure(message: string): string | undefined {
  const text = message.trim()
  if (!text) return undefined

  if (/\b402\b/.test(text) || /insufficient balance|余额不足|欠费/i.test(text)) {
    return '上游生成服务余额不足，请联系管理员充值后重试'
  }
  if (/\b403\b/.test(text) && /locked|top_up/i.test(text)) {
    return '上游生成服务账户已被锁定（欠费），请联系管理员充值后重试'
  }
  if (/\b401\b/.test(text) || /unauthorized|invalid api key/i.test(text)) {
    return '上游生成服务鉴权失败，请检查服务配置'
  }
  if (/fetch failed|UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return '无法连接上游生成服务（网络异常），请稍后重试'
  }
  if (/\b429\b/.test(text) || /rate limit|too many requests/i.test(text)) {
    return '上游生成服务限流，请稍后重试'
  }
  // 与 mapMessageToErrorCode 的 model_unavailable 规则同字面量族（\b 防止误伤 model_not_found_x）
  if (/model_not_found\b|No available channel/i.test(text)) {
    return '平台暂未开通该模型（上游无可用渠道），请换个模型或联系管理员'
  }
  // 参数类 4xx（与 mapMessageToErrorCode 的 invalid_input 规则同字面量族）：
  // 主要是 agnes-image 的 `n must be 1` —— 用户可见文案要说明是模型张数限制，
  // 而不是把上游技术原文直接抛给用户。
  if (/\binvalid_request\b/i.test(text) || /n must be 1/i.test(text)) {
    return '生成参数不被该模型支持（如一次只能生成 1 张），请按模型限制调整后重试'
  }
  return undefined
}