// S2-1a：server 端 DB 包装器（同签名同步函数，5s TTL 缓存 + 软删过滤），替换 shared 常量版
import { resolveModelKey } from './model-catalog-store'

/**
 * Chat model used by the refs-merge (chat/completions) call.
 *
 * Non-text generations resolve their own modality model (e.g. a video model),
 * which must never be sent to chat/completions — the gateway rejects it
 * (403 Forbidden) and the whole generation fails. Always merge with a
 * text-capable model instead.
 */
export function mergeChatModel(
  downstreamType: 'text' | 'image' | 'video' | 'audio',
  resolvedModel?: string,
): string | undefined {
  if (downstreamType === 'text' && resolvedModel) return resolvedModel
  return (
    process.env.OPENAI_CHAT_MODEL ||
    resolveModelKey('text', undefined).entry.gatewayModelId
  )
}
