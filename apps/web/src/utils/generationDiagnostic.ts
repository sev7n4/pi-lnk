import type { ErrorCode, GenerationDiagnostic, TaskKind } from '@lnkpi/shared'
import { formatDiagnosticCopy, modelOptionName } from '@lnkpi/shared'
import type { GenerationRecord } from '@/services/studio-api'
import { NODE_GENERATION_STATUS } from '@/constants/dockStudio'
import {
  extractRefundedPointsFromError,
  extractStructuredGenerationFields,
  formatGenerationFailureMessage,
  parseRefundedPointsFromMetadata,
} from '@/utils/generationPointsMessage'

export type { ErrorCode, GenerationDiagnostic, TaskKind }
export { formatDiagnosticCopy }

export interface DiagnosticNodeContext {
  nodeId?: string
  nodeLabel?: string
  sessionId?: string
}

export function buildCopyForNode(
  diag: GenerationDiagnostic,
  ctx: DiagnosticNodeContext,
): string {
  return formatDiagnosticCopy({
    ...diag,
    nodeId: ctx.nodeId ?? diag.nodeId,
    nodeLabel: ctx.nodeLabel ?? diag.nodeLabel,
    sessionId: ctx.sessionId ?? diag.sessionId,
  })
}

export interface ShortGenerationError {
  userMessage: string
  errorCode?: ErrorCode
  taskKind?: TaskKind
  taskId?: string
  refundedPoints?: number
}

export function parseShortGenerationError(err: unknown): ShortGenerationError {
  const structured = extractStructuredGenerationFields(err)
  const refundedPoints =
    structured.refundedPoints ?? extractRefundedPointsFromError(err)
  const errForFormat = structured.userMessage
    ? { response: { data: { message: structured.userMessage } } }
    : err
  const userMessage = formatGenerationFailureMessage(errForFormat, refundedPoints)

  return {
    userMessage,
    errorCode: structured.errorCode,
    taskKind: structured.taskKind,
    taskId: structured.taskId,
    refundedPoints,
  }
}

export function parseErrorCodeFromMetadata(metadata?: string | null): ErrorCode | undefined {
  if (!metadata) return undefined
  try {
    const meta = JSON.parse(metadata) as { errorCode?: unknown }
    return parseShortGenerationError({
      response: { data: { errorCode: meta.errorCode } },
    }).errorCode
  } catch {
    return undefined
  }
}

export function buildPollingFailurePatch(opts: {
  metadata?: string | null
  generationRecordId?: string
  materialId?: string
}): Record<string, unknown> {
  const refundedPoints = parseRefundedPointsFromMetadata(opts.metadata)
  const errorCode = parseErrorCodeFromMetadata(opts.metadata)
  const patch: Record<string, unknown> = {
    status: NODE_GENERATION_STATUS.error,
    errorMessage: refundedPoints
      ? formatGenerationFailureMessage(new Error('生成失败'), refundedPoints)
      : '生成失败',
  }
  if (opts.generationRecordId) patch.generationRecordId = opts.generationRecordId
  if (opts.materialId) patch.materialId = opts.materialId
  if (errorCode) patch.errorCode = errorCode
  return patch
}

export interface DiagnosticCache {
  get(
    taskKind: TaskKind,
    taskId: string,
    fetcher: () => Promise<GenerationDiagnostic>,
  ): Promise<GenerationDiagnostic>
  clear(taskId?: string): void
}

export function createDiagnosticCache(): DiagnosticCache {
  const inflight = new Map<string, Promise<GenerationDiagnostic>>()

  return {
    get(taskKind, taskId, fetcher) {
      const key = `${taskKind}:${taskId}`
      const existing = inflight.get(key)
      if (existing) return existing

      const promise = fetcher().catch((error) => {
        inflight.delete(key)
        throw error
      })
      inflight.set(key, promise)
      return promise
    },
    clear(taskId) {
      if (taskId === undefined) {
        inflight.clear()
        return
      }
      for (const key of inflight.keys()) {
        if (key.endsWith(`:${taskId}`)) {
          inflight.delete(key)
        }
      }
    },
  }
}

/** Session-scoped cache shared by node ⓘ popover and Dock failure chip. */
export const sharedDiagnosticCache = createDiagnosticCache()

export function parseGenerationRecordMeta(metadata?: string | null): Record<string, unknown> {
  if (!metadata) return {}
  try {
    return JSON.parse(metadata) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function isFailedGenerationStatus(status: string): boolean {
  return (
    status === 'failed' ||
    status === 'error' ||
    status === NODE_GENERATION_STATUS.fallback_pending
  )
}

/** 后端 droppedFields 的字段名 → 用户可读标签。未登记的字段直接透出原名，不静默吞掉。 */
export const DROPPED_FIELD_LABEL: Record<string, string> = {
  generateAudio: '音轨',
  seed: '随机种子',
  negativePrompt: '负面提示词',
  crop: '裁切',
  referenceVideos: '参考视频',
  referenceAudios: '参考音频',
  referenceImages: '参考图',
  duration: '时长',
  aspectRatio: '画面比例',
  resolution: '分辨率',
}

/**
 * 把后端 metadata 里的 `droppedFields` 变成一句用户能读的话。
 *
 * ⚠️ 2026-10-04 新增。生产上`droppedFields` 只写进 metadata、前端零渲染 ⇒
 * 用户点了「生成带音轨视频」，模型不支持时**既没报错也没反馈**，只是安静地
 * 少了一个能力（Agnes 335 次诚实丢弃 + Seedance 16 次误丢，用户全都看不见）。
 * 见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.3
 */
export function describeDroppedFields(
  dropped: ReadonlyArray<{ field?: unknown }> | null | undefined,
): string | null {
  if (!Array.isArray(dropped) || dropped.length === 0) return null
  const names: string[] = []
  const seen = new Set<string>()
  for (const item of dropped) {
    const field = typeof item?.field === 'string' ? item.field.trim() : ''
    if (!field || seen.has(field)) continue
    seen.add(field)
    names.push(DROPPED_FIELD_LABEL[field] ?? field)
  }
  if (names.length === 0) return null
  return `以下参数当前模型不支持，已忽略：${names.join('、')}`
}

/** 从 record.metadata 里读出被丢弃的参数说明（成功态也可能有）。 */
export function getDroppedFieldsNotice(metadata?: string | null): string | null {
  const meta = parseGenerationRecordMeta(metadata)
  return describeDroppedFields(
    meta.droppedFields as ReadonlyArray<{ field?: unknown }> | undefined,
  )
}

/**
 * 模型被换成默认模型时的一句用户可读提示（成功态也可能有）。
 *
 * ⚠️ 2026-10-08 新增。`modelFallback` 只写进 metadata、前端零渲染 ⇒
 * 用户选了 Seedance、实际生成 Agnes，**页面不报错且照扣 30 积分**
 * （生产 `completed` 且 `originalModel != modelKey` 共 1206 笔）。
 *
 * ⛔ 防误报闸门（本函数的主要复杂度都花在这里）：生产 `modelFallback`
 * 命中 1653 笔、`completed` 1206 笔，但**拿「真正发给上游的 id」逐条核对后，
 * 真降级只有 54 笔**（BYOK 44 + platform 10）：
 *
 * - 1196 笔 BYOK 记录的 `originalModel = 'userId::agnes-image-2.0-flash'`、
 *   `modelKey = 'agnes-image-2.1-flash'` —— 看着像换了模型，但
 *   `modelId`（= 真正投递值，见下）就是 2.0-flash，**根本没换**。
 * - 那 10 笔 platform 是真降级：`originalModel=seedance-2.0-mini`，
 *   实际生成 `agnes-video-v2.0`，照扣 30 积分。
 *
 * ⇒ 因此判据必须是「请求的模型」vs「**真正发出去的**模型」。
 * ⛔ 而「真正发出去的」在不同链路落在不同字段，且同名 `gatewayModelId`
 * 在 BYOK 场景是 adapter 内部口径而非实际投递值 —— 见 `pickModelId` 处的实测记录。
 * 拿 `metadata.modelKey` 比会误报 1196 次，比用户看到静默更糟。
 */
export function describeModelFallback(meta: Record<string, unknown>): string | null {
  if (meta.modelFallback !== true) return null
  const requested = typeof meta.originalModel === 'string' ? meta.originalModel.trim() : ''
  if (!requested) return null
  // ⛔ 字段优先级是**实测定的，不能换**：
  // 生产 BYOK 记录里 `gatewayModelId=agnes-image-2.1-flash` 与
  // `modelId=agnes-image-2.0-flash` 同时存在且互相矛盾 —— 前者是
  // generation-adapter 的内部解析口径，后者才是 studio.service.ts:1171
  // 真正交给上游的（`resolved.source === 'user' ? resolved.modelName : ...`）。
  // 先取 gatewayModelId 会把 1196 笔没换模型的记录全误报成降级。
  const dispatchedRaw =
    pickModelId(meta.modelId) ?? pickModelId(meta.gatewayModelId)
  if (!dispatchedRaw) return null
  // 渠道 ref（`userId::model`）与裸 id 视为同一模型，先归一再比。
  const requestedName = modelOptionName(requested)
  const dispatchedName = modelOptionName(dispatchedRaw)
  if (requestedName === dispatchedName) return null
  return `所选模型「${requestedName}」当前不可用，已用「${dispatchedName}」生成（按原计划扣费）`
}

function pickModelId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function getModelFallbackNotice(metadata?: string | null): string | null {
  return describeModelFallback(parseGenerationRecordMeta(metadata))
}

export function getRecordFailureMessage(
  record: Pick<GenerationRecord, 'status' | 'metadata'>,
): string | null {
  const meta = parseGenerationRecordMeta(record.metadata)
  const notices = [
    describeDroppedFields(
      meta.droppedFields as ReadonlyArray<{ field?: unknown }> | undefined,
    ),
    describeModelFallback(meta),
  ].filter((n): n is string => !!n)
  const combinedNotice = notices.length > 0 ? notices.join('；') : null
  if (!isFailedGenerationStatus(record.status)) {
    // 成功态也返回提示：能力被丢弃/模型被替换不是错误，但用户必须看得见
    return combinedNotice
  }
  if (typeof meta.userMessage === 'string' && meta.userMessage) return meta.userMessage
  const byok =
    (typeof meta.byokErrorRaw === 'string' && meta.byokErrorRaw) ||
    (typeof meta.errorRaw === 'string' && meta.errorRaw) ||
    ''
  if (record.status === NODE_GENERATION_STATUS.fallback_pending) {
    const base = byok ? `平台回退待确认：${byok.slice(0, 240)}` : '平台回退待确认'
    return combinedNotice ? `${base}；${combinedNotice}` : base
  }
  if (byok) {
    const raw = byok.slice(0, 240)
    return combinedNotice ? `${raw}；${combinedNotice}` : raw
  }
  return combinedNotice ?? '生成失败'
}

export function buildFallbackDiagnostic(record: GenerationRecord): GenerationDiagnostic {
  const meta = parseGenerationRecordMeta(record.metadata)
  const isFallback = record.status === NODE_GENERATION_STATUS.fallback_pending
  const byok =
    (typeof meta.byokErrorRaw === 'string' && meta.byokErrorRaw) ||
    (typeof meta.errorRaw === 'string' && meta.errorRaw) ||
    ''
  return {
    userMessage: getRecordFailureMessage(record) || '生成失败',
    code: isFallback
      ? 'fallback_pending'
      : ((parseErrorCodeFromMetadata(record.metadata) as ErrorCode | undefined) || 'unknown'),
    taskKind: 'generation',
    taskId: record.id,
    occurredAt: record.createdAt,
    channelId: typeof meta.channelId === 'string' ? meta.channelId : null,
    model: record.model ?? (typeof meta.originalModel === 'string' ? meta.originalModel : null),
    providerSnippet: byok ? byok.slice(0, 2048) : null,
    hint: isFallback ? '请确认是否使用平台回退继续，或取消本次生成。' : undefined,
  }
}
