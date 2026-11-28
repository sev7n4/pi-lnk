/**
 * 上游错误文本识别 SSOT（2026-11-28 三套分类器合并）。
 *
 * 为什么只统一「字面识别」而不统一枚举：
 * - shared 生图侧用 ErrorCode（insufficient_points / invalid_input …）；
 * - server 对话侧用 PiRunErrorKind（insufficient_balance / rate_limit …）；
 * - pi-runtime 工具/LLM 信号侧用 ToolErrorClass（upstream_4xx / timeout …）。
 *
 * 三者面向的 UI / Prometheus label 契约不同，直接合并枚举会造成大范围行为漂移。
 * 因此把**重复的字面正则**收进本模块，各分类器保留自己的优先级与输出枚举，
 * 通过 `matchesProviderPattern` 委托；新代码可直接用 `classifyProviderErrorText`。
 *
 * ⚠️ 与错误分类器一贯纪律一致：只返回闭集分类，绝不把错误原文放进返回值。
 */
export type ProviderErrorKind =
  | 'aborted'
  | 'insufficient_balance'
  | 'auth'
  | 'rate_limit'
  | 'invalid_input'
  | 'context_overflow'
  | 'timeout'
  | 'network'
  | 'model_unavailable'
  | 'validation'

export const PROVIDER_ERROR_PATTERNS: Readonly<Record<ProviderErrorKind, RegExp>> = {
  aborted: /\babort(ed)?\b|取消|中断/i,
  insufficient_balance: /insufficient|余额不足|欠费|积分不足|\b402\b/i,
  auth: /\b40[13]\b|unauthoriz|forbidden|未授权|invalid api key|invalid key/i,
  // `invalid_request` 不带 \b：生产形态是 `invalid_request_error`，词边界会被下划线吃掉。
  rate_limit: /\b429\b|rate.?limit|too many requests|video[_ ]queue[_ ]full|video queue is full/i,
  invalid_input: /invalid_request|json_parse_error|missing field|n must be 1/i,
  context_overflow: /context length|maximum context|token.*exceed/i,
  timeout: /timeout|超时|etimedout/i,
  network: /econnrefused|econnreset|enotfound|fetch failed|und_err_connect_timeout|eai_again|network/i,
  model_unavailable: /model_not_found\b|no available channel|模型.*停用/i,
  validation: /invalid|validation|参数|校验|expected/i,
}

/** 单一字面判定入口；各分类器按自己的优先级挑着用，避免各自复制正则。 */
export function matchesProviderPattern(kind: ProviderErrorKind, text: string): boolean {
  return PROVIDER_ERROR_PATTERNS[kind].test(text)
}

const CANONICAL_PRIORITY: readonly ProviderErrorKind[] = [
  'aborted',
  'insufficient_balance',
  'auth',
  'rate_limit',
  'invalid_input',
  'context_overflow',
  'timeout',
  'network',
  'model_unavailable',
  'validation',
]

/** 新调用方推荐入口：固定优先级返回闭集分类；无命中返回 null（不造分类）。 */
export function classifyProviderErrorText(text: string): ProviderErrorKind | null {
  for (const kind of CANONICAL_PRIORITY) {
    if (matchesProviderPattern(kind, text)) return kind
  }
  return null
}
