import { buildImageEditRequest, buildSyncImageEditRequestBody } from '../studio/edit-adapter'
import { extractApimartTaskId, pollApimartImageTask } from './apimart-image-task'
import { withUpstreamRetry } from './upstream-retry'

export interface ImageEditInput {
  userPrompt: string
  imageUrl: string
  maskUrl: string
  /** 替换参考图：追加进 image_urls（蒙版作用于首图）。 */
  referenceImageUrls?: string[]
  modelId?: string
  /** openai_sync wire 用：显式像素尺寸（如 1024x1024），'auto' 部分上游会 500。 */
  size?: string
  pollIntervalMs?: number
  maxPollMs?: number
}

export interface ImageEditProvider {
  edit(input: ImageEditInput): Promise<{ url: string }>
}

export class ApimartImageEditProvider implements ImageEditProvider {
  constructor(
    private apiKey: string,
    private baseUrl = 'https://api.apimart.ai/v1',
    private model?: string,
    /**
     * 创建阶段退避基数（ms）。生产默认 1500；测试注入 1。
     * ⚠️ U9 新增 —— 生产 image_edit 77 条成功率仅 11.7%，其中 31 条是
     * `fetch failed`（纯网络抖动），此前**零重试**全部直接判失败。
     */
    private createRetryBaseDelayMs = 1500,
  ) {}

  private retryHook(tag: string, attempt: number, delayMs: number, error: unknown) {
    console.warn(
      `[${tag}] edit failed (attempt ${attempt}), retrying in ${delayMs}ms:`,
      error,
    )
  }

  async edit(input: ImageEditInput): Promise<{ url: string }> {
    const built = buildImageEditRequest({
      userPrompt: input.userPrompt,
      imageUrl: input.imageUrl,
      maskUrl: input.maskUrl,
      referenceImageUrls: input.referenceImageUrls,
    })
    const body: Record<string, unknown> = { ...built.body }
    if (input.modelId) body.model = input.modelId
    else if (this.model) body.model = this.model

    const root = this.baseUrl.replace(/\/$/, '')
    // ⚠️ U9：`fetch` 对 4xx/5xx 是**正常返回**（`ok: false`）不抛异常 ⇒
    // 必须在 `!res.ok` 显式 throw，`withUpstreamRetry` 才有介入机会。
    const res = await withUpstreamRetry(
      async () => {
        const r = await fetch(`${root}/images/generations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        })
        if (!r.ok) throw new Error(`Image edit API ${r.status}: ${await r.text()}`)
        return r
      },
      {
        baseDelayMs: this.createRetryBaseDelayMs,
        onRetry: ({ attempt, delayMs, error }) =>
          this.retryHook('ApimartImageEditProvider', attempt, delayMs, error),
      },
    )
    const json = await res.json()
    const taskId = extractApimartTaskId(json)
    if (!taskId) {
      throw new Error(`Image edit API async response missing task_id: ${JSON.stringify(json)}`)
    }
    const urls = await pollApimartImageTask({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      taskId,
      pollIntervalMs: input.pollIntervalMs,
      maxPollMs: input.maxPollMs,
    })
    if (!urls[0]) throw new Error('Image edit API returned no urls')
    return { url: urls[0] }
  }
}

/**
 * BYOK 同步编辑 provider（openai_sync wire）：OpenAI 兼容 images API，
 * 同步响应直出 data[0].url；兼容部分网关返回 task_id 时回落 apimart 轮询。
 */
export class SyncImageEditProvider implements ImageEditProvider {
  constructor(
    private apiKey: string,
    private baseUrl = 'https://api.openai.com/v1',
    private model?: string,
    /** 创建阶段退避基数（ms）。生产 1500；测试注入 1。⚠️ U9 新增。 */
    private createRetryBaseDelayMs = 1500,
  ) {}

  private retryHook(tag: string, attempt: number, delayMs: number, error: unknown) {
    console.warn(
      `[${tag}] edit failed (attempt ${attempt}), retrying in ${delayMs}ms:`,
      error,
    )
  }

  async edit(input: ImageEditInput): Promise<{ url: string }> {
    const body = buildSyncImageEditRequestBody({
      model: input.modelId || this.model || 'gpt-image-1',
      userPrompt: input.userPrompt,
      imageUrl: input.imageUrl,
      maskUrl: input.maskUrl,
      referenceImageUrls: input.referenceImageUrls,
      size: input.size,
    })
    const root = this.baseUrl.replace(/\/$/, '')
    // ⚠️ U9：同 Apimart —— `!res.ok` 必须显式 throw，否则重试永不触发。
    const res = await withUpstreamRetry(
      async () => {
        const r = await fetch(`${root}/images/generations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        })
        if (!r.ok) throw new Error(`Image edit API ${r.status}: ${await r.text()}`)
        return r
      },
      {
        baseDelayMs: this.createRetryBaseDelayMs,
        onRetry: ({ attempt, delayMs, error }) =>
          this.retryHook('SyncImageEditProvider', attempt, delayMs, error),
      },
    )
    const json = (await res.json()) as {
      data?: Array<{ url?: string }>
      task_id?: string
    }
    const direct = json.data?.[0]?.url
    if (direct) return { url: direct }
    // apimart 网关 task_id 在 data 里；agnes 等直返网关在顶层
    const taskId = extractApimartTaskId(json) ?? json.task_id
    if (taskId) {
      const urls = await pollApimartImageTask({
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        taskId,
        pollIntervalMs: input.pollIntervalMs,
        maxPollMs: input.maxPollMs,
      })
      if (urls[0]) return { url: urls[0] }
    }
    throw new Error(`Image edit API returned no urls: ${JSON.stringify(json).slice(0, 300)}`)
  }
}

export function createImageEditProvider(opts?: {
  apiKey?: string
  baseUrl?: string
  model?: string
  /** 缺省 apimart_mask（平台异步任务协议）；openai_sync 为 BYOK 同步协议。 */
  wire?: 'apimart_mask' | 'openai_sync'
}): ImageEditProvider {
  if (!opts?.apiKey) throw new Error('missing api key')
  if (opts.wire === 'openai_sync') {
    return new SyncImageEditProvider(opts.apiKey, opts.baseUrl, opts.model)
  }
  return new ApimartImageEditProvider(opts.apiKey, opts.baseUrl, opts.model)
}
