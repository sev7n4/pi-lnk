import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import {
  decodeChannelModel,
  readPlatformCredentialEnv,
  resolveUpstreamRoute,
  type ApiCallFormat,
  type ModelCapability,
  type PlatformCredentialEnv,
  type UpstreamId,
} from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'
import { CryptoService } from './crypto.service'
import { PLATFORM_CHANNEL_ID } from './provider.service'
import { currentUpstreamRoutes } from './upstream-route-store'

export type ResolvedGenerationProvider = {
  channelId: string
  modelName: string
  apiFormat: ApiCallFormat
  credentials: { apiKey?: string; baseUrl: string }
  source: 'user' | 'platform'
}

/**
 * env 名 → 既有 credential 读取器（readPlatformCredentialEnv）字段的穷举映射。
 * S2-2b 后 RouteResult 只回 `apiKeyEnvName`（env 变量名，绝不回密钥值）；
 * 密钥值一律从这里取——映射表穷举 UPSTREAM_REGISTRY 全部 env 名，
 * 未知名返回空串（缺 key 显式失败，绝不静默回落）。
 */
function readCredentialEnvValue(envName: string, vars: Required<PlatformCredentialEnv>): string {
  switch (envName) {
    case 'OPENAI_API_KEY':
      return vars.openaiApiKey
    case 'APIMART_API_KEY':
      return vars.apimartApiKey
    case 'STEPFUN_API_KEY':
      return vars.stepfunApiKey
    case 'MINIMAX_API_KEY':
      return vars.minimaxApiKey
    case 'FAL_KEY':
      return vars.falApiKey
    default:
      return ''
  }
}

/**
 * 上游 → baseUrl：agnes_hub 运行时决定（env OPENAI_BASE_URL > DB 渠道快照）；
 * 其余上游既有读取器已编码「env 覆盖 > 静态缺省」（缺省值与 UPSTREAM_REGISTRY 一致）。
 */
function baseUrlForUpstream(
  upstream: UpstreamId,
  channel: { baseUrl: string } | null,
  vars: Required<PlatformCredentialEnv>,
): string {
  switch (upstream) {
    case 'agnes_hub':
      return process.env.OPENAI_BASE_URL?.trim() || channel?.baseUrl || ''
    case 'apimart':
      return vars.apimartBaseUrl
    case 'fal':
      return vars.falBaseUrl
    case 'minimax':
      return vars.minimaxBaseUrl
    case 'stepfun':
      return vars.stepfunBaseUrl
  }
}

@Injectable()
export class ProviderResolverService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
  ) {}

  /**
   * Resolve channel credentials for a generation request.
   * - Bare / undecodable model values → platform + legacy modelName
   * - User channel without apiKey → still returns source:'user' (caller may fail into fallback_pending)
   */
  async resolveForGeneration(
    userId: string,
    modelValue: string | undefined,
    modality: ModelCapability,
  ): Promise<ResolvedGenerationProvider> {
    const decoded = modelValue ? decodeChannelModel(modelValue) : null
    const channelId = decoded?.channelId ?? PLATFORM_CHANNEL_ID
    let modelName = decoded?.modelName ?? (modelValue ?? '')
    // 平台文本通道缺省 modelName 时中心化回落 OPENAI_CHAT_MODEL，
    // 避免各调用点拿到空串（曾导致识图白名单 supportsVisionTextModel('') 恒 false）。
    if (channelId === PLATFORM_CHANNEL_ID && modality === 'text' && !modelName.trim()) {
      modelName = process.env.OPENAI_CHAT_MODEL?.trim() || modelName
    }

    if (channelId === PLATFORM_CHANNEL_ID) {
      const channel = await this.prisma.providerChannel.findUnique({
        where: { id: PLATFORM_CHANNEL_ID },
      })
      // S2-2b：路由判定查表（UpstreamRoute DB 真源，经 5s TTL 缓存 + 运营写端点显式刷新）。
      // 未命中且无可用 default 行 → resolveUpstreamRoute 确定性抛错（A3：绝不静默回落
      // OpenAI 链，把 platformCredentials 注释级防护升级为类型级）。
      const route = resolveUpstreamRoute(currentUpstreamRoutes(), modelName, modality)
      const vars = readPlatformCredentialEnv()
      // 密钥：主 env 缺失时按命中行的 fallbackApiKeyEnvName 回落（apimart →
      // OPENAI_API_KEY，legacy resolveApimartPlatformCredentials 的 || 链语义）。
      // 缺 key 不改路由：baseUrl 仍指向命中的上游（StepFun 既有语义：绝不因缺 key
      // 静默错路由到 OpenAI；显式失败由下游调用方负责，文案含「未配置」）。
      const primaryKey = readCredentialEnvValue(route.apiKeyEnvName, vars)
      const fallbackKey = route.fallbackApiKeyEnvName
        ? readCredentialEnvValue(route.fallbackApiKeyEnvName, vars)
        : ''
      return {
        channelId: PLATFORM_CHANNEL_ID,
        modelName,
        apiFormat: (channel?.apiFormat as ApiCallFormat) ?? 'openai',
        credentials: {
          apiKey: primaryKey || fallbackKey || undefined,
          baseUrl: baseUrlForUpstream(route.upstream, channel, vars),
        },
        source: 'platform',
      }
    }

    const channel = await this.prisma.providerChannel.findUnique({
      where: { id: channelId },
    })
    if (!channel || channel.userId !== userId) {
      throw new NotFoundException('channel not found')
    }

    let apiKey: string | undefined
    if (channel.encryptedApiKey && channel.iv && channel.authTag) {
      apiKey = this.crypto.decrypt({
        ciphertext: channel.encryptedApiKey,
        iv: channel.iv,
        authTag: channel.authTag,
        keyVersion: channel.keyVersion,
      })
    }

    return {
      channelId,
      modelName,
      apiFormat: channel.apiFormat as ApiCallFormat,
      credentials: { apiKey, baseUrl: channel.baseUrl },
      source: 'user',
    }
  }
}
