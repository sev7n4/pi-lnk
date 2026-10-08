import { BadRequestException } from '@nestjs/common'
import {
  audioKindOf,
  getModelEntry,
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

/**
 * 调用方声明的 `kind` 必须与**模型目录里的分类**一致，否则显式拒绝（Ruling R12）。
 *
 * 🔴 为什么必须有这条守卫：`generateAudio` 的分支由 `audioKindOf(resolved.modelName)` 驱动，
 * **不读** `options.kind`。所以 agent 传 `kind:'music'` 而节点 `audioModel` 仍是 TTS 时，
 * 旧行为是静默出一段 TTS 并把记录标 completed —— 调用方拿到「成功」，却不是要的东西
 * （违反计划全局约束「禁止静默回退：不可用必须显式可判读」）。
 *
 * - `kind` 缺省（undefined）⇒ 放行。存量调用（web 存量、agent 未声明分类）行为逐字节不变。
 * - `voice` **也参与校验**：否则「拿 design 模型当 TTS 用」这条错配仍然静默。
 * - 非法值（`'MUSIC'` / 空串 / 非三分类）天然与目录 kind 不一致 ⇒ 在此一并被拒，
 *   不需要另一套枚举校验（`audioKindOf` 是缺省值唯一判据处，判定只走它）。
 * - 目录外模型按 `audioKindOf` 的缺省（voice）判定 —— 与 `generateAudio` 的 kind 派生同源，
 *   不会出现「守卫说 voice、实际分支按 music」的分叉。
 */
export function assertAudioKindMatchesModel(kind: string | undefined, modelName: string): void {
  if (kind === undefined) return
  const modelKind: AudioKind = audioKindOf(getModelEntry(modelName) ?? { modality: 'audio' })
  if (kind === modelKind) return
  throw new BadRequestException(
    `音频分类与当前模型不匹配：请求 ${KIND_LABEL[kind as AudioKind] ?? kind}（kind=${kind}），` +
      `但模型 ${modelName || '(空)'} 属于 ${KIND_LABEL[modelKind]}分类。` +
      `请把节点的音频模型改成${KIND_LABEL[kind as AudioKind] ?? kind}分类的模型，或把 kind 改成 ${modelKind}。`,
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
