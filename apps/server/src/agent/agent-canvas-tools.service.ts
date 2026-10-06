import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common'
import { parseVisionQaJson, type ParsedVisionQaJson } from '@lnkpi/agent'
import { CANVAS_ACTION_APPLIER, defaultCanvasActionApplier } from './canvas-action-applier'
import type { ProviderContext, ProviderSource } from '../provider/provider-context'
import {
  audioKindOf,
  computeImportTranslation,
  decodeChannelModel,
  duplicateResultToCanvasActions,
  duplicateSubgraph,
  getGenerationScene,
  getModelEntry,
  isProductFourPanelPrompt,
  SUPPORTED_ASPECT_RATIOS,
  isRootNode,
  normalizeModelRef,
  remapWorkflowIds,
  resolveDuplicateSourceIds,
  resolveNodeRefs,
  resolveCanonicalVideoRequest,
  summarizePromptCompletion,
  validateWorkflow,
  type AudioKind,
  type CanvasAction,
  type CanvasActionApplier,
  type CanvasData,
  type CanvasEdge,
  type CanvasNode,
  type DuplicateCanvasNode,
  type LocalRefBinding,
  type NodeType,
  type SidebarAttachment,
  validateSidebarAttachments,
} from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'
import { PersistRemoteService } from '../assets/persist-remote.service'
import { PUBLIC_ASSETS } from '../assets/public-assets.data'
import { MaterialService } from '../canvas/material.service'
import { sanitizeAgentMessageContent } from './agentMessageSanitize'
import { StudioService, type StudioRefInput } from '../studio/studio.service'
import { ImageSliceService } from '../studio/image-slice.service'
import { VideoGenerationOrchestrator } from '../studio/video-generation.orchestrator'
import { PLATFORM_CHANNEL_ID, ProviderService } from '../provider/provider.service'
import {
  applyLayoutOps,
  createGroupFromNodes,
  getAbsolutePosition,
  getNodeSize,
  layoutNodesAlongEdges,
  layoutNodesInGrid,
  moveNodes,
  summarizeLayoutGroups,
  type CanvasLayoutOp,
  type CanvasLayoutOpResult,
  type LayoutNode,
  ungroupNode,
} from './canvas-layout.util'

const GRID_X = 280
const GRID_Y = 220
const DEFAULT_POLL_INTERVAL_MS = 1500
const DEFAULT_POLL_TIMEOUT_MS = 180_000
const STAGE_TTL_MS = 30 * 60 * 1000

let nodeSeq = 0

function nextNodeId(type: string) {
  return `${type}-${Date.now()}-${++nodeSeq}`
}

function edgeId(source: string, target: string) {
  return `e-${source}-${target}`
}

function parseCanvas(raw: string | null | undefined): CanvasData {
  if (!raw) return { nodes: [], edges: [] }
  try {
    const parsed = JSON.parse(raw) as CanvasData
    return {
      ...parsed,
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    }
  } catch {
    return { nodes: [], edges: [] }
  }
}

function parseStagedActions(raw: string | null | undefined): CanvasAction[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as CanvasAction[]) : []
  } catch {
    return []
  }
}

function nodeTitle(node: CanvasNode): string {
  const data = node.data ?? {}
  return String(data.title ?? data.label ?? data.name ?? '').trim()
}

function nodeStatus(node: CanvasNode): string {
  return String(node.data?.status ?? 'draft')
}

/** update_node 的唯一可写字段集（spec §4.1）。改动此表必须同步 spec 与图 1。 */
export const UPDATE_NODE_WRITABLE_FIELDS = ['title', 'imageModel', 'videoModel', 'textModel', 'audioModel'] as const

export type NodeModal = 'image' | 'video' | 'text' | 'audio'

/**
 * 节点类型 → 允许写的模型字段与模态。
 * 非此表的类型（group/shot/sceneComposer）**无**模型字段可写；prompt 与 text 共用 textModel。
 */
export const NODE_TYPE_MODEL_FIELD: Record<string, { field: string; modality: NodeModal }> = {
  image: { field: 'imageModel', modality: 'image' },
  video: { field: 'videoModel', modality: 'video' },
  text: { field: 'textModel', modality: 'text' },
  prompt: { field: 'textModel', modality: 'text' },
  audio: { field: 'audioModel', modality: 'audio' },
}

export type NodePatchValidation =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: string; allowed?: string[] }

/**
 * `update_node` 的入参校验（spec §4.1 判据 R-1~R-4）。
 *
 * 刻意是**模块级纯函数**：本仓 agent 链路没有 schema 校验兜底（harness 不校验），
 * 白名单是唯一防线，必须能被独立单测逐条打靶。
 */
export function validateNodePatch(input: {
  patch: Record<string, unknown>
  node: { type?: string; data?: Record<string, unknown> }
  selectable: Record<NodeModal, string[]>
}): NodePatchValidation {
  const { patch, node, selectable } = input
  const nodeType = String(node.type ?? '')
  const modelRule = NODE_TYPE_MODEL_FIELD[nodeType]
  const writableFields = ['title', ...(modelRule ? [modelRule.field] : [])]

  const unknown = Object.keys(patch).filter((k) => !UPDATE_NODE_WRITABLE_FIELDS.includes(k as never))
  if (unknown.length) {
    return { ok: false, reason: `unsupported field(s): ${unknown.join(', ')}`, allowed: writableFields }
  }
  // R-1：一次只允许一个模型字段，且必须是该节点类型的模态字段
  const modelFields = Object.keys(patch).filter((k) => k !== 'title')
  if (modelFields.length > 1) {
    return { ok: false, reason: 'at most one model field per call', allowed: writableFields }
  }
  if (modelFields.length === 1) {
    if (!modelRule || modelFields[0] !== modelRule.field) {
      return {
        ok: false,
        reason: `node type "${nodeType}" only accepts ${modelRule ? modelRule.field : 'no model field'}`,
        allowed: writableFields,
      }
    }
  }

  const data: Record<string, unknown> = {}
  if ('title' in patch) {
    // Review Focus 4：空白 title 不得把标题清空
    const title = typeof patch.title === 'string' ? patch.title.trim() : ''
    if (!title) return { ok: false, reason: 'title must be a non-empty string', allowed: writableFields }
    data.title = title
  }
  if (modelRule && modelRule.field in patch) {
    const raw = patch[modelRule.field]
    if (typeof raw !== 'string') {
      return { ok: false, reason: `${modelRule.field} must be a string`, allowed: selectable[modelRule.modality] }
    }
    const normalized = normalizeModelRef(modelRule.modality, raw)
    // R-2：fallback 说明裸名不在目录中——不得静默采用被回落出来的默认模型
    if (!normalized || normalized.fallback) {
      return { ok: false, reason: `unknown model "${raw}"`, allowed: selectable[modelRule.modality] }
    }
    // R-3：清单是唯一权威（BYOK ref 也可能已被用户从可选清单移除）
    if (!selectable[modelRule.modality].includes(normalized.ref)) {
      return { ok: false, reason: `model "${raw}" is not in the user's selectable list`, allowed: selectable[modelRule.modality] }
    }
    data[modelRule.field] = normalized.ref
  }

  if (Object.keys(data).length === 0) {
    return { ok: false, reason: 'patch must contain at least one writable field', allowed: writableFields }
  }
  return { ok: true, data }
}

/**
 * 生成参数可写字段（按节点模态分组）。agent 只影响「预填什么」，用户仍可否决（HITL 不变）。
 * 视频/音频参数整体收在嵌套对象里，避免与image 的扁平字段撞名。
 */
export const GENERATION_PARAM_FIELDS = {
  image: ['imageAspect', 'imageResolution', 'imageCount', 'imageModel', 'guideSceneId'],
  video: [
    'videoSettings',
    'videoMode',
    'videoModel',
    'seed',
    'negativePrompt',
    'guideSceneId',
  ],
  audio: [
    // 前端 AudioDockPanel 消费的是**扁平**字段（audioVoice/audioEmotion/audioSpeed/...），不是嵌套对象
    'audioVoice',
    'audioEmotion',
    'audioLanguage',
    'audioSpeed',
    'audioVolume',
    'audioPitch',
    'audioModel',
    'guideSceneId',
  ],
} as const

const IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const
const VIDEO_RESOLUTIONS = ['480p', '720p', '768p', '1080p', '2k', '4k'] as const
/** 区间取自 AudioVoiceSettingsSelector.vue（前端唯一权威）：speed 0.5~2 / volume 0.1~2 / pitch -12~12。 */
const AUDIO_RANGES = { speed: [0.5, 2], volume: [0.1, 2], pitch: [-12, 12] } as const

export type GenerationParamValidation =
  | { ok: true; data: Record<string, unknown>; applied: string[] }
  | { ok: false; reason: string; allowed?: string[] }

function inRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
}

/**
 * `set_node_generation_params` 的入参校验。
 *
 * 与 `validateNodePatch` 同款纪律：模块级纯函数、白名单是唯一防线、**失败绝不静默回落默认值**
 * （静默兜底会让模型以为设成功了），一律带 `allowed` 清单让模型自纠。
 */
export function validateGenerationParams(input: {
  params: Record<string, unknown>
  node: { type?: string; data?: Record<string, unknown> }
}): GenerationParamValidation {
  const { params, node } = input
  const nodeType = String(node.type ?? '')
  const nodeData = node.data ?? {}
  const modality = nodeType === 'video' ? 'video' : nodeType === 'audio' ? 'audio' : 'image'
  // 显式标注 string[]：GENERATION_PARAM_FIELDS 是 `as const` 的 readonly 字面量元组，
  // 展开后仍是 readonly 联合元素数组，`includes(k: string)` 收窄不了。
  const allowed: string[] = [...GENERATION_PARAM_FIELDS[modality]]

  const unknown = Object.keys(params).filter((k) => !allowed.includes(k))
  if (unknown.length) {
    return {
      ok: false,
      reason: `unsupported field(s) for ${nodeType || 'unknown'} node: ${unknown.join(', ')}`,
      allowed,
    }
  }

  const data: Record<string, unknown> = {}
  const applied: string[] = []

  for (const key of Object.keys(params)) {
    const value = params[key]
    if (value === undefined || value === null) continue

    // guideSceneId：三模态通用，且必须是注册表里真实存在的 id（不接受模型编造）
    if (key === 'guideSceneId') {
      if (typeof value !== 'string' || !getGenerationScene(value.trim())) {
        return { ok: false, reason: `unknown guideSceneId "${String(value)}"`, allowed }
      }
      data.guideSceneId = value.trim()
      applied.push(key)
      continue
    }

    // seed / negativePrompt：视频通用裸字段
    if (key === 'seed') {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return { ok: false, reason: 'seed must be an integer', allowed }
      }
      data.seed = value
      applied.push(key)
      continue
    }
    if (key === 'negativePrompt') {
      if (typeof value !== 'string') {
        return { ok: false, reason: 'negativePrompt must be a string', allowed }
      }
      data.negativePrompt = value
      applied.push(key)
      continue
    }
    if (key === 'videoMode') {
      if (value !== 'text_to_video' && value !== 'image_to_video') {
        return { ok: false, reason: 'videoMode must be text_to_video|image_to_video', allowed }
      }
      data.videoMode = value
      applied.push(key)
      continue
    }

    // 模型字段交给既有的 normalizeModelRef 链路（R-3：清单是唯一权威）
    if (key === 'imageModel' || key === 'videoModel' || key === 'audioModel') {
      if (typeof value !== 'string') {
        return { ok: false, reason: `${key} must be a string`, allowed }
      }
      const normalized = normalizeModelRef(modality as NodeModal, value)
      if (!normalized || normalized.fallback) {
        return { ok: false, reason: `unknown model "${value}"`, allowed }
      }
      data[key] = normalized.ref
      applied.push(key)
      continue
    }

    // image 扁平字段
    if (key === 'imageAspect') {
      if (typeof value !== 'string' || !SUPPORTED_ASPECT_RATIOS.has(value)) {
        return {
          ok: false,
          reason: `unsupported imageAspect "${String(value)}"`,
          allowed: [...SUPPORTED_ASPECT_RATIOS],
        }
      }
      data.imageAspect = value
      applied.push(key)
      continue
    }
    if (key === 'imageResolution') {
      if (typeof value !== 'string' || !IMAGE_RESOLUTIONS.includes(value as never)) {
        return { ok: false, reason: `unsupported imageResolution "${String(value)}"`, allowed: [...IMAGE_RESOLUTIONS] }
      }
      data.imageResolution = value
      applied.push(key)
      continue
    }
    if (key === 'imageCount') {
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 4) {
        return { ok: false, reason: 'imageCount must be an integer within 1..4', allowed }
      }
      data.imageCount = value
      applied.push(key)
      continue
    }

    // audio 扁平字段（与 AudioDockPanel 消费的 node.data 键一一对应）
    if (key === 'audioVoice') {
      if (typeof value !== 'string' || !value.trim()) {
        return { ok: false, reason: 'audioVoice must be a non-empty string', allowed }
      }
      // 音色号跨模型不通用 —— 必须按当前 audioModel 校验
      const modelRef = typeof nodeData.audioModel === 'string' ? nodeData.audioModel : ''
      // 与前端 catalogModelKeyFromValue 同源：ref 可能是编码过的 channelModel
      const modelKey = decodeChannelModel(modelRef)?.modelName ?? modelRef
      const entry = modelKey ? getModelEntry(modelKey) : undefined
      // ⚠️ 查不到音色清单时**不能放行**：那会让任意音色号静默落库，
      // 而 dock 面板读不出/读错都无提示。与「失败绝不静默回落」同款纪律。
      if (!entry?.voices?.length) {
        return {
          ok: false,
          reason: modelKey
            ? `cannot verify audioVoice: model "${modelKey}" has no voice list — set audioModel first`
            : 'cannot verify audioVoice: node has no audioModel — set audioModel first',
          allowed,
        }
      }
      // voices 是 {id,label}[]，而 node.data.audioVoice 存的是 id（见 AudioDockPanel.syncFromNode）
      const voiceIds = entry.voices.map((v) => v.id)
      if (!voiceIds.includes(value)) {
        return { ok: false, reason: `voice "${value}" is not available for model "${modelKey}"`, allowed: voiceIds }
      }
      data.audioVoice = value
      applied.push(key)
      continue
    }
    if (key === 'audioEmotion' || key === 'audioLanguage') {
      if (typeof value !== 'string' || !value.trim()) {
        return { ok: false, reason: `${key} must be a non-empty string`, allowed }
      }
      data[key] = value
      applied.push(key)
      continue
    }
    if (key === 'audioSpeed' || key === 'audioVolume' || key === 'audioPitch') {
      const field = key.slice('audio'.length).toLowerCase() as 'speed' | 'volume' | 'pitch'
      const [min, max] = AUDIO_RANGES[field]
      if (!inRange(value, min, max)) {
        return { ok: false, reason: `${key} must be a number within ${min}..${max}`, allowed }
      }
      data[key] = value
      applied.push(key)
      continue
    }

    // video 嵌套设置
    if (key === 'videoSettings') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ok: false, reason: 'videoSettings must be an object', allowed }
      }
      const v = value as Record<string, unknown>
      const settings: Record<string, unknown> = {}
      if (v.aspectRatio !== undefined) {
        if (typeof v.aspectRatio !== 'string' || !SUPPORTED_ASPECT_RATIOS.has(v.aspectRatio)) {
          return {
            ok: false,
            reason: `unsupported videoSettings.aspectRatio "${String(v.aspectRatio)}"`,
            allowed: [...SUPPORTED_ASPECT_RATIOS],
          }
        }
        settings.aspectRatio = v.aspectRatio
      }
      if (v.resolution !== undefined) {
        if (typeof v.resolution !== 'string' || !VIDEO_RESOLUTIONS.includes(v.resolution as never)) {
          return {
            ok: false,
            reason: `unsupported videoSettings.resolution "${String(v.resolution)}"`,
            allowed: [...VIDEO_RESOLUTIONS],
          }
        }
        settings.resolution = v.resolution
      }
      if (v.duration !== undefined) {
        // 上界按模型能力 clamp（各模型 4~15s 不一）；下界固定 1s
        if (!inRange(v.duration, 1, 60)) {
          return { ok: false, reason: 'videoSettings.duration must be a number within 1..60', allowed }
        }
        settings.duration = Math.round(v.duration)
      }
      if (v.crop !== undefined) {
        if (typeof v.crop !== 'boolean') {
          return { ok: false, reason: 'videoSettings.crop must be a boolean', allowed }
        }
        settings.crop = v.crop
      }
      if (v.generateAudio !== undefined) {
        if (typeof v.generateAudio !== 'boolean') {
          return { ok: false, reason: 'videoSettings.generateAudio must be a boolean', allowed }
        }
        settings.generateAudio = v.generateAudio
      }
      if (Object.keys(settings).length === 0) {
        return { ok: false, reason: 'videoSettings has no recognized field', allowed }
      }
      data.videoSettings = settings
      applied.push(key)
      continue
    }
  }

  if (applied.length === 0) {
    return { ok: false, reason: 'params must contain at least one writable field', allowed }
  }
  return { ok: true, data, applied }
}

/** 由 canvas.edges 推导节点的上下游（只回 id+type+title，体积可控；悬空边跳过）。 */
export function relationsForNode(
  canvas: { nodes: CanvasNode[]; edges: CanvasEdge[] },
  nodeId: string,
): {
  upstream: Array<{ id: string; type: string; title: string }>
  downstream: Array<{ id: string; type: string; title: string }>
} {
  const brief = (id: string) => {
    const node = canvas.nodes.find((n) => n.id === id)
    if (!node) return null
    return { id: node.id, type: String(node.type ?? ''), title: nodeTitle(node) }
  }
  const upstream = canvas.edges
    .filter((e) => e.target === nodeId)
    .map((e) => brief(e.source))
    .filter((n): n is { id: string; type: string; title: string } => n !== null)
  const downstream = canvas.edges
    .filter((e) => e.source === nodeId)
    .map((e) => brief(e.target))
    .filter((n): n is { id: string; type: string; title: string } => n !== null)
  return { upstream, downstream }
}

function nodeToAgentAttachment(node: CanvasNode): SidebarAttachment | null {
  const data = node.data ?? {}
  const url = String(data.url ?? '').trim()
  const text = String(data.content ?? data.prompt ?? '').trim()
  if (!url && !text) return null

  const t = String(node.type ?? '')
  let mediaType: SidebarAttachment['mediaType'] = 'image'
  if (t === 'text' || t === 'prompt') mediaType = 'text'
  else if (t === 'video') mediaType = 'video'
  else if (t === 'audio') mediaType = 'audio'
  else if (t === 'image' || t === 'mediaInput') mediaType = 'image'
  else if (text && !url) mediaType = 'text'
  else if (!url) return null

  return {
    id: `agent-ref-${node.id}`,
    mediaType,
    sourceKind: 'canvasNode',
    label: nodeTitle(node) || node.id,
    url: url || undefined,
    text: text || undefined,
    sourceNodeId: node.id,
  }
}

function assetKindFromNodeType(type: string): 'image' | 'video' | 'audio' | null {
  if (type === 'image' || type === 'mediaInput') return 'image'
  if (type === 'video') return 'video'
  if (type === 'audio') return 'audio'
  return null
}

const WORKFLOW_FETCH_TIMEOUT_MS = 15_000
const WORKFLOW_MAX_BYTES = 2 * 1024 * 1024

type ImportedCanvasNode = CanvasNode & {
  parentNode?: string
  extent?: 'parent'
  expandParent?: boolean
}

function formatWorkflowValidationError(err: unknown): string {
  if (err && typeof err === 'object' && 'issues' in err && Array.isArray((err as { issues: unknown }).issues)) {
    const issues = (err as { issues: Array<{ path: Array<string | number>; message: string }> }).issues
    if (issues.length) {
      return issues
        .map((issue) => {
          const path = issue.path.length ? issue.path.join('.') : 'workflow'
          return `${path}: ${issue.message}`
        })
        .join('; ')
    }
  }
  return err instanceof Error ? err.message : '工作流格式无效'
}

function inferPersistKind(nodeType: string | undefined, mediaKind?: string): 'image' | 'video' | 'audio' {
  const fromIndex = String(mediaKind ?? '').toLowerCase()
  if (fromIndex === 'image' || fromIndex === 'video' || fromIndex === 'audio') {
    return fromIndex
  }
  return assetKindFromNodeType(String(nodeType ?? '')) ?? 'image'
}

async function fetchWorkflowJson(workflowUrl: string): Promise<unknown> {
  let parsed: URL
  try {
    parsed = new URL(workflowUrl)
  } catch {
    throw new BadRequestException('workflowUrl 无效')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException('workflowUrl 仅支持 http/https')
  }

  let res: Response
  try {
    res = await fetch(parsed.href, { signal: AbortSignal.timeout(WORKFLOW_FETCH_TIMEOUT_MS) })
  } catch (err) {
    throw new BadRequestException(err instanceof Error ? `拉取工作流失败: ${err.message}` : '拉取工作流失败')
  }
  if (!res.ok) {
    throw new BadRequestException(`拉取工作流失败: HTTP ${res.status}`)
  }

  const contentLength = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(contentLength) && contentLength > WORKFLOW_MAX_BYTES) {
    throw new BadRequestException('工作流文件过大')
  }

  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength > WORKFLOW_MAX_BYTES) {
    throw new BadRequestException('工作流文件过大')
  }

  try {
    return JSON.parse(new TextDecoder().decode(buf)) as unknown
  } catch {
    throw new BadRequestException('工作流 JSON 解析失败')
  }
}

function toStudioRefs(node: CanvasNode, canvas: CanvasData): StudioRefInput[] {
  return resolveNodeRefs({
    targetNodeId: node.id,
    targetType: String(node.type),
    nodes: canvas.nodes,
    edges: canvas.edges,
    localRefs: (node.data?.localRefs as LocalRefBinding[] | undefined) ?? [],
    refOrder: (node.data?.refOrder as string[]) ?? [],
  })
    .filter((r) => !r.stale)
    .map((r) => ({
      refKey: r.refKey,
      mediaType: r.mediaType,
      label: r.label,
      text: r.payload.text,
      url: r.payload.url,
    }))
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clampImageGenCount(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return 1
  return Math.max(1, Math.min(4, Math.round(v)))
}

type AccountGenPrefs = {
  defaultImageModel: string
  defaultVideoModel: string
  defaultTextModel: string
  defaultAudioModel: string
  canvasImageCount: number
  defaultImageAspect: string
  defaultImageResolution: string
  defaultVideoAspect: string
  defaultVideoDuration: number
  defaultVideoResolution: string
  defaultVideoCrop: string
  audioVoice: string
  audioFormat: string
  audioSpeed: number
  audioInstructions: string | null
}

const HARDCODE_PREFS: AccountGenPrefs = {
  defaultImageModel: '',
  defaultVideoModel: '',
  defaultTextModel: '',
  defaultAudioModel: '',
  canvasImageCount: 1,
  defaultImageAspect: '16:9',
  defaultImageResolution: '1K',
  defaultVideoAspect: '16:9',
  defaultVideoDuration: 5,
  defaultVideoResolution: '720p',
  defaultVideoCrop: 'none',
  audioVoice: 'female-shaonv',
  audioFormat: 'mp3',
  audioSpeed: 1,
  audioInstructions: null,
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function parseVisionQaResponse(raw: string): ParsedVisionQaJson {
  return parseVisionQaJson(raw)
}

function parseRecordText(metadata: string | null | undefined, prompt: string): string {
  if (!metadata) return prompt
  try {
    const meta = JSON.parse(metadata) as { text?: string }
    return meta.text ?? prompt
  } catch {
    return prompt
  }
}

function parseRecordPromptContent(
  metadata: string | null | undefined,
  prompt: string,
): { content: string; mode: string | null } {
  if (!metadata) return { content: prompt, mode: null }
  try {
    const meta = JSON.parse(metadata) as { content?: string; mode?: string; text?: string }
    return {
      content: meta.content ?? meta.text ?? prompt,
      mode: meta.mode ?? null,
    }
  } catch {
    return { content: prompt, mode: null }
  }
}

function modalityDefaults(nodeType: NodeType | string, prefs: AccountGenPrefs): Record<string, unknown> {
  switch (nodeType) {
    case 'image':
      return {
        imageModel: prefs.defaultImageModel || undefined,
        imageAspect: prefs.defaultImageAspect || '16:9',
        imageResolution: prefs.defaultImageResolution || '1K',
        imageCount: clampImageGenCount(prefs.canvasImageCount),
      }
    case 'video':
      return {
        videoModel: prefs.defaultVideoModel || undefined,
        videoSettings: {
          aspectRatio: prefs.defaultVideoAspect || '16:9',
          duration: prefs.defaultVideoDuration || 5,
          resolution: prefs.defaultVideoResolution || '720p',
          crop: prefs.defaultVideoCrop || 'none',
        },
      }
    case 'text':
    case 'prompt':
      return {
        textModel: prefs.defaultTextModel || undefined,
      }
    case 'audio':
      return {
        audioModel: prefs.defaultAudioModel || undefined,
        audioVoice: prefs.audioVoice || 'female-shaonv',
        audioFormat: prefs.audioFormat || 'mp3',
        audioSpeed: prefs.audioSpeed ?? 1,
        ...(prefs.audioInstructions ? { audioInstructions: prefs.audioInstructions } : {}),
      }
    default:
      return {}
  }
}

function canEditImageNodeType(input: {
  type: string
  mediaKind?: unknown
  mimeType?: unknown
}): boolean {
  if (input.type === 'image') return true
  if (input.type !== 'mediaInput') return false
  const kind = String(input.mediaKind ?? '').toLowerCase()
  if (kind === 'image') return true
  const mime = String(input.mimeType ?? '').toLowerCase()
  return mime.startsWith('image/')
}

@Injectable()
export class AgentCanvasToolsService {
  /** Overridable in unit tests */
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
  pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StudioService) private readonly studio: StudioService,
    @Inject(MaterialService) private readonly material: MaterialService,
    @Inject(VideoGenerationOrchestrator) private readonly videoOrchestrator: VideoGenerationOrchestrator,
    @Inject(PersistRemoteService) private readonly persistRemote: PersistRemoteService,
    @Inject(ImageSliceService) private readonly imageSliceService: ImageSliceService,
    // update_node 的模型白名单校验需要按 userId 取 selectable 清单（ProviderModule 已在 AgentModule imports）
    @Inject(ProviderService) private readonly provider: ProviderService,
    // 两产品线拆分 path A 的 seam：画布动作落地实现可替换（归属待定）。
    // 可选 —— 未提供时回退默认实现，保证现有调用/测试行为不变。
    @Optional()
    @Inject(CANVAS_ACTION_APPLIER)
    private readonly canvasActionApplier?: CanvasActionApplier,
  ) {}

  /** 画布动作落地实现：注入优先，缺省回退默认（@lnkpi/agent 的 applyCanvasActions）。 */
  private get applier(): CanvasActionApplier {
    return this.canvasActionApplier ?? defaultCanvasActionApplier
  }

  private async loadAccountGenPrefs(userId: string): Promise<AccountGenPrefs> {
    const row = await this.prisma.userAiPreferences.findUnique({ where: { userId } })
    if (!row) return { ...HARDCODE_PREFS }
    return {
      defaultImageModel: row.defaultImageModel || '',
      defaultVideoModel: row.defaultVideoModel || '',
      defaultTextModel: row.defaultTextModel || '',
      defaultAudioModel: row.defaultAudioModel || '',
      canvasImageCount: row.canvasImageCount ?? 1,
      defaultImageAspect: row.defaultImageAspect || '16:9',
      defaultImageResolution: row.defaultImageResolution || '1K',
      defaultVideoAspect: row.defaultVideoAspect || '16:9',
      defaultVideoDuration: row.defaultVideoDuration || 5,
      defaultVideoResolution: row.defaultVideoResolution || '720p',
      defaultVideoCrop: row.defaultVideoCrop || 'none',
      audioVoice: row.audioVoice || 'female-shaonv',
      audioFormat: row.audioFormat || 'mp3',
      audioSpeed: row.audioSpeed ?? 1,
      audioInstructions: row.audioInstructions ?? null,
    }
  }

  async upsertPromptNode(input: {
    sessionId: string
    userId: string
    nodeId?: string
    prompt: string
    content: string
    position?: { x: number; y: number }
    stage?: boolean
  }): Promise<{ nodeId: string; actions: CanvasAction[] }> {
    const { canvas } = await this.loadOwnedSession(input.sessionId, input.userId)
    const existing = input.nodeId
      ? canvas.nodes.find((n) => n.id === input.nodeId)
      : undefined

    if (existing) {
      const actions: CanvasAction[] = [
        {
          type: 'update_node',
          payload: {
            id: existing.id,
            data: { prompt: input.prompt, content: input.content, title: input.prompt },
          },
        },
      ]
      await this.applyOrStage(input.sessionId, actions, input.stage)
      return { nodeId: existing.id, actions }
    }

    const nodeId = input.nodeId ?? nextNodeId('prompt')
    const col = canvas.nodes.length
    const position = input.position ?? { x: 80 + col * GRID_X, y: 80 }
    const actions: CanvasAction[] = [
      {
        type: 'add_node',
        payload: {
          id: nodeId,
          nodeType: 'prompt',
          position,
          data: {
            prompt: input.prompt,
            content: input.content,
            title: input.prompt,
            status: 'draft',
          },
        },
      },
    ]
    await this.applyOrStage(input.sessionId, actions, input.stage)
      return { nodeId, actions }
  }

  async getNode(
    input: { sessionId: string; nodeId: string },
  ): Promise<CanvasNode & ReturnType<typeof relationsForNode>> {
    const { canvas } = await this.loadSession(input.sessionId)
    const node = canvas.nodes.find((n) => n.id === input.nodeId)
    if (!node) throw new NotFoundException('节点不存在')
    // 上下游是该节点的一等属性；拆第二个读工具只会迫使模型记住"读节点要调两次"
    return { ...node, ...relationsForNode(canvas, node.id) }
  }

  /** 焦点过滤阈值（审计 P0-①）：≤ 此数全量返回，避免小画布反而丢信息。 */
  private static readonly CANVAS_SUMMARY_FULL_LIMIT = 30

  async getCanvasSummary(input: {
    sessionId: string
    focusNodeId?: string
  }): Promise<{
    nodes: Array<{ id: string; type: string; title: string; status: string }>
    omittedCount?: number
    focusNodeId?: string
  }> {
    const { canvas } = await this.loadSession(input.sessionId)
    const all = canvas.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      title: nodeTitle(n),
      status: nodeStatus(n),
    }))
    // 焦点过滤 fail-open 三闸：无焦点 / 小画布 / 焦点不存在 → 全量（任何一类都不丢信息）。
    const focus = input.focusNodeId
    if (!focus || all.length <= AgentCanvasToolsService.CANVAS_SUMMARY_FULL_LIMIT) return { nodes: all }
    if (!canvas.nodes.some((n) => n.id === focus)) return { nodes: all }
    const keep = new Set<string>([focus])
    for (const e of canvas.edges) {
      if (e.source === focus) keep.add(e.target)
      if (e.target === focus) keep.add(e.source)
    }
    const nodes = all.filter((n) => keep.has(n.id))
    return { nodes, omittedCount: all.length - nodes.length, focusNodeId: focus }
  }

  async addNodesBatch(input: {
    sessionId: string
    userId: string
    items: Array<{
      key: string
      title: string
      targetType: NodeType | string
      prompt?: string
      position?: { x: number; y: number }
      pipeline?: string
      imageAspect?: string
      videoSettings?: {
        aspectRatio?: string
        duration?: number
        resolution?: string
        crop?: string
        generateAudio?: boolean
      }
      videoMode?: string
      referenceImageUrl?: string
      promptMode?: string
      guideSceneId?: string
      guideEditIntentId?: string
    }>
    stage?: boolean
  }): Promise<{ nodes: Array<{ key: string; nodeId: string }>; actions: CanvasAction[] }> {
    const { canvas } = await this.loadOwnedSession(input.sessionId, input.userId)
    const prefs = await this.loadAccountGenPrefs(input.userId)
    const actions: CanvasAction[] = []
    const mapping: Array<{ key: string; nodeId: string }> = []
    const baseIndex = canvas.nodes.length

    for (let i = 0; i < input.items.length; i++) {
      const item = input.items[i]
      const nodeType = (item.targetType || 'image') as NodeType
      const nodeId = nextNodeId(nodeType)
      const position =
        item.position ??
        {
          x: 80 + ((baseIndex + i) % 4) * GRID_X,
          y: 80 + Math.floor((baseIndex + i) / 4) * GRID_Y,
        }
      const defaults = modalityDefaults(nodeType, prefs)
      const nodeData: Record<string, unknown> = {
        title: item.title,
        manifestKey: item.key,
        prompt: item.prompt ?? '',
        status: 'draft',
        ...defaults,
      }
      if (item.pipeline) nodeData.pipeline = item.pipeline
      if (item.imageAspect) nodeData.imageAspect = item.imageAspect
      if (item.videoSettings && typeof item.videoSettings === 'object') {
        const base =
          nodeData.videoSettings && typeof nodeData.videoSettings === 'object'
            ? (nodeData.videoSettings as Record<string, unknown>)
            : {}
        nodeData.videoSettings = { ...base, ...item.videoSettings }
      }
      if (item.videoMode) nodeData.videoMode = item.videoMode
      if (item.referenceImageUrl) nodeData.referenceImageUrl = item.referenceImageUrl
      if (item.promptMode) nodeData.promptMode = item.promptMode
      if (item.guideSceneId) nodeData.guideSceneId = item.guideSceneId
      if (item.guideEditIntentId) nodeData.guideEditIntentId = item.guideEditIntentId
      actions.push({
        type: 'add_node',
        payload: {
          id: nodeId,
          nodeType,
          position,
          data: nodeData,
        },
      })
      mapping.push({ key: item.key, nodeId })
    }

    await this.applyOrStage(input.sessionId, actions, input.stage)
    return { nodes: mapping, actions }
  }

  /**
   * Phase 2b: single media-node upsert (image|video|text|audio).
   * Create path wraps addNodesBatch so account modality defaults are stamped.
   */
  async upsertMediaNode(input: {
    sessionId: string
    userId: string
    targetType: 'image' | 'video' | 'text' | 'audio' | string
    prompt: string
    title?: string
    nodeId?: string
    position?: { x: number; y: number }
    stage?: boolean
  }): Promise<{ nodeId: string; actions: CanvasAction[] }> {
    const allowed = new Set(['image', 'video', 'text', 'audio'])
    const targetType = String(input.targetType || '').trim()
    if (!allowed.has(targetType)) {
      throw new BadRequestException('targetType 必须是 image|video|text|audio')
    }

    const { canvas } = await this.loadOwnedSession(input.sessionId, input.userId)
    const existing = input.nodeId
      ? canvas.nodes.find((n) => n.id === input.nodeId)
      : undefined

    if (existing) {
      const data: Record<string, unknown> = { prompt: input.prompt }
      if (typeof input.title === 'string' && input.title.trim()) {
        data.title = input.title.trim()
      }
      const actions: CanvasAction[] = [
        {
          type: 'update_node',
          payload: { id: existing.id, data },
        },
      ]
      await this.applyOrStage(input.sessionId, actions, input.stage)
      return { nodeId: existing.id, actions }
    }

    const title =
      (typeof input.title === 'string' && input.title.trim()) ||
      input.prompt.trim() ||
      targetType
    const batch = await this.addNodesBatch({
      sessionId: input.sessionId,
      userId: input.userId,
      items: [
        {
          key: `upsert_media_${targetType}`,
          title,
          targetType,
          prompt: input.prompt,
          position: input.position,
        },
      ],
      stage: input.stage,
    })
    const nodeId = batch.nodes[0]?.nodeId
    if (!nodeId) throw new BadRequestException('创建媒体节点失败')
    return { nodeId, actions: batch.actions }
  }

  /**
   * Phase 2b: mark a single node pending_confirm. Never calls studio generate / run_*.
   */
  async proposeGeneration(input: {
    sessionId: string
    userId: string
    nodeId: string
  }): Promise<{
    nodeId: string
    status: 'pending_confirm'
    summary: {
      type: string
      promptPreview: string
      title?: string
      imageModel?: string
      videoModel?: string
      textModel?: string
      audioModel?: string
      imageAspect?: string
      imageResolution?: string
      videoSettings?: unknown
    }
    actions: CanvasAction[]
  }> {
    const { canvas } = await this.loadOwnedSession(input.sessionId, input.userId)
    const node = canvas.nodes.find((n) => n.id === input.nodeId)
    if (!node) throw new NotFoundException('节点不存在')

    const prompt = String(node.data?.prompt ?? '').trim()
    if (!prompt) {
      throw new BadRequestException('节点缺少 prompt，无法提出生成确认')
    }

    const title = nodeTitle(node) || undefined
    const data = node.data ?? {}
    const promptPreview = prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt
    const summary: {
      type: string
      promptPreview: string
      title?: string
      imageModel?: string
      videoModel?: string
      textModel?: string
      audioModel?: string
      imageAspect?: string
      imageResolution?: string
      videoSettings?: unknown
    } = {
      type: String(node.type),
      promptPreview,
      ...(title ? { title } : {}),
    }
    if (typeof data.imageModel === 'string' && data.imageModel) summary.imageModel = data.imageModel
    if (typeof data.videoModel === 'string' && data.videoModel) summary.videoModel = data.videoModel
    if (typeof data.textModel === 'string' && data.textModel) summary.textModel = data.textModel
    if (typeof data.audioModel === 'string' && data.audioModel) summary.audioModel = data.audioModel
    if (typeof data.imageAspect === 'string' && data.imageAspect) summary.imageAspect = data.imageAspect
    if (typeof data.imageResolution === 'string' && data.imageResolution) {
      summary.imageResolution = data.imageResolution
    }
    if (data.videoSettings && typeof data.videoSettings === 'object') {
      summary.videoSettings = data.videoSettings
    }

    const actions: CanvasAction[] = [
      {
        type: 'update_node',
        payload: { id: node.id, data: { status: 'pending_confirm' } },
      },
    ]
    await this.applyOrStage(input.sessionId, actions, false)
    return { nodeId: node.id, status: 'pending_confirm', summary, actions }
  }

  /**
   * Phase 2c.1: clear pending_confirm back to draft. Never calls studio generate / run_*.
   * Idempotent when the node is already draft (or any non-pending status).
   */
  async clearProposeGeneration(input: {
    sessionId: string
    userId: string
    nodeId: string
  }): Promise<{
    nodeId: string
    status: 'draft'
    actions: CanvasAction[]
  }> {
    const { canvas } = await this.loadOwnedSession(input.sessionId, input.userId)
    const node = canvas.nodes.find((n) => n.id === input.nodeId)
    if (!node) throw new NotFoundException('节点不存在')

    const actions: CanvasAction[] = [
      {
        type: 'update_node',
        payload: { id: node.id, data: { status: 'draft' } },
      },
    ]
    await this.applyOrStage(input.sessionId, actions, false)
    return { nodeId: node.id, status: 'draft', actions }
  }

  async connectNodes(input: {
    sessionId: string
    edges: Array<{ source: string; target: string }>
    stage?: boolean
  }): Promise<{ actions: CanvasAction[] }> {
    const { canvas } = await this.loadSession(input.sessionId)
    const actions: CanvasAction[] = []
    const existing = new Set(canvas.edges.map((e) => `${e.source}->${e.target}`))

    for (const edge of input.edges) {
      const key = `${edge.source}->${edge.target}`
      if (existing.has(key)) continue
      existing.add(key)
      actions.push({
        type: 'add_edge',
        payload: {
          id: edgeId(edge.source, edge.target),
          source: edge.source,
          target: edge.target,
        },
      })
    }

    await this.applyOrStage(input.sessionId, actions, input.stage)
    return { actions }
  }

  /**
   * W31: Remove nodes and their associated edges from canvas.
   */
  async removeNodes(input: {
    sessionId: string
    nodeIds: string[]
    stage?: boolean
  }): Promise<{ actions: CanvasAction[] }> {
    const { canvas } = await this.loadSession(input.sessionId)
    const actions: CanvasAction[] = []

    // Remove edges connected to deleted nodes
    for (const nodeId of input.nodeIds) {
      for (const edge of canvas.edges) {
        if (edge.source === nodeId || edge.target === nodeId) {
          actions.push({
            type: 'remove_edge',
            payload: { id: edge.id },
          })
        }
      }
      // Remove the node
      actions.push({
        type: 'remove_node',
        payload: { id: nodeId },
      })
    }

    await this.applyOrStage(input.sessionId, actions, input.stage)
    return { actions }
  }

  /**
   * W32: Remove edges from canvas.
   */
  async removeEdges(input: {
    sessionId: string
    /** 有则校验归属（spec S8）；缺省保持旧行为以兼容既有调用方 */
    userId?: string
    edgeIds: string[]
    stage?: boolean
  }): Promise<{ actions: CanvasAction[] }> {
    const { canvas } = input.userId
      ? await this.loadOwnedSession(input.sessionId, input.userId)
      : await this.loadSession(input.sessionId)
    const actions: CanvasAction[] = []

    for (const edgeId of input.edgeIds) {
      // Verify edge exists
      if (!canvas.edges.some((e) => e.id === edgeId)) {
        continue // Skip non-existent edges
      }
      actions.push({
        type: 'remove_edge',
        payload: { id: edgeId },
      })
    }

    await this.applyOrStage(input.sessionId, actions, input.stage)
    return { actions }
  }

  async setNodePrompt(input: {
    sessionId: string
    nodeId: string
    prompt: string
    title?: string
    stage?: boolean
  }): Promise<{ actions: CanvasAction[] }> {
    const { canvas } = await this.loadSession(input.sessionId)
    if (!canvas.nodes.some((n) => n.id === input.nodeId)) {
      throw new NotFoundException('节点不存在')
    }
    // P0 修复：modify 模式可选同时更新标题（改节点名，如「模特定妆」→「双人模特定妆」）
    const data: Record<string, unknown> = { prompt: input.prompt }
    if (typeof input.title === 'string' && input.title.trim()) {
      data.title = input.title.trim()
    }
    const actions: CanvasAction[] = [
      {
        type: 'update_node',
        payload: { id: input.nodeId, data },
      },
    ]
    await this.applyOrStage(input.sessionId, actions, input.stage)
    return { actions }
  }

  async setNodeContent(input: {
    sessionId: string
    userId: string
    nodeId: string
    content: string
    stage?: boolean
  }): Promise<{ actions: CanvasAction[] }> {
    const { canvas } = await this.loadOwnedSession(input.sessionId, input.userId)
    if (!canvas.nodes.some((n) => n.id === input.nodeId)) {
      throw new NotFoundException('节点不存在')
    }
    const actions: CanvasAction[] = [
      {
        type: 'update_node',
        payload: {
          id: input.nodeId,
          data: { content: input.content, status: 'completed' },
        },
      },
    ]
    await this.applyOrStage(input.sessionId, actions, input.stage)
    return { actions }
  }

  /**
   * 改节点属性（spec §4.1 白名单）：title + 节点自身模态的模型字段。
   * 刻意**不碰** prompt/content——那归 setNodeText，避免与本仓
   * 「upsert_prompt_node 全量覆盖 vs set_node_text 部分更新」语义（PR #63）打架。
   */
  async updateNode(input: {
    sessionId: string
    userId: string
    nodeId: string
    patch: Record<string, unknown>
  }): Promise<{ nodeId: string; actions: CanvasAction[] }> {
    const { canvas } = await this.loadOwnedSession(input.sessionId, input.userId)
    const node = canvas.nodes.find((n) => n.id === input.nodeId)
    if (!node) throw new NotFoundException('节点不存在')

    const selectable = await this.selectableModels(input.userId)
    const validated = validateNodePatch({ patch: input.patch, node, selectable })
    if (!validated.ok) {
      throw new BadRequestException({
        message: validated.reason,
        ...(validated.allowed ? { allowed: validated.allowed } : {}),
      })
    }

    const actions: CanvasAction[] = [
      { type: 'update_node', payload: { id: node.id, data: validated.data } },
    ]
    await this.persist(input.sessionId, actions)
    return { nodeId: node.id, actions }
  }

  /**
   * 生成场景清单（pi-runtime `list_generation_scenes` 的数据源）。
   *
   * 为何由 Nest 读而不在 pi 侧直接 import：pi-runtime 的 package.json 没有 @lnkpi/shared 依赖
   * （加它要改镜像构建链），而注册表 SSOT 在 shared。故 Nest 读、pi 只做传输。
   */
  async listGenerationScenes(input: { userId: string; modality?: string; sceneId?: string }): Promise<{
    scenes: Array<{
      id: string
      label: string
      modality: string
      group?: string
      description: string
      preferredParams: Record<string, unknown>
    }>
  }> {
    if (!input.userId) throw new BadRequestException('userId required')
    const { listGenerationScenes: list, guideModality } = await import('@lnkpi/shared')

    const one = input.sceneId?.trim()
    if (one) {
      const scene = list().find((s) => s.id === one)
      if (!scene) throw new NotFoundException(`unknown sceneId "${one}"`)
      return {
        scenes: [
          {
            id: scene.id,
            label: scene.label,
            modality: guideModality(scene),
            group: scene.groupId,
            description: scene.description,
            preferredParams: scene.preferredParams as Record<string, unknown>,
          },
        ],
      }
    }

    const key = input.modality?.trim()
    // 未知模态回落全量而非返回空——空会让模型以为「没有可用场景」
    const scenes = list()
      .filter((s) => (key && key !== 'all' ? guideModality(s) === key : true))
      .map((s) => ({
        id: s.id,
        label: s.label,
        modality: guideModality(s),
        group: s.groupId,
        description: s.description,
        preferredParams: s.preferredParams as Record<string, unknown>,
      }))
    return { scenes }
  }

  /**
   * set_node_generation_params：agent 按领域推理预填 dock 底部参数。
   *
   * 与 update_node 分开的原因：后者「一次只允许一个模型字段」（R-1）且白名单只有 title+模型字段，
   * 生成参数是多字段批量场景，语义也不同（这是「配生成参数」不是「改属性」）。
   * 走同一条 update_node action 通道 ⇒ 与 saveCanvas 同一 SSOT，不会被前端覆盖。
   */
  async setNodeGenerationParams(input: {
    sessionId: string
    userId: string
    nodeId: string
    params: Record<string, unknown>
  }): Promise<{ nodeId: string; applied: string[]; actions: CanvasAction[] }> {
    const { canvas } = await this.loadOwnedSession(input.sessionId, input.userId)
    const node = canvas.nodes.find((n) => n.id === input.nodeId)
    if (!node) throw new NotFoundException('节点不存在')

    const selectable = await this.selectableModels(input.userId)
    const validated = validateGenerationParams({ params: input.params, node })
    if (!validated.ok) {
      throw new BadRequestException({
        message: validated.reason,
        ...(validated.allowed ? { allowed: validated.allowed } : {}),
      })
    }

    // R-3 同款纪律：模型字段必须落在用户可选清单内
    const modelField = (['imageModel', 'videoModel', 'audioModel'] as const).find(
      (k) => k in validated.data,
    )
    if (modelField) {
      const modal: NodeModal = modelField === 'imageModel' ? 'image' : modelField === 'videoModel' ? 'video' : 'audio'
      const ref = validated.data[modelField] as string
      if (!selectable[modal].includes(ref)) {
        throw new BadRequestException({
          message: `model "${ref}" is not in the user's selectable list`,
          allowed: selectable[modal],
        })
      }
    }

    const actions: CanvasAction[] = [
      { type: 'update_node', payload: { id: node.id, data: validated.data } },
    ]
    await this.persist(input.sessionId, actions)
    return { nodeId: node.id, applied: validated.applied, actions }
  }

  /**
   * 按模态列出可写模型 ref（= update_node 的合法取值集）。
   * `source` 直接来自 preferences 里的 channelId 前缀：`platform::*` → 平台，其余 → BYOK。
   * `audioKind` 仅 audio 模态出现：未登记音频模型一律 `voice`（`audioKindOf` 是缺省唯一判据处）。
   */
  async listNodeModelOptions(input: { userId: string }): Promise<{
    modalities: Record<
      NodeModal,
      Array<{
        ref: string
        model: string
        channelId: string
        channelName: string
        source: ProviderSource
        audioKind?: AudioKind
      }>
    >
  }> {
    if (!input.userId) throw new BadRequestException('userId required')
    const { platformChannel, channels, preferences } = await this.provider.bootstrap(input.userId)
    const nameOf = new Map<string, string>([[platformChannel.id, platformChannel.name]])
    for (const ch of channels) nameOf.set(ch.id, ch.name)

    const build = (refs: string[], modality: NodeModal) =>
      refs.map((ref) => {
        const decoded = decodeChannelModel(ref)
        const channelId = decoded?.channelId ?? PLATFORM_CHANNEL_ID
        const model = decoded?.modelName ?? ref
        const entry = getModelEntry(model)
        return {
          ref,
          model,
          channelId,
          channelName: nameOf.get(channelId) ?? channelId,
          source: (channelId === PLATFORM_CHANNEL_ID ? 'platform' : 'user') as ProviderSource,
          ...(modality === 'audio'
            ? { audioKind: entry && entry.modality === 'audio' ? audioKindOf(entry) : 'voice' }
            : {}),
        }
      })

    return {
      modalities: {
        image: build(preferences.selectableImageModels, 'image'),
        video: build(preferences.selectableVideoModels, 'video'),
        text: build(preferences.selectableTextModels, 'text'),
        audio: build(preferences.selectableAudioModels, 'audio'),
      },
    }
  }

  /** selectable 清单 → validateNodePatch 需要的形态（按模态分桶）。 */
  private async selectableModels(userId: string): Promise<Record<NodeModal, string[]>> {
    const { preferences } = await this.provider.bootstrap(userId)
    return {
      image: preferences.selectableImageModels,
      video: preferences.selectableVideoModels,
      text: preferences.selectableTextModels,
      audio: preferences.selectableAudioModels,
    }
  }

  async attachRefs(input: {
    sessionId: string
    nodeId: string
    refOrder: string[]
  }): Promise<{ actions: CanvasAction[] }> {
    const { canvas } = await this.loadSession(input.sessionId)
    if (!canvas.nodes.some((n) => n.id === input.nodeId)) {
      throw new NotFoundException('节点不存在')
    }

    const actions: CanvasAction[] = []
    const edgeIds: string[] = []
    const existing = new Set(canvas.edges.map((e) => `${e.source}->${e.target}`))

    for (const sourceId of input.refOrder) {
      const id = edgeId(sourceId, input.nodeId)
      edgeIds.push(id)
      const key = `${sourceId}->${input.nodeId}`
      if (existing.has(key)) continue
      existing.add(key)
      actions.push({
        type: 'add_edge',
        payload: { id, source: sourceId, target: input.nodeId },
      })
    }

    actions.push({
      type: 'update_node',
      payload: { id: input.nodeId, data: { refOrder: edgeIds } },
    })

    await this.persist(input.sessionId, actions)
    return { actions }
  }

  async applySidebarAttachments(input: {
    sessionId: string
    nodeIds: string[]
    attachments: SidebarAttachment[]
    refOrder?: string[]
    mode: 'localRefs' | 'attach_edges'
    mentionedKeys?: string[]
  }): Promise<{ actions: CanvasAction[]; sourceNodeIds: string[] }> {
    validateSidebarAttachments(input.attachments)
    const order = input.refOrder?.length
      ? input.refOrder
      : input.attachments.map((a) => a.id)

    if (input.mode === 'localRefs') {
      const localRefs: LocalRefBinding[] = input.attachments
        .map((a) => ({
          id: a.id,
          mediaType: a.mediaType,
          sourceKind: a.sourceKind === 'asset' ? 'asset' : 'upload',
          label: a.label,
          url: a.url,
          text: a.text,
        }))
      const actions: CanvasAction[] = input.nodeIds.map((nodeId) => ({
        type: 'update_node',
        payload: {
          id: nodeId,
          data: {
            localRefs,
            refOrder: order,
            ...(input.mentionedKeys?.length ? { mentionedKeys: input.mentionedKeys } : {}),
          },
        },
      }))
      await this.persist(input.sessionId, actions)
      return { actions, sourceNodeIds: [] }
    }

    const { canvas } = await this.loadSession(input.sessionId)
    const actions: CanvasAction[] = []
    const sourceByAttachmentId = new Map<string, string>()
    const baseIndex = canvas.nodes.length

    for (const attachment of input.attachments) {
      if (attachment.sourceKind === 'canvasNode' && attachment.sourceNodeId?.trim()) {
        sourceByAttachmentId.set(attachment.id, attachment.sourceNodeId)
        continue
      }

      const nodeType = attachment.mediaType === 'text' ? 'text' : 'mediaInput'
      const nodeId = nextNodeId(nodeType)
      const positionIndex = baseIndex + actions.length
      const position = {
        x: 80 + (positionIndex % 4) * GRID_X,
        y: 80 + Math.floor(positionIndex / 4) * GRID_Y,
      }
      const data: Record<string, unknown> =
        attachment.mediaType === 'text'
          ? {
              title: attachment.label,
              content: attachment.text ?? '',
              prompt: attachment.text ?? '',
              status: 'completed',
            }
          : {
              title: attachment.label,
              url: attachment.url ?? '',
              mediaKind: attachment.mediaType,
              status: 'completed',
            }

      actions.push({
        type: 'add_node',
        payload: {
          id: nodeId,
          nodeType: nodeType as NodeType,
          position,
          data,
        },
      })
      sourceByAttachmentId.set(attachment.id, nodeId)
    }

    const orderedAttachmentIds = [
      ...order,
      ...input.attachments.map((attachment) => attachment.id).filter((id) => !order.includes(id)),
    ]
    const sourceNodeIds = orderedAttachmentIds
      .map((attachmentId) => sourceByAttachmentId.get(attachmentId))
      .filter((nodeId): nodeId is string => Boolean(nodeId))

    if (actions.length) {
      await this.persist(input.sessionId, actions)
    }
    return { actions, sourceNodeIds }
  }

  async updateNodesBatch(input: {
    sessionId: string
    items: Array<{ nodeId: string; patch: Record<string, unknown> }>
  }): Promise<{ actions: CanvasAction[] }> {
    const actions: CanvasAction[] = input.items.map((item) => ({
      type: 'update_node',
      payload: { id: item.nodeId, data: item.patch },
    }))
    await this.persist(input.sessionId, actions)
    return { actions }
  }

  async startImageGeneration(input: {
    sessionId: string
    userId: string
    nodeId: string
  }): Promise<{ generationRecordId: string; status: string; actions: CanvasAction[] }> {
    const { canvas } = await this.loadOwnedSession(input.sessionId, input.userId)
    const node = canvas.nodes.find((n) => n.id === input.nodeId)
    if (!node) throw new NotFoundException('节点不存在')

    const prompt = String(node.data?.prompt ?? node.data?.content ?? '').trim()
    if (!prompt) throw new NotFoundException('节点缺少 prompt')

    const started: CanvasAction[] = [
      {
        type: 'update_node',
        payload: {
          id: input.nodeId,
          data: {
            status: 'generating',
            generationStartedAt: new Date().toISOString(),
          },
        },
      },
    ]
    let current = await this.persist(input.sessionId, started)
    const allActions = [...started]

    const prefs = await this.loadAccountGenPrefs(input.userId)
    const refs = toStudioRefs(node, current)
    const pipeline = String(node.data?.pipeline ?? '').trim()
    let imagePrompt = prompt
    let aspectRatio = pickString(node.data?.imageAspect, prefs.defaultImageAspect || '16:9')
    let resolution = pickString(
      node.data?.imageResolution,
      prefs.defaultImageResolution || '1K',
    )
    const count = clampImageGenCount(
      node.data?.imageCount ?? prefs.canvasImageCount ?? 1,
    )
    const model = pickString(node.data?.imageModel, prefs.defaultImageModel) || undefined

    if (pipeline === 'turnaround_image' || isProductFourPanelPrompt(prompt)) {
      const textModel = pickString(node.data?.textModel, prefs.defaultTextModel) || undefined
      const expanded = await this.studio.expandPromptContent(input.userId, prompt, textModel)
      imagePrompt = expanded.content
      aspectRatio = '2:1'
      const userResolution = pickString(
        node.data?.imageResolution,
        prefs.defaultImageResolution || '1K',
      )
      const bumpedResolution = userResolution === '1K' ? '2K' : userResolution
      if (bumpedResolution !== userResolution) {
        resolution = bumpedResolution
      }
      const expandActions: CanvasAction[] = [
        {
          type: 'update_node',
          payload: {
            id: input.nodeId,
            data: {
              expandedPrompt: expanded.content,
              content: expanded.content,
              promptMode: expanded.mode,
              pipeline,
              imageAspect: aspectRatio,
              imageResolution: resolution,
              ...(bumpedResolution !== userResolution ? { resolutionBump: true } : {}),
              ...(pickString(node.data?.guideSceneId, '')
                ? { guideSceneId: pickString(node.data?.guideSceneId, '') }
                : {}),
              ...(pickString(node.data?.guideEditIntentId, '')
                ? { guideEditIntentId: pickString(node.data?.guideEditIntentId, '') }
                : {}),
            },
          },
        },
      ]
      await this.persist(input.sessionId, expandActions)
      allActions.push(...expandActions)
    }

    const mentionedKeys = Array.isArray(node.data?.mentionedKeys)
      ? (node.data.mentionedKeys as string[])
      : undefined
    const record = await this.studio.generateImage(
      input.userId,
      imagePrompt,
      model,
      aspectRatio,
      refs,
      mentionedKeys?.length ? mentionedKeys : undefined,
      resolution,
      count,
      { sessionId: input.sessionId, nodeId: input.nodeId },
    )

    const recordId = record.id
    allActions.push({
      type: 'update_node',
      payload: { id: input.nodeId, data: { generationRecordId: recordId } },
    })
    await this.persist(input.sessionId, [
      {
        type: 'update_node',
        payload: { id: input.nodeId, data: { generationRecordId: recordId } },
      },
    ])

    return {
      generationRecordId: recordId,
      status: 'generating',
      actions: allActions,
    }
  }

  async waitImageGeneration(input: {
    sessionId: string
    userId: string
    nodeId: string
    generationRecordId: string
  }): Promise<{ url?: string; status: string; generationRecordId: string; actions: CanvasAction[] }> {
    const recordId = input.generationRecordId
    const allActions: CanvasAction[] = []

    try {
      const initial = await this.studio.getGeneration(input.userId, recordId)
      const terminal = await this.pollGeneration(input.userId, recordId, initial)
      const status = String(terminal.status)
      const url = typeof terminal.url === 'string' && terminal.url ? terminal.url : undefined

      const finishData: Record<string, unknown> = {
        status:
          status === 'completed'
            ? 'completed'
            : status === 'failed' || status === 'error'
              ? 'error'
              : status,
        generationRecordId: recordId,
      }
      if (url) finishData.url = url
      if (status !== 'completed') {
        finishData.errorMessage = '图像生成未完成或超时'
      }

      const finishActions: CanvasAction[] = [
        { type: 'update_node', payload: { id: input.nodeId, data: finishData } },
      ]
      await this.persist(input.sessionId, finishActions)
      allActions.push(...finishActions)

      return {
        url,
        status: String(finishData.status),
        generationRecordId: recordId,
        actions: allActions,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '图像生成失败'
      const errorActions: CanvasAction[] = [
        {
          type: 'update_node',
          payload: {
            id: input.nodeId,
            data: { status: 'error', errorMessage, generationRecordId: recordId },
          },
        },
      ]
      await this.persist(input.sessionId, errorActions)
      allActions.push(...errorActions)
      return { status: 'error', generationRecordId: recordId, actions: allActions }
    }
  }

  async runImageGeneration(input: {
    sessionId: string
    userId: string
    nodeId: string
  }): Promise<{ url?: string; status: string; generationRecordId?: string; actions: CanvasAction[] }> {
    try {
      const started = await this.startImageGeneration(input)
      const finished = await this.waitImageGeneration({
        ...input,
        generationRecordId: started.generationRecordId,
      })
      return {
        ...finished,
        actions: [...started.actions, ...finished.actions],
      }
    } catch (err) {
      if (err instanceof ForbiddenException || err instanceof NotFoundException) throw err
      const errorMessage = err instanceof Error ? err.message : '图像生成失败'
      const errorActions: CanvasAction[] = [
        {
          type: 'update_node',
          payload: {
            id: input.nodeId,
            data: { status: 'error', errorMessage },
          },
        },
      ]
      await this.persist(input.sessionId, errorActions)
      return { status: 'error', actions: errorActions }
    }
  }

  async startVideoGeneration(input: {
    sessionId: string
    userId: string
    nodeId: string
  }): Promise<{ generationRecordId: string; status: string; actions: CanvasAction[] }> {
    const { canvas } = await this.loadOwnedSession(input.sessionId, input.userId)
    const node = canvas.nodes.find((n) => n.id === input.nodeId)
    if (!node) throw new NotFoundException('节点不存在')

    const prefs = await this.loadAccountGenPrefs(input.userId)
    const request = resolveCanonicalVideoRequest({
      node,
      canvas,
      sessionId: input.sessionId,
      accountDefaults: {
        model: prefs.defaultVideoModel || undefined,
        duration: prefs.defaultVideoDuration,
        aspectRatio: prefs.defaultVideoAspect,
        resolution: prefs.defaultVideoResolution,
        crop: prefs.defaultVideoCrop,
      },
    })
    if (!request.prompt) throw new NotFoundException('节点缺少 prompt')

    const legacyUrl = String(node.data?.referenceImageUrl ?? '').trim() || undefined
    return this.videoOrchestrator.start(
      input.userId,
      request,
      (actions) => this.persist(input.sessionId, actions),
      legacyUrl,
    )
  }

  async waitVideoGeneration(input: {
    sessionId: string
    userId: string
    nodeId: string
    generationRecordId: string
  }): Promise<{ url?: string; status: string; generationRecordId: string; actions: CanvasAction[] }> {
    return this.videoOrchestrator.wait(
      input.userId,
      {
        sessionId: input.sessionId,
        nodeId: input.nodeId,
        generationRecordId: input.generationRecordId,
      },
      (actions) => this.persist(input.sessionId, actions),
    )
  }

  async runVideoGeneration(input: {
    sessionId: string
    userId: string
    nodeId: string
  }): Promise<{ url?: string; status: string; generationRecordId?: string; actions: CanvasAction[] }> {
    try {
      const started = await this.startVideoGeneration(input)
      const finished = await this.waitVideoGeneration({
        ...input,
        generationRecordId: started.generationRecordId,
      })
      return {
        ...finished,
        actions: [...started.actions, ...finished.actions],
      }
    } catch (err) {
      if (err instanceof ForbiddenException || err instanceof NotFoundException) throw err
      const errorMessage = err instanceof Error ? err.message : '视频生成失败'
      const errorActions: CanvasAction[] = [
        {
          type: 'update_node',
          payload: {
            id: input.nodeId,
            data: { status: 'error', errorMessage },
          },
        },
      ]
      await this.persist(input.sessionId, errorActions)
      return { status: 'error', actions: errorActions }
    }
  }

  async runTextGeneration(input: {
    sessionId: string
    userId: string
    nodeId: string
  }): Promise<{ status: string; generationRecordId?: string; actions: CanvasAction[] }> {
    const { canvas } = await this.loadOwnedSession(input.sessionId, input.userId)
    const node = canvas.nodes.find((n) => n.id === input.nodeId)
    if (!node) throw new NotFoundException('节点不存在')

    const prompt = String(node.data?.prompt ?? node.data?.content ?? '').trim()
    if (!prompt) throw new NotFoundException('节点缺少 prompt')

    const started: CanvasAction[] = [
      {
        type: 'update_node',
        payload: {
          id: input.nodeId,
          data: {
            status: 'generating',
            generationStartedAt: new Date().toISOString(),
            prompt,
          },
        },
      },
    ]
    await this.persist(input.sessionId, started)
    const allActions = [...started]

    try {
      const prefs = await this.loadAccountGenPrefs(input.userId)
      const refs = toStudioRefs(node, canvas)
      const model = pickString(node.data?.textModel, prefs.defaultTextModel) || undefined
      const record = await this.studio.generateText(
        input.userId,
        prompt,
        model,
        refs,
        undefined,
        undefined,
        node.data?.textThinking === true,
        node.data?.textThinkingEffort === 'max' ? 'max' : 'high',
        { sessionId: input.sessionId, nodeId: input.nodeId },
      )
      const recordId = record.id
      const content = parseRecordText(record.metadata, prompt)
      const finishActions: CanvasAction[] = [
        {
          type: 'update_node',
          payload: {
            id: input.nodeId,
            data: {
              status: 'completed',
              content,
              generationRecordId: recordId,
              errorMessage: null,
            },
          },
        },
      ]
      await this.persist(input.sessionId, finishActions)
      allActions.push(...finishActions)
      return { status: 'completed', generationRecordId: recordId, actions: allActions }
    } catch (err) {
      if (err instanceof ForbiddenException || err instanceof NotFoundException) throw err
      const errorMessage = err instanceof Error ? err.message : '文本生成失败'
      const errorActions: CanvasAction[] = [
        {
          type: 'update_node',
          payload: {
            id: input.nodeId,
            data: { status: 'error', errorMessage },
          },
        },
      ]
      await this.persist(input.sessionId, errorActions)
      allActions.push(...errorActions)
      return { status: 'error', actions: allActions }
    }
  }

  async runPromptGeneration(input: {
    sessionId: string
    userId: string
    nodeId: string
  }): Promise<{
    status: string
    generationRecordId?: string
    actions: CanvasAction[]
    promptMode?: string | null
    completionSummary?: string
  }> {
    const { canvas } = await this.loadOwnedSession(input.sessionId, input.userId)
    const node = canvas.nodes.find((n) => n.id === input.nodeId)
    if (!node) throw new NotFoundException('节点不存在')

    const prompt = String(node.data?.prompt ?? '').trim()
    const refs = toStudioRefs(node, canvas)
    const hasImageRef = refs.some((r) => r.mediaType === 'image' && Boolean(r.url?.trim()))
    if (!prompt && !hasImageRef) throw new NotFoundException('节点缺少 prompt')

    const started: CanvasAction[] = [
      {
        type: 'update_node',
        payload: {
          id: input.nodeId,
          data: {
            status: 'generating',
            generationStartedAt: new Date().toISOString(),
          },
        },
      },
    ]
    await this.persist(input.sessionId, started)
    const allActions = [...started]

    try {
      const prefs = await this.loadAccountGenPrefs(input.userId)
      const model = pickString(node.data?.textModel, prefs.defaultTextModel) || undefined
      const guideSceneId = pickString(node.data?.guideSceneId, '') || undefined
      const record = await this.studio.generatePrompt(
        input.userId,
        prompt,
        model,
        undefined,
        { sessionId: input.sessionId, nodeId: input.nodeId },
        guideSceneId,
        refs,
        Array.isArray(node.data?.mentionedKeys)
          ? (node.data.mentionedKeys as string[])
          : undefined,
      )
      const recordId = record.id
      const parsed = parseRecordPromptContent(record.metadata, prompt)
      const finishData: Record<string, unknown> = {
        status: 'completed',
        content: parsed.content,
        generationRecordId: recordId,
        errorMessage: null,
      }
      if (parsed.mode) finishData.promptMode = parsed.mode
      const existingGuideScene = pickString(node.data?.guideSceneId, '')
      if (existingGuideScene) finishData.guideSceneId = existingGuideScene
      const existingGuideEdit = pickString(node.data?.guideEditIntentId, '')
      if (existingGuideEdit) finishData.guideEditIntentId = existingGuideEdit
      const finishActions: CanvasAction[] = [
        { type: 'update_node', payload: { id: input.nodeId, data: finishData } },
      ]
      await this.persist(input.sessionId, finishActions)
      allActions.push(...finishActions)
      const completionSummary = summarizePromptCompletion(parsed.mode, parsed.content)
      return {
        status: 'completed',
        generationRecordId: recordId,
        actions: allActions,
        promptMode: parsed.mode,
        completionSummary: completionSummary ?? undefined,
      }
    } catch (err) {
      if (err instanceof ForbiddenException || err instanceof NotFoundException) throw err
      const errorMessage = err instanceof Error ? err.message : '提示词生成失败'
      const errorActions: CanvasAction[] = [
        {
          type: 'update_node',
          payload: {
            id: input.nodeId,
            data: { status: 'error', errorMessage },
          },
        },
      ]
      await this.persist(input.sessionId, errorActions)
      allActions.push(...errorActions)
      return { status: 'error', actions: allActions }
    }
  }

  async runAudioGeneration(input: {
    sessionId: string
    userId: string
    nodeId: string
  }): Promise<{ url?: string; status: string; generationRecordId?: string; actions: CanvasAction[] }> {
    const { canvas } = await this.loadOwnedSession(input.sessionId, input.userId)
    const node = canvas.nodes.find((n) => n.id === input.nodeId)
    if (!node) throw new NotFoundException('节点不存在')

    const text = String(node.data?.prompt ?? node.data?.content ?? '').trim()
    if (!text) throw new NotFoundException('节点缺少文本')

    const started: CanvasAction[] = [
      {
        type: 'update_node',
        payload: {
          id: input.nodeId,
          data: {
            status: 'generating',
            generationStartedAt: new Date().toISOString(),
            prompt: text,
          },
        },
      },
    ]
    await this.persist(input.sessionId, started)
    const allActions = [...started]

    try {
      const prefs = await this.loadAccountGenPrefs(input.userId)
      const refs = toStudioRefs(node, canvas)
      const record = await this.studio.generateAudio(
        input.userId,
        text,
        {
          model: pickString(node.data?.audioModel, prefs.defaultAudioModel) || undefined,
          voice: pickString(node.data?.audioVoice, prefs.audioVoice || 'female-shaonv'),
          emotion: pickString(node.data?.audioEmotion, 'neutral'),
          language: pickString(node.data?.audioLanguage, 'zh'),
          speed: typeof node.data?.audioSpeed === 'number' ? node.data.audioSpeed : prefs.audioSpeed ?? 1,
          volume: typeof node.data?.audioVolume === 'number' ? node.data.audioVolume : 1,
          pitch: typeof node.data?.audioPitch === 'number' ? node.data.audioPitch : 0,
        },
        refs,
        undefined,
        undefined,
        { sessionId: input.sessionId, nodeId: input.nodeId },
      )
      const recordId = record.id
      const url = typeof record.url === 'string' && record.url ? record.url : undefined
      const finishActions: CanvasAction[] = [
        {
          type: 'update_node',
          payload: {
            id: input.nodeId,
            data: {
              status: 'completed',
              url,
              generationRecordId: recordId,
              errorMessage: null,
            },
          },
        },
      ]
      await this.persist(input.sessionId, finishActions)
      allActions.push(...finishActions)
      return { url, status: 'completed', generationRecordId: recordId, actions: allActions }
    } catch (err) {
      if (err instanceof ForbiddenException || err instanceof NotFoundException) throw err
      const errorMessage = err instanceof Error ? err.message : '音频生成失败'
      const errorActions: CanvasAction[] = [
        {
          type: 'update_node',
          payload: {
            id: input.nodeId,
            data: { status: 'error', errorMessage },
          },
        },
      ]
      await this.persist(input.sessionId, errorActions)
      allActions.push(...errorActions)
      return { status: 'error', actions: allActions }
    }
  }

  async getGenerationStatus(input: {
    sessionId: string
    nodeId: string
  }): Promise<{
    status: string
    url?: string
    generationRecordId?: string
    materialId?: string
    recordKind?: 'studio' | 'material'
  }> {
    const node = await this.getNode(input)
    const status = nodeStatus(node)
    const url = typeof node.data?.url === 'string' && node.data.url ? node.data.url : undefined
    const generationRecordId = this.generationRecordIdFromNode(node)
    const materialId = this.materialIdFromNode(node)
    const recordKind = generationRecordId ? 'studio' : materialId ? 'material' : undefined
    return {
      status,
      url,
      generationRecordId,
      materialId,
      recordKind,
    }
  }

  private generationRecordIdFromNode(node: CanvasNode): string | undefined {
    const id = node.data?.generationRecordId
    return typeof id === 'string' && id.trim() ? id.trim() : undefined
  }

  private materialIdFromNode(node: CanvasNode): string | undefined {
    const id = node.data?.materialId
    return typeof id === 'string' && id.trim() ? id.trim() : undefined
  }

  private async resolveGenerationRecord(input: {
    sessionId: string
    userId: string
    generationRecordId?: string
    nodeId?: string
  }): Promise<{ recordId: string; recordKind: 'studio' | 'material'; nodeId?: string }> {
    const direct = input.generationRecordId?.trim()
    if (direct) {
      try {
        await this.studio.getGeneration(input.userId, direct)
        return { recordId: direct, recordKind: 'studio', nodeId: input.nodeId }
      } catch {
        const material = await this.prisma.material.findFirst({
          where: { id: direct, shot: { session: { userId: input.userId } } },
        })
        if (material) {
          return { recordId: direct, recordKind: 'material', nodeId: input.nodeId }
        }
        throw new NotFoundException('生成记录不存在')
      }
    }
    if (!input.nodeId) {
      throw new BadRequestException('需要提供 generationRecordId 或 nodeId')
    }
    const node = await this.getNode({ sessionId: input.sessionId, nodeId: input.nodeId })
    const studioId = this.generationRecordIdFromNode(node)
    if (studioId) {
      return { recordId: studioId, recordKind: 'studio', nodeId: input.nodeId }
    }
    const materialId = this.materialIdFromNode(node)
    if (materialId) {
      return { recordId: materialId, recordKind: 'material', nodeId: input.nodeId }
    }
    throw new NotFoundException('节点无关联的生成记录')
  }

  async getGenerationDiagnostic(input: {
    sessionId: string
    userId: string
    generationRecordId?: string
    nodeId?: string
  }) {
    const { recordId, recordKind } = await this.resolveGenerationRecord(input)
    if (recordKind === 'material') {
      return this.material.getMaterialDiagnostic(input.userId, recordId)
    }
    return this.studio.getGenerationDiagnostic(input.userId, recordId)
  }

  async cancelGeneration(input: {
    sessionId: string
    userId: string
    generationRecordId?: string
    nodeId?: string
  }): Promise<{
    status: string
    generationRecordId: string
    recordKind: 'studio' | 'material'
    actions: CanvasAction[]
  }> {
    const { recordId, recordKind, nodeId } = await this.resolveGenerationRecord(input)
    if (recordKind === 'material') {
      await this.material.cancelGeneration(input.userId, recordId)
    } else {
      await this.studio.cancelGeneration(input.userId, recordId)
    }
    const actions: CanvasAction[] = []
    if (nodeId) {
      actions.push({
        type: 'update_node',
        payload: {
          id: nodeId,
          data: { status: 'error', errorMessage: '已取消' },
        },
      })
      await this.persist(input.sessionId, actions)
    }
    return {
      status: 'cancelled',
      generationRecordId: recordId,
      recordKind,
      actions,
    }
  }

  async confirmPlatformFallback(input: {
    sessionId: string
    userId: string
    generationRecordId?: string
    nodeId?: string
  }): Promise<{
    status: string
    generationRecordId: string
    recordKind: 'studio' | 'material'
    url?: string
    actions: CanvasAction[]
  }> {
    const { recordId, recordKind, nodeId } = await this.resolveGenerationRecord(input)
    const record =
      recordKind === 'material'
        ? await this.material.confirmPlatformFallback(input.userId, recordId)
        : await this.studio.confirmPlatformFallback(input.userId, recordId)
    const actions: CanvasAction[] = []
    const url = typeof record.url === 'string' && record.url ? record.url : undefined
    if (nodeId) {
      const patch: Record<string, unknown> = {
        status: record.status === 'completed' ? 'completed' : record.status,
      }
      if (recordKind === 'studio') patch.generationRecordId = recordId
      if (recordKind === 'material') patch.materialId = recordId
      if (url) patch.url = url
      if (record.status === 'failed') {
        patch.errorMessage = '平台回退失败'
      }
      actions.push({
        type: 'update_node',
        payload: { id: nodeId, data: patch },
      })
      await this.persist(input.sessionId, actions)
    }
    return {
      status: record.status,
      generationRecordId: recordId,
      recordKind,
      url,
      actions,
    }
  }

  async cancelPlatformFallback(input: {
    sessionId: string
    userId: string
    generationRecordId?: string
    nodeId?: string
  }): Promise<{
    status: string
    generationRecordId: string
    recordKind: 'studio' | 'material'
    actions: CanvasAction[]
  }> {
    const { recordId, recordKind, nodeId } = await this.resolveGenerationRecord(input)
    if (recordKind === 'material') {
      await this.material.cancelPlatformFallback(input.userId, recordId)
    } else {
      await this.studio.cancelPlatformFallback(input.userId, recordId)
    }
    const actions: CanvasAction[] = []
    if (nodeId) {
      actions.push({
        type: 'update_node',
        payload: {
          id: nodeId,
          data: { status: 'error', errorMessage: '已拒绝平台回退' },
        },
      })
      await this.persist(input.sessionId, actions)
    }
    return { status: 'failed', generationRecordId: recordId, recordKind, actions }
  }

  async listGenerationTasks(input: {
    sessionId: string
    userId: string
    type?: string
  }): Promise<{
    tasks: Array<{
      id: string
      type: string
      status: string
      prompt: string
      url?: string | null
      nodeId?: string | null
      sessionId?: string | null
      createdAt: Date
    }>
  }> {
    await this.loadOwnedSession(input.sessionId, input.userId)
    const rows = await this.studio.listGenerations(input.userId, input.type, input.sessionId)
    return {
      tasks: rows.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        prompt: row.prompt,
        url: row.url,
        nodeId: row.nodeId,
        sessionId: row.sessionId,
        createdAt: row.createdAt,
      })),
    }
  }

  async listUserAssets(input: { userId: string }): Promise<{
    items: Array<{
      id: string
      url: string
      label: string
      kind: string
      sourceNodeId?: string | null
      createdAt: Date
    }>
  }> {
    const items = await this.prisma.userAsset.findMany({
      where: { userId: input.userId },
      orderBy: { createdAt: 'desc' },
      take: 500,
    })
    return { items }
  }

  async listPublicAssets(input?: {
    kind?: 'image' | 'video' | 'audio'
    search?: string
  }): Promise<{ items: typeof PUBLIC_ASSETS }> {
    let items = PUBLIC_ASSETS
    if (input?.kind) {
      items = items.filter((item) => item.kind === input.kind)
    }
    if (input?.search) {
      const q = input.search.toLowerCase()
      items = items.filter((item) => item.label.toLowerCase().includes(q))
    }
    return { items }
  }

  async saveNodeToAssetLibrary(input: {
    sessionId: string
    userId: string
    nodeId: string
    label?: string
  }): Promise<{ assetId: string; url: string; kind: string }> {
    await this.loadOwnedSession(input.sessionId, input.userId)
    const node = await this.getNode({ sessionId: input.sessionId, nodeId: input.nodeId })
    const kind = assetKindFromNodeType(String(node.type ?? ''))
    const url = String(node.data?.url ?? '').trim()
    if (!kind || !url) {
      throw new BadRequestException('节点缺少可保存的媒体 URL')
    }

    const result = await this.persistRemote.persistRemote({
      userId: input.userId,
      url,
      kind,
      label: input.label?.trim() || nodeTitle(node) || node.id,
      sessionId: input.sessionId,
      sourceNodeId: node.id,
      replaceNodeUrl: false,
    })
    return { assetId: result.assetId, url: result.persistedUrl, kind }
  }

  async introduceNodesToAgent(input: {
    sessionId: string
    userId: string
    nodeIds: string[]
  }): Promise<{
    attachments: SidebarAttachment[]
    skipped: string[]
    canvasCommands: Array<{ type: string; attachments: SidebarAttachment[] }>
  }> {
    await this.loadOwnedSession(input.sessionId, input.userId)
    const attachments: SidebarAttachment[] = []
    const skipped: string[] = []
    for (const nodeId of input.nodeIds) {
      try {
        const node = await this.getNode({ sessionId: input.sessionId, nodeId })
        const att = nodeToAgentAttachment(node)
        if (att) attachments.push(att)
        else skipped.push(nodeId)
      } catch {
        skipped.push(nodeId)
      }
    }
    const canvasCommands =
      attachments.length > 0
        ? [{ type: 'introduce_nodes', attachments }]
        : []
    return { attachments, skipped, canvasCommands }
  }

  async applyAssetToNode(input: {
    sessionId: string
    userId: string
    nodeId: string
    assetId: string
    source: 'user' | 'public'
  }): Promise<{ actions: CanvasAction[]; canvasCommands: Array<{ type: string; nodeId: string }> }> {
    await this.loadOwnedSession(input.sessionId, input.userId)
    let url = ''
    let label = ''
    let kind: 'image' | 'video' | 'audio' | null = null
    if (input.source === 'user') {
      const asset = await this.prisma.userAsset.findFirst({
        where: { id: input.assetId, userId: input.userId },
      })
      if (!asset) throw new NotFoundException('资产不存在')
      url = asset.url
      label = asset.label
      kind = asset.kind as 'image' | 'video' | 'audio'
    } else {
      const asset = PUBLIC_ASSETS.find((item) => item.id === input.assetId)
      if (!asset) throw new NotFoundException('公共资产不存在')
      url = asset.url
      label = asset.label
      kind = asset.kind
    }
    const node = await this.getNode({ sessionId: input.sessionId, nodeId: input.nodeId })
    const nodeKind = assetKindFromNodeType(String(node.type ?? ''))
    if (!nodeKind || nodeKind !== kind) {
      throw new BadRequestException('资产类型与节点类型不匹配')
    }
    const actions: CanvasAction[] = [
      {
        type: 'update_node',
        payload: {
          id: input.nodeId,
          data: {
            url,
            status: 'completed',
            label: label || nodeTitle(node),
          },
        },
      },
    ]
    await this.persist(input.sessionId, actions)
    return {
      actions,
      canvasCommands: [{ type: 'focus_node', nodeId: input.nodeId }],
    }
  }

  async getCanvasLayout(input: { sessionId: string }): Promise<{
    nodes: Array<{
      id: string
      type: string
      title: string
      status: string
      position: { x: number; y: number }
      absolutePosition: { x: number; y: number }
      size: { w: number; h: number }
      parentNode?: string
    }>
    groups: Array<{
      id: string
      title: string
      childIds: string[]
      position: { x: number; y: number }
      size: { w: number; h: number }
    }>
    edges: Array<{ id: string; source: string; target: string }>
  }> {
    const { canvas } = await this.loadSession(input.sessionId)
    const layoutNodes = canvas.nodes as LayoutNode[]
    const nodes = layoutNodes.map((node) => {
      const { w, h } = getNodeSize(node)
      return {
        id: node.id,
        type: String(node.type ?? ''),
        title: nodeTitle(node),
        status: nodeStatus(node),
        position: node.position,
        absolutePosition: getAbsolutePosition(node, layoutNodes),
        size: { w, h },
        ...(node.parentNode ? { parentNode: node.parentNode } : {}),
      }
    })
    return {
      nodes,
      groups: summarizeLayoutGroups(layoutNodes),
      edges: canvas.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    }
  }

  async duplicateNode(input: {
    sessionId: string
    userId: string
    nodeId?: string
    nodeIds?: string[]
    includeUpstream?: boolean
    offset?: { x: number; y: number }
  }): Promise<{
    nodeId: string
    nodeIds: string[]
    actions: CanvasAction[]
    canvasCommands: Array<{ type: string; nodeId: string }>
  }> {
    await this.loadOwnedSession(input.sessionId, input.userId)
    const { canvas } = await this.loadSession(input.sessionId)

    const seeds = input.nodeIds?.length ? input.nodeIds : input.nodeId ? [input.nodeId] : []
    if (!seeds.length) throw new BadRequestException('nodeId or nodeIds required')

    const edgeMode = input.includeUpstream ? 'upstream' : 'none'
    const nodes = canvas.nodes as DuplicateCanvasNode[]
    const edges = canvas.edges ?? []
    const sourceIds = resolveDuplicateSourceIds(
      nodes,
      edges,
      seeds[0],
      seeds.length > 1 ? seeds : [seeds[0]],
    )
    const result = duplicateSubgraph(nodes, edges, sourceIds, {
      offset: input.offset ?? { x: 48, y: 48 },
      edgeMode,
      createNodeId: (type) => nextNodeId(type),
    })
    const updated: CanvasData = {
      ...canvas,
      nodes: [...canvas.nodes, ...(result.nodes as CanvasNode[])],
      edges: [...edges, ...result.edges],
    }
    await this.persistCanvasData(input.sessionId, updated)

    const actions = duplicateResultToCanvasActions(result)
    const nodeIds = result.nodes.map((node) => node.id)
    const focusId = result.newRootIds[0] ?? result.nodes[0]?.id ?? nodeIds[0]
    return {
      nodeId: nodeIds[0]!,
      nodeIds,
      actions,
      canvasCommands: [{ type: 'focus_node', nodeId: focusId }],
    }
  }

  async uploadMediaToCanvas(input: {
    sessionId: string
    userId: string
    url: string
    mediaType: 'image' | 'video' | 'audio'
    title?: string
    position?: { x: number; y: number }
  }): Promise<{ nodeId: string; actions: CanvasAction[] }> {
    await this.loadOwnedSession(input.sessionId, input.userId)
    const { canvas } = await this.loadSession(input.sessionId)
    const nodeType = input.mediaType === 'image' ? 'mediaInput' : input.mediaType
    const nodeId = nextNodeId(nodeType)
    const position =
      input.position ?? {
        x: 80 + (canvas.nodes.length % 4) * GRID_X,
        y: 80 + Math.floor(canvas.nodes.length / 4) * GRID_Y,
      }
    const actions: CanvasAction[] = [
      {
        type: 'add_node',
        payload: {
          id: nodeId,
          nodeType: nodeType as NodeType,
          position,
          data: {
            title: input.title?.trim() || '上传媒体',
            url: input.url.trim(),
            status: 'completed',
          },
        },
      },
    ]
    await this.persist(input.sessionId, actions)
    return { nodeId, actions }
  }

  async exportMediaPackage(input: {
    sessionId: string
    userId: string
    nodeIds: string[]
  }): Promise<{
    manifest: {
      exportedAt: string
      count: number
      items: Array<{ nodeId: string; url: string; fileName: string; downloadPath: string }>
    }
    /** Client command: browser downloads workflow zip (graph + media). */
    canvasCommands: Array<{
      type: 'export_pack'
      nodeIds: string[]
      exportMode?: 'full_package' | 'lightweight'
    }>
  }> {
    await this.loadOwnedSession(input.sessionId, input.userId)
    const { canvas } = await this.loadSession(input.sessionId)
    const idSet = new Set(input.nodeIds)
    const items: Array<{ nodeId: string; url: string; fileName: string; downloadPath: string }> = []
    for (const node of canvas.nodes) {
      if (!idSet.has(node.id)) continue
      const url = String(node.data?.url ?? '').trim()
      if (!url) continue
      const ext = url.includes('.mp4') ? 'mp4' : url.includes('.mp3') ? 'mp3' : 'png'
      const fileName = `${nodeTitle(node) || node.id}.${ext}`.replace(/[^\w\u4e00-\u9fff.-]+/g, '_')
      const params = new URLSearchParams({
        url,
        filename: fileName,
        sessionId: input.sessionId,
      })
      items.push({
        nodeId: node.id,
        url,
        fileName,
        downloadPath: `/api/media/stream-download?${params.toString()}`,
      })
    }
    // Empty nodeIds → client treats as full canvas; otherwise graph scope (incl. nodes without url).
    const scopedNodeIds =
      input.nodeIds.length === 0
        ? []
        : canvas.nodes.filter((node) => idSet.has(node.id)).map((node) => node.id)
    return {
      manifest: {
        exportedAt: new Date().toISOString(),
        count: items.length,
        items,
      },
      canvasCommands: [
        { type: 'export_pack', nodeIds: scopedNodeIds, exportMode: 'full_package' },
      ],
    }
  }

  async importWorkflow(input: {
    sessionId: string
    userId: string
    workflow?: unknown
    workflowUrl?: string
    /** Default true: along-edges layout on addedNodeIds after merge. */
    arrangeAlongEdges?: boolean
  }): Promise<{
    addedNodeIds: string[]
    idMap: Record<string, string>
    mediaOk: number
    mediaFail: number
    warnings?: string[]
    actions: CanvasAction[]
    canvasCommands: Array<{ type: 'focus_nodes'; nodeIds: string[] }>
  }> {
    await this.loadOwnedSession(input.sessionId, input.userId)
    const { canvas } = await this.loadSession(input.sessionId)

    let raw: unknown
    if (input.workflow !== undefined && input.workflow !== null) {
      raw = input.workflow
    } else if (input.workflowUrl?.trim()) {
      raw = await fetchWorkflowJson(input.workflowUrl.trim())
    } else {
      throw new BadRequestException('需要提供 workflow 或 workflowUrl')
    }

    let validated
    try {
      validated = validateWorkflow(raw)
    } catch (err) {
      throw new BadRequestException(formatWorkflowValidationError(err))
    }

    const { document: remapped, idMap } = remapWorkflowIds(validated, (type) => nextNodeId(type))
    const remappedIdSet = new Set(remapped.graph.nodes.map((node) => node.id))
    const { x: dx, y: dy } = computeImportTranslation({
      importNodes: remapped.graph.nodes,
      canvasNodes: canvas.nodes,
    })

    const urlByNodeId = new Map<string, { url: string; kind: 'image' | 'video' | 'audio' }>()
    for (const node of remapped.graph.nodes) {
      const url = String(node.data?.url ?? '').trim()
      if (!url) continue
      urlByNodeId.set(node.id, { url, kind: inferPersistKind(node.type) })
    }
    for (const entry of remapped.mediaIndex) {
      const url = String(entry.url ?? entry.persistedUrl ?? '').trim()
      if (!url) continue
      const node = remapped.graph.nodes.find((n) => n.id === entry.nodeId)
      if (!node) continue
      if (!urlByNodeId.has(entry.nodeId)) {
        urlByNodeId.set(entry.nodeId, { url, kind: inferPersistKind(node.type, entry.kind) })
        if (!String(node.data?.url ?? '').trim()) {
          node.data = { ...node.data, url }
        }
      }
    }
    for (const node of remapped.graph.nodes) {
      const refs = node.data?.localRefs
      if (Array.isArray(refs) && refs[0] && typeof refs[0] === 'object') {
        const refUrl = String((refs[0] as { url?: string }).url ?? '').trim()
        if (refUrl.startsWith('data:image')) continue
        if (refUrl && !urlByNodeId.has(node.id)) {
          urlByNodeId.set(node.id, { url: refUrl, kind: inferPersistKind(node.type) })
        }
      }
    }

    let mediaOk = 0
    let mediaFail = 0
    const warnings: string[] = []
    for (const [nodeId, { url, kind }] of urlByNodeId) {
      const node = remapped.graph.nodes.find((n) => n.id === nodeId)
      if (!node) continue
      try {
        const persisted = await this.persistRemote.persistRemote({
          userId: input.userId,
          url,
          kind,
          sessionId: input.sessionId,
          sourceNodeId: nodeId,
          replaceNodeUrl: false,
        })
        if (persisted?.persistedUrl) {
          node.data = { ...node.data, url: persisted.persistedUrl }
          mediaOk += 1
        } else {
          mediaFail += 1
          warnings.push(`媒体持久化失败: ${nodeId}`)
        }
      } catch (err) {
        mediaFail += 1
        warnings.push(
          `媒体持久化失败: ${nodeId}${err instanceof Error && err.message ? ` (${err.message})` : ''}`,
        )
      }
    }

    const mergeNodes: ImportedCanvasNode[] = remapped.graph.nodes.map((node) => {
      const root = isRootNode(node, remappedIdSet)
      const parent = node.parentNode ?? node.parentId
      return {
        id: node.id,
        type: node.type as NodeType,
        position: root
          ? { x: node.position.x + dx, y: node.position.y + dy }
          : { x: node.position.x, y: node.position.y },
        data: { ...node.data },
        ...(!root && parent
          ? { parentNode: parent, extent: 'parent' as const, expandParent: true }
          : {}),
      }
    })
    const mergeEdges = remapped.graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    }))

    const updated: CanvasData = {
      ...canvas,
      nodes: [...canvas.nodes, ...(mergeNodes as CanvasNode[])],
      edges: [...canvas.edges, ...mergeEdges],
    }

    const addedNodeIds = mergeNodes.map((node) => node.id)
    const shouldArrange = input.arrangeAlongEdges !== false
    const finalNodes =
      shouldArrange
        ? (layoutNodesAlongEdges(
            updated.nodes as LayoutNode[],
            updated.edges ?? [],
            addedNodeIds,
            40,
          ) as CanvasNode[])
        : updated.nodes
    const finalCanvas: CanvasData = { ...updated, nodes: finalNodes }
    await this.persistCanvasData(input.sessionId, finalCanvas)

    const positionById = new Map(
      finalNodes.map((node) => [node.id, node.position] as const),
    )
    const actions: CanvasAction[] = [
      ...mergeNodes.map((node) => ({
        type: 'add_node' as const,
        payload: {
          id: node.id,
          nodeType: node.type,
          position: positionById.get(node.id) ?? node.position,
          data: node.data ?? {},
        },
      })),
      ...mergeEdges.map((edge) => ({
        type: 'add_edge' as const,
        payload: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
        },
      })),
    ]

    return {
      addedNodeIds,
      idMap,
      mediaOk,
      mediaFail,
      ...(warnings.length ? { warnings } : {}),
      actions,
      canvasCommands: [{ type: 'focus_nodes', nodeIds: addedNodeIds }],
    }
  }

  async groupNodes(input: {
    sessionId: string
    userId: string
    nodeIds: string[]
    title?: string
  }): Promise<{ groupId: string; actions: CanvasAction[] }> {
    await this.loadOwnedSession(input.sessionId, input.userId)
    const { canvas } = await this.loadSession(input.sessionId)
    const before = canvas.nodes as LayoutNode[]
    const result = createGroupFromNodes(before, input.nodeIds, input.title)
    if (!result) throw new BadRequestException('至少需要 2 个可分组节点')
    await this.persistLayoutNodes(input.sessionId, result.nodes)
    return { groupId: result.groupId, actions: [] }
  }

  async ungroupNode(input: {
    sessionId: string
    userId: string
    groupId: string
  }): Promise<{ actions: CanvasAction[] }> {
    await this.loadOwnedSession(input.sessionId, input.userId)
    const { canvas } = await this.loadSession(input.sessionId)
    const before = canvas.nodes as LayoutNode[]
    const after = ungroupNode(before, input.groupId)
    await this.persistLayoutNodes(input.sessionId, after)
    return { actions: [] }
  }

  async arrangeNodesGrid(input: {
    sessionId: string
    userId: string
    nodeIds: string[]
    gap?: number
  }): Promise<{ actions: CanvasAction[] }> {
    await this.loadOwnedSession(input.sessionId, input.userId)
    const { canvas } = await this.loadSession(input.sessionId)
    const before = canvas.nodes as LayoutNode[]
    const after = layoutNodesInGrid(before, input.nodeIds, input.gap ?? 40)
    await this.persistLayoutNodes(input.sessionId, after)
    return { actions: [] }
  }

  async arrangeNodesAlongEdges(input: {
    sessionId: string
    userId: string
    nodeIds: string[]
    gap?: number
  }): Promise<{ actions: CanvasAction[] }> {
    await this.loadOwnedSession(input.sessionId, input.userId)
    const { canvas } = await this.loadSession(input.sessionId)
    const after = layoutNodesAlongEdges(
      canvas.nodes as LayoutNode[],
      canvas.edges ?? [],
      input.nodeIds,
      input.gap ?? 40,
    )
    await this.persistLayoutNodes(input.sessionId, after)
    return { actions: [] }
  }

  async moveNodes(input: {
    sessionId: string
    userId: string
    items: Array<{ nodeId: string; x: number; y: number }>
  }): Promise<{ movedNodeIds: string[]; actions: CanvasAction[] }> {
    await this.loadOwnedSession(input.sessionId, input.userId)
    const { canvas } = await this.loadSession(input.sessionId)
    const before = canvas.nodes as LayoutNode[]
    const { nodes: after, movedIds } = moveNodes(before, input.items)
    if (!movedIds.length) {
      throw new BadRequestException('未找到可移动的节点')
    }
    await this.persistLayoutNodes(input.sessionId, after)
    return { movedNodeIds: movedIds, actions: [] }
  }

  async applyLayoutOps(input: {
    sessionId: string
    userId: string
    ops: CanvasLayoutOp[]
  }): Promise<{
    results: CanvasLayoutOpResult[]
    layout: Awaited<ReturnType<AgentCanvasToolsService['getCanvasLayout']>>
    actions: CanvasAction[]
  }> {
    await this.loadOwnedSession(input.sessionId, input.userId)
    const { canvas } = await this.loadSession(input.sessionId)
    const before = canvas.nodes as LayoutNode[]
    let after: LayoutNode[]
    let results: CanvasLayoutOpResult[]
    try {
      ;({ nodes: after, results } = applyLayoutOps(before, input.ops, canvas.edges ?? []))
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : '布局操作失败')
    }
    await this.persistLayoutNodes(input.sessionId, after)
    const layout = await this.getCanvasLayout({ sessionId: input.sessionId })
    return { results, layout, actions: [] }
  }

  async getImageEditCapabilities(input: {
    sessionId: string
    nodeId: string
  }): Promise<{
    canEdit: boolean
    nodeType: string
    hasUrl: boolean
    supportedModes: string[]
  }> {
    const node = await this.getNode({ sessionId: input.sessionId, nodeId: input.nodeId })
    const nodeType = String(node.type ?? '')
    const url = String(node.data?.url ?? '').trim()
    const canEdit = Boolean(url) && canEditImageNodeType({
      type: nodeType,
      mediaKind: node.data?.mediaKind,
      mimeType: node.data?.mimeType,
    })
    return {
      canEdit,
      nodeType,
      hasUrl: Boolean(url),
      supportedModes: canEdit ? ['inpaint'] : [],
    }
  }

  async gridSliceImage(input: {
    sessionId: string
    userId: string
    sourceUrl?: string
    nodeId?: string
    cols: number
    rows: number
  }) {
    let sourceUrl = String(input.sourceUrl ?? '').trim()
    if (!sourceUrl) {
      if (!input.nodeId) {
        throw new BadRequestException('需要提供 sourceUrl 或 nodeId')
      }
      await this.loadOwnedSession(input.sessionId, input.userId)
      const node = await this.getNode({ sessionId: input.sessionId, nodeId: input.nodeId })
      sourceUrl = String(node.data?.url ?? '').trim()
      if (!sourceUrl) {
        throw new BadRequestException('节点缺少可切图的 URL')
      }
    }
    return this.imageSliceService.slice({
      userId: input.userId,
      sourceUrl,
      cols: input.cols,
      rows: input.rows,
      sessionId: input.sessionId,
    })
  }

  async getAgentMessages(input: {
    sessionId: string
    threadId: string
  }): Promise<Array<{ id: string; role: string; content: string; toolCalls?: string; createdAt: Date }>> {
    const messages = await this.prisma.agentMessage.findMany({
      where: { sessionId: input.sessionId, threadId: input.threadId },
      orderBy: { createdAt: 'asc' },
    })
    return messages.map((msg) => ({
      id: msg.id,
      role: msg.role,
      content: msg.content,
      toolCalls: msg.toolCalls ?? undefined,
      createdAt: msg.createdAt,
    }))
  }

  async saveAgentMessage(input: {
    sessionId: string
    threadId: string
    userId: string
    role: string
    content: string
    toolCalls?: string
  }): Promise<{ id: string }> {
    // Verify session ownership
    await this.loadOwnedSession(input.sessionId, input.userId)

    const content = sanitizeAgentMessageContent(input.role, input.content)
    if (!content) {
      return { id: '' }
    }

    const message = await this.prisma.agentMessage.create({
      data: {
        sessionId: input.sessionId,
        threadId: input.threadId,
        role: input.role,
        content,
        toolCalls: input.toolCalls,
      },
    })
    return { id: message.id }
  }

  /**
   * Acquire a distributed lock for a thread.
   * Returns true if lock acquired, false if already locked by another holder.
   * Automatically cleans up expired locks.
   */
  async acquireThreadLock(input: {
    threadId: string
    holderId: string
    ttlSeconds: number
  }): Promise<{ acquired: boolean }> {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000)

    // Clean up expired locks for this thread
    await this.prisma.threadLock.deleteMany({
      where: {
        threadId: input.threadId,
        leaseExpiresAt: { lt: now },
      },
    })

    // Try to acquire the lock
    try {
      await this.prisma.threadLock.create({
        data: {
          threadId: input.threadId,
          leaseHolder: input.holderId,
          leaseExpiresAt: expiresAt,
        },
      })
      return { acquired: true }
    } catch {
      // Lock already exists - check if we hold it
      const existing = await this.prisma.threadLock.findUnique({
        where: { threadId: input.threadId },
      })
      if (existing && existing.leaseHolder === input.holderId) {
        // We already hold it - renew
        await this.prisma.threadLock.update({
          where: { threadId: input.threadId },
          data: { leaseExpiresAt: expiresAt },
        })
        return { acquired: true }
      }
      return { acquired: false }
    }
  }

  /**
   * Renew an existing lock. Returns false if lock doesn't exist or held by another holder.
   */
  async renewThreadLock(input: {
    threadId: string
    holderId: string
    ttlSeconds: number
  }): Promise<{ renewed: boolean }> {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000)

    const existing = await this.prisma.threadLock.findUnique({
      where: { threadId: input.threadId },
    })

    if (!existing) {
      return { renewed: false }
    }

    // Check if lock expired
    if (existing.leaseExpiresAt < now) {
      // Delete expired lock
      await this.prisma.threadLock.delete({
        where: { threadId: input.threadId },
      })
      return { renewed: false }
    }

    // Check if we hold the lock
    if (existing.leaseHolder !== input.holderId) {
      return { renewed: false }
    }

    // Renew the lock
    await this.prisma.threadLock.update({
      where: { threadId: input.threadId },
      data: { leaseExpiresAt: expiresAt },
    })
    return { renewed: true }
  }

  /**
   * Release a lock. Safe to call even if lock doesn't exist.
   */
  async releaseThreadLock(input: {
    threadId: string
    holderId: string
  }): Promise<{ released: boolean }> {
    const existing = await this.prisma.threadLock.findUnique({
      where: { threadId: input.threadId },
    })

    if (!existing) {
      return { released: false }
    }

    // Only release if we hold the lock
    if (existing.leaseHolder !== input.holderId) {
      return { released: false }
    }

    await this.prisma.threadLock.delete({
      where: { threadId: input.threadId },
    })
    return { released: true }
  }

  /**
   * W15: Get generation progress from GenProgress table
   */
  async getGenProgress(input: { threadId: string }): Promise<{
    id: string
    lines: string
    summary: string | null
  } | null> {
    const record = await this.prisma.genProgress.findFirst({
      where: { threadId: input.threadId },
      orderBy: { createdAt: 'desc' },
    })

    if (!record) {
      return null
    }

    return {
      id: record.id,
      lines: record.lines,
      summary: record.summary,
    }
  }

  /**
   * W15: Save generation progress to GenProgress table
   */
  async saveGenProgress(input: {
    threadId: string
    sessionId: string
    lines: string
    summary?: string | null
  }): Promise<{ id: string }> {
    const record = await this.prisma.genProgress.create({
      data: {
        threadId: input.threadId,
        sessionId: input.sessionId,
        lines: input.lines,
        summary: input.summary ?? null,
      },
    })
    return { id: record.id }
  }

  /**
   * W18: Get latest context snapshot for a thread
   */
  async getContextSnapshot(input: {
    threadId: string
    stage?: string
  }): Promise<{
    id: string
    stage: string
    brief: string | null
    planSummary: string | null
    manifestJson: string | null
    messageCount: number | null
  } | null> {
    const where: { threadId: string; stage?: string } = { threadId: input.threadId }
    if (input.stage) {
      where.stage = input.stage
    }

    const record = await this.prisma.contextSnapshot.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
    })

    if (!record) {
      return null
    }

    return {
      id: record.id,
      stage: record.stage,
      brief: record.brief,
      planSummary: record.planSummary,
      manifestJson: record.manifestJson,
      messageCount: record.messageCount,
    }
  }

  /**
   * W18: Save context snapshot (brief/plan/manifest summaries)
   */
  async saveContextSnapshot(input: {
    threadId: string
    sessionId: string
    stage: string
    brief?: string | null
    planSummary?: string | null
    manifestJson?: string | null
    messageCount?: number | null
  }): Promise<{ id: string }> {
    const record = await this.prisma.contextSnapshot.create({
      data: {
        threadId: input.threadId,
        sessionId: input.sessionId,
        stage: input.stage,
        brief: input.brief ?? null,
        planSummary: input.planSummary ?? null,
        manifestJson: input.manifestJson ?? null,
        messageCount: input.messageCount ?? null,
      },
    })
    return { id: record.id }
  }

  private async pollGeneration(
    userId: string,
    recordId: string,
    initial: { id: string; status: string; url?: string | null },
    timeoutMs = this.pollTimeoutMs,
  ): Promise<{ id: string; status: string; url?: string | null }> {
    const terminal = new Set(['completed', 'failed', 'error', 'fallback_pending'])
    if (terminal.has(initial.status)) return initial

    const deadline = Date.now() + timeoutMs
    let latest = initial
    while (Date.now() < deadline) {
      await sleep(this.pollIntervalMs)
      latest = await this.studio.getGeneration(userId, recordId)
      if (terminal.has(latest.status)) return latest
    }
    return { ...latest, status: latest.status === 'generating' ? 'timeout' : latest.status }
  }

  private async loadSession(sessionId: string): Promise<{
    id: string
    userId: string
    canvas: CanvasData
  }> {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } })
    if (!session) throw new NotFoundException('会话不存在')
    return {
      id: session.id,
      userId: session.userId,
      canvas: parseCanvas(session.canvasData),
    }
  }

  private async loadOwnedSession(
    sessionId: string,
    userId: string,
  ): Promise<{ id: string; userId: string; canvas: CanvasData }> {
    const session = await this.loadSession(sessionId)
    if (session.userId !== userId) throw new ForbiddenException()
    return session
  }

  /**
   * W8: Accumulate canvas actions in stagedActions without applying to canvasData.
   */
  async stageCanvasActions(input: {
    sessionId: string
    actions: CanvasAction[]
  }): Promise<{ stagedCount: number }> {
    if (input.actions.length === 0) {
      const session = await this.prisma.session.findUnique({ where: { id: input.sessionId } })
      if (!session) throw new NotFoundException('会话不存在')
      const staged = parseStagedActions(session.stagedActions)
      return { stagedCount: staged.length }
    }
    await this.expireStaleStage(input.sessionId)
    const now = new Date()
    await this.prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({
        where: { id: input.sessionId },
        select: { stagedActions: true },
      })
      if (!session) throw new NotFoundException('会话不存在')
      const merged = [...parseStagedActions(session.stagedActions), ...input.actions]
      await tx.session.update({
        where: { id: input.sessionId },
        data: { stagedActions: JSON.stringify(merged), stagedAt: now },
      })
    })
    return { stagedCount: input.actions.length }
  }

  /** W8: Apply staged actions atomically and clear the stage. */
  async commitStage(input: { sessionId: string }): Promise<{ actions: CanvasAction[] }> {
    await this.expireStaleStage(input.sessionId)
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({
        where: { id: input.sessionId },
        select: { canvasData: true, stagedActions: true },
      })
      if (!session) throw new NotFoundException('会话不存在')
      const staged = parseStagedActions(session.stagedActions)
      if (staged.length === 0) return { actions: [] }
      const current = parseCanvas(session.canvasData)
      const updated = this.applier.apply(current, staged)
      await tx.session.update({
        where: { id: input.sessionId },
        data: {
          canvasData: JSON.stringify({ ...current, ...updated }),
          stagedActions: null,
          stagedAt: null,
        },
      })
      return { actions: staged }
    })
  }

  /** W8: Discard staged actions without touching canvasData. */
  async rollbackStage(input: { sessionId: string }): Promise<{ cleared: boolean }> {
    const session = await this.prisma.session.findUnique({
      where: { id: input.sessionId },
      select: { stagedActions: true },
    })
    if (!session) throw new NotFoundException('会话不存在')
    if (!session.stagedActions) return { cleared: false }
    await this.prisma.session.update({
      where: { id: input.sessionId },
      data: { stagedActions: null, stagedAt: null },
    })
    return { cleared: true }
  }

  async runVisionQa(input: {
    sessionId: string
    userId: string
    imageUrls: string[]
    userText?: string
    sceneKind?: string
    systemPrompt: string
    userContent: string
    providerRef: string
    model: string
    apiKey: string
    baseUrl: string
    source: ProviderSource
  }): Promise<ParsedVisionQaJson & { visionUsed: boolean }> {
    await this.loadOwnedSession(input.sessionId, input.userId)
    const provider: ProviderContext = {
      providerRef: input.providerRef,
      model: input.model,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      source: input.source,
    }
    const { text, visionUsed } = await this.studio.runVisionQaInternal(input.userId, {
      systemPrompt: input.systemPrompt,
      userContent: input.userContent,
      imageUrls: input.imageUrls,
      provider,
    })
    const parsed = parseVisionQaResponse(text)
    return { ...parsed, visionUsed }
  }

  private async expireStaleStage(sessionId: string): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { stagedActions: true, stagedAt: true },
    })
    if (!session?.stagedActions || !session.stagedAt) return
    if (Date.now() - session.stagedAt.getTime() <= STAGE_TTL_MS) return
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { stagedActions: null, stagedAt: null },
    })
  }

  private async applyOrStage(
    sessionId: string,
    actions: CanvasAction[],
    stage?: boolean,
  ): Promise<void> {
    if (actions.length === 0) return
    if (stage) {
      await this.stageCanvasActions({ sessionId, actions })
      return
    }
    await this.persist(sessionId, actions)
  }

  /**
   * Replace canvas nodes for layout operations (group/ungroup/grid) that need
   * parentNode/style fields not supported by applyCanvasActions.
   */
  private async persistCanvasData(sessionId: string, canvas: CanvasData): Promise<CanvasData> {
    await this.expireStaleStage(sessionId)
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { canvasData: true, stagedActions: true },
      })
      if (!session) throw new NotFoundException('会话不存在')
      if (session.stagedActions) {
        throw new ConflictException(
          'Canvas has staged actions pending commit; call commitStage or rollbackStage first',
        )
      }
      await tx.session.update({
        where: { id: sessionId },
        data: { canvasData: JSON.stringify(canvas) },
      })
      return canvas
    })
  }

  private async persistLayoutNodes(sessionId: string, nodes: LayoutNode[]): Promise<CanvasData> {
    await this.expireStaleStage(sessionId)
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { canvasData: true, stagedActions: true },
      })
      if (!session) throw new NotFoundException('会话不存在')
      if (session.stagedActions) {
        throw new ConflictException(
          'Canvas has staged actions pending commit; call commitStage or rollbackStage first',
        )
      }
      const current = parseCanvas(session.canvasData)
      const updated: CanvasData = { ...current, nodes: nodes as CanvasNode[] }
      await tx.session.update({
        where: { id: sessionId },
        data: { canvasData: JSON.stringify(updated) },
      })
      return updated
    })
  }

  /**
   * Atomic canvas patch — re-reads canvasData inside a Prisma transaction so
   * concurrent calls on the same session never lose each other's updates.
   *
   * Caller MUST NOT rely on the in-memory `canvas` it loaded earlier; pass only
   * the actions. The returned `CanvasData` is the post-apply snapshot (== DB
   * state right after this call), safe to consume for downstream computations
   * such as `toStudioRefs`.
   *
   * Concurrency contract: under N concurrent `persist` calls on the same
   * session, every action lands in DB exactly once; final canvas = the
   * sequential composition of all N action lists.
   */
  private async persist(
    sessionId: string,
    actions: CanvasAction[],
  ): Promise<CanvasData> {
    await this.expireStaleStage(sessionId)
    if (actions.length === 0) {
      // Dedup-to-empty fast path (e.g. connectNodes with all edges already
      // present). Skip the transaction and just return the current canvas.
      const session = await this.prisma.session.findUnique({ where: { id: sessionId } })
      if (!session) throw new NotFoundException('会话不存在')
      return parseCanvas(session.canvasData)
    }
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { canvasData: true, stagedActions: true },
      })
      if (!session) throw new NotFoundException('会话不存在')
      if (session.stagedActions) {
        throw new ConflictException(
          'Canvas has staged actions pending commit; call commitStage or rollbackStage first',
        )
      }
      const current = parseCanvas(session.canvasData)
      const updated = this.applier.apply(current, actions)
      const merged: CanvasData = { ...current, ...updated }
      await tx.session.update({
        where: { id: sessionId },
        data: { canvasData: JSON.stringify(merged) },
      })
      return merged
    })
  }
}
