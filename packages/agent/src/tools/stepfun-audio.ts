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

export interface StepFunMusicInput {
  caption: string
  lyrics?: string
  instrumental?: boolean
  temperature?: number
  topK?: number
  responseFormat?: string
}

export type MusicQueryResult =
  | { status: 'RUNNING' }
  | { status: 'SUCCESS'; buffer: Buffer }
  | { status: 'FAILED'; error: string }

/**
 * 音乐是**异步任务**形态：`submit` 拿 task_id → 轮询 `query` → 终态取音频字节。
 * 与 design 的同步单次 POST 不同，这里必须有超时上限，否则上游卡住会把调用方
 * （服务端后台任务 / pi 工具）一起挂住。
 */
export class StepFunMusicProvider {
  constructor(
    private apiKey: string,
    private baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private headers() {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` }
  }

  async submit(input: StepFunMusicInput): Promise<{ taskId: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/audio/music/submit`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        task: 'text_to_music',
        // ⚠️ 上游字段名是 model_id，写 model 会被当成未知字段忽略 ⇒ 静默用默认模型。
        model_id: 'stepaudio-3-music-preview',
        caption: input.caption,
        ...(input.lyrics ? { lyrics: input.lyrics } : {}),
        ...(input.instrumental != null ? { instrumental: input.instrumental } : {}),
        ...(input.temperature != null ? { temperature: input.temperature } : {}),
        ...(input.topK != null ? { top_k: input.topK } : {}),
        response_format: input.responseFormat ?? 'mp3',
      }),
    })
    if (!res.ok) throw new Error(`StepFun music/submit ${res.status}: ${await res.text()}`)
    const body = (await res.json()) as { task_id?: string }
    if (!body.task_id) {
      throw new Error(
        `StepFun music/submit 未返回 task_id：${JSON.stringify(body).slice(0, 200)}`,
      )
    }
    return { taskId: body.task_id }
  }

  /** ⚠️ FAILED 时 HTTP 仍是 200 ⇒ 必须读 status 字段，不能只看 HTTP 码。 */
  async query(taskId: string): Promise<MusicQueryResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/audio/music/query`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ task_id: taskId }),
    })
    if (!res.ok) throw new Error(`StepFun music/query ${res.status}: ${await res.text()}`)
    const body = (await res.json()) as {
      status?: string
      audio?: string
      error?: unknown
    }
    const status = (body.status ?? '').toUpperCase()
    if (status === 'SUCCESS') {
      return { status: 'SUCCESS', buffer: Buffer.from(body.audio ?? '', 'base64') }
    }
    if (status === 'FAILED') {
      const detail =
        typeof body.error === 'object' && body.error && 'message' in body.error
          ? String((body.error as { message?: unknown }).message ?? '')
          : JSON.stringify(body.error ?? body).slice(0, 200)
      return { status: 'FAILED', error: detail }
    }
    return { status: 'RUNNING' }
  }

  async generate(
    input: StepFunMusicInput,
    opts: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<{ buffer: Buffer }> {
    const intervalMs = opts.intervalMs ?? 5_000
    const timeoutMs = opts.timeoutMs ?? 300_000 // 官方 1–3 分钟，留 5 分钟上限
    const { taskId } = await this.submit(input)

    const deadline = Date.now() + timeoutMs
    for (;;) {
      const r = await this.query(taskId)
      if (r.status === 'SUCCESS') return { buffer: r.buffer }
      if (r.status === 'FAILED') throw new Error(`music task FAILED: ${r.error}`)
      if (Date.now() >= deadline) {
        //措辞用「仍在生成中」而非「仍在进行」：超时是「上游还在跑、不是失败」，
        // 这条文案会经 audioFailureMessage 直接显示给用户，必须一眼能判读。
        throw new Error(
          `音乐仍在生成中（task_id=${taskId}），已等待 ${Math.round(timeoutMs / 1000)}s`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
}
