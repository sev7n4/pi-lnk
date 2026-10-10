import type { ProviderResolverService } from './provider-resolver.service'

export type ProviderSource = 'user' | 'platform'

export type ProviderContext = {
  providerRef: string
  model: string
  apiKey: string
  baseUrl: string
  source: ProviderSource
  /**
   * 命中渠道的 models JSON 原文（含可选 pricing）。P1 cost 接线读取面：
   * `resolveChannelModelCost(ctx.channelModelsJson, ctx.model)` → override.cost。
   * 渠道缺省 / 旧调用方未传时缺省 —— 缺省 = 不计费（cost 不下发，行为不变）。
   */
  channelModelsJson?: string
}

/** Map a resolved generation provider into ProviderContext (shared Agent + canvas contract). */
export function providerContextFromResolved(
  providerRef: string,
  resolved: {
    modelName: string
    credentials: { apiKey?: string; baseUrl?: string }
    source: ProviderSource
    channelModelsJson?: string
  },
): ProviderContext {
  const ref = providerRef.trim()
  if (!ref) throw new Error('providerRef required')
  const apiKey = resolved.credentials.apiKey?.trim() ?? ''
  const baseUrl = resolved.credentials.baseUrl?.trim() ?? ''
  if (!apiKey || !baseUrl) {
    throw new Error('ProviderContext incomplete: apiKey and baseUrl required')
  }
  return {
    providerRef: ref,
    model: resolved.modelName,
    apiKey,
    baseUrl,
    source: resolved.source,
    ...(resolved.channelModelsJson ? { channelModelsJson: resolved.channelModelsJson } : {}),
  }
}

export async function buildTextProviderContext(
  resolver: ProviderResolverService,
  userId: string,
  providerRef: string,
): Promise<ProviderContext> {
  const ref = providerRef.trim()
  if (!ref) throw new Error('providerRef required')
  const resolved = await resolver.resolveForGeneration(userId, ref, 'text')
  return providerContextFromResolved(ref, resolved)
}
