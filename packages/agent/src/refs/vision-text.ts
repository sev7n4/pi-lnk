import { upstreamFetch } from '../tools/upstream-fetch'
import { withUpstreamRetry } from '../tools/upstream-retry'
import { appendCreationContext } from '../tools/creation-context'
import type { CreationContext } from '../tools/creation-context'

export const ECOMMERCE_VISION_SYSTEM = `你是电商视觉策划专家。根据用户提供的商品参考图与文字需求，输出完整的电商视觉方案，用中文 Markdown，结构清晰。
必须包含：
1. 商品理解（品类、卖点、目标人群）
2. 主图方案（构图、背景、文案位）
3. 详情图方案（卖点分层展示）
4. 细节图方案（材质/工艺特写角度）
5. 模特图方案（场景、姿态、穿搭/展示方式）
禁止只复述用户原句；若用户未写需求，按通用电商最佳实践补全。`

export const DEFAULT_VISION_USER_PROMPT =
  '请根据参考图生成电商主图、详情图、细节图、模特图的完整视觉方案。'

export interface VisionTextOptions {
  apiKey?: string
  baseUrl?: string
  model?: string
  /** G5：创作上下文（选中指代 + 画布摘要），注入 system 末尾。 */
  context?: CreationContext
}

export interface VisionTextResult {
  text: string
  /**
   * 实际重试次数（首次成功 = 0，重试 1 次后成功 = 1）—— **不是总尝试数**。
   * 口径与非 vision 路径（Task 4 补齐真值）保持一致，供上层写进账本 metadata。
   */
  retryCount: number
}

export async function generateTextWithImages(
  prompt: string,
  imageUrls: string[],
  opts: VisionTextOptions = {},
): Promise<VisionTextResult> {
  const urls = imageUrls.map((u) => u.trim()).filter(Boolean)
  if (urls.length === 0) {
    throw new Error('至少提供一张参考图')
  }

  const userText = prompt.trim() || DEFAULT_VISION_USER_PROMPT

  const key = opts.apiKey ?? process.env.OPENAI_API_KEY
  if (!key) {
    throw new Error('vision text credentials missing: set OPENAI_API_KEY or provide a BYOK key')
  }

  const baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const model = opts.model ?? process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o'

  let retryCount = 0
  const res = await withUpstreamRetry(
    async () => {
      const r = await upstreamFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          stream: false,
          temperature: 0.7,
          messages: [
            {
              role: 'system',
              content: appendCreationContext(ECOMMERCE_VISION_SYSTEM, opts.context),
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: userText },
                ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
              ],
            },
          ],
        }),
      })
      // ⛔ 纪律：必须在回调内 throw，否则 4xx/5xx 不会触发重试
      // （`fetch` 对 4xx/5xx 是正常返回 `ok: false`，不抛异常）。
      if (!r.ok) throw new Error(`Vision API ${r.status}: ${await r.text()}`)
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

  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> }
  const text = json.choices[0]?.message?.content?.trim()
  if (!text) {
    throw new Error('Vision LLM 返回空内容')
  }

  return { text, retryCount }
}
