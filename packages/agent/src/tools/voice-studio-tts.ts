/**
 * VoiceStudio（本地引擎）TTS provider（P1，2026-11-24）。
 *
 * spec: specs/2026-11-24-voicestudio-p1p2-implementation-spec.md §4；上游 = 自托管
 * VoiceStudio v0.5.8（OpenAI 兼容 `/v1/audio/speech`，P0 spike 协议全通）。
 *
 * 与既有 `OpenAITTSProvider`（StepFun/OpenAI 通道）的关系：**继承复用**切分与
 * 拼接骨架（inputLimit 4096 语义同源），仅覆写两处：
 * 1. `generate()` 前置 `/health` 探活 —— 本地引擎不可用必须**显式报错**并指路云端
 *    模型，禁静默换道（soundhelix 教训 + 伪绿纪律）；
 * 2. `speak()` 字段映射 —— VS 的指导字段是 `instructions`（复数），pi-lnk 侧统一
 *    叫 `instruction`（单数）；`emotion`/`volume`/`pitch` 被 VS 静默忽略
 *    （spike 实测）⇒ 一律不发送（emotion 已由目录 `instruction` 处置转为指导文本）。
 */
import {
  boundedFetch,
} from './upstream-fetch'
import { OpenAITTSProvider, type AudioGenerateOptions, type AudioProvider } from './audio-provider'
import { VOICESTUDIO_MODEL_ENTRY } from '@lnkpi/shared'

/** VS speech 单次调用的客户端预算。与部署 runbook 的 `OMNIVOICE_CPU_GENERATE_TIMEOUT_S=600`
 *  对齐：服务端 CPU 生成超时先到 ⇒ 用户拿到 VS 自带的可判读错误；客户端仅在
 *  服务端无响应（挂死/网络断）时兜底掐断（boundedFetch 纪律：上游调用必有界）。 */
export const VOICESTUDIO_SPEAK_TIMEOUT_MS = 600_000

/** 探活超时（spec §4.1：5s）。 */
export const VOICESTUDIO_HEALTH_TIMEOUT_MS = 5_000

/** 探活结果缓存 TTL（spec §4.1：60s）。成功/失败**双向缓存**：失败也缓存，
 *  VS 停机期间后续生成请求快速显式失败，不逐请求空等 5s 超时。 */
export const VOICESTUDIO_HEALTH_TTL_MS = 60_000

/** 探活失败的显式报错文案（spec §4.1 逐字要求：指路云端可切换模型）。 */
export const VOICESTUDIO_UNAVAILABLE_MESSAGE =
  'VoiceStudio 本地引擎不可用：可切换云端模型（Seed / MiniMax / StepFun）后重试'

let voiceStudioHealthCache: { ok: boolean; at: number } | null = null

/** 测试专用：重置探活缓存（模块级状态，vitest isolate per file）。 */
export function __resetVoiceStudioHealthCacheForTests(): void {
  voiceStudioHealthCache = null
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * VoiceStudio `/health` 探活（生成前置门）。
 *
 * - 5s 超时（boundedFetch 单源，不手写 AbortSignal）；
 * - 60s 双向缓存（成功短路直通；失败缓存期间抛同一显式文案，快速失败）；
 * - 失败**只抛错、绝不回退** —— 回退 = 静默换道，违反「不可用必须显式可判读」。
 */
export async function probeVoiceStudioHealth(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const cached = voiceStudioHealthCache
  if (cached && Date.now() - cached.at < VOICESTUDIO_HEALTH_TTL_MS) {
    if (cached.ok) return
    throw new Error(VOICESTUDIO_UNAVAILABLE_MESSAGE)
  }
  let ok = false
  let detail = ''
  try {
    const res = await boundedFetch(fetchImpl, `${trimTrailingSlash(baseUrl)}/health`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeoutMs: VOICESTUDIO_HEALTH_TIMEOUT_MS,
    })
    ok = res.ok
    if (!ok) detail = `HTTP ${res.status}`
  } catch (err) {
    ok = false
    detail = err instanceof Error ? err.message : String(err)
  }
  voiceStudioHealthCache = { ok, at: Date.now() }
  if (!ok) {
    throw new Error(`${VOICESTUDIO_UNAVAILABLE_MESSAGE}${detail ? `（${detail}）` : ''}`)
  }
}

export interface VoiceStudioProviderOpts {
  apiKey?: string
  baseUrl?: string
  /** 上游引擎 id（目录 gatewayModelId）。缺省取 VOICESTUDIO_MODEL_ENTRY（SSOT）。 */
  model?: string
  /** 测试注入缝（StepFun provider 家族同款纪律）。 */
  fetchImpl?: typeof fetch
}

/**
 * 构造 VoiceStudio provider。**契约（2026-10-04 家族契约延续）**：缺凭据抛错、
 * 上游失败时 `generate()` reject —— 失败冒泡到 studio.service catch 退款 + failed，
 * 禁占位音频、禁回退云端。
 */
export function createVoiceStudioAudioProvider(opts: VoiceStudioProviderOpts): AudioProvider {
  if (!opts.apiKey) {
    throw new Error('本地引擎未配置密钥（OMNIVOICE_API_KEY）')
  }
  if (!opts.baseUrl) {
    throw new Error('本地引擎地址未配置（OMNIVOICE_BASE_URL）')
  }
  return new VoiceStudioTTSProvider(opts.apiKey, opts.baseUrl, opts.model ?? VOICESTUDIO_MODEL_ENTRY.gatewayModelId, opts.fetchImpl)
}

export class VoiceStudioTTSProvider extends OpenAITTSProvider implements AudioProvider {
  private readonly fetchImpl: typeof fetch

  constructor(
    apiKey: string,
    baseUrl: string,
    model = VOICESTUDIO_MODEL_ENTRY.gatewayModelId,
    fetchImpl: typeof fetch = fetch,
  ) {
    super(apiKey, baseUrl, model)
    this.fetchImpl = fetchImpl
  }

  /** 生成前置探活：不可用显式报错（文案见 {@link VOICESTUDIO_UNAVAILABLE_MESSAGE}）。 */
  override async generate(text: string, voiceOrOpts?: string | AudioGenerateOptions): Promise<{ url: string }> {
    await probeVoiceStudioHealth(this.baseUrl, this.apiKey, this.fetchImpl)
    return super.generate(text, voiceOrOpts)
  }

  /**
   * VS 字段映射（单→复数改名 + 静默忽略字段不发）：
   * - `instruction` → `instructions`（VS 字段名，spike 实测复数生效、单数被忽略）；
   * - `voice` 缺省 `default`（VS 实测直用；OpenAI 兼容别名都收）；
   * - `speed` 直通；`emotion`/`volume`/`pitch` **不发**（VS 静默忽略，emotion
   *   已在 adapter 层按目录处置转为指导文本）；
   * - `response_format: 'mp3'` 显式锁死 —— 基类按 `data:audio/mpeg` 落 data URL，
   *   上游缺省格式漂移会产出错误 MIME。
   */
  protected override async speak(input: string, model: string, options: AudioGenerateOptions): Promise<Buffer> {
    const res = await boundedFetch(this.fetchImpl, `${trimTrailingSlash(this.baseUrl)}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input,
        voice: options.voice ?? 'default',
        ...(options.speed != null ? { speed: options.speed } : {}),
        ...(options.instruction ? { instructions: options.instruction } : {}),
        response_format: 'mp3',
      }),
      timeoutMs: VOICESTUDIO_SPEAK_TIMEOUT_MS,
    })
    if (!res.ok) throw new Error(`TTS API ${res.status}: ${await res.text()}`)
    return Buffer.from(await res.arrayBuffer())
  }
}
