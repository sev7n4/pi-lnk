import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
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

/**
 * 平台渠道镜像条目（ProviderChannel.models JSON）：只读所需的最小形状。
 * ⛔ availability 的唯一写入方是 upstream-probe.service（B1 裁定），此处只读过滤。
 */
type MirrorModelEntry = { name?: unknown; availability?: unknown }

/**
 * 解析平台渠道镜像 models JSON（防御式：畸形/缺字段一律返回空数组——availability
 * 校验是「有证据才拒绝」，解析失败不得阻断生成）。
 */
function parseMirrorModels(raw: string | null | undefined): MirrorModelEntry[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as MirrorModelEntry[]) : []
  } catch {
    return []
  }
}

/**
 * S2-3 生成入口模型 availability 校验（防绕过 UI 直发）：
 * 平台镜像条目被探活器灰显（availability === 'unavailable'）→ 400 拒绝。
 * 错误语义：BadRequestException body 携带 `errorCode: 'model_unavailable'`
 * （与 throwGenerationFailure 同形状）；message 命中 S0-2 字面量族
 * （模型+停用 → mapMessageToErrorCode === 'model_unavailable'），使得该错误
 * 沿既有失败落库路径（applyFailureDiagnosticMeta）记录时 errorCode 语义一致。
 * 缺条目 / unknown / 解析失败 → 放行（校验绝不比探活更激进）。
 */
export function assertPlatformModelAvailable(
  mirrorModelsJson: string | null | undefined,
  modelName: string,
): void {
  const entry = parseMirrorModels(mirrorModelsJson).find((m) => m.name === modelName)
  if (entry?.availability !== 'unavailable') return
  throw new BadRequestException({
    message: `模型「${modelName}」已停用，请更换可用模型后重试`,
    errorCode: 'model_unavailable',
  })
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
      // S2-3：生成入口模型 availability 校验（单点覆盖 studio/material/agent 三条
      // 生成链路——它们全部经由本方法 resolve 平台模型；探活灰显的模型在此拒绝，
      // 不再放行到上游才失败）。
      assertPlatformModelAvailable(channel?.models, modelName)
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
