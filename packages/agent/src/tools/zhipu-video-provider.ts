import type { VideoGenerateOptions, VideoProvider } from './video-provider'
import { withVideoRetry } from './video-retry'
import { UPSTREAM_POLL_TIMEOUT_MS, upstreamFetch } from './upstream-fetch'
import { createPollErrorTracker, isRetryableUpstreamError } from './upstream-retry'

/**
 * 智谱 BigModel（CogVideoX）异步视频 provider。
 *
 * API 契约（2026-10-10 实测通过，cogvideox-flash 免费档）：
 * - 创建：POST {base}/videos/generations  body {model, prompt, duration?, image_url?, quality?}
 *   → 200 {id, task_status:'PROCESSING'}；429 = 上游并发限流（可退避重试）
 * - 查询：GET {base}/async-result/{id}（⚠️ 官方 SDK retrieve_videos_result 的真实路径，
 *   不是 /videos/generations/{id}——path/query 形态均 404/405）
 *   → {task_status:'SUCCESS'|'FAIL'|'PROCESSING', video_result:[{url, cover_image_url}]}
 *
 * 免费档实测：cogvideox-flash 约 3 分钟出片；/models 列表只含 glm 文本族
 * （不含 cogvideox）——探活条目级 diff 不覆盖本上游（目录 admin 条目不进
 * STUDIO_MODEL_CATALOG 种子），不会误判 ghost。
 */
export const ZHIPU_DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
export const ZHIPU_DEFAULT_MODEL = 'cogvideox-flash'

export function isZhipuVideoModel(model?: string): boolean {
  return /^cogvideox/i.test(model?.trim() ?? '')
}

export function isZhipuBaseUrl(baseUrl?: string): boolean {
  try {
    const host = new URL(baseUrl ?? '').hostname
    return host === 'open.bigmodel.cn' || host === 'api.z.ai'
  } catch {
    return false
  }
}

interface ZhipuCreateResponse {
  id?: string
  task_status?: string
}

interface ZhipuPollResponse {
  task_status?: string
  video_result?: Array<{ url?: string; cover_image_url?: string }>
  error?: { code?: string | number; message?: string }
}

export class ZhipuVideoProvider implements VideoProvider {
  constructor(
    private apiKey: string,
    private baseUrl = ZHIPU_DEFAULT_BASE_URL,
    private defaultModel = ZHIPU_DEFAULT_MODEL,
    private pollIntervalMs = 5000,
    private maxPollAttempts = 100,
    /** 创建阶段退避基数（ms）。测试注入 1 保持快速。 */
    private createRetryBaseDelayMs: number = 2000,
  ) {}

  async generate(
    prompt: string,
    options?: VideoGenerateOptions,
  ): Promise<{ url: string; lastFrameUrl?: string }> {
    const model = options?.model?.trim() || this.defaultModel
    const body: Record<string, unknown> = { model, prompt }
    // 智谱仅支持 5/10 秒；越界值就近夹取。
    const duration = options?.duration
    if (duration) body.duration = duration >= 10 ? 10 : 5
    // 图生视频 / 首尾帧：image_url 支持数组（1 张=i2v，2 张=首尾帧，首帧在前）。
    const imageUrls = [
      ...(options?.imageWithRoles ?? []).map((r) => r.url),
      ...(options?.referenceImages ?? []),
      ...(options?.image ? [options.image] : []),
    ]
      .map((u) => u.trim())
      .filter(Boolean)
      .slice(0, 2)
    if (imageUrls.length > 0) body.image_url = imageUrls
    // negativePrompt / seed / aspectRatio 智谱侧无对应参数，忽略。

    const createRes = await withVideoRetry(
      async () => {
        const res = await upstreamFetch(`${this.baseUrl}/videos/generations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          throw new Error(`Zhipu video create ${res.status}: ${await res.text()}`)
        }
        return res
      },
      {
        baseDelayMs: this.createRetryBaseDelayMs,
        onRetry: ({ attempt, delayMs, error }) => {
          console.warn(
            `[ZhipuVideoProvider] create failed (attempt ${attempt}), retrying in ${delayMs}ms:`,
            error,
          )
        },
      },
    )

    const created = (await createRes.json()) as ZhipuCreateResponse
    const taskId = created.id
    if (!taskId) {
      throw new Error(`Zhipu video create: missing id (${JSON.stringify(created)})`)
    }

    const pollErrors = createPollErrorTracker('ZhipuVideoProvider')
    for (let attempt = 0; attempt < this.maxPollAttempts; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, this.pollIntervalMs))

      let pollRes: Response
      try {
        pollRes = await upstreamFetch(`${this.baseUrl}/async-result/${encodeURIComponent(taskId)}`, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          timeoutMs: UPSTREAM_POLL_TIMEOUT_MS,
        })
      } catch (err) {
        if (isRetryableUpstreamError(err)) continue
        throw err
      }
      if (!pollRes.ok) {
        await pollErrors.recordHttpError(pollRes)
        continue
      }
      pollErrors.reset()

      const result = (await pollRes.json()) as ZhipuPollResponse
      if (result.task_status === 'SUCCESS') {
        const url = result.video_result?.[0]?.url
        if (!url) {
          throw new Error(`Zhipu video SUCCESS without url: ${JSON.stringify(result)}`)
        }
        // ⚠️ video_result[].cover_image_url 是封面海报不是最后一帧，
        // 不冒充 lastFrameUrl（契约语义：调用方依赖 lastFrame 做续生成）。
        return { url }
      }
      if (result.task_status === 'FAIL') {
        throw new Error(`Zhipu video failed: ${JSON.stringify(result.error ?? result)}`)
      }
    }

    throw new Error(`Zhipu video timed out after ${this.maxPollAttempts} polls`)
  }
}
