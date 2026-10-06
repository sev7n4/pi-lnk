/**
 * 阶跃星辰音频的两条**非 OpenAI 兼容**调用形态。
 * 现有 `audio-provider.ts` 只认 `POST /audio/speech`，接不上这两个端点。
 *
 * ⚠️ 一律返回 `Buffer`（不是 data URL）：design 与 music 的产物体量远超内联阈值
 * （music 实测 2.2MB），调用方必须走对象存储转存。
 */
export interface StepFunDesignInput {
  roles: Array<{ role: string; voice: string }>
  scripts: Array<{ role?: string; text: string }>
  instruction?: string
  responseFormat?: string
}

export class StepFunDesignProvider {
  constructor(
    private apiKey: string,
    private baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async generate(input: StepFunDesignInput): Promise<{ buffer: Buffer; contentType: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/audio/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: 'stepaudio-3-gen-preview',
        task: 'text_to_audio',
        roles: input.roles,
        scripts: input.scripts,
        ...(input.instruction ? { instruction: input.instruction } : {}),
        response_format: input.responseFormat ?? 'mp3',
      }),
    })
    if (!res.ok) throw new Error(`StepFun audio/generate ${res.status}: ${await res.text()}`)

    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    const body = Buffer.from(await res.arrayBuffer())
    // 200 但返回 JSON ⇒ 上游用错误体答复（如 model not found）。当 mp3 存下去会变成
    // 一个「能播但没声音」的坏文件，且无任何报错 —— 必须显式失败。
    if (contentType.includes('application/json')) {
      let detail = body.toString('utf8').slice(0, 300)
      try {
        const parsed = JSON.parse(detail) as { error?: { message?: string } }
        detail = parsed.error?.message ?? detail
      } catch {
        /* 保持原文 */
      }
      throw new Error(`StepFun audio/generate 返回 JSON 而非音频：${detail}`)
    }
    return { buffer: body, contentType }
  }
}
