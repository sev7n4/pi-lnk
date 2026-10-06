import { BadRequestException } from '@nestjs/common'
import {
  isStepFunPlatformModel,
  readPlatformCredentialEnv,
  resolveStepFunPlatformCredentials,
  type AudioKind,
  type PlatformCredentialEnv,
} from '@lnkpi/shared'

const KIND_LABEL: Record<AudioKind, string> = {
  voice: '配音',
  design: '综合音频',
  music: '音乐',
}

/** design / music 只有阶跃提供，别的模型名进来必然是选错了 —— 显式拒绝，不静默换成别的模型。 */
export function assertStepFunAudioModel(kind: AudioKind, modelName: string): void {
  if (kind === 'voice') return
  if (isStepFunPlatformModel(modelName)) return
  throw new BadRequestException(
    `${KIND_LABEL[kind]}分类仅支持阶跃（StepFun）模型，当前模型为 ${modelName || '(空)'}`,
  )
}

export function isPlatformAudioUnavailable(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? '')
  return /\b402\b/.test(text) || /insufficient/i.test(text)
}

/** 「不可用必须显式可判读」——三类失败各给可操作的文案，不复用泛化的 500。 */
export function audioFailureMessage(kind: AudioKind, err: unknown, channelId: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const platform = channelId === 'platform'

  if (/missing api key/i.test(raw) && platform && kind !== 'voice') {
    return `${KIND_LABEL[kind]}通道未配置平台密钥（STEPFUN_API_KEY），请改用自己的阶跃渠道或联系管理员`
  }
  if (isPlatformAudioUnavailable(err) && platform) {
    return `平台音频额度不足（上游 402），请稍后重试或改用自己的阶跃渠道`
  }
  if (kind === 'music') return `音乐生成失败：${raw}`
  if (kind === 'design') return `综合音频生成失败：${raw}`
  return raw
}

/**
 * 降级重放（`providerFallback` / `channelId:'platform'`）该用哪套凭证。
 *
 * ⚠️ 这里替换掉旧代码的 `createAudioProvider(undefined)` —— 那个调用只认
 * `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_TTS_MODEL`，会把 `stepaudio-3-*`
 * 这类模型名**静默发到 OpenAI 兼容网关**（典型静默错路由，且不报错）。
 *
 * - 阶跃模型 ⇒ 必须用 STEPFUN_* 凭证；缺 key 时**显式拒绝**，不退回 OPENAI_*。
 * - 非阶跃模型 ⇒ 完全沿用旧行为（OPENAI_*），保证存量路径逐字节不变。
 */
export function resolvePlatformAudioFallback(
  modelName: string,
  env?: PlatformCredentialEnv,
): { ok: true; credentials: { apiKey: string; baseUrl?: string } } | { ok: false; reason: string } {
  const sf = resolveStepFunPlatformCredentials(modelName, env)
  if (sf) {
    if (!sf.apiKey) {
      return {
        ok: false,
        reason: `平台音频通道未配置密钥（STEPFUN_API_KEY），无法为 ${modelName} 走平台回退`,
      }
    }
    return { ok: true, credentials: { apiKey: sf.apiKey, baseUrl: sf.baseUrl } }
  }

  const vars = readPlatformCredentialEnv(env)
  if (!vars.openaiApiKey) {
    return {
      ok: false,
      reason: '平台音频通道未配置密钥（OPENAI_API_KEY / STEPFUN_API_KEY）',
    }
  }
  return {
    ok: true,
    credentials: { apiKey: vars.openaiApiKey, baseUrl: vars.openaiBaseUrl || undefined },
  }
}
