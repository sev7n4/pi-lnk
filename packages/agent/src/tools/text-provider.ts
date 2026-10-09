import { upstreamFetch } from './upstream-fetch'
import { withUpstreamRetry } from './upstream-retry'

export type TextThinkingEffort = 'high' | 'max'

export type TextGenerateOptions = {
  thinking?: boolean
  thinkingEffort?: TextThinkingEffort
}

/**
 * `generate` 的返回值。
 *
 * `retryCount` = **实际重试次数**（首次成功 = 0，重试 1 次后成功 = 1），
 * **不是总尝试数**。口径与 `vision-text.ts` 的 `VisionTextResult.retryCount`
 * 严格一致，两条文本路径的同一字段才能被上层写进同一份账本 metadata。
 */
export interface TextGenerateResult {
  text: string
  retryCount: number
}

export interface TextProvider {
  generate(prompt: string, model?: string, options?: TextGenerateOptions): Promise<TextGenerateResult>
}

/** Match deepseek-v4 family plus official V4.1 Flash id `deepseek-flash`. */
export function isDeepSeekV4Model(model?: string | null): boolean {
  if (!model) return false
  return /deepseek-v4/i.test(model) || /(?:^|[/:])deepseek-flash(?:[-./]|$)/i.test(model)
}

/** Extra chat.completions fields for DeepSeek V4 thinking control. */
export function buildDeepSeekThinkingFields(
  options?: TextGenerateOptions,
): Record<string, unknown> {
  if (!options?.thinking) {
    return { thinking: { type: 'disabled' } }
  }
  const effort = options.thinkingEffort === 'max' ? 'max' : 'high'
  return {
    thinking: { type: 'enabled' },
    reasoning_effort: effort,
  }
}

export class PlaceholderTextProvider implements TextProvider {
  async generate(prompt: string): Promise<TextGenerateResult> {
    return {
      text: `【AI 创作草案】\n\n基于「${prompt}」的扩写：\n\n场景一：主角站在霓虹闪烁的街头，雨水倒映着城市的灯光。\n\n场景二：镜头缓缓推进，揭示隐藏在阴影中的秘密。\n\n（配置 OPENAI_API_KEY 后可获得真实 LLM 输出）`,
      retryCount: 0,
    }
  }
}

export class OpenAITextProvider implements TextProvider {
  constructor(
    private apiKey: string,
    private baseUrl = 'https://api.openai.com/v1',
    private model = 'gpt-4o',
  ) {}

  async generate(prompt: string, model?: string, options?: TextGenerateOptions): Promise<TextGenerateResult> {
    const resolvedModel = model ?? this.model
    const body: Record<string, unknown> = {
      model: resolvedModel,
      stream: false,
      messages: [
        { role: 'system', content: '你是专业 AI 创作助手，擅长脚本、旁白与分镜描述。用中文回复，结构清晰。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.8,
    }
    if (isDeepSeekV4Model(resolvedModel)) {
      Object.assign(body, buildDeepSeekThinkingFields(options))
    }

    let retryCount = 0
    const res = await withUpstreamRetry(
      async () => {
        const r = await upstreamFetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        })
        // ⛔ 纪律：throw 必须在 withUpstreamRetry 回调**内部**。`fetch` 对 4xx/5xx
        // 是正常返回（`ok: false`）而不抛异常，throw 移到回调外则 429/503
        // 永远不会触发重试（见 `upstream-retry.ts` 文件头）。
        if (!r.ok) throw new Error(`Text API ${r.status}: ${await r.text()}`)
        return r
      },
      {
        attempts: 3,
        baseDelayMs: 1500,
        onRetry: () => {
          retryCount += 1
        },
      },
    )
    const json = await res.json() as { choices: Array<{ message: { content: string } }> }
    return { text: json.choices[0]?.message?.content ?? '', retryCount }
  }
}

export type ProviderCredentialOpts = { apiKey?: string; baseUrl?: string; model?: string }

export function createTextProvider(opts?: ProviderCredentialOpts): TextProvider {
  if (opts?.apiKey) {
    return new OpenAITextProvider(opts.apiKey, opts.baseUrl, opts.model)
  }
  const key = process.env.OPENAI_API_KEY
  if (key) {
    return new OpenAITextProvider(key, process.env.OPENAI_BASE_URL, process.env.OPENAI_CHAT_MODEL)
  }
  return new PlaceholderTextProvider()
}
