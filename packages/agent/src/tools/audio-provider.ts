import { upstreamFetch } from './upstream-fetch'

export interface AudioGenerateOptions {
  model?: string
  voice?: string
  speed?: number
  volume?: number
  pitch?: number
  emotion?: string
  /** StepFun 的自然语言演绎指导（`instruction`）。不进入朗读内容。 */
  instruction?: string
}

export interface AudioProvider {
  generate(text: string, voiceOrOpts?: string | AudioGenerateOptions): Promise<{ url: string }>
}

function resolveAudioOptions(voiceOrOpts?: string | AudioGenerateOptions): AudioGenerateOptions {
  if (typeof voiceOrOpts === 'string') return { voice: voiceOrOpts }
  return voiceOrOpts ?? {}
}

/**
 * 单次请求的文本上限（字符）。
 *
 * ⚠️ **各上游不同，且超限是 400 硬错**：OpenAI 兼容端点普遍收 4096，
 * 而 StepFun 官方文档明确 `input` **最大 1000 字符**（超出直接报错，不是截断）。
 * 未知模型按 4096 保守处理。
 */
function inputLimitFor(model: string): number {
  // ⚠️ 别写成 /^step(tts|audio)-/：那样只匹配 `stepaudio-*`，**漏掉全部 `step-tts-*`**
  // （`step` 之后没有分隔符，`tts` 分支匹配不上）⇒ 最便宜那档静默退回 4096，
  // 上游按 400 拒掉。判据是「StepFun 家族」：step-tts-* / stepaudio-* / step-*-vivid。
  return /^step[-_]?/i.test(model) ? 1000 : 4096
}

/**
 * 按句末标点把文本切成 ≤ limit 的片段。
 *
 * 为何要切：StepFun 硬限 1000 字符。直接 `slice(0, 1000)` 会**静默截断台词**
 * （用户听到 half 一句，且无任何报错）—— 与 U1 那类静默降级同罪。
 * 切分后逐片请求再拼接音频，代价是多几次往返，收益是台词完整。
 *
 * 切点优先落在句末标点（。！？!?；;，,、换行），找不到就在硬边界切开，
 * 保证**每片长度都 ≤ limit**（这是上游的硬约束，优先于标点美观）。
 */
export function splitTextForTts(text: string, limit: number): string[] {
  const normalized = text.trim()
  if (normalized.length <= limit) return normalized ? [normalized] : []

  const pieces: string[] = []
  let rest = normalized
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    // 从后往前找句末标点；留至少 1/4 的余量，避免标点就贴在开头
    const minCut = Math.floor(limit / 4)
    let cut = -1
    for (let i = window.length - 1; i >= minCut; i--) {
      if ('。！？!?；;，,、\n'.includes(window[i]!)) {
        cut = i + 1
        break
      }
    }
    if (cut <= 0) cut = limit
    pieces.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) pieces.push(rest)
  return pieces
}

export class OpenAITTSProvider implements AudioProvider {
  constructor(
    private apiKey: string,
    private baseUrl = 'https://api.openai.com/v1',
    private model = 'tts-1',
  ) {}

  async generate(text: string, voiceOrOpts?: string | AudioGenerateOptions): Promise<{ url: string }> {
    const options = resolveAudioOptions(voiceOrOpts)
    const model = options.model ?? this.model
    const chunks = splitTextForTts(text, inputLimitFor(model))
    if (chunks.length === 0) throw new Error('TTS 输入为空')

    const buffers: Buffer[] = []
    for (const chunk of chunks) {
      buffers.push(await this.speak(chunk, model, options))
    }
    const base64 = Buffer.concat(buffers).toString('base64')
    return { url: `data:audio/mpeg;base64,${base64}` }
  }

  /** 单次上游调用。失败一律抛出（不吞、不兜底占位音频）。 */
  private async speak(
    input: string,
    model: string,
    options: AudioGenerateOptions,
  ): Promise<Buffer> {
    const res = await upstreamFetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input,
        voice: options.voice ?? 'alloy',
        speed: options.speed,
        ...(options.volume != null ? { volume: options.volume } : {}),
        ...(options.pitch != null ? { pitch: options.pitch } : {}),
        ...(options.emotion ? { emotion: options.emotion } : {}),
        ...(options.instruction ? { instruction: options.instruction } : {}),
      }),
    })
    if (!res.ok) throw new Error(`TTS API ${res.status}: ${await res.text()}`)
    return Buffer.from(await res.arrayBuffer())
  }
}

export type ProviderCredentialOpts = { apiKey?: string; baseUrl?: string; model?: string }

/**
 * 构造音频 provider。**契约（2026-10-04 起）**：无凭据时抛错，上游失败时 `generate()` reject。
 *
 * ⚠️ 不要在此处重新引入「失败后返回占位音频」的兜底。生产曾因此产生 18/18 条
 * `soundhelix.com` 示例曲的假成功记录：`hasTtsData` 全false、扣费 18 笔退款 0 笔，
 * 而 Agnes 网关的 `/v1/audio/speech` 实测四个候选模型全 503 `model_not_found`。
 * 失败必须冒泡到 `studio.service` 的 catch，由它退款并写failed 状态。
 */
export function createAudioProvider(opts?: ProviderCredentialOpts): AudioProvider {
  if (opts?.apiKey) {
    return new OpenAITTSProvider(
      opts.apiKey,
      opts.baseUrl ?? 'https://api.openai.com/v1',
      opts.model ?? 'tts-1',
    )
  }
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('音频通道未配置 API Key（OPENAI_API_KEY）')
  return new OpenAITTSProvider(
    key,
    process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    process.env.OPENAI_TTS_MODEL ?? 'tts-1',
  )
}
