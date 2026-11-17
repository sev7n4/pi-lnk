export function apiErrorMessage(err: unknown, fallback = '请求失败'): string {
  const ax = err as {
    response?: { data?: { message?: string | string[]; error?: string } }
    message?: string
  }
  const msg = ax.response?.data?.message ?? ax.response?.data?.error ?? ax.message
  if (Array.isArray(msg)) return msg.join('; ') || fallback
  if (typeof msg === 'string' && msg.trim()) return msg
  return fallback
}

export type AssistantErrorKind = 'rate_limit' | 'model_not_found' | 'generic'

export interface FriendlyAssistantError {
  text: string
  kind: AssistantErrorKind
}

/** U-3（2026-11-17 E2E）：assistant error message 原以原始 JSON dump 直出对话流
 * （含 request id 全文），用户无法读懂。识别高频可解释错误并给出人话文案；
 * 未知错误保持原文透传（generic），不破坏现有未见过的错误呈现。 */
export function friendlyAssistantError(raw: string): FriendlyAssistantError {
  const s = typeof raw === 'string' ? raw : ''
  if (!s.trim()) return { kind: 'generic', text: s }
  const compact = s.replace(/\s+/g, ' ')
  if (
    /rate limit for free users/i.test(compact)
    || /\b429\b/.test(compact)
    || /rate.?limit/i.test(compact)
  ) {
    return {
      kind: 'rate_limit',
      text: 'AI 服务当前限频，请稍后重试；如持续出现请升级套餐或联系支持。',
    }
  }
  if (/model_not_found|not found for channel|模型不存在/i.test(compact)) {
    return {
      kind: 'model_not_found',
      text: '所选模型在当前渠道不可用，请切换模型后重试。',
    }
  }
  return { kind: 'generic', text: s }
}
