export type WorkType = 'canvas' | 'shortfilm'

/** 与 agentContract 的 NODE_TYPES 保持一致（改一处必须改另一处，否则画布动作会被静默丢弃）。
 *  2026-09-28 补入 `audio`；mediaInput / videoComposition / worldModel 当前无需求，有意不列。 */
export type NodeType = 'prompt' | 'image' | 'video' | 'audio' | 'text' | 'group' | 'shot' | 'sceneComposer'

export * from './randomId'
export * from './generationTimeoutBudget'
export * from './canvas/groupChildIds'
export * from './canvas/selectionDigest'
export * from './canvas/duplicateSubgraph'
export * from './canvas/duplicateToCanvasActions'
export * from './canvas/imageVersions'
export * from './canvas/workflowExchange'
export * from './canvas/workflowImportPlacement'
export * from './canvas/workflowRecipe'
export * from './canvas/recipeCatalog'
export * from './canvas/compositionGold'
export * from './canvas/compositionIr'
export * from './canvas/compositionExtract'
export * from './canvas/compositionBind'
export * from './canvas/compositionExpand'
export * from './canvas/compositionLint'
export * from './canvas/compositionVideo'
export * from './canvas/selectionBatchGenerate'
export * from './sceneComposer'
export * from './videoComposition'
export * from './nodeRefs'
export * from './imageParams'
export * from './imageModelProfiles'
export * from './imageCredits'
export * from './imageEditProfiles'
export * from './toolCredits'
export * from './videoModelProfiles'
export * from './videoModelCapabilities'
export * from './videoSettingsOptions'
export * from './platformCredentials'
export * from './upstreamRouting'
export * from './studioModelCatalog'
export * from './providerChannels'
export * from './modelCapability'
export * from './generationDiagnostics'
export * from './retryRecommendation'
export * from './publicMediaUrl'
export * from './upstreamRefInline'
export * from './agentContract'
export * from './sidebarAttachments'
export * from './agentIntent'
export * from './promptContent'
export * from './agentTrace'
export * from './mediaInfo'
export * from './videoGeneration/types'
export { resolveCanonicalVideoRequest } from './videoGeneration/resolveCanonicalVideoRequest'
export * from './videoGeneration/minimaxH3Reference'
export * from './imagePromptingGuide'
export * from './gridSlice'

export type GenerationType = 'text' | 'image' | 'video'

/**
 * ⛔ 不要再在这里导出模型清单。
 *
 * 2026-10-08 移除 `TEXT_MODELS` / `IMAGE_MODELS` / `VIDEO_MODELS`：它们与
 * `STUDIO_MODEL_CATALOG`（见 `./studioModelCatalog`，本文件 :37 已 re-export）
 * **零重叠**，却因`ModelSelector.vue` 与 `GET /agent/capabilities/list`
 * 直接引用而对用户可见 ⇒ 用户选中 `sora` / `dall-e-3`，后端
 * `resolveModelKey` 查不到 ⇒ 静默回落默认模型（`fallback:true` 仅写入
 * metadata，不抛错）⇒ **选了 A 生成 B，且照扣费、页面不报错**。
 *
 * 需要模型清单时一律用 `./studioModelCatalog` 的 `STUDIO_MODEL_CATALOG` /
 * `listModels(modality)` / `getModelEntry(id)`。
 *
 * `AIModel` 类型本身保留（`capabilities-api.ts` 与 `useCapabilities` 的返回
 * 形状依赖它），但**实例必须从 catalog 派生**，不许再手写字面量数组。
 * 回归锁见 `studioModelCatalog.ghost.test.ts`。
 */
export interface AIModel {
  id: string
  name: string
  provider: string
  type: GenerationType
}

export interface User {
  id: string
  phone: string
  nickname: string
  avatar?: string
  points?: number
  membership?: string
  createdAt: string
  inviteCode?: string
  invitedByUserId?: string
  inviteeCount?: number
}

export interface Session {
  id: string
  title: string
  userId: string
  canvasData?: CanvasData
  createdAt: string
  updatedAt: string
}

export interface Work {
  id: string
  title: string
  coverUrl: string
  playbackUrl?: string
  playbackKind?: 'image' | 'video'
  type: WorkType
  authorId: string
  authorName: string
  authorAvatar?: string
  sessionId?: string
  likes: number
  views: number
  category?: string
  createdAt: string
}

export interface ApiResponse<T> {
  code: number
  message: string
  data: T
}

export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface LoginRequest {
  phone: string
  code: string
}

export interface AuthToken {
  token: string
  user: User
}

export interface CreateSessionRequest {
  title?: string
  // 2026-09-29 移除 `prompt`：新建画布不再种提示词节点，brief 走 initialPrompt query 预填侧栏。
}

export interface CanvasNode {
  id: string
  type: NodeType
  position: { x: number; y: number }
  data: Record<string, unknown>
}

export interface CanvasEdge {
  id: string
  source: string
  target: string
}

export interface CanvasData {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  viewport?: { x: number; y: number; zoom: number }
  compositionRunGroup?: { nodeIds: string[]; dumpHash: string; createdAt: string }
}

export interface GenerationRequest {
  sessionId: string
  nodeId?: string
  type: GenerationType
  prompt: string
  modelId: string
  params?: Record<string, unknown>
}

export interface GenerationResult {
  id: string
  type: GenerationType
  status: 'pending' | 'processing' | 'completed' | 'failed'
  outputUrl?: string
  outputText?: string
  error?: string
}

export const WORK_CATEGORIES = ['全部', '2026-赛事', '精选作品', '短片', '画布'] as const

export type WorkCategory = (typeof WORK_CATEGORIES)[number]

// ⛔ 已移除（2026-10-08）：TEXT_MODELS / IMAGE_MODELS / VIDEO_MODELS。
// 理由与替代来源见本文件 `AIModel` 上方的注释。

export type VideoAspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9' | 'adaptive'
export type VideoCropMode = 'none' | 'center' | 'fill'
export type VideoResolution = '480p' | '720p' | '768p' | '1080p' | '2k' | '4k'

export interface VideoSettings {
  aspectRatio: VideoAspectRatio
  duration: number // 4–15 整数秒
  crop: VideoCropMode
  resolution: VideoResolution
  /** Seedance 等模型：是否生成音频，默认 true */
  generateAudio?: boolean
}

export function clampVideoDuration(
  n: unknown,
  bounds?: { min?: number; max?: number },
): number {
  const min = bounds?.min ?? 4
  const max = bounds?.max ?? 15
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return Math.min(max, Math.max(min, 5))
  return Math.min(max, Math.max(min, Math.round(v)))
}

export const VIDEO_ASPECT_RATIO_OPTIONS: { value: VideoAspectRatio; label: string }[] = [
  { value: '16:9', label: '16:9 横屏' },
  { value: '9:16', label: '9:16 竖屏' },
  { value: '1:1', label: '1:1 方形' },
]

export const VIDEO_DURATION_MARKS = [4, 5, 10, 15] as const

export const VIDEO_DURATION_OPTIONS: { value: 4 | 5 | 10 | 15; label: string }[] = [
  { value: 4, label: '4 秒' },
  { value: 5, label: '5 秒' },
  { value: 10, label: '10 秒' },
  { value: 15, label: '15 秒' },
]

export const VIDEO_RESOLUTION_OPTIONS: { value: VideoResolution; label: string }[] = [
  { value: '480p', label: '480p' },
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
]

export const VIDEO_CROP_OPTIONS: { value: VideoCropMode; label: string }[] = [
  { value: 'none', label: '不裁剪' },
  { value: 'center', label: '居中裁剪' },
  { value: 'fill', label: '填充裁剪' },
]

export const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  aspectRatio: '16:9',
  duration: 5,
  crop: 'none',
  resolution: '720p',
  generateAudio: true,
}

// --- Shot/Material 模型（对标 NeoWOW Canvas Domain）---

export type ShotStatus = 'draft' | 'generating' | 'generated' | 'failed'
export type MaterialType = 'image' | 'video' | 'audio'
export type MaterialStatus =
  | 'idle'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'fallback_pending'

export interface Material {
  id: string
  shotId: string
  type: MaterialType
  url?: string
  thumbnail?: string
  prompt?: string
  status: MaterialStatus
  order: number
}

export interface Shot {
  id: string
  sessionId: string
  title: string
  prompt: string
  order: number
  status: ShotStatus
  position: { x: number; y: number }
  materials: Material[]
}

// --- Agent 驱动画布 ---
// ⚠️ CanvasAction / CanvasActionType 的单一来源是 `./agentContract`（zod schema 派生），
// 由下方 `export * from './agentContract'` 透出。此处**不再重复声明**——
// 本地声明会静默遮蔽 export * 的同名导出，历史上正是因此出现过多份互不一致的 CanvasAction。

export interface AgentChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCalls?: string
  attachments?: string
  /** JSON: LinkedCanvasOutput[] — assistant turn canvas outputs for relocation */
  linkedOutputs?: string
  /** JSON: AgentMessageMetadata */
  metadata?: string
  createdAt: string
}

export interface CapabilityItem {
  id: string
  name: string
  type: GenerationType
  provider: string
  description?: string
}
export * from './pi/typebox-bridge'
