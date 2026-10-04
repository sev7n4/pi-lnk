export interface AudioGenerateOptions {
  model?: string
  voice?: string
  speed?: number
  volume?: number
  pitch?: number
  emotion?: string
}

export interface AudioProvider {
  generate(text: string, voiceOrOpts?: string | AudioGenerateOptions): Promise<{ url: string }>
}

function resolveAudioOptions(voiceOrOpts?: string | AudioGenerateOptions): AudioGenerateOptions {
  if (typeof voiceOrOpts === 'string') return { voice: voiceOrOpts }
  return voiceOrOpts ?? {}
}

export class OpenAITTSProvider implements AudioProvider {
  constructor(
    private apiKey: string,
    private baseUrl = 'https://api.openai.com/v1',
    private model = 'tts-1',
  ) {}

  async generate(text: string, voiceOrOpts?: string | AudioGenerateOptions): Promise<{ url: string }> {
    const options = resolveAudioOptions(voiceOrOpts)
    const res = await fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model ?? this.model,
        input: text.slice(0, 4096),
        voice: options.voice ?? 'alloy',
        speed: options.speed,
        ...(options.volume != null ? { volume: options.volume } : {}),
        ...(options.pitch != null ? { pitch: options.pitch } : {}),
        ...(options.emotion ? { emotion: options.emotion } : {}),
      }),
    })
    if (!res.ok) throw new Error(`TTS API ${res.status}: ${await res.text()}`)
    const buffer = await res.arrayBuffer()
    const base64 = Buffer.from(buffer).toString('base64')
    return { url: `data:audio/mpeg;base64,${base64}` }
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
