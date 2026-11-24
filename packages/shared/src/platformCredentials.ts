import { isApimartBackedImageModel } from './imageModelProfiles'
import { resolveModelKey } from './studioModelCatalog'

export const DEFAULT_APIMART_BASE_URL = 'https://api.apimart.ai/v1'
export const DEFAULT_FAL_BASE_URL = 'https://fal.run'
export const DEFAULT_MINIMAX_BASE_URL = 'https://api.minimax.io'
export const DEFAULT_STEPFUN_BASE_URL = 'https://api.stepfun.com/v1'
export const DEFAULT_ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'

export type PlatformCredentialEnv = {
  apimartApiKey?: string
  apimartBaseUrl?: string
  falApiKey?: string
  falBaseUrl?: string
  openaiApiKey?: string
  openaiBaseUrl?: string
  minimaxApiKey?: string
  minimaxBaseUrl?: string
  stepfunApiKey?: string
  stepfunBaseUrl?: string
  zhipuApiKey?: string
  zhipuBaseUrl?: string
  // VoiceStudio 本地引擎（P1，2026-11-24）：自托管实例，**无云端静态缺省** ——
  // baseUrl 缺省空串：双 env（OMNIVOICE_BASE_URL + OMNIVOICE_API_KEY）任一缺失
  // ⇒ 模型不注册（VOICESTUDIO_MODEL_ENTRY 不并入目录），配 env 即自动启用。
  omnivoiceApiKey?: string
  omnivoiceBaseUrl?: string
}

function readEnv(name: string): string | undefined {
  const env = (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> }
    }
  ).process?.env
  const value = env?.[name]
  return typeof value === 'string' ? value.trim() : undefined
}

export function readPlatformCredentialEnv(
  env: PlatformCredentialEnv = {},
): Required<PlatformCredentialEnv> {
  return {
    apimartApiKey: env.apimartApiKey ?? readEnv('APIMART_API_KEY') ?? '',
    apimartBaseUrl:
      env.apimartBaseUrl ?? readEnv('APIMART_BASE_URL') ?? DEFAULT_APIMART_BASE_URL,
    falApiKey: env.falApiKey ?? readEnv('FAL_KEY') ?? '',
    falBaseUrl: env.falBaseUrl ?? readEnv('FAL_BASE_URL') ?? DEFAULT_FAL_BASE_URL,
    openaiApiKey: env.openaiApiKey ?? readEnv('OPENAI_API_KEY') ?? '',
    openaiBaseUrl: env.openaiBaseUrl ?? readEnv('OPENAI_BASE_URL') ?? '',
    minimaxApiKey: env.minimaxApiKey ?? readEnv('MINIMAX_API_KEY') ?? '',
    minimaxBaseUrl:
      env.minimaxBaseUrl ?? readEnv('MINIMAX_BASE_URL') ?? DEFAULT_MINIMAX_BASE_URL,
    stepfunApiKey: env.stepfunApiKey ?? readEnv('STEPFUN_API_KEY') ?? '',
    stepfunBaseUrl:
      env.stepfunBaseUrl ?? readEnv('STEPFUN_BASE_URL') ?? DEFAULT_STEPFUN_BASE_URL,
    zhipuApiKey: env.zhipuApiKey ?? readEnv('ZHIPU_API_KEY') ?? '',
    zhipuBaseUrl: env.zhipuBaseUrl ?? readEnv('ZHIPU_BASE_URL') ?? DEFAULT_ZHIPU_BASE_URL,
    omnivoiceApiKey: env.omnivoiceApiKey ?? readEnv('OMNIVOICE_API_KEY') ?? '',
    // ⚠️ 缺省空串（非 DEFAULT_*）：VoiceStudio 是自托管实例，地址只来自 env；
    // 空串即「未配置」信号（目录注册判据消费，见 voiceStudioEnvConfigured）。
    omnivoiceBaseUrl: env.omnivoiceBaseUrl ?? readEnv('OMNIVOICE_BASE_URL') ?? '',
  }
}

export function usesApimartImageGateway(modelKey: string): boolean {
  const trimmed = modelKey.trim()
  if (!trimmed) return false
  if (isApimartBackedImageModel(trimmed)) return true
  const { modelKey: resolvedKey, entry } = resolveModelKey('image', trimmed)
  return isApimartBackedImageModel(resolvedKey, entry.gatewayModelId)
}

export function isFalH3MaxPlatformModel(modelName: string): boolean {
  return /h3-max/i.test(modelName)
}

/**
 * VoiceStudio 本地引擎的平台模型判定（P1，2026-11-24）。
 *
 * 与路由种子行（prefix `voicestudio`，大小写不敏感）同义 —— A1 对拍副本
 * （legacyResolveUpstream）与消费方统一走本判定，禁在调用方重写第二份 regex。
 * 前缀（非 exact）匹配：为 P2/P3 的 voicestudio-* 派生模型行（如克隆 profile
 * 模型行）预留，目录当前仅 `voicestudio-local`（VOICESTUDIO_MODEL_KEY）。
 */
export function isVoiceStudioPlatformModel(modelName: string): boolean {
  return /^voicestudio/i.test(modelName.trim())
}

/**
 * VoiceStudio 本地引擎是否已配置（「env 未配置 ⇒ 模型不注册」的唯一判据处，
 * spec §4.1 ⭐）。双 env **齐备**才算配置 —— 半配置（只有 key 或只有地址）按
 * 未配置处理，不给用户半可用的模型。
 */
export function isVoiceStudioEnvConfigured(env?: Pick<PlatformCredentialEnv, 'omnivoiceApiKey' | 'omnivoiceBaseUrl'>): boolean {
  const vars = readPlatformCredentialEnv(env)
  return vars.omnivoiceApiKey !== '' && vars.omnivoiceBaseUrl !== ''
}

export function resolveFalH3MaxPlatformCredentials(
  modelName: string,
  env?: PlatformCredentialEnv,
): { apiKey: string; baseUrl: string } | null {
  if (!isFalH3MaxPlatformModel(modelName)) return null
  const vars = readPlatformCredentialEnv(env)
  return {
    apiKey: vars.falApiKey,
    baseUrl: vars.falBaseUrl || DEFAULT_FAL_BASE_URL,
  }
}

export function isMiniMaxH3PlatformModel(modelName: string): boolean {
  return /^minimax-h3$/i.test(modelName)
}

export function resolveMiniMaxH3PlatformCredentials(
  modelName: string,
  env?: PlatformCredentialEnv,
): { apiKey: string; baseUrl: string } | null {
  if (!isMiniMaxH3PlatformModel(modelName)) return null
  const vars = readPlatformCredentialEnv(env)
  return {
    apiKey: vars.minimaxApiKey,
    baseUrl: vars.minimaxBaseUrl || DEFAULT_MINIMAX_BASE_URL,
  }
}

export function resolveApimartPlatformCredentials(
  modelKey: string,
  env?: PlatformCredentialEnv,
): { apiKey: string; baseUrl: string } | null {
  if (!usesApimartImageGateway(modelKey)) return null
  const vars = readPlatformCredentialEnv(env)
  const apiKey = vars.apimartApiKey || vars.openaiApiKey
  if (!apiKey) return null
  return { apiKey, baseUrl: vars.apimartBaseUrl || DEFAULT_APIMART_BASE_URL }
}

export function resolvePlatformImageProviderOpts(
  modelKey?: string,
  env?: PlatformCredentialEnv,
): { apiKey: string; baseUrl: string } | undefined {
  if (modelKey) {
    const apimart = resolveApimartPlatformCredentials(modelKey, env)
    if (apimart) return apimart
  }
  const vars = readPlatformCredentialEnv(env)
  if (!vars.openaiApiKey) return undefined
  return {
    apiKey: vars.openaiApiKey,
    baseUrl: vars.openaiBaseUrl,
  }
}

/**
 * 阶跃星辰（StepFun）平台模型判别。
 * 覆盖 `step-tts-*` / `stepaudio-*` 两个命名族；与 `/h3-max/i`、`/^minimax-h3$/i` 无交集。
 */
export function isStepFunPlatformModel(modelName: string): boolean {
  return /^step/i.test(modelName.trim())
}

/**
 * ⚠️ 匹配即返回，**绝不因缺 key 返回 null**：
 * 返回 null 会让 `provider-resolver` 落回 `OPENAI_BASE_URL`，把阶跃模型名静默发到 OpenAI
 * （典型静默错路由）。缺 key 的显式失败由调用方（apps/server 音频路径）负责。
 */
export function resolveStepFunPlatformCredentials(
  modelName: string,
  env?: PlatformCredentialEnv,
): { apiKey: string; baseUrl: string } | null {
  if (!isStepFunPlatformModel(modelName)) return null
  const vars = readPlatformCredentialEnv(env)
  return {
    apiKey: vars.stepfunApiKey,
    baseUrl: vars.stepfunBaseUrl || DEFAULT_STEPFUN_BASE_URL,
  }
}
