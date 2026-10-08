import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import {
  buildAudioRequest,
  buildEffectiveImagePrompt,
  buildEffectiveVideoPrompt,
  buildImageEditRequest,
  buildImageProviderGenerateOptions,
  buildImageProviderOptions,
  buildVideoProviderGenerateOptions,
  buildVideoProviderOptions,
  buildVideoReferenceBundle,
  createAudioProvider,
  createImageEditProvider,
  createImageProvider,
  createSegmentProvider,
  createTextProvider,
  createVideoProvider,
  generatePromptFromUserInput,
  generateTextForRefs,
  generateVisionQaJson,
  imageRefDescriptorsFromRefs,
  mergeRefsToPrompt,
  resolvePromptGenerateText,
  Seedance1xUnsupportedError,
  StepFunDesignProvider,
  StepFunMusicProvider,
  stripRefImagePromptTags,
  supportsVisionTextModel,
  type MergeTextSource,
  type StepFunMusicInput,
} from '@lnkpi/agent'
import {
  BYOK_FALLBACK_CONFIRM_MESSAGE,
  evaluateMediaRefPreflight,
  mapMessageToErrorCode,
  P1_IMAGE_EDIT_MODEL_KEY,
  BYOK_IMAGE_EDIT_PROFILE,
  IMAGE_EDIT_MODEL_PRICING,
  IMAGE_EDIT_MODEL_KEYS,
  resolveImageEditProfile,
  audioKindOf,
  decodeChannelModel,
  getModelEntry,
  redactProviderSnippet,
  resolveImageSize,
  resolveModelKey,
  resolvePlatformImageProviderOpts,
  resolvePublicMediaUrls,
  resolveVideoModelProfile,
  translateUpstreamFailure,
  type ErrorCode,
  type AudioKind,
  type GenerationRefPayload,
  type GenerationDiagnostic,
  type ImageRefWire,
  type ImageResolutionTier,
  type MediaInfo,
  type MediaRefPreflight,
  type StudioModality,
  type VideoGenerationMode,
  type CanvasData,
  assertMiniMaxH3ReferenceLimits,
  imageGenerationCredits,
  resolveCompositionVideoPrompt,
} from '@lnkpi/shared'
import {
  alreadyRefunded,
  applyChargeMeta,
  applyRefundMeta,
  isCancelledException,
  isCancelledMeta,
  rethrowWithRefundedPoints,
  throwCancelledException,
} from '../points/charge-session'
import { studioPointCategory } from '../points/point-categories'
import { PointsService } from '../points/points.service'
import { consumeMeta, refundMeta } from '../points/point-tx.types'
import {
  falH3MaxVideoRecordMeta,
  minimaxH3VideoRecordMeta,
  videoCreditsForModel,
} from '../points/video-credits'
import { PrismaService } from '../prisma/prisma.service'
import { classifyByokFailure } from '../provider/byok-fallback'
import { mergeChatModel } from '../provider/merge-chat-model'
import {
  providerContextFromResolved,
  type ProviderContext,
} from '../provider/provider-context'
import {
  ProviderResolverService,
  type ResolvedGenerationProvider,
} from '../provider/provider-resolver.service'
import { MediaProbeService } from '../media/media-probe.service'
import {
  parseJpegDimensions,
  parsePngDimensions,
} from '../media/media-probe.service'
import {
  buildMediaInfoPayload,
  enrichVideoMediaInfoDimensions,
} from '../media/build-media-info'
import { inlineUpstreamReferenceImages } from '../media/upstream-ref-inline'
import { downscaleOversizedReferenceImages } from '../media/upstream-ref-downscale'
import {
  computeMaskBBox,
  cropImageToDataUrl,
  normalizeMaskPng,
  parseElementName,
} from './element-recognize.util'
import {
  assertSameDimensions,
  compositeUnmaskedPixels,
  MaskDimensionMismatchError,
  readImageBuffer,
} from '../media/composite-unmasked'
import { UploadService } from '../upload/upload.service'
import sharp from 'sharp'
import { hasCompositionPBlock } from './video-generation-request.util'
import {
  assertStepFunAudioModel,
  assertAudioKindMatchesModel,
  audioFailureMessage,
  resolvePlatformAudioFallback,
} from './audio-kind'

// Grace window before returning the async `generating` record: fast image
// providers usually finish within this, sparing the client a polling round.
const IMAGE_FAST_PATH_MS = 3000

/**
 * 把 TTS provider 返回的 `data:audio/mpeg;base64,...` 落成真实文件，返回可持久化的 URL。
 *
 * ⚠️ 历史包袱（2026-10-04 修）：此前这里写的是
 * `const storeUrl = url.startsWith('data:') ? AUDIO_PLACEHOLDER : url`
 * ——即**真实 TTS 产物被替换成 soundhelix 示例曲**，而失败兜底返回的 https
 * soundhelix 却原样落库。两条路都指向同一个假 URL，于是生产 18/18 条audio
 * 记录都是示例曲、`hasTtsData` 全false、扣费 18 笔退款 0 笔。
 *
 * 现在没有占位可替换了，`data:` 必须落盘（否则整段 base64 会被写进 SQLite）。
 */
function decodeAudioDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) throw new Error('音频 provider 返回了无法解析的 data URL')
  const mimeType = match[1]
  const payload = match[3] ?? ''
  const buffer = match[2]
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8')
  if (buffer.length === 0) throw new Error('音频 provider 返回了空音频数据')
  return { buffer, mimeType }
}

const segmentTimestamps = new Map<string, number[]>()

export function allowSegmentRate(
  userId: string,
  now = Date.now(),
  windowMs = 60_000,
  max = 20,
): boolean {
  const recent = (segmentTimestamps.get(userId) ?? []).filter((t) => now - t < windowMs)
  if (recent.length >= max) {
    return false
  }
  recent.push(now)
  segmentTimestamps.set(userId, recent)
  return true
}

export function resetSegmentRateLimitForTests(): void {
  segmentTimestamps.clear()
}

export interface StudioRefInput {
  refKey: string
  mediaType: string
  label?: string
  text?: string
  url?: string
}

function extractTextSources(refs?: StudioRefInput[]): MergeTextSource[] {
  return (refs ?? [])
    .filter((r) => r.mediaType === 'text' && r.text?.trim())
    .map((r) => ({
      refKey: r.refKey,
      label: r.label?.trim() || r.refKey,
      text: r.text!.trim(),
    }))
}

// Full referenceImages[] is kept in metadata; agnes-image-* uses native extra_body.image for all refs.
function extractReferenceImages(refs?: StudioRefInput[]): string[] {
  return resolvePublicMediaUrls(
    (refs ?? [])
      .filter((r) => r.mediaType === 'image' && r.url?.trim())
      .map((r) => r.url!.trim()),
  )
}

function resolveStudioVideoMode(
  explicit: string | undefined,
  referenceBundle: ReturnType<typeof buildVideoReferenceBundle>,
): VideoGenerationMode {
  if (
    explicit === 'first_last_frame'
    || explicit === 'image_to_video'
    || explicit === 'text_to_video'
    || explicit === 'reference_to_video'
  ) {
    return explicit
  }
  return referenceBundle.images.length ? 'image_to_video' : 'text_to_video'
}

function isOfficialMiniMaxH3ReferenceToVideo(
  model: string | undefined,
  videoMode: VideoGenerationMode,
): boolean {
  if (videoMode !== 'reference_to_video') return false
  const modelKey = model ?? ''
  const profile = resolveVideoModelProfile(modelKey, modelKey)
  return profile.refWire === 'minimax_h3_content' || /^minimax-h3$/i.test(modelKey)
}

function providerOpts(resolved: ResolvedGenerationProvider) {
  const { apiKey, baseUrl } = resolved.credentials
  if (resolved.source === 'user' && !apiKey) return undefined
  return {
    apiKey,
    baseUrl: baseUrl || undefined,
  }
}

/**
 * Text upstream credentials shared with Agent via providerContextFromResolved (AC-8).
 * When providerRef is set and complete, no env overlay — same source/baseUrl as 启 run.
 */
function textGenCreds(
  resolved: ResolvedGenerationProvider,
  model?: string,
): { apiKey?: string; baseUrl?: string } {
  const ref = model?.trim()
  if (ref) {
    try {
      const ctx = providerContextFromResolved(ref, resolved)
      return { apiKey: ctx.apiKey, baseUrl: ctx.baseUrl }
    } catch {
      // incomplete BYOK / missing platform creds — fall through
    }
  }
  const opts = providerOpts(resolved)
  return {
    apiKey: opts?.apiKey ?? process.env.OPENAI_API_KEY,
    baseUrl: opts?.baseUrl ?? process.env.OPENAI_BASE_URL,
  }
}

function parseMeta(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

function hintForCode(code: ErrorCode): string | undefined {
  switch (code) {
    case 'upstream_timeout':
      return '请稍后重试'
    case 'insufficient_points':
      return '请充值后再试'
    case 'cancelled':
      return '可重新发起生成'
    case 'upload_required':
      return '请先上传参考图'
    case 'model_unavailable':
      return '请更换可用模型'
    case 'upstream_error':
      return '请稍后重试或更换模型'
    case 'fallback_pending':
      return '可确认使用平台通道或取消'
    case 'invalid_input':
      return '请检查输入后重试'
    default:
      return undefined
  }
}

function userMessageForCode(code: ErrorCode, fallback: string): string {
  switch (code) {
    case 'insufficient_points':
      return '积分不足'
    case 'upstream_timeout':
      return '上游超时，请稍后重试'
    case 'cancelled':
      return '已取消'
    case 'upload_required':
      return '参考图尚未上传'
    case 'model_unavailable':
      return '模型不可用'
    case 'upstream_error':
      return '上游服务异常'
    case 'fallback_pending':
      return '需要确认是否使用平台回退'
    case 'invalid_input':
      return '输入无效'
    default:
      return fallback.trim() || '生成失败'
  }
}

function errMessage(err: unknown): string {
  if (err instanceof BadRequestException) {
    const response = err.getResponse()
    if (typeof response === 'string') return response
    if (response && typeof response === 'object') {
      const message = (response as { message?: unknown }).message
      if (typeof message === 'string') return message
      if (Array.isArray(message)) return message.map(String).join('; ')
    }
  }
  if (err instanceof Error) return err.message
  return '生成失败'
}

function applyFailureDiagnosticMeta(
  existingMeta: Record<string, unknown>,
  err: unknown,
  overrides: { userMessage?: string; errorCode?: ErrorCode } = {},
): Record<string, unknown> {
  const errMsg = errMessage(err)
  const errorCode = overrides.errorCode ?? mapMessageToErrorCode(errMsg)
  const userMessage =
    overrides.userMessage ?? translateUpstreamFailure(errMsg) ?? userMessageForCode(errorCode, errMsg)
  return {
    ...existingMeta,
    errorCode,
    errorRaw: errMsg.slice(0, 8000),
    userMessage,
    failedAt: new Date().toISOString(),
  }
}

function throwGenerationFailure(opts: {
  userMessage: string
  errorCode: ErrorCode
  taskId: string
  refundedPoints?: number
}): never {
  throw new BadRequestException({
    message: opts.userMessage,
    errorCode: opts.errorCode,
    taskKind: 'generation',
    taskId: opts.taskId,
    ...(opts.refundedPoints != null ? { refundedPoints: opts.refundedPoints } : {}),
  })
}

type CancelFlag = { isCancelled(): boolean }

/** 分割提示（2026-09-26 元素编辑选区统一）：点（可多，label 0/1）/ 框 / 扩缩像素，可组合。 */
export type SegmentPromptPoint = { x: number; y: number; label?: 0 | 1 }
export type SegmentPromptBox = { x1: number; y1: number; x2: number; y2: number }
export type SegmentPrompt = {
  points?: SegmentPromptPoint[]
  box?: SegmentPromptBox
  dilate?: number
}

/** 归一化分割提示：box / points / 旧 x,y 单点 三选一（或组合），均无则 400。 */
function normalizeSegmentPrompt(input: {
  x?: number
  y?: number
  label?: 0 | 1
  points?: SegmentPromptPoint[]
  box?: SegmentPromptBox
  dilate?: number
}): SegmentPrompt {
  const points = (input.points ?? [])
    .filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y) && p.x >= 0 && p.y >= 0)
    .slice(0, 16)
    .map((p) => ({ x: p.x, y: p.y, label: p.label === 0 ? 0 : 1 as 0 | 1 }))
  let box: SegmentPromptBox | undefined
  const b = input.box
  if (
    b
    && [b.x1, b.y1, b.x2, b.y2].every((v) => Number.isFinite(v) && v >= 0)
    && b.x1 !== b.x2
    && b.y1 !== b.y2
  ) {
    box = {
      x1: Math.min(b.x1, b.x2),
      y1: Math.min(b.y1, b.y2),
      x2: Math.max(b.x1, b.x2),
      y2: Math.max(b.y1, b.y2),
    }
  }
  if (!box && points.length === 0) {
    if (Number.isFinite(input.x) && input.x! >= 0 && Number.isFinite(input.y) && input.y! >= 0) {
      points.push({ x: input.x!, y: input.y!, label: input.label === 0 ? 0 : 1 })
    } else {
      throw new BadRequestException('选区提示无效（需要点或框）')
    }
  }
  const dilate = Number.isFinite(input.dilate)
    ? Math.max(-64, Math.min(64, Math.round(input.dilate!)))
    : 0
  return { points, box, ...(dilate ? { dilate } : {}) }
}

/** fal 回落只支持单点：取首个正点，无则框中心点，再无则任意点。 */
function promptFallbackPoint(prompt: SegmentPrompt): SegmentPromptPoint {
  const positive = prompt.points?.find((p) => p.label !== 0)
  if (positive) return positive
  if (prompt.box) {
    return {
      x: Math.round((prompt.box.x1 + prompt.box.x2) / 2),
      y: Math.round((prompt.box.y1 + prompt.box.y2) / 2),
      label: 1,
    }
  }
  return prompt.points?.[0] ?? { x: 0, y: 0, label: 1 }
}

export type CanvasGenerationScope = {
  sessionId?: string
  nodeId?: string
}

function withCanvasScope(scope?: CanvasGenerationScope) {
  if (!scope?.sessionId && !scope?.nodeId) return {}
  return {
    ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
    ...(scope.nodeId ? { nodeId: scope.nodeId } : {}),
  }
}

function parseSessionCanvas(raw: string | null | undefined): CanvasData | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as CanvasData
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.nodes)) {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

const EMPTY_P_BLOCK_V_MESSAGE = '分镜还是空的，写好后再生成视频。'

/** Map generateVisionQaJson throws to structured errorClass + neutral Chinese reason. */
function classifyVisionCatch(err: unknown): { errorClass: string; reason: string } {
  const raw = err instanceof Error ? err.message : String(err)
  const lower = raw.toLowerCase()
  if (/\b429\b/.test(raw) || lower.includes('rate limit')) {
    return { errorClass: 'VISION_RATE_LIMIT', reason: '识图请求过于频繁，请稍后再试' }
  }
  if (lower.includes('timeout') || lower.includes('timed out') || raw.includes('超时')) {
    return { errorClass: 'VISION_TIMEOUT', reason: '识图超时，请稍后重试' }
  }
  if (lower.includes('fetch failed') || lower.includes('download')) {
    return { errorClass: 'VISION_FETCH_FAILED', reason: '参考图读取失败，请重新上传' }
  }
  return { errorClass: 'VISION_UPSTREAM', reason: '识图失败' }
}

@Injectable()
export class StudioService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PointsService) private readonly points: PointsService,
    @Inject(ProviderResolverService) private readonly resolver: ProviderResolverService,
    @Inject(MediaProbeService) private readonly mediaProbe: MediaProbeService,
    @Inject(UploadService) private readonly upload: UploadService,
  ) {}

  async listGenerations(userId: string, type?: string, sessionId?: string) {
    return this.prisma.generationRecord.findMany({
      where: {
        userId,
        ...(type ? { type } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
  }

  private async resolveMergedPrompt(
    localPrompt: string,
    refs: StudioRefInput[] | undefined,
    downstreamType: 'text' | 'image' | 'video' | 'audio',
    mentionedKeys?: string[],
    credentials?: { apiKey?: string; baseUrl?: string },
    model?: string,
    videoImageRefs?: Array<{ refKey: string; label: string }>,
  ) {
    const { mergedText, skippedMerge, mergeDegraded } = await mergeRefsToPrompt({
      sources: extractTextSources(refs),
      localPrompt: localPrompt.trim() || undefined,
      downstreamType,
      mentionedKeys: mentionedKeys?.length ? mentionedKeys : undefined,
      imageRefs:
        downstreamType === 'video'
          ? videoImageRefs
          : downstreamType === 'image'
            ? imageRefDescriptorsFromRefs(refs)
            : undefined,
      apiKey: credentials?.apiKey ?? process.env.OPENAI_API_KEY,
      baseUrl: credentials?.baseUrl ?? process.env.OPENAI_BASE_URL,
      model: mergeChatModel(downstreamType, model),
    })
    return {
      mergedText,
      skippedMerge,
      mergeDegraded,
      referenceImages: extractReferenceImages(refs),
    }
  }

  private pendingMeta(
    resolved: ResolvedGenerationProvider,
    err: unknown,
    extra: Record<string, unknown> = {},
  ) {
    const raw = errMessage(err).slice(0, 8000)
    const failureClass = classifyByokFailure(err)
    return {
      ...extra,
      channelId: resolved.channelId,
      failureClass,
      confirmMessage: BYOK_FALLBACK_CONFIRM_MESSAGE,
      originalModel: extra.originalModel,
      byokErrorRaw: raw,
      errorRaw: raw,
      errorCode: 'fallback_pending' as ErrorCode,
      userMessage: raw
        ? `BYOK 上游失败（${failureClass}）：${raw.slice(0, 240)}`
        : 'BYOK 上游失败，可改用平台模型继续',
      failedAt: new Date().toISOString(),
    }
  }

  private byokPendingMeta(
    resolved: ResolvedGenerationProvider,
    err: unknown,
    cost: number,
    extra: Record<string, unknown> = {},
  ) {
    return applyRefundMeta(
      applyChargeMeta(this.pendingMeta(resolved, err, extra), cost),
      cost,
      'byok_failed',
    )
  }

  private platformFallbackCost(type: string, meta: Record<string, unknown>): number {
    if (type === 'text' || type === 'prompt' || type === 'audio') return 5
    if (type === 'image') return 10 * (Number(meta.count ?? 1) || 1)
    if (type === 'video') {
      return videoCreditsForModel({
        duration: Number(meta.duration ?? 5),
        modelKey:
          (typeof meta.modelKey === 'string' && meta.modelKey) ||
          (typeof meta.originalModel === 'string' && meta.originalModel) ||
          undefined,
        resolution: typeof meta.resolution === 'string' ? meta.resolution : undefined,
        videoMode: typeof meta.videoMode === 'string' ? meta.videoMode : undefined,
        referenceImageCount: typeof meta.referenceImageCount === 'number'
          ? meta.referenceImageCount
          : Array.isArray(meta.referenceImages)
            ? meta.referenceImages.length
            : undefined,
        referenceVideoCount: typeof meta.referenceVideoCount === 'number'
          ? meta.referenceVideoCount
          : Array.isArray(meta.referenceVideos)
            ? meta.referenceVideos.length
            : undefined,
      })
    }
    throw new BadRequestException('不支持的生成类型')
  }

  /** Catalog gateway id for platform confirm — never reuse user-channel modelName. */
  private platformGatewayModelId(
    modality: StudioModality,
    meta: Record<string, unknown>,
  ): string {
    const requested =
      typeof meta.modelKey === 'string' && meta.modelKey.trim()
        ? meta.modelKey
        : undefined
    return resolveModelKey(modality, requested).entry.gatewayModelId
  }

  /** Internal agent path: vision QA for product_visual — no points charge. */
  async runVisionQaInternal(
    _userId: string,
    params: {
      systemPrompt: string
      userContent: string
      imageUrls: string[]
      provider: ProviderContext
    },
  ): Promise<{ text: string; visionUsed: boolean }> {
    const provider = params.provider
    if (!provider?.providerRef || !provider.model || !provider.baseUrl || !provider.source) {
      return {
        text: JSON.stringify({
          pass: false,
          reason: '识图凭证不完整，请重新选择模型后再试',
          errorClass: 'VISION_PROVIDER_CONTEXT_INVALID',
          product_summary: '',
        }),
        visionUsed: false,
      }
    }
    if (!provider.apiKey?.trim()) {
      if (provider.source === 'user') {
        return {
          text: JSON.stringify({
            pass: false,
            reason: '自定义渠道未配置 API Key',
            errorClass: 'VISION_BYOK_MISSING_KEY',
            product_summary: '',
          }),
          visionUsed: false,
        }
      }
      return {
        text: JSON.stringify({
          pass: false,
          reason: '识图凭证不完整，请重新选择模型后再试',
          errorClass: 'VISION_PROVIDER_CONTEXT_INVALID',
          product_summary: '',
        }),
        visionUsed: false,
      }
    }
    if (!supportsVisionTextModel(provider.model)) {
      return {
        text: JSON.stringify({
          pass: false,
          reason:
            '当前模型不支持识图。请换成 DeepSeek Flash 或 Gemini / GPT-4o 后再问。我没有根据这张图编造产品信息。',
          errorClass: 'VISION_UNSUPPORTED',
          product_summary: '',
        }),
        visionUsed: false,
      }
    }
    const urls = params.imageUrls.map((u) => u.trim()).filter(Boolean)
    if (!urls.length) {
      throw new BadRequestException('imageUrls 不能为空')
    }
    const providerRefs = await inlineUpstreamReferenceImages(urls)
    try {
      return await generateVisionQaJson(params.systemPrompt, params.userContent, providerRefs, {
        model: provider.model,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        maxRetries: 0,
      })
    } catch (err) {
      const { errorClass, reason } = classifyVisionCatch(err)
      return {
        text: JSON.stringify({ pass: false, reason, errorClass, product_summary: '' }),
        visionUsed: false,
      }
    }
  }

  async generateText(
    userId: string,
    prompt: string,
    model?: string,
    refs?: StudioRefInput[],
    mentionedKeys?: string[],
    cancel?: CancelFlag,
    thinking?: boolean,
    thinkingEffort?: 'high' | 'max',
    scope?: CanvasGenerationScope,
  ) {
    const cost = 5
    const chargeReason = '文本生成'
    await this.points.consume(
      userId,
      cost,
      chargeReason,
      consumeMeta('text', { model: model ?? null, generationId: null }),
    )
    const resolved = await this.resolver.resolveForGeneration(userId, model, 'text')
    const { modelKey: resolvedKey, entry, fallback } = resolveModelKey('text', resolved.modelName)
    const gatewayModelId =
      resolved.source === 'user' ? resolved.modelName : entry.gatewayModelId
    const { mergedText, skippedMerge, mergeDegraded, referenceImages } = await this.resolveMergedPrompt(
      prompt,
      refs,
      'text',
      mentionedKeys,
      resolved.source === 'user' ? resolved.credentials : undefined,
      gatewayModelId,
    )
    const storeModel = resolved.source === 'user' ? model ?? resolvedKey : resolvedKey
    const textOpts = {
      thinking: !!thinking,
      thinkingEffort: thinkingEffort === 'max' ? ('max' as const) : ('high' as const),
    }
    const baseMeta = {
      modelKey: resolvedKey,
      gatewayModelId,
      channelId: resolved.channelId,
      skippedMerge,
      refsCount: refs?.length ?? 0,
      visionUsed: false,
      referenceImages,
      thinking: textOpts.thinking,
      thinkingEffort: textOpts.thinking ? textOpts.thinkingEffort : undefined,
      ...(fallback && resolved.source === 'platform' ? { modelFallback: true } : {}),
    }

    try {
      if (resolved.source === 'user' && !resolved.credentials.apiKey) {
        throw new Error('missing api key')
      }
      const creds = textGenCreds(resolved, model)
      const providerRefs = referenceImages.length
        ? await inlineUpstreamReferenceImages(referenceImages)
        : referenceImages
      const { text, visionUsed } = await generateTextForRefs(mergedText, providerRefs, {
        model: gatewayModelId,
        apiKey: creds.apiKey,
        baseUrl: creds.baseUrl,
        textOpts,
      })
      if (cancel?.isCancelled()) {
        await this.points.refund(
          userId,
          cost,
          `${chargeReason}-取消退款`,
          refundMeta('text', 'cancelled_refund', {
            model: resolved.modelName,
            generationId: null,
          }),
        )
        throwCancelledException(cost)
      }
      return this.prisma.generationRecord.create({
        data: {
          userId,
          type: 'text',
          prompt: mergedText,
          model: storeModel,
          url: null,
          status: 'completed',
          metadata: JSON.stringify(applyChargeMeta({ ...baseMeta, text, visionUsed }, cost)),
          ...withCanvasScope(scope),
        },
      })
    } catch (err) {
      if (isCancelledException(err)) throw err
      if (resolved.source !== 'user') {
        await this.points.refund(
          userId,
          cost,
          `${chargeReason}-失败退款`,
          refundMeta('text', 'failed_refund', {
            model: resolved.modelName,
            generationId: null,
          }),
        )
        const failedMeta = applyFailureDiagnosticMeta(
          applyRefundMeta(applyChargeMeta({ ...baseMeta }, cost), cost, 'platform_failed'),
          err,
        )
        const failed = await this.prisma.generationRecord.create({
          data: {
            userId,
            type: 'text',
            prompt: mergedText,
            model: storeModel,
            url: null,
            status: 'failed',
            metadata: JSON.stringify(failedMeta),
            ...withCanvasScope(scope),
          },
        })
        throwGenerationFailure({
          userMessage: String(failedMeta.userMessage ?? '生成失败'),
          errorCode: failedMeta.errorCode as ErrorCode,
          taskId: failed.id,
          refundedPoints: cost,
        })
      }
      await this.points.refund(
        userId,
        cost,
        `${chargeReason}-BYOK失败退款`,
        refundMeta('text', 'byok_refund', {
          model: resolved.modelName,
          generationId: null,
        }),
      )
      return this.prisma.generationRecord.create({
        data: {
          userId,
          type: 'text',
          prompt: mergedText,
          model: storeModel,
          url: null,
          status: 'fallback_pending',
          metadata: JSON.stringify(
            this.byokPendingMeta(resolved, err, cost, {
              originalModel: model,
              ...baseMeta,
            }),
          ),
          ...withCanvasScope(scope),
        },
      })
    }
  }

  async generatePrompt(
    userId: string,
    prompt: string,
    model?: string,
    cancel?: CancelFlag,
    scope?: CanvasGenerationScope,
    guideSceneId?: string,
    refs?: StudioRefInput[],
    mentionedKeys?: string[],
  ) {
    const referenceImages = extractReferenceImages(refs)
    const trimmed = resolvePromptGenerateText(prompt, referenceImages)
    if (!trimmed) throw new BadRequestException('prompt 不能为空')
    const cost = 5
    const chargeReason = '提示词模式生成'
    await this.points.consume(
      userId,
      cost,
      chargeReason,
      consumeMeta('text', { model: model ?? null, generationId: null }),
    )
    const resolved = await this.resolver.resolveForGeneration(userId, model, 'text')
    const { modelKey: resolvedKey, entry, fallback } = resolveModelKey('text', resolved.modelName)
    const gatewayModelId =
      resolved.source === 'user' ? resolved.modelName : entry.gatewayModelId
    const storeModel = resolved.source === 'user' ? model ?? resolvedKey : resolvedKey
    const creds = textGenCreds(resolved, model)
    const baseMeta = {
      modelKey: resolvedKey,
      gatewayModelId,
      channelId: resolved.channelId,
      refsCount: refs?.length ?? 0,
      visionUsed: false,
      referenceImages,
      ...(fallback && resolved.source === 'platform' ? { modelFallback: true } : {}),
      ...(guideSceneId ? { guideSceneId } : {}),
      ...(mentionedKeys?.length ? { mentionedKeys } : {}),
    }

    try {
      if (resolved.source === 'user' && !resolved.credentials.apiKey) {
        throw new Error('missing api key')
      }
      const providerRefs = referenceImages.length
        ? await inlineUpstreamReferenceImages(referenceImages)
        : referenceImages
      const { mode, content, visionUsed } = await generatePromptFromUserInput(trimmed, {
        model: gatewayModelId,
        apiKey: creds.apiKey,
        baseUrl: creds.baseUrl,
        guideSceneId,
        referenceImages: providerRefs,
        mentionedKeys,
      })
      if (cancel?.isCancelled()) {
        await this.points.refund(
          userId,
          cost,
          `${chargeReason}-取消退款`,
          refundMeta('text', 'cancelled_refund', {
            model: resolved.modelName,
            generationId: null,
          }),
        )
        throwCancelledException(cost)
      }
      return this.prisma.generationRecord.create({
        data: {
          userId,
          type: 'prompt',
          prompt: trimmed,
          model: storeModel,
          url: null,
          status: 'completed',
          metadata: JSON.stringify(
            applyChargeMeta({ ...baseMeta, mode, content, visionUsed }, cost),
          ),
          ...withCanvasScope(scope),
        },
      })
    } catch (err) {
      if (isCancelledException(err)) throw err
      if (resolved.source !== 'user') {
        await this.points.refund(
          userId,
          cost,
          `${chargeReason}-失败退款`,
          refundMeta('text', 'failed_refund', {
            model: resolved.modelName,
            generationId: null,
          }),
        )
        const failedMeta = applyFailureDiagnosticMeta(
          applyRefundMeta(applyChargeMeta({ ...baseMeta }, cost), cost, 'platform_failed'),
          err,
        )
        const failed = await this.prisma.generationRecord.create({
          data: {
            userId,
            type: 'prompt',
            prompt: trimmed,
            model: storeModel,
            url: null,
            status: 'failed',
            metadata: JSON.stringify(failedMeta),
            ...withCanvasScope(scope),
          },
        })
        throwGenerationFailure({
          userMessage: String(failedMeta.userMessage ?? '生成失败'),
          errorCode: failedMeta.errorCode as ErrorCode,
          taskId: failed.id,
          refundedPoints: cost,
        })
      }
      await this.points.refund(
        userId,
        cost,
        `${chargeReason}-BYOK失败退款`,
        refundMeta('text', 'byok_refund', {
          model: resolved.modelName,
          generationId: null,
        }),
      )
      return this.prisma.generationRecord.create({
        data: {
          userId,
          type: 'prompt',
          prompt: trimmed,
          model: storeModel,
          url: null,
          status: 'fallback_pending',
          metadata: JSON.stringify(
            this.byokPendingMeta(resolved, err, cost, {
              originalModel: model,
              ...baseMeta,
            }),
          ),
          ...withCanvasScope(scope),
        },
      })
    }
  }

  /** Expand user prompt via prompt-modes (no separate charge; used by turnaround image pipeline). */
  async expandPromptContent(
    userId: string,
    prompt: string,
    model?: string,
  ): Promise<{ mode: string; content: string }> {
    const trimmed = prompt?.trim()
    if (!trimmed) throw new BadRequestException('prompt 不能为空')
    const resolved = await this.resolver.resolveForGeneration(userId, model, 'text')
    const { modelKey: resolvedKey, entry } = resolveModelKey('text', resolved.modelName)
    const gatewayModelId =
      resolved.source === 'user' ? resolved.modelName : entry.gatewayModelId
    const creds = textGenCreds(resolved, model)
    if (resolved.source === 'user' && !resolved.credentials.apiKey) {
      throw new Error('missing api key')
    }
    const { mode, content } = await generatePromptFromUserInput(trimmed, {
      model: gatewayModelId,
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
    })
    return { mode, content }
  }

  async getGeneration(userId: string, id: string) {
    const record = await this.prisma.generationRecord.findFirst({
      where: { id, userId },
    })
    if (!record) {
      throw new BadRequestException('生成记录不存在')
    }
    const meta = parseMeta(record.metadata)
    const mediaInfo = meta.mediaInfo as MediaInfo | undefined
    const refPreflight = meta.refPreflight as MediaRefPreflight | undefined
    return {
      ...record,
      ...(mediaInfo ? { mediaInfo } : {}),
      ...(refPreflight ? { refPreflight } : {}),
    }
  }

  private async buildMediaInfo(
    outputUrl: string | null,
    referenceUrls: string[],
  ): Promise<MediaInfo> {
    return buildMediaInfoPayload(this.mediaProbe, outputUrl, referenceUrls)
  }

  private async enrichVideoMediaInfoDimensions(
    mediaInfo: MediaInfo,
    lastFrameUrl?: string | null,
  ): Promise<MediaInfo> {
    return enrichVideoMediaInfoDimensions(this.mediaProbe, mediaInfo, lastFrameUrl)
  }

  async getGenerationDiagnostic(userId: string, id: string): Promise<GenerationDiagnostic> {
    const record = await this.getGeneration(userId, id)
    if (
      record.status !== 'failed'
      && record.status !== 'error'
      && record.status !== 'fallback_pending'
    ) {
      throw new NotFoundException('诊断不可用')
    }
    const meta = parseMeta(record.metadata)
    const errRaw =
      (typeof meta.byokErrorRaw === 'string' && meta.byokErrorRaw.trim()
        ? meta.byokErrorRaw
        : '')
      || (meta.errorRaw != null ? String(meta.errorRaw) : '')
    const code =
      (typeof meta.errorCode === 'string' ? (meta.errorCode as ErrorCode) : undefined) ??
      mapMessageToErrorCode(errRaw)
    const defaultMessage =
      record.status === 'fallback_pending' ? '平台回退待确认' : '生成失败'
    const userMessage =
      (typeof meta.userMessage === 'string' && meta.userMessage.trim()
        ? meta.userMessage
        : undefined) ?? defaultMessage
    const occurredAt =
      typeof meta.failedAt === 'string' && meta.failedAt
        ? meta.failedAt
        : record.createdAt.toISOString()

    return {
      userMessage,
      code,
      taskKind: 'generation',
      taskId: record.id,
      model: record.model ?? (typeof meta.model === 'string' ? meta.model : null) ?? null,
      channelId: typeof meta.channelId === 'string' ? meta.channelId : null,
      apiFormat: typeof meta.apiFormat === 'string' ? meta.apiFormat : null,
      httpStatus: typeof meta.httpStatus === 'number' ? meta.httpStatus : null,
      occurredAt,
      providerSnippet: errRaw ? redactProviderSnippet(errRaw) : null,
      hint:
        record.status === 'fallback_pending'
          ? '请确认是否使用平台回退继续，或取消本次生成。'
          : hintForCode(code),
    }
  }

  async generateImage(
    userId: string,
    prompt: string,
    model?: string,
    aspectRatio = '16:9',
    refs?: StudioRefInput[],
    mentionedKeys?: string[],
    resolution = '1K',
    count = 1,
    scope?: CanvasGenerationScope,
  ) {
    const n = Math.max(1, Math.min(4, Number(count) || 1))
    // 诊断 B4：定价按分辨率分级（1K=10 / 2K=15 / 4K=20 每张），单一真源在 shared
    const cost = imageGenerationCredits({ count: n, resolution })
    const chargeReason = '图像生成'
    const resolved = await this.resolver.resolveForGeneration(userId, model, 'image')
    const { mergedText, skippedMerge, mergeDegraded, referenceImages } = await this.resolveMergedPrompt(
      prompt,
      refs,
      'image',
      mentionedKeys,
      resolved.source === 'user' ? resolved.credentials : undefined,
      resolved.modelName,
    )
    const pixelSize = resolveImageSize(aspectRatio, resolution as ImageResolutionTier)
    const built = buildImageProviderOptions({
      modelKey: resolved.modelName,
      aspectRatio,
      resolution: resolution as ImageResolutionTier,
      pixelSize,
      n,
      referenceImages,
      byok: resolved.source === 'user',
      channelBaseUrl: resolved.credentials.baseUrl,
    })
    const modelId = resolved.source === 'user' ? resolved.modelName : built.modelId
    const storeModel =
      resolved.source === 'user' ? model ?? built.meta.modelKey : built.meta.modelKey
    const effectivePrompt = buildEffectiveImagePrompt(
      mergedText,
      built,
      imageRefDescriptorsFromRefs(refs),
    )
    const providerOptions = buildImageProviderGenerateOptions(built)
    // 账本对账（诊断 B2）：扣费交易必须携带 generationId，否则扣费与生成永远无法对上。
    // 记录先行：先建 generating 占位再扣费；扣费失败（积分不足）立即删除占位，不留孤儿。
    // 旧顺序（先扣费后建记录）还有个隐性泄漏——resolve/merge 阶段抛错时「已扣费、
    // 无记录、无退款」，用户侧连一条可展示的失败记录都没有。
    const record = await this.prisma.generationRecord.create({
      data: {
        userId,
        type: 'image',
        prompt: effectivePrompt,
        model: storeModel,
        status: 'generating',
        metadata: JSON.stringify(
          applyChargeMeta(
            {
              ...built.meta,
              modelId,
              aspectRatio,
              resolution,
              count: n,
              size: built.size,
              pixelSize,
              referenceImages,
              skippedMerge,
              // 诊断 C2：降级（无 key / LLM 失败退拼接）与 LLM 归纳成功可区分，供排查与告警
              mergeDegraded,
              channelId: resolved.channelId,
              originalModel: model,
              providerSource: resolved.source,
              responseMode: built.meta.responseMode,
              refWire: built.meta.refWire,
            },
            cost,
          ),
        ),
        ...withCanvasScope(scope),
      },
    })
    try {
      await this.points.consume(
        userId,
        cost,
        chargeReason,
        consumeMeta('image', { model: model ?? null, generationId: record.id }),
      )
    } catch (err) {
      await this.prisma.generationRecord
        .delete({ where: { id: record.id } })
        .catch(() => undefined)
      throw err
    }
    const completion = this.completeImage(
      record.id,
      userId,
      cost,
      chargeReason,
      effectivePrompt,
      providerOptions,
      resolved,
    ).catch((err) => {
      console.error('Image generation failed:', err)
      return null
    })
    // Fast path: quick providers finish within the grace window, so the client
    // gets the terminal record directly instead of one extra polling round-trip.
    if (built.meta.responseMode === 'async_task') {
      void completion
      return record
    }
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const fast = await Promise.race([
      completion,
      new Promise<null>((resolve) => {
        graceTimer = setTimeout(() => resolve(null), IMAGE_FAST_PATH_MS)
      }),
    ])
    if (graceTimer) clearTimeout(graceTimer)
    return fast ?? record
  }

  private async completeImage(
    id: string,
    userId: string,
    cost: number,
    chargeReason: string,
    prompt: string,
    options: import('@lnkpi/agent').ImageProviderGenerateOptions,
    resolved: ResolvedGenerationProvider,
  ) {
    try {
      if (resolved.source === 'user' && !resolved.credentials.apiKey) {
        throw new Error('missing api key')
      }
      const genOptions =
        options.referenceImages?.length
          ? {
              ...options,
              referenceImages: await inlineUpstreamReferenceImages(options.referenceImages),
            }
          : options
      const { url, urls } = await createImageProvider(providerOpts(resolved)).generate(
        prompt,
        genOptions,
      )
      const imageUrls = urls?.length ? urls : [url]
      const existing = await this.prisma.generationRecord.findFirst({ where: { id } })
      if (!existing || existing.status !== 'generating') return null
      const meta = parseMeta(existing.metadata)
      if (isCancelledMeta(meta) || alreadyRefunded(meta)) return null
      const referenceUrls = Array.isArray(meta.referenceImages)
        ? (meta.referenceImages as string[]).filter((url) => typeof url === 'string' && url.trim())
        : []
      const mediaInfo = await this.buildMediaInfo(imageUrls[0] ?? null, referenceUrls)
      const updated = await this.prisma.generationRecord.updateMany({
        where: { id, status: 'generating' },
        data: {
          url: imageUrls[0],
          status: 'completed',
          metadata: JSON.stringify({ ...meta, urls: imageUrls, mediaInfo }),
        },
      })
      if (updated.count === 0) return null
      return this.prisma.generationRecord.findFirst({ where: { id } })
    } catch (err) {
      console.error('Image generation failed:', err)
      const existing = await this.prisma.generationRecord.findFirst({ where: { id } })
      if (!existing || existing.status !== 'generating') return null
      const meta = parseMeta(existing.metadata)
      if (isCancelledMeta(meta) || alreadyRefunded(meta)) return null
      if (resolved.source === 'user') {
        await this.points.refund(
          userId,
          cost,
          `${chargeReason}-BYOK失败退款`,
          refundMeta('image', 'byok_refund', {
            model: resolved.modelName,
            generationId: id,
          }),
        )
        return this.prisma.generationRecord.update({
          where: { id },
          data: {
            status: 'fallback_pending',
            metadata: JSON.stringify(this.byokPendingMeta(resolved, err, cost, meta)),
          },
        })
      }
      await this.points.refund(
        userId,
        cost,
        `${chargeReason}-失败退款`,
        refundMeta('image', 'failed_refund', {
          model: resolved.modelName,
          generationId: id,
        }),
      )
      const failedMeta = applyFailureDiagnosticMeta(
        applyRefundMeta(meta, cost, 'platform_failed'),
        err,
      )
      return this.prisma.generationRecord.update({
        where: { id },
        data: {
          status: 'failed',
          metadata: JSON.stringify(failedMeta),
        },
      })
    }
  }

  async generateImageVariation(
    userId: string,
    prompt: string,
    basePrompt?: string,
    model?: string,
    cancel?: CancelFlag,
    scope?: CanvasGenerationScope,
  ) {
    const cost = 10
    const chargeReason = '图像变体'
    const combined = basePrompt ? `${basePrompt}。变体要求：${prompt}` : prompt
    const resolved = await this.resolver.resolveForGeneration(userId, model, 'image')
    const storeModel = model ?? resolved.modelName
    const baseMeta = { variation: true, basePrompt, channelId: resolved.channelId, chargeReason }
    // 账本对账（诊断 B2 收尾）：与 generateImage 同构的「记录先行」——先建 generating 占位
    // 再扣费，扣费交易才带得上 generationId；扣费失败立即删除占位，不留孤儿。
    // 旧顺序（先扣费后建记录）除账本对不上外还有两处泄漏：
    //   ① `resolveForGeneration` 抛错时「已扣费 / 无记录 / 无退款」——它原本在 try 之外；
    //   ② 进程在生成中途挂掉时同样无记录可查，reaper（#277/#281）只扫 GenerationRecord，
    //      扫不到这一笔，扣的分永远退不回来。
    const record = await this.prisma.generationRecord.create({
      data: {
        userId,
        type: 'image',
        prompt: combined,
        model: storeModel,
        url: null,
        status: 'generating',
        metadata: JSON.stringify(applyChargeMeta(baseMeta, cost)),
        ...withCanvasScope(scope),
      },
    })
    try {
      await this.points.consume(
        userId,
        cost,
        chargeReason,
        consumeMeta('image', { model: model ?? null, generationId: record.id }),
      )
    } catch (err) {
      await this.prisma.generationRecord
        .delete({ where: { id: record.id } })
        .catch(() => undefined)
      throw err
    }
    try {
      if (resolved.source === 'user' && !resolved.credentials.apiKey) {
        throw new Error('missing api key')
      }
      const { url } = await createImageProvider(providerOpts(resolved)).generate(combined, {
        modelId: resolved.modelName || undefined,
      })
      if (cancel?.isCancelled()) {
        // 与 cancelGeneration 同源：先读一次已结算状态，alreadyRefunded 时不重复退款
        // （占位记录此刻已存在 ⇒ 外部 cancelGeneration 也够得着它，必须防双退）。
        const cur = await this.prisma.generationRecord.findFirst({ where: { id: record.id } })
        let cancelMeta: Record<string, unknown> = { ...parseMeta(cur?.metadata), cancelled: true }
        if (!alreadyRefunded(cancelMeta)) {
          await this.points.refund(
            userId,
            cost,
            `${chargeReason}-取消退款`,
            refundMeta('image', 'cancelled_refund', {
              model: resolved.modelName,
              generationId: record.id,
            }),
          )
          cancelMeta = applyRefundMeta(cancelMeta, cost, 'cancelled')
        }
        await this.prisma.generationRecord.update({
          where: { id: record.id },
          data: {
            status: 'failed',
            metadata: JSON.stringify(
              applyFailureDiagnosticMeta(cancelMeta, new Error('已取消'), {
                errorCode: 'cancelled',
                userMessage: '已取消',
              }),
            ),
          },
        })
        throwCancelledException(cost)
      }
      return this.prisma.generationRecord.update({
        where: { id: record.id },
        data: { url, status: 'completed' },
      })
    } catch (err) {
      if (isCancelledException(err)) throw err
      if (resolved.source !== 'user') {
        await this.points.refund(
          userId,
          cost,
          `${chargeReason}-失败退款`,
          refundMeta('image', 'failed_refund', {
            model: resolved.modelName,
            generationId: record.id,
          }),
        )
        const failedMeta = applyFailureDiagnosticMeta(
          applyRefundMeta(applyChargeMeta(baseMeta, cost), cost, 'platform_failed'),
          err,
        )
        const failed = await this.prisma.generationRecord.update({
          where: { id: record.id },
          data: {
            status: 'failed',
            metadata: JSON.stringify(failedMeta),
          },
        })
        throwGenerationFailure({
          userMessage: String(failedMeta.userMessage ?? '生成失败'),
          errorCode: failedMeta.errorCode as ErrorCode,
          taskId: failed.id,
          refundedPoints: cost,
        })
      }
      await this.points.refund(
        userId,
        cost,
        `${chargeReason}-BYOK失败退款`,
        refundMeta('image', 'byok_refund', {
          model: resolved.modelName,
          generationId: record.id,
        }),
      )
      return this.prisma.generationRecord.update({
        where: { id: record.id },
        data: {
          status: 'fallback_pending',
          metadata: JSON.stringify(
            this.byokPendingMeta(resolved, err, cost, {
              originalModel: model,
              variation: true,
              basePrompt,
            }),
          ),
        },
      })
    }
  }

  async editImage(
    userId: string,
    input: {
      prompt: string
      imageUrl: string
      maskUrl: string
      model?: string
      size?: string
      mode?: 'inpaint' | 'outpaint'
      /** 替换参考图（元素编辑/重绘「+」上传，对象替换）：追加进 image_urls。 */
      referenceImageUrls?: string[]
      outpaintFrom?: { width: number; height: number }
      outpaintTo?: { width: number; height: number }
      sessionId?: string
      nodeId?: string
      parentRecordId?: string
      parentVersionId?: string
    },
    cancel?: CancelFlag,
  ) {
    const chargeReason = '图像精修'
    const scope = { sessionId: input.sessionId, nodeId: input.nodeId }

    const editModelKey = input.model ?? P1_IMAGE_EDIT_MODEL_KEY
    const editMode: 'inpaint' | 'outpaint' = input.mode ?? 'inpaint'
    // BYOK 渠道模型（channelId::modelName）→ 同步编辑 wire；平台白名单 key → apimart 异步协议
    const byokChannel = decodeChannelModel(editModelKey)
    let profile: ReturnType<typeof resolveImageEditProfile>
    if (byokChannel) {
      profile = { ...BYOK_IMAGE_EDIT_PROFILE, gatewayModelId: byokChannel.modelName }
    } else {
      try {
        profile = resolveImageEditProfile(editModelKey)
      } catch {
        throw new BadRequestException(
          `未知的精修模型：${input.model ?? '(默认)'}；仅支持 ${IMAGE_EDIT_MODEL_KEYS.join(', ')}`,
        )
      }
    }
    const cost = IMAGE_EDIT_MODEL_PRICING[editModelKey] ?? 10

    let base: Buffer
    let mask: Buffer
    let baseDims = { width: 0, height: 0 }
    try {
      ;[base, mask] = await Promise.all([
        readImageBuffer(input.imageUrl),
        readImageBuffer(input.maskUrl),
      ])
      baseDims = await assertSameDimensions(base, mask)
    } catch (err) {
      if (err instanceof MaskDimensionMismatchError) {
        throw new BadRequestException(err.message)
      }
      throw err
    }

    let resolved
    try {
      resolved = await this.resolver.resolveForGeneration(userId, editModelKey, 'image')
    } catch (err) {
      // 渠道解析失败（如 BYOK 渠道不存在）：此时尚未扣费（扣费已后移到占位记录之后），
      // 直接抛即可 —— 原来的「先退积分再抛」是配合旧顺序（先扣费）的。
      throw err
    }
    if (byokChannel && resolved.apiFormat !== 'openai') {
      // 同上：尚未扣费，无需退款。
      throw new BadRequestException('该渠道的 API 格式暂不支持图像编辑')
    }
    // BYOK 同步 wire 需要显式像素尺寸（部分上游 'auto' 会 500），缺省跟随原图
    const byokSize = byokChannel
      ? input.size && input.size !== 'auto'
        ? input.size
        : `${baseDims.width}x${baseDims.height}`
      : undefined
    const built = byokChannel
      ? {
          prompt: '',
          body: {},
          meta: {
            editMode: 'inpaint' as const,
            modelKey: editModelKey,
            gatewayModelId: byokChannel.modelName,
            editWire: profile.editWire,
            size: byokSize ?? 'auto',
          },
        }
      : buildImageEditRequest({
          userPrompt: input.prompt,
          imageUrl: input.imageUrl,
          maskUrl: input.maskUrl,
          referenceImageUrls: input.referenceImageUrls,
          sizeOverride: input.size,
        })
    // 扩图尺寸兜底（2026-09-26 线上故障）：DTO 已放行缺失/null 字段，这里把
    // 非有限正数的整体尺寸对象回落为原图尺寸，绝不让 null/NaN 进 metadata。
    const saneDims = (d?: { width: number; height: number }) =>
      d && Number.isFinite(d.width) && d.width > 0 && Number.isFinite(d.height) && d.height > 0
        ? { width: d.width, height: d.height }
        : undefined
    const outpaintMeta =
      editMode === 'outpaint'
        ? {
            outpaintFrom: saneDims(input.outpaintFrom) ?? {
              width: baseDims.width,
              height: baseDims.height,
            },
            outpaintTo: saneDims(input.outpaintTo) ?? {
              width: baseDims.width,
              height: baseDims.height,
            },
          }
        : {}
    const editMeta = {
      editMode,
      editModelKey,
      editSize: input.size ?? profile.size,
      composited: false,
      baseImageUrl: input.imageUrl,
      maskUrl: input.maskUrl,
      parentRecordId: input.parentRecordId,
      parentVersionId: input.parentVersionId,
      chargeReason,
      channelId: resolved.channelId,
      modelKey: built.meta.modelKey,
      gatewayModelId: built.meta.gatewayModelId,
      ...outpaintMeta,
    }
    const record = await this.prisma.generationRecord.create({
      data: {
        userId,
        type: 'image_edit',
        prompt: input.prompt,
        model: editModelKey,
        status: 'generating',
        metadata: JSON.stringify(applyChargeMeta(editMeta, cost)),
        ...withCanvasScope(scope),
      },
    })

    // 账本对账（诊断 B2 收尾）：扣费交易必须携带 generationId，否则扣费与生成永远对不上。
    // 精修的记录本来就在生成前创建（status=generating），把扣费挪到记录之后即与
    // generateImage 同构；扣费失败（积分不足）立即删除占位，不留孤儿。
    try {
      await this.points.consume(
        userId,
        cost,
        chargeReason,
        consumeMeta('image', { model: editModelKey, generationId: record.id }),
      )
    } catch (err) {
      await this.prisma.generationRecord
        .delete({ where: { id: record.id } })
        .catch(() => undefined)
      throw err
    }

    const refundAndFail = async (err: unknown) => {
      await this.points.refund(
        userId,
        cost,
        `${chargeReason}-失败退款`,
        refundMeta('image', 'failed_refund', {
          model: resolved.modelName,
          generationId: record.id,
        }),
      )
      const existing = await this.prisma.generationRecord.findFirst({ where: { id: record.id } })
      const meta = parseMeta(existing?.metadata)
      const failedMeta = applyFailureDiagnosticMeta(
        applyRefundMeta(meta, cost, 'platform_failed'),
        err,
      )
      const failed = await this.prisma.generationRecord.update({
        where: { id: record.id },
        data: {
          status: 'failed',
          metadata: JSON.stringify(failedMeta),
        },
      })
      throwGenerationFailure({
        userMessage: String(failedMeta.userMessage ?? '精修失败'),
        errorCode: failedMeta.errorCode as ErrorCode,
        taskId: failed.id,
        refundedPoints: cost,
      })
    }

    try {
      if (cancel?.isCancelled()) {
        await this.points.refund(
          userId,
          cost,
          `${chargeReason}-取消退款`,
          refundMeta('image', 'cancelled_refund', {
            model: resolved.modelName,
            generationId: record.id,
          }),
        )
        throwCancelledException(cost)
      }
      const refUrls = (input.referenceImageUrls ?? []).map((u) => u.trim()).filter(Boolean)
      const inlined = await inlineUpstreamReferenceImages([input.imageUrl, input.maskUrl, ...refUrls])
      const inlinedImage = inlined[0] ?? input.imageUrl
      const inlinedMask = inlined[1] ?? input.maskUrl
      const inlinedRefs = refUrls.length ? inlined.slice(2).map((u, i) => u ?? refUrls[i]!) : []
      if (cancel?.isCancelled()) {
        await this.points.refund(
          userId,
          cost,
          `${chargeReason}-取消退款`,
          refundMeta('image', 'cancelled_refund', {
            model: resolved.modelName,
            generationId: record.id,
          }),
        )
        throwCancelledException(cost)
      }
      if (resolved.source === 'user' && !resolved.credentials.apiKey) {
        throw new Error('missing api key')
      }
      const { url: upstreamUrl } = await createImageEditProvider({
        ...providerOpts(resolved),
        wire: profile.editWire,
      }).edit({
        userPrompt: input.prompt,
        imageUrl: inlinedImage,
        maskUrl: inlinedMask,
        referenceImageUrls: inlinedRefs,
        ...(byokChannel ? { modelId: byokChannel.modelName, size: byokSize } : {}),
      })
      if (cancel?.isCancelled()) {
        await this.points.refund(
          userId,
          cost,
          `${chargeReason}-取消退款`,
          refundMeta('image', 'cancelled_refund', {
            model: resolved.modelName,
            generationId: record.id,
          }),
        )
        throwCancelledException(cost)
      }
      const result = await readImageBuffer(upstreamUrl)
      const { buffer: composited } = await compositeUnmaskedPixels({ base, result, mask })
      if (cancel?.isCancelled()) {
        await this.points.refund(
          userId,
          cost,
          `${chargeReason}-取消退款`,
          refundMeta('image', 'cancelled_refund', {
            model: resolved.modelName,
            generationId: record.id,
          }),
        )
        throwCancelledException(cost)
      }
      const saved = await this.upload.saveUserFile(userId, composited, 'edit.png', 'image/png')
      const existing = await this.prisma.generationRecord.findFirst({ where: { id: record.id } })
      const meta = parseMeta(existing?.metadata)
      const updated = await this.prisma.generationRecord.updateMany({
        where: { id: record.id, status: 'generating' },
        data: {
          url: saved.url,
          status: 'completed',
          metadata: JSON.stringify({
            ...meta,
            editMode,
            composited: true,
            baseImageUrl: input.imageUrl,
            maskUrl: input.maskUrl,
            parentRecordId: input.parentRecordId,
            parentVersionId: input.parentVersionId,
            chargeReason,
          }),
        },
      })
      if (updated.count === 0) {
        throwCancelledException(cost)
      }
      return this.prisma.generationRecord.findFirst({ where: { id: record.id } })
    } catch (err) {
      if (isCancelledException(err)) {
        const existing = await this.prisma.generationRecord.findFirst({ where: { id: record.id } })
        const meta = parseMeta(existing?.metadata)
        const cancelledMeta = applyFailureDiagnosticMeta(
          applyRefundMeta({ ...meta, cancelled: true }, cost, 'cancelled'),
          err,
          { errorCode: 'cancelled', userMessage: '已取消' },
        )
        await this.prisma.generationRecord.update({
          where: { id: record.id },
          data: {
            status: 'failed',
            metadata: JSON.stringify(cancelledMeta),
          },
        })
        throw err
      }
      return refundAndFail(err)
    }
  }

  /**
   * 内网 MobileSAM 分割（2026-09-26 自建链路）：配置 LNKPI_SEGMENT_SERVICE_URL 即优先走自建
   * （点提示 → mask PNG 同源落盘），失败/未配置返回 null，调用方回落 fal。
   * 与 mattingImage 同款模式：api 侧下载图片（代理感知）→ base64 POST → 收 PNG → saveUserFile。
   */
  private async segmentViaInternalService(
    userId: string,
    imageUrl: string,
    prompt: SegmentPrompt,
  ): Promise<{ maskUrl: string } | null> {
    const endpoint = process.env.LNKPI_SEGMENT_SERVICE_URL?.trim()
    if (!endpoint) return null

    let buffer: Buffer
    try {
      buffer = await readImageBuffer(imageUrl)
    } catch {
      return null
    }
    if (buffer.byteLength > 20 * 1024 * 1024) return null

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    let png: Buffer
    try {
      const body: Record<string, unknown> = { image: buffer.toString('base64') }
      if (prompt.points?.length) body.points = prompt.points
      if (prompt.box) {
        body.box = [prompt.box.x1, prompt.box.y1, prompt.box.x2, prompt.box.y2]
      }
      if (prompt.dilate) body.dilate = prompt.dilate
      const res = await fetch(`${endpoint.replace(/\/$/, '')}/segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) return null
      png = Buffer.from(await res.arrayBuffer())
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
    if (png.subarray(1, 4).toString('ascii') !== 'PNG') return null
    const saved = await this.upload.saveUserFile(userId, png, 'segment.png', 'image/png')
    return { maskUrl: saved.url }
  }

  async segmentImage(
    userId: string,
    input: {
      imageUrl: string
      x?: number
      y?: number
      label?: 0 | 1
      points?: SegmentPromptPoint[]
      box?: SegmentPromptBox
      dilate?: number
    },
  ): Promise<{ maskUrl: string }> {
    const imageUrl = input.imageUrl?.trim()
    if (!imageUrl) {
      throw new BadRequestException('imageUrl 不能为空')
    }
    const prompt = normalizeSegmentPrompt(input)
    if (!allowSegmentRate(userId)) {
      throw new HttpException('点选过于频繁，请稍后再试', HttpStatus.TOO_MANY_REQUESTS)
    }

    const [inlinedUrl] = await inlineUpstreamReferenceImages([imageUrl])
    const publicUrl = inlinedUrl ?? imageUrl

    // 内网 MobileSAM 优先（未配置/失败返回 null → 回落 fal）
    try {
      const internal = await this.segmentViaInternalService(userId, publicUrl, prompt)
      if (internal) return internal
    } catch {
      // 落盘等异常也回落 fal
    }

    const apiKey = process.env.FAL_KEY?.trim()
    if (!apiKey) {
      throw new ServiceUnavailableException('点选暂不可用')
    }

    // fal 回落仅支持单点：取首个正点，否则框中心点
    const fallbackPoint = promptFallbackPoint(prompt)
    try {
      return await createSegmentProvider({ apiKey }).segment({
        imageUrl: publicUrl,
        x: fallbackPoint.x,
        y: fallbackPoint.y,
        label: fallbackPoint.label ?? 1,
      })
    } catch (err) {
      if (
        err instanceof BadRequestException
        || err instanceof ServiceUnavailableException
        || err instanceof HttpException
      ) {
        throw err
      }
      throw new BadGatewayException(
        translateUpstreamFailure(errMessage(err)) ?? '云端点选失败',
      )
    }
  }

  async mattingImage(userId: string, input: { imageUrl: string }): Promise<{ url: string }> {
    const imageUrl = input.imageUrl?.trim()
    if (!imageUrl) {
      throw new BadRequestException('imageUrl 不能为空')
    }
    const endpoint = process.env.MATTING_SERVICE_URL?.trim()
    if (!endpoint) {
      throw new ServiceUnavailableException('抠图服务未启用')
    }

    let buffer: Buffer
    try {
      buffer = await readImageBuffer(imageUrl)
    } catch {
      throw new BadGatewayException('抠图服务暂时不可用')
    }

    const isPng =
      buffer.length >= 8
      && buffer[0] === 0x89
      && buffer[1] === 0x50
      && buffer[2] === 0x4e
      && buffer[3] === 0x47
    const isJpeg = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8
    const contentType = isPng ? 'image/png' : isJpeg ? 'image/jpeg' : 'application/octet-stream'
    const dimensions = parsePngDimensions(buffer) ?? parseJpegDimensions(buffer)
    if (!dimensions) {
      throw new BadRequestException('不支持的图片格式')
    }
    if (buffer.byteLength > 20 * 1024 * 1024 || dimensions.width > 4096 || dimensions.height > 4096) {
      throw new BadRequestException('图片过大（限 20MB / 4096px）')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    let png: Buffer
    try {
      const out = await fetch(`${endpoint.replace(/\/$/, '')}/matting`, {
        method: 'POST',
        body: new Uint8Array(buffer),
        headers: { 'Content-Type': contentType },
        signal: controller.signal,
      })
      if (!out.ok) {
        throw new BadGatewayException('抠图服务暂时不可用')
      }
      png = Buffer.from(await out.arrayBuffer())
    } catch (err) {
      if (err instanceof BadGatewayException) {
        throw err
      }
      throw new BadGatewayException('抠图服务暂时不可用')
    } finally {
      clearTimeout(timer)
    }
    if (png.subarray(1, 4).toString('ascii') !== 'PNG') {
      throw new BadGatewayException('抠图服务暂时不可用')
    }
    const saved = await this.upload.saveUserFile(userId, png, 'matting.png', 'image/png')
    return { url: saved.url }
  }

  /**
   * 元素编辑焦点识别（2026-09-25 用户需求）：点击图上一点 → SAM 点分割出对象精确蒙版 →
   * 裁剪对象局部给识图模型命名。返回 { name, maskUrl（同源落盘）, bbox（原图像素） }。
   * 蒙版供前端并入元素编辑累积层；命名展示在编辑内容小芯片条（可二次编辑）。
   * 不计费（与 vision QA 同级的轻量调用）。
   */
  async elementRecognize(
    userId: string,
    input: {
      imageUrl: string
      x?: number
      y?: number
      label?: 0 | 1
      points?: SegmentPromptPoint[]
      box?: SegmentPromptBox
      dilate?: number
      model?: string
    },
  ): Promise<{
    name: string
    maskUrl: string
    bbox: { x: number; y: number; width: number; height: number }
  }> {
    const imageUrl = input.imageUrl?.trim()
    if (!imageUrl) {
      throw new BadRequestException('imageUrl 不能为空')
    }
    const prompt = normalizeSegmentPrompt(input)
    if (!allowSegmentRate(userId)) {
      throw new HttpException('识别过于频繁，请稍后再试', HttpStatus.TOO_MANY_REQUESTS)
    }
    const apiKey = process.env.FAL_KEY?.trim()

    const [inlinedUrl] = await inlineUpstreamReferenceImages([imageUrl])
    const publicUrl = inlinedUrl ?? imageUrl

    let segmentMaskUrl: string
    try {
      // 内网 MobileSAM 优先（未配置/失败返回 null → 回落 fal）
      const internal = await this.segmentViaInternalService(userId, publicUrl, prompt)
      if (internal) {
        segmentMaskUrl = internal.maskUrl
      } else {
        if (!apiKey) {
          throw new ServiceUnavailableException('对象识别服务未配置')
        }
        // fal 回落仅支持单点：取首个正点，否则框中心点
        const fallbackPoint = promptFallbackPoint(prompt)
        const out = await createSegmentProvider({ apiKey }).segment({
          imageUrl: publicUrl,
          x: fallbackPoint.x,
          y: fallbackPoint.y,
          label: fallbackPoint.label ?? 1,
        })
        segmentMaskUrl = out.maskUrl
      }
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof HttpException) throw err
      throw new BadGatewayException(
        translateUpstreamFailure(errMessage(err)) ?? '对象识别（分割）失败，请重试',
      )
    }

    const [imgBuf, maskBuf] = await Promise.all([
      readImageBuffer(imageUrl).catch(() => null),
      readImageBuffer(segmentMaskUrl).catch(() => null),
    ])
    if (!imgBuf || !maskBuf) {
      throw new BadGatewayException('对象识别失败：素材读取失败，请重试')
    }
    const imgMeta = await sharp(imgBuf).metadata()
    const imgWidth = imgMeta.width ?? 0
    const imgHeight = imgMeta.height ?? 0
    if (!imgWidth || !imgHeight) {
      throw new BadRequestException('不支持的图片格式')
    }

    const bbox = await computeMaskBBox(maskBuf, imgWidth, imgHeight)
    if (!bbox) {
      throw new BadRequestException('未识别到对象，请换一处点击，或改用框选/画笔')
    }

    const maskPng = await normalizeMaskPng(maskBuf, imgWidth, imgHeight)
    const saved = await this.upload.saveUserFile(userId, maskPng, 'element-mask.png', 'image/png')
    // 命名是装饰性步骤（蒙版/bbox 才是必需品）：失败降级为「选区」，绝不阻断元素编辑主流程。
    let name = '选区'
    try {
      name = await this.recognizeElementName(userId, imgBuf, bbox, input.model)
    } catch {
      /* 识图模型不可用/调用失败 → 保持默认名 */
    }
    return { name, maskUrl: saved.url, bbox }
  }

  /** 识图命名：传入模型 → LNKPI_VISION_NAMING_MODEL → 平台默认文本模型，取第一个可识图的。 */
  private async recognizeElementName(
    userId: string,
    imgBuf: Buffer,
    bbox: { x: number; y: number; width: number; height: number },
    model?: string,
  ): Promise<string> {
    const candidates: ResolvedGenerationProvider[] = []
    const namingFallback =
      process.env.LNKPI_VISION_NAMING_MODEL?.trim() || process.env.OPENAI_CHAT_MODEL?.trim() || undefined
    for (const candidate of [model, namingFallback]) {
      try {
        candidates.push(await this.resolver.resolveForGeneration(userId, candidate, 'text'))
      } catch {
        /* 该通道解析失败 → 看下一个候选 */
      }
    }
    const vision = candidates.find(
      (r) =>
        r.credentials.apiKey?.trim() &&
        r.credentials.baseUrl?.trim() &&
        supportsVisionTextModel(r.modelName),
    )
    if (!vision) {
      throw new BadRequestException(
        '当前模型不支持识图——请把文本模型切换为可识图模型（DeepSeek Flash / Gemini / GPT-4o）后重试',
      )
    }
    const dataUrl = await cropImageToDataUrl(imgBuf, bbox)
    const provider = providerContextFromResolved(vision.channelId, vision)
    const { text } = await this.runVisionQaInternal(userId, {
      systemPrompt: '你是图像对象识别助手。只输出 JSON，不要输出任何其他内容。',
      userContent:
        '这是图中某个被选中对象的局部截图。判断它是什么对象或部位（例如：眼睛、鼻子、耳朵、项链、帽子、杯子）。' +
        '只输出 JSON：{"name":"<不超过6个字的中文对象名>"}',
      imageUrls: [dataUrl],
      provider,
    })
    return parseElementName(text) ?? '未识别对象'
  }

  async generateVideo(
    userId: string,
    prompt: string,
    model?: string,
    duration = 5,
    aspectRatio = '16:9',
    refs?: StudioRefInput[],
    mentionedKeys?: string[],
    resolution = '720p',
    crop = 'none',
    referenceImageUrl?: string,
    scope?: CanvasGenerationScope,
    videoMode?: string,
    generateAudio?: boolean,
    seed?: number,
    negativePrompt?: string,
  ) {
    if (scope?.sessionId && scope?.nodeId) {
      const session = await this.prisma.session.findUnique({ where: { id: scope.sessionId } })
      const canvas = parseSessionCanvas(session?.canvasData)
      if (canvas) {
        const livePrompt = resolveCompositionVideoPrompt(canvas, scope.nodeId)
        if ('error' in livePrompt) {
          throw new BadRequestException(EMPTY_P_BLOCK_V_MESSAGE)
        }
        if (hasCompositionPBlock(canvas, scope.nodeId)) {
          prompt = livePrompt.prompt
        }
      }
    }
    const videoRefs: GenerationRefPayload[] = (refs ?? []).map((ref) => ({
      ...ref,
      mediaType: ref.mediaType as GenerationRefPayload['mediaType'],
    }))
    const referenceBundle = buildVideoReferenceBundle(videoRefs, referenceImageUrl)
    for (const group of [
      referenceBundle.images,
      referenceBundle.videos,
      referenceBundle.audios,
    ]) {
      for (const ref of group) {
        ref.url = resolvePublicMediaUrls([ref.url])[0] ?? ref.url
      }
    }
    const resolvedVideoMode = resolveStudioVideoMode(videoMode, referenceBundle)
    if (
      referenceBundle.audios.length
      && !referenceBundle.images.length
      && !referenceBundle.videos.length
      && !isOfficialMiniMaxH3ReferenceToVideo(model, resolvedVideoMode)
    ) {
      throw new BadRequestException('参考音频须配合参考图或视频')
    }
    if (resolvedVideoMode === 'reference_to_video') {
      const profile = resolveVideoModelProfile(model ?? '', model ?? '')
      if (profile.refWire === 'minimax_h3_content') {
        try {
          assertMiniMaxH3ReferenceLimits({
            imageCount: referenceBundle.images.length,
            videoCount: referenceBundle.videos.length,
            audioCount: referenceBundle.audios.length,
            promptLength: prompt.length,
          })
        } catch (err) {
          throw new BadRequestException((err as Error).message)
        }
      }
    }
    const durationCredits = videoCreditsForModel({
      duration,
      modelKey: model,
      resolution,
      videoMode: resolvedVideoMode,
      referenceImageCount: referenceBundle.images.length,
      referenceVideoCount: referenceBundle.videos.length,
    })
    const chargeReason = '视频生成'
    const resolved = await this.resolver.resolveForGeneration(userId, model, 'video')
    const { mergedText, skippedMerge } = await this.resolveMergedPrompt(
      prompt,
      refs,
      'video',
      mentionedKeys,
      resolved.source === 'user' ? resolved.credentials : undefined,
      resolved.modelName,
      referenceBundle.images.map(({ refKey, label }) => ({ refKey, label })),
    )
    const built = (() => {
      try {
        return buildVideoProviderOptions({
          modelKey: resolved.modelName,
          duration,
          aspectRatio,
          resolution,
          crop,
          referenceBundle,
          videoMode: resolvedVideoMode,
          gatewayModelHint: resolved.source === 'user' ? resolved.modelName : undefined,
          channelBaseUrl: resolved.credentials.baseUrl,
          generateAudio,
          seed,
          negativePrompt,
        })
      } catch (err) {
        if (err instanceof Seedance1xUnsupportedError) {
          throw new BadRequestException(err.message)
        }
        throw err
      }
    })()
    const storeModel =
      resolved.source === 'user' ? model ?? built.meta.modelKey : built.meta.modelKey
    const effectivePrompt = buildEffectiveVideoPrompt(mergedText, built)
    const providerOptions = buildVideoProviderGenerateOptions(built)
    if (resolved.source === 'user') {
      providerOptions.model = resolved.modelName
    }
    const effectiveBundle = built.effectiveReferenceBundle
    let upstreamImageRefs = effectiveBundle.images
    let refPreflight: MediaRefPreflight | undefined
    let refDownscaled = false
    if (effectiveBundle.images.length > 0) {
      let probedRefs = await Promise.all(
        effectiveBundle.images.map(async (ref) => ({
          ...(await this.mediaProbe.probeUrl(ref.url)),
          refKey: ref.refKey,
        })),
      )
      refPreflight = evaluateMediaRefPreflight(probedRefs, {
        blockWire: built.meta.refWire === 'agnes_keyframes' ? 'agnes_keyframes' : undefined,
      })
      if (refPreflight.level === 'error' && built.meta.refWire === 'agnes_keyframes') {
        const downscaled = await downscaleOversizedReferenceImages(upstreamImageRefs)
        if (downscaled.changed) {
          upstreamImageRefs = upstreamImageRefs.map((ref, index) => ({
            ...ref,
            url: downscaled.urls[index] ?? ref.url,
          }))
          probedRefs = downscaled.probed.map((item, index) => ({
            ...item,
            refKey: upstreamImageRefs[index]?.refKey ?? item.refKey,
          }))
          refPreflight = evaluateMediaRefPreflight(probedRefs, {
            blockWire: 'agnes_keyframes',
          })
          refDownscaled = true
        }
      }
      if (refPreflight.level === 'error' && built.meta.refWire === 'agnes_keyframes') {
        // 预检在扣费之前（记录先行 #277 形态）：拒绝时直接抛错，无需退款、无孤儿记录
        throw new BadRequestException(refPreflight.message)
      }
    }
    const record = await this.prisma.generationRecord.create({
      data: {
        userId,
        type: 'video',
        prompt: effectivePrompt,
        model: storeModel,
        status: 'generating',
        metadata: JSON.stringify(
          applyChargeMeta(
            {
              ...built.meta,
              duration,
              aspectRatio,
              resolution,
              crop,
              ...(resolvedVideoMode ? { videoMode: resolvedVideoMode } : {}),
              referenceImageCount: referenceBundle.images.length,
              referenceVideoCount: referenceBundle.videos.length,
              referenceImages: upstreamImageRefs.map(({ url }) => url),
              referenceVideos: effectiveBundle.videos.map(({ url }) => url),
              referenceAudios: effectiveBundle.audios.map(({ url }) => url),
              skippedMerge,
              mergedText,
              channelId: resolved.channelId,
              originalModel: model,
              providerSource: resolved.source,
              ...(refDownscaled ? { refDownscaled: true } : {}),
              ...(refPreflight && refPreflight.level === 'warn' ? { refPreflight } : {}),
              ...falH3MaxVideoRecordMeta({
                modelKey: resolved.modelName || model,
                hasStartImage: upstreamImageRefs.length > 0,
                credentialSource: resolved.source,
              }),
              ...minimaxH3VideoRecordMeta({
                modelKey: resolved.modelName || model,
                credentialSource: resolved.source,
              }),
            },
            durationCredits,
          ),
        ),
        ...withCanvasScope(scope),
      },
    })
    // 账本对齐 #277 形态：先建 generating 占位再扣费（携带 generationId）；
    // 扣费失败（积分不足）立即删除占位，不留孤儿。旧顺序（先扣费后建记录）有
    // 隐性泄漏——resolve/merge/预检阶段抛错时「已扣费、无记录、无退款」。
    try {
      await this.points.consume(
        userId,
        durationCredits,
        chargeReason,
        consumeMeta('video', { model: model ?? null, generationId: record.id }),
      )
    } catch (err) {
      await this.prisma.generationRecord
        .delete({ where: { id: record.id } })
        .catch(() => undefined)
      throw err
    }
    this.completeVideo(
      record.id,
      userId,
      durationCredits,
      chargeReason,
      effectivePrompt,
      providerOptions,
      resolved,
    ).catch(console.error)
    return record
  }

  async generateAudio(
    userId: string,
    text: string,
    options: {
      model?: string
      voice?: string
      emotion?: string
      language?: string
      speed?: number
      volume?: number
      pitch?: number
      kind?: string
      roles?: Array<{ role: string; voice: string }>
      scripts?: Array<{ role?: string; text: string }>
      instruction?: string
      caption?: string
      lyrics?: string
      instrumental?: boolean
    } = {},
    refs?: StudioRefInput[],
    mentionedKeys?: string[],
    cancel?: CancelFlag,
    scope?: CanvasGenerationScope,
  ) {
    // ⚠️ 先resolve 再定 cost：`music` 15 分、`voice`/`design` 5 分（见 plan §全局约束）。
    // kind 只能从 resolve 后的 modelName 判（用户可能传 `ch_xxx::model`），所以扣分点
    // 必须后移；扣分金额/文案与既有 voice 路径逐字节相同（cost=5、reason=音频生成）。
    const resolved = await this.resolver.resolveForGeneration(userId, options.model, 'audio')
    const kind: AudioKind = audioKindOf(getModelEntry(resolved.modelName) ?? { modality: 'audio' })
    const cost = kind === 'music' ? 15 : 5
    const chargeReason = kind === 'music' ? '音频生成-音乐' : '音频生成'
    await this.points.consume(
      userId,
      cost,
      chargeReason,
      consumeMeta('audio', { model: options.model ?? null, generationId: null }),
    )
    const { mergedText, skippedMerge } = await this.resolveMergedPrompt(
      text,
      refs,
      'audio',
      mentionedKeys,
      resolved.source === 'user' ? resolved.credentials : undefined,
      resolved.modelName,
    )
    const built = buildAudioRequest({
      mergedText,
      modelKey: resolved.modelName,
      voice: options.voice,
      emotion: options.emotion,
      language: options.language,
      speed: options.speed,
      volume: options.volume,
      pitch: options.pitch,
    })
    const audioOpts =
      resolved.source === 'user'
        ? { ...built.options, model: resolved.modelName }
        : built.options
    const storeModel =
      resolved.source === 'user' ? options.model ?? built.meta.modelKey : built.meta.modelKey

    try {
      assertStepFunAudioModel(kind, resolved.modelName)
      // R12：调用方声明的 kind 与模型分类必须一致。不一致时**显式拒绝** ——
      // 上面那行守卫只管「design/music 必须是阶跃模型」，管不了「声明 music 却拿着
      // TTS 模型」这种错配（那会让 voice 分支静默产出 TTS 并标 completed）。
      // 放在 try 内首两条 ⇒ 异常走既有 catch 的退款 + failed 记录链路，不吞积分。
      assertAudioKindMatchesModel(options.kind, resolved.modelName)
      if (resolved.source === 'user' && !resolved.credentials.apiKey) {
        throw new Error('missing api key')
      }
      if (kind === 'design') {
        // 综合音频走非 OpenAI 兼容的同步端点，返回裸字节（不是 data URL）。
        // 平台缺 key / 上游 402 / 模型不在目录都由既有 catch 显式退款报错，不静默回落。
        const apiKey = resolved.credentials.apiKey
        if (!apiKey) throw new Error('missing api key')
        const { buffer, contentType } = await new StepFunDesignProvider(
          apiKey,
          resolved.credentials.baseUrl,
        ).generate({
          roles: options.roles ?? [],
          scripts: options.scripts ?? [],
          instruction: options.instruction,
          responseFormat: 'mp3',
        })
        const stored = await this.upload.saveUserFile(userId, buffer, 'design.mp3', contentType)
        if (cancel?.isCancelled()) {
          await this.points.refund(
            userId,
            cost,
            `${chargeReason}-取消退款`,
            refundMeta('audio', 'cancelled_refund', {
              model: resolved.modelName,
              generationId: null,
            }),
          )
          throwCancelledException(cost)
        }
        const designRecord = await this.prisma.generationRecord.create({
          data: {
            userId,
            type: 'audio',
            prompt: mergedText,
            model: storeModel,
            url: stored.url,
            status: 'completed',
            metadata: JSON.stringify(
              applyChargeMeta(
                {
                  ...built.meta,
                  skippedMerge,
                  audioKind: kind,
                  channelId: resolved.channelId,
                  roles: options.roles,
                  scripts: options.scripts,
                  instruction: options.instruction,
                },
                cost,
              ),
            ),
            ...withCanvasScope(scope),
          },
        })
        return { ...designRecord, url: stored.url }
      }
      if (kind === 'music') {
        // 音乐是**异步任务**：submit + 轮询 query，官方 1–3 分钟，远超一次 HTTP 请求的耐心。
        // 故乐观扣分 → 建 `status:'generating'` 记录 → 立即返回，让前端既有轮询器接管
        // （`useGenerationPolling` 每 2s 查 `getGeneration`），**不新增轮询端点**。
        // 终态失败（含上游 HTTP 200 但 status=FAILED）在 completeMusic 里退款 + 写可判读文案。
        //
        // 下面这个缺 key 守卫**只对平台渠道可达**：BYOK 缺 key 已被上面的通用守卫
        // （`resolved.source === 'user' && !apiKey`）先一步抛走。两条路径殊途同归 ——
        // 都落进 catch，且 music 一律进 failed（见 catch 里的 `kind === 'music'` 注释）。
        const apiKey = resolved.credentials.apiKey
        if (!apiKey) throw new Error('missing api key')
        // 未显式给 caption 时回落正文：music 的 caption 就是「要生成什么曲子」的描述，
        // 与 voice 用 mergedText 同理，避免空 caption 打上游拿不到可判读的错误。
        const caption = options.caption ?? mergedText
        const musicRecord = await this.prisma.generationRecord.create({
          data: {
            userId,
            type: 'audio',
            prompt: mergedText,
            model: storeModel,
            status: 'generating',
            metadata: JSON.stringify(
              applyChargeMeta(
                {
                  ...built.meta,
                  skippedMerge,
                  audioKind: kind,
                  channelId: resolved.channelId,
                  caption,
                  lyrics: options.lyrics,
                  instrumental: options.instrumental,
                },
                cost,
              ),
            ),
            ...withCanvasScope(scope),
          },
        })
        this.completeMusic(
          musicRecord.id,
          userId,
          cost,
          chargeReason,
          {
            caption,
            lyrics: options.lyrics,
            instrumental: options.instrumental,
            responseFormat: 'mp3',
          },
          resolved,
        ).catch(console.error)
        return { ...musicRecord, generationStartedAt: new Date().toISOString() }
      }
      const { url } = await createAudioProvider(providerOpts(resolved)).generate(
        built.text,
        audioOpts,
      )
      const hasTtsData = url.startsWith('data:')
      const storeUrl = hasTtsData
        ? (
            await this.upload.saveUserFile(
              userId,
              decodeAudioDataUrl(url).buffer,
              'tts.mp3',
              'audio/mpeg',
            )
          ).url
        : url
      if (cancel?.isCancelled()) {
        await this.points.refund(
          userId,
          cost,
          `${chargeReason}-取消退款`,
          refundMeta('audio', 'cancelled_refund', {
            model: resolved.modelName,
            generationId: null,
          }),
        )
        throwCancelledException(cost)
      }
      const record = await this.prisma.generationRecord.create({
        data: {
          userId,
          type: 'audio',
          prompt: mergedText,
          model: storeModel,
          url: storeUrl,
          status: 'completed',
          metadata: JSON.stringify(
            applyChargeMeta(
              {
                ...built.meta,
                skippedMerge,
                voice: built.options.voice ?? options.voice ?? 'default',
                emotion: options.emotion ?? 'neutral',
                language: options.language ?? 'zh',
                speed: options.speed ?? 1,
                volume: options.volume,
                pitch: options.pitch,
                hasTtsData,
                audioKind: kind,
                channelId: resolved.channelId,
              },
              cost,
            ),
          ),
          ...withCanvasScope(scope),
        },
      })
      return { ...record, url }
    } catch (err) {
      if (isCancelledException(err)) throw err
      // 🔴 三类失败都**不得**变成「换平台重试」的重试入口，原因各不相同：
      //
      // 1. `kind !== 'voice'`（design / music）：`confirmPlatformFallback` 的 audio 分支
      //    （见下）**不读 `meta.audioKind`**，固定发 OpenAI 兼容 TTS —— design/music
      //    若挂上去，用户点「用平台重试」会拿到一段把 `stepaudio-3-gen-preview` /
      //    `stepaudio-3-music-preview` 当 TTS 模型发出去的语音，并被标成 completed。
      //    与 music 同源：平台重放要支持 design/music 属后续范围；在此之前，
      //    失败必须显式可判读。voice 是唯一**语义与 TTS 重放一致**的分类，
      //    故它的既有 fallback_pending 行为逐字节不变。
      //    （此分支同时覆盖 BYOK design/music 缺 key：通用守卫先于分类分支抛错。）
      //
      // 2. 🔴 Ruling R14 `err instanceof BadRequestException`：**客户端参数校验类**失败
      //    （`assertAudioKindMatchesModel` 的 kind↔模型不匹配、`assertStepFunAudioModel` 的
      //    「design/music 给了非阶跃模型」）换渠道重试**必然还是同样的错** —— 用户点一下
      //    只会再失败一次，且中途平台会拿 design/music 的模型名去发 TTS 请求。
      //    这类失败不是「渠道故障」，重试入口是误导，必须显式失败。
      //    按**异常类型**分流而非状态码：上游 4xx 由 provider 包成普通 `Error`
      //    （见 audio-provider.ts 的 `TTS API ${res.status}`），仍算渠道侧问题，保留重试。
      //
      // 3. 其余（非 user 渠道）：既有行为，平台失败一律 failed。
      if (resolved.source !== 'user' || kind !== 'voice' || err instanceof BadRequestException) {
        await this.points.refund(
          userId,
          cost,
          `${chargeReason}-失败退款`,
          refundMeta('audio', 'failed_refund', {
            model: resolved.modelName,
            generationId: null,
          }),
        )
        const failedMeta = applyFailureDiagnosticMeta(
          applyRefundMeta(
            applyChargeMeta(
              {
                ...built.meta,
                skippedMerge,
                voice: built.options.voice ?? options.voice ?? 'default',
                emotion: options.emotion ?? 'neutral',
                language: options.language ?? 'zh',
                speed: options.speed ?? 1,
                volume: options.volume,
                pitch: options.pitch,
                audioKind: kind,
                channelId: resolved.channelId,
              },
              cost,
            ),
            cost,
            'platform_failed',
          ),
          err,
          { userMessage: audioFailureMessage(kind, err, resolved.channelId) },
        )
        const failed = await this.prisma.generationRecord.create({
          data: {
            userId,
            type: 'audio',
            prompt: mergedText,
            model: storeModel,
            url: null,
            status: 'failed',
            metadata: JSON.stringify(failedMeta),
            ...withCanvasScope(scope),
          },
        })
        throwGenerationFailure({
          userMessage: String(failedMeta.userMessage ?? '生成失败'),
          errorCode: failedMeta.errorCode as ErrorCode,
          taskId: failed.id,
          refundedPoints: cost,
        })
      }
      await this.points.refund(
        userId,
        cost,
        `${chargeReason}-BYOK失败退款`,
        refundMeta('audio', 'byok_refund', {
          model: resolved.modelName,
          generationId: null,
        }),
      )
      const record = await this.prisma.generationRecord.create({
        data: {
          userId,
          type: 'audio',
          prompt: mergedText,
          model: storeModel,
          url: null,
          status: 'fallback_pending',
          metadata: JSON.stringify(
            this.byokPendingMeta(resolved, err, cost, {
              ...built.meta,
              originalModel: options.model,
              skippedMerge,
              voice: options.voice,
              emotion: options.emotion,
              language: options.language,
              speed: options.speed,
              volume: options.volume,
              pitch: options.pitch,
              audioKind: kind,
              audioOptions: audioOpts,
            }),
          ),
          ...withCanvasScope(scope),
        },
      })
      return record
    }
  }

  async confirmPlatformFallback(userId: string, recordId: string, cancel?: CancelFlag) {
    const record = await this.getGeneration(userId, recordId)
    if (record.status !== 'fallback_pending') {
      throw new BadRequestException('当前状态不可确认平台回退')
    }
    const meta = parseMeta(record.metadata)
    const platformCost = this.platformFallbackCost(record.type, meta)
    const pointCategory = studioPointCategory(record.type)
    const pointExtra = {
      model: record.model ?? null,
      generationId: record.id,
    }
    await this.points.consume(
      userId,
      platformCost,
      '平台回退生成',
      consumeMeta(pointCategory, pointExtra),
    )
    const chargedMeta = { ...meta, chargedPoints: platformCost, priorByokRefunded: true }

    try {
      if (record.type === 'image') {
        const size = String(meta.size ?? '1024x1024')
        const resolution = typeof meta.nativeParams === 'object' && meta.nativeParams
          ? (meta.nativeParams as Record<string, unknown>).resolution
          : undefined
        const n = Number(meta.count ?? 1) || 1
        const modelId = this.platformGatewayModelId('image', meta)
        const refs = Array.isArray(meta.referenceImages)
          ? (meta.referenceImages as string[]).filter((url) => typeof url === 'string' && url.trim())
          : []
        const useNativeRefs = refs.length > 0 && meta.refImageMode === 'native'
        const prompt = useNativeRefs ? stripRefImagePromptTags(record.prompt) : record.prompt
        const modelKey =
          typeof meta.modelKey === 'string' && meta.modelKey.trim()
            ? meta.modelKey
            : undefined
        const providerRefs = useNativeRefs ? await inlineUpstreamReferenceImages(refs) : undefined
        const { url, urls } = await createImageProvider(
          resolvePlatformImageProviderOpts(modelKey ?? modelId),
        ).generate(prompt, {
          size,
          resolution: typeof resolution === 'string' ? resolution : undefined,
          n,
          modelId,
          referenceImages: providerRefs,
          refWire:
            meta.refWire === 'agnes_extra_body' ||
            meta.refWire === 'apimart_image_urls' ||
            meta.refWire === 'legacy_prompt_tags' ||
            meta.refWire === 'none'
              ? (meta.refWire as ImageRefWire)
              : undefined,
          responseMode:
            meta.responseMode === 'async_task' || meta.responseMode === 'sync_url'
              ? meta.responseMode
              : undefined,
          quality:
            typeof meta.nativeParams === 'object' &&
            meta.nativeParams &&
            typeof (meta.nativeParams as Record<string, unknown>).quality === 'string'
              ? ((meta.nativeParams as Record<string, unknown>).quality as string)
              : undefined,
        })
        const imageUrls = urls?.length ? urls : [url]
        if (cancel?.isCancelled()) {
          await this.points.refund(
            userId,
            platformCost,
            '平台回退-取消退款',
            refundMeta(pointCategory, 'cancelled_refund', pointExtra),
          )
          throwCancelledException(platformCost)
        }
        return this.prisma.generationRecord.update({
          where: { id: record.id },
          data: {
            url: imageUrls[0],
            status: 'completed',
            metadata: JSON.stringify({
              ...chargedMeta,
              urls: imageUrls,
              gatewayModelId: modelId,
              providerFallback: true,
              channelId: 'platform',
            }),
          },
        })
      }

      if (record.type === 'text' || record.type === 'prompt') {
        const gatewayModelId = this.platformGatewayModelId('text', meta)
        const referenceImages = Array.isArray(meta.referenceImages)
          ? (meta.referenceImages as string[])
          : []
        let text: string
        let promptMeta: Record<string, unknown> = {}
        if (record.type === 'prompt') {
          const guideSceneId =
            typeof meta.guideSceneId === 'string' && meta.guideSceneId.trim()
              ? meta.guideSceneId.trim()
              : undefined
          const { mode, content, visionUsed } = await generatePromptFromUserInput(record.prompt, {
            model: gatewayModelId,
            apiKey: process.env.OPENAI_API_KEY,
            baseUrl: process.env.OPENAI_BASE_URL,
            guideSceneId,
            referenceImages: referenceImages.length
              ? await inlineUpstreamReferenceImages(referenceImages)
              : referenceImages,
            mentionedKeys: Array.isArray(meta.mentionedKeys)
              ? (meta.mentionedKeys as string[])
              : undefined,
          })
          text = content
          promptMeta = {
            mode,
            content,
            visionUsed,
            referenceImages,
            ...(guideSceneId ? { guideSceneId } : {}),
          }
        } else if (referenceImages.length > 0) {
          const providerRefs = await inlineUpstreamReferenceImages(referenceImages)
          const result = await generateTextForRefs(record.prompt, providerRefs, {
            model: gatewayModelId,
            apiKey: process.env.OPENAI_API_KEY,
            baseUrl: process.env.OPENAI_BASE_URL,
          })
          text = result.text
        } else {
          const result = await createTextProvider(undefined).generate(record.prompt, gatewayModelId)
          text = result.text
        }
        if (cancel?.isCancelled()) {
          await this.points.refund(
            userId,
            platformCost,
            '平台回退-取消退款',
            refundMeta(pointCategory, 'cancelled_refund', pointExtra),
          )
          throwCancelledException(platformCost)
        }
        return this.prisma.generationRecord.update({
          where: { id: record.id },
          data: {
            status: 'completed',
            metadata: JSON.stringify({
              ...chargedMeta,
              ...promptMeta,
              text: record.type === 'text' ? text : meta.text,
              gatewayModelId,
              providerFallback: true,
              channelId: 'platform',
            }),
          },
        })
      }

      if (record.type === 'audio') {
        const platformModel = this.platformGatewayModelId('audio', meta)
        const prevAudio = (meta.audioOptions as Record<string, unknown> | undefined) ?? {}
        const audioOptions = {
          ...prevAudio,
          model: platformModel,
          voice: prevAudio.voice ?? meta.voice,
          speed: prevAudio.speed ?? meta.speed,
          volume: prevAudio.volume ?? meta.volume,
          pitch: prevAudio.pitch ?? meta.pitch,
        }
        const fallback = resolvePlatformAudioFallback(platformModel)
        if (!fallback.ok) throw new Error(fallback.reason)
        const { url } = await createAudioProvider(fallback.credentials).generate(
          record.prompt,
          audioOptions as { model?: string; voice?: string; speed?: number; volume?: number; pitch?: number },
        )
        const hasTtsData = url.startsWith('data:')
        const storeUrl = hasTtsData
          ? (
              await this.upload.saveUserFile(
                record.userId,
                decodeAudioDataUrl(url).buffer,
                'tts.mp3',
                'audio/mpeg',
              )
            ).url
          : url
        if (cancel?.isCancelled()) {
          await this.points.refund(
            userId,
            platformCost,
            '平台回退-取消退款',
            refundMeta(pointCategory, 'cancelled_refund', pointExtra),
          )
          throwCancelledException(platformCost)
        }
        return this.prisma.generationRecord.update({
          where: { id: record.id },
          data: {
            url: storeUrl,
            status: 'completed',
            metadata: JSON.stringify({
              ...chargedMeta,
              audioOptions,
              gatewayModelId: platformModel,
              hasTtsData,
              providerFallback: true,
              channelId: 'platform',
            }),
          },
        })
      }

      if (record.type === 'video') {
        const platformModel = this.platformGatewayModelId('video', meta)
        const { url } = await createVideoProvider(undefined).generate(record.prompt, {
          model: platformModel,
          duration: Number(meta.duration ?? 5),
          aspectRatio: String(meta.aspectRatio ?? '16:9'),
          resolution: String(meta.resolution ?? '720p'),
          crop: meta.crop === undefined ? undefined : String(meta.crop),
          image: Array.isArray(meta.referenceImages)
            ? (meta.referenceImages as string[])[0]
            : undefined,
        })
        if (cancel?.isCancelled()) {
          await this.points.refund(
            userId,
            platformCost,
            '平台回退-取消退款',
            refundMeta(pointCategory, 'cancelled_refund', pointExtra),
          )
          throwCancelledException(platformCost)
        }
        return this.prisma.generationRecord.update({
          where: { id: record.id },
          data: {
            url,
            status: 'completed',
            metadata: JSON.stringify({
              ...chargedMeta,
              gatewayModelId: platformModel,
              providerFallback: true,
              channelId: 'platform',
            }),
          },
        })
      }

      throw new BadRequestException('不支持的生成类型')
    } catch (err) {
      if (isCancelledException(err)) {
        const cancelledMeta = applyFailureDiagnosticMeta(
          applyRefundMeta(chargedMeta, platformCost, 'cancelled'),
          err,
          { errorCode: 'cancelled', userMessage: '已取消' },
        )
        await this.prisma.generationRecord.update({
          where: { id: record.id },
          data: {
            status: 'failed',
            metadata: JSON.stringify(cancelledMeta),
          },
        })
        throw err
      }
      if (err instanceof BadRequestException && err.message === '不支持的生成类型') {
        await this.points.refund(
          userId,
          platformCost,
          '平台回退失败退款',
          refundMeta(pointCategory, 'failed_refund', pointExtra),
        )
        rethrowWithRefundedPoints(err, platformCost)
      }
      await this.points.refund(
        userId,
        platformCost,
        '平台回退失败退款',
        refundMeta(pointCategory, 'failed_refund', pointExtra),
      )
      const failedMeta = applyFailureDiagnosticMeta(
        applyRefundMeta(chargedMeta, platformCost, 'platform_fallback_failed'),
        err,
      )
      await this.prisma.generationRecord.update({
        where: { id: record.id },
        data: {
          status: 'failed',
          metadata: JSON.stringify(failedMeta),
        },
      })
      throwGenerationFailure({
        userMessage: String(failedMeta.userMessage ?? '生成失败'),
        errorCode: failedMeta.errorCode as ErrorCode,
        taskId: record.id,
        refundedPoints: platformCost,
      })
    }
  }

  async cancelPlatformFallback(userId: string, recordId: string) {
    const record = await this.getGeneration(userId, recordId)
    if (record.status !== 'fallback_pending') {
      throw new BadRequestException('当前状态不可取消平台回退')
    }
    const meta = parseMeta(record.metadata)
    if (!alreadyRefunded(meta)) {
      const cost =
        typeof meta.chargedPoints === 'number'
          ? meta.chargedPoints
          : this.platformFallbackCost(record.type, meta)
      await this.points.refund(
        userId,
        cost,
        '平台回退取消退款',
        refundMeta(studioPointCategory(record.type), 'cancelled_refund', {
          model: record.model ?? null,
          generationId: record.id,
        }),
      )
    }
    const byokErrorRaw =
      (typeof meta.byokErrorRaw === 'string' && meta.byokErrorRaw.trim()
        ? meta.byokErrorRaw
        : undefined)
      ?? (typeof meta.errorRaw === 'string' && meta.errorRaw.trim() && meta.errorRaw !== '已取消'
        ? meta.errorRaw
        : undefined)
    const cancelledMeta: Record<string, unknown> = {
      ...meta,
      cancelled: true,
      ...(byokErrorRaw ? { byokErrorRaw, errorRaw: byokErrorRaw } : {}),
      errorCode: 'cancelled',
      userMessage: byokErrorRaw
        ? `已取消平台回退。原 BYOK 错误：${byokErrorRaw.slice(0, 500)}`
        : '已取消',
      failedAt: new Date().toISOString(),
    }
    return this.prisma.generationRecord.update({
      where: { id: record.id },
      data: {
        status: 'failed',
        metadata: JSON.stringify(cancelledMeta),
      },
    })
  }

  async cancelGeneration(userId: string, recordId: string) {
    const record = await this.getGeneration(userId, recordId)
    if (record.status !== 'generating') {
      throw new BadRequestException('当前状态不可取消')
    }
    const meta = parseMeta(record.metadata)
    const cost = typeof meta.chargedPoints === 'number' ? meta.chargedPoints : 0
    const chargeReason =
      record.type === 'video'
        ? '视频生成'
        : record.type === 'image'
          ? '图像生成'
          : record.type === 'image_edit'
            ? '图像精修'
            : '生成'
    let updatedMeta: Record<string, unknown> = { ...meta, cancelled: true }
    if (cost > 0 && !alreadyRefunded(meta)) {
      await this.points.refund(
        userId,
        cost,
        `${chargeReason}-取消退款`,
        refundMeta(studioPointCategory(record.type), 'cancelled_refund', {
          model: record.model ?? null,
          generationId: record.id,
        }),
      )
      updatedMeta = applyRefundMeta(updatedMeta, cost, 'cancelled')
    }
    updatedMeta = applyFailureDiagnosticMeta(updatedMeta, new Error('已取消'), {
      errorCode: 'cancelled',
      userMessage: '已取消',
    })
    return this.prisma.generationRecord.update({
      where: { id: record.id },
      data: {
        status: 'failed',
        metadata: JSON.stringify(updatedMeta),
      },
    })
  }

  private async completeVideo(
    id: string,
    userId: string,
    cost: number,
    chargeReason: string,
    prompt: string,
    options: import('@lnkpi/agent').VideoProviderGenerateOptions,
    resolved: ResolvedGenerationProvider,
  ) {
    try {
      if (resolved.source === 'user' && !resolved.credentials.apiKey) {
        throw new Error('missing api key')
      }
      const { url, lastFrameUrl } = await createVideoProvider({
        ...providerOpts(resolved),
        model: resolved.modelName,
      }).generate(
        prompt,
        options,
      )
      const existing = await this.prisma.generationRecord.findFirst({ where: { id } })
      if (!existing || existing.status !== 'generating') return
      const meta = parseMeta(existing.metadata)
      if (isCancelledMeta(meta) || alreadyRefunded(meta)) return
      const referenceUrls = [
        ...(Array.isArray(meta.referenceImages) ? (meta.referenceImages as string[]) : []),
        ...(Array.isArray(meta.referenceVideos) ? (meta.referenceVideos as string[]) : []),
        ...(Array.isArray(meta.referenceAudios) ? (meta.referenceAudios as string[]) : []),
      ].filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
      const mediaInfo = await this.enrichVideoMediaInfoDimensions(
        await this.buildMediaInfo(url, referenceUrls),
        lastFrameUrl,
      )
      const updated = await this.prisma.generationRecord.updateMany({
        where: { id, status: 'generating' },
        data: {
          url,
          status: 'completed',
          metadata: JSON.stringify({
            ...meta,
            ...(lastFrameUrl ? { lastFrameUrl } : {}),
            mediaInfo,
          }),
        },
      })
      if (updated.count === 0) return
    } catch (err) {
      console.error('Video generation failed:', err)
      const existing = await this.prisma.generationRecord.findFirst({ where: { id } })
      if (!existing || existing.status !== 'generating') return
      const meta = parseMeta(existing.metadata)
      if (isCancelledMeta(meta) || alreadyRefunded(meta)) return
      if (resolved.source === 'user') {
        await this.points.refund(
          userId,
          cost,
          `${chargeReason}-BYOK失败退款`,
          refundMeta('video', 'byok_refund', {
            model: resolved.modelName,
            generationId: id,
          }),
        )
        await this.prisma.generationRecord.update({
          where: { id },
          data: {
            status: 'fallback_pending',
            metadata: JSON.stringify(this.byokPendingMeta(resolved, err, cost, meta)),
          },
        })
        return
      }
      await this.points.refund(
        userId,
        cost,
        `${chargeReason}-失败退款`,
        refundMeta('video', 'failed_refund', {
          model: resolved.modelName,
          generationId: id,
        }),
      )
      const failedMeta = applyFailureDiagnosticMeta(
        applyRefundMeta(meta, cost, 'platform_failed'),
        err,
      )
      await this.prisma.generationRecord.update({
        where: { id },
        data: {
          status: 'failed',
          metadata: JSON.stringify(failedMeta),
        },
      })
    }
  }

  /**
   * 音乐异步任务的终态收敛（2026-10-06 audio-node-unified-capability Task 7）。
   *
   * 🔴 上游终态 `FAILED` 时 HTTP 仍是 200 ⇒ provider 层按 `status` 字段判失败并抛错，
   * 这里据此退款 + 把可判读文案（`audioFailureMessage('music', ...)`）写进 metadata，
   * 前端轮询到 `failed` 后由 `buildPollingFailurePatch` 展示。**绝不静默当成功。**
   *
   * ⚠️ 失败一律进 `failed`，**不进 `fallback_pending`**：`confirmPlatformFallback` 的 audio
   * 分支固定走 `createAudioProvider`（TTS），音乐若挂上fallback_pending，用户点「用平台重试」
   * 会被静默重放成一段 TTS 语音 —— 比直接失败更坏。平台重放要支持 music 属Task 8+ 的范围。
   * （提交**前**的失败由 `generateAudio` 的共享 catch 用`kind !== 'voice'` 保证同一不变量 ——
   *  design 与 music 同理：`stepaudio-3-gen-preview` 同样会被重放成 TTS。）
   */
  private async completeMusic(
    id: string,
    userId: string,
    cost: number,
    chargeReason: string,
    input: StepFunMusicInput,
    resolved: ResolvedGenerationProvider,
  ) {
    try {
      const apiKey = resolved.credentials.apiKey
      if (!apiKey) throw new Error('missing api key')
      const { buffer } = await new StepFunMusicProvider(
        apiKey,
        resolved.credentials.baseUrl,
      ).generate(input)
      const stored = await this.upload.saveUserFile(userId, buffer, 'music.mp3', 'audio/mpeg')
      const existing = await this.prisma.generationRecord.findFirst({ where: { id } })
      if (!existing || existing.status !== 'generating') return
      const meta = parseMeta(existing.metadata)
      // 用户在生成期间取消过 ⇒ 退款已由 cancelGeneration 结算，勿重复写/重复退。
      if (isCancelledMeta(meta) || alreadyRefunded(meta)) return
      const updated = await this.prisma.generationRecord.updateMany({
        where: { id, status: 'generating' },
        data: {
          url: stored.url,
          status: 'completed',
          metadata: JSON.stringify(meta),
        },
      })
      if (updated.count === 0) return
    } catch (err) {
      console.error('Music generation failed:', err)
      const existing = await this.prisma.generationRecord.findFirst({ where: { id } })
      if (!existing || existing.status !== 'generating') return
      const meta = parseMeta(existing.metadata)
      if (isCancelledMeta(meta) || alreadyRefunded(meta)) return
      await this.points.refund(
        userId,
        cost,
        `${chargeReason}-失败退款`,
        refundMeta('audio', 'failed_refund', {
          model: resolved.modelName,
          generationId: id,
        }),
      )
      const failedMeta = applyFailureDiagnosticMeta(
        applyRefundMeta(meta, cost, 'platform_failed'),
        err,
        { userMessage: audioFailureMessage('music', err, resolved.channelId) },
      )
      await this.prisma.generationRecord.update({
        where: { id },
        data: {
          status: 'failed',
          metadata: JSON.stringify(failedMeta),
        },
      })
    }
  }
}
