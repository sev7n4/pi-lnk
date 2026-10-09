import { decodeChannelModel } from '@lnkpi/shared'
import { createTextProvider } from '../tools/text-provider'
import type { TextGenerateOptions } from '../tools/text-provider'
import type { CreationContext } from '../tools/creation-context'
import { generateTextWithImages } from './vision-text'

const VISION_MODEL_PATTERN =
  /(?:^|[/:])(?:gemini|gpt-4o|gpt-4-turbo|gpt-4-vision|gpt-5|claude-(?:opus|sonnet|haiku|3)|agnes)(?:[-./]|$)/i

const NON_VISION_MODEL_PATTERN =
  /(?:^|[/:])(?:deepseek|o[134](?:-|$|-mini|-pro)|text-embedding|whisper|tts|dall-e|babbage|davinci|curie|ada|moderation|flowmusic|suno)(?:[-./]|$)/i

/** Official V4.1 Flash id plus retired aliases that now route to it. */
const DEEPSEEK_FLASH_VISION_PATTERN =
  /(?:^|[/:])deepseek(?:-v4(?:\.1)?)?-flash(?:-vision-exp)?(?:[-./]|$)/i

export function isDeepSeekFlashVisionModel(model?: string | null): boolean {
  if (!model?.trim()) return false
  return DEEPSEEK_FLASH_VISION_PATTERN.test(model.trim())
}

export function upstreamChatModel(model?: string): string | undefined {
  if (!model) return model
  return decodeChannelModel(model)?.modelName ?? model
}

/** Whether chat/completions accepts OpenAI-style image_url message parts for this model id. */
export function supportsVisionTextModel(model?: string | null): boolean {
  if (!model?.trim()) return false
  const normalized = model.trim()
  if (isDeepSeekFlashVisionModel(normalized)) return true
  if (NON_VISION_MODEL_PATTERN.test(normalized)) return false
  return VISION_MODEL_PATTERN.test(normalized)
}

export function appendImageRefsForTextOnlyPrompt(prompt: string, imageUrls: string[]): string {
  const trimmed = prompt.trim()
  const urls = imageUrls.map((url) => url.trim()).filter(Boolean)
  if (urls.length === 0) return trimmed
  const tags = urls.map((url) => `[ref-image:${url}]`).join('\n')
  return `${trimmed}\n\n【参考图说明】当前文本模型不支持直接识图，以下为上游参考图 URL，请结合用户文字需求作答：\n${tags}`
}

export type TextGenerationWithRefsOptions = {
  model?: string
  apiKey?: string
  baseUrl?: string
  textOpts?: TextGenerateOptions
  /**
   * G5：创作上下文（选中指代 + 画布摘要）。透传给 provider 后追加到 system 末尾。
   * 不传时 system 与改动前**逐字相同**（有测试锁住这一点）。
   */
  nodeContext?: CreationContext
}

export interface TextForRefsResult {
  text: string
  visionUsed: boolean
  /**
   * 实际重试次数（首次成功 = 0，重试 1 次后成功 = 1）—— **不是总尝试数**。
   * 与 vision 路径（`vision-text.ts`）同口径，供上层写进账本 metadata。
   *
   * 非 vision 两条分支由 `OpenAITextProvider` 的 `withUpstreamRetry` 计数透传
   * （见 `text-provider.ts`）；上游 429/503 抖动被退避重试救回时该值 > 0。
   */
  retryCount: number
}

/** Route image-ref text generation to vision API or text-only fallback. */
export async function generateTextForRefs(
  prompt: string,
  referenceImages: string[],
  opts: TextGenerationWithRefsOptions = {},
): Promise<TextForRefsResult> {
  const refs = referenceImages.map((url) => url.trim()).filter(Boolean)
  // G5：上下文只注入 system（见 creation-context.ts），不参与 prompt 本身
  const textOpts = opts.nodeContext
    ? { ...opts.textOpts, context: opts.nodeContext }
    : opts.textOpts
  if (refs.length === 0) {
    const provider = createTextProvider({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
    })
    const { text, retryCount } = await provider.generate(prompt, opts.model, textOpts)
    return { text, visionUsed: false, retryCount }
  }

  if (supportsVisionTextModel(opts.model)) {
    const { text, retryCount } = await generateTextWithImages(prompt, refs, {
      model: upstreamChatModel(opts.model),
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      context: opts.nodeContext,
    })
    return { text, visionUsed: true, retryCount }
  }

  const provider = createTextProvider({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    model: opts.model,
  })
  const { text, retryCount } = await provider.generate(
    appendImageRefsForTextOnlyPrompt(prompt, refs),
    opts.model,
    textOpts,
  )
  return { text, visionUsed: false, retryCount }
}
