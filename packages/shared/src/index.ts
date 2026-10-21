export type WorkType = 'canvas' | 'shortfilm'

/** 与 agentContract 的 NODE_TYPES 保持一致（改一处必须改另一处，否则画布动作会被静默丢弃）。
 *  2026-09-28 补入 `audio`。
 *  2026-10-17 下线 `prompt`（提示词节点，PR feat/prompt-node-decommission）——存量画布
 *  里的 prompt 节点数据仍在 JSON 中（运行时按字符串分发渲染），但联合类型与白名单不再接纳。
 *  2026-10-19 下线 `group` / `shot` / `sceneComposer`（分组 / 分镜 / 导演台）节点：联合类型与白名单不再接纳，
 *  存量节点仅走运行时兜底渲染。
 *  2026-10-19 下线 `mediaInput`（媒体输入）：附件按媒体类型直落 image/video/audio/text 节点。 */
export type NodeType = 'image' | 'video' | 'audio' | 'text'

export * from './randomId'
export * from './generationTimeoutBudget'
export * from './canvas/selectionDigest'
export * from './canvas/duplicateSubgraph'
export * from './canvas/duplicateToCanvasActions'
export * from './canvas/imageVersions'
export * from './canvas/workflowExchange'
export * from './canvas/workflowImportPlacement'
export * from './canvas/layout'
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
export * from './turnState'
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

/**
 * 画布分组（2026-10-20）。
 *
 * ⚠️ **不再是节点类型**：分组曾以 `group` 节点承载（`CanvasNode` + `parentNode`），
 * 现改为 `CanvasData.groups` 侧车结构 —— 分组框由画布 overlay 渲染，不占节点位、
 * 不进 agent 节点白名单。`childIds` 为绝对坐标语义（子节点 position 不再相对父）。
 */
export interface CanvasGroup {
  id: string
  title: string
  /** 8 色卡键；缺省 = neutral（中性灰）。色值本体在 `--neo-group-*` 令牌。 */
  colorKey?: string
  childIds: string[]
  /** 画布绝对坐标下的外框（含 padding）。 */
  position: { x: number; y: number }
  size: { width: number; height: number }
}

export interface CanvasData {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  viewport?: { x: number; y: number; zoom: number }
  /** 分组侧车（overlay 渲染，非节点）。存量 group 节点不在此列。 */
  groups?: CanvasGroup[]
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

/**
 * 作品分类 = `Work.type` 维度（真实维度），消费方：`GET /works?category=`。
 *
 * 2026-10-21 P1：运营位（'2026-赛事'/'精选作品'）移出分类体系——它们是运营标签
 * 不是作品维度，混进分类会让筛选项语义漂移。`Work.category` 字段的语义随之改为
 * **可选合集名**（自由文本），不再参与过滤；发布弹窗改为可选输入。
 * 存量旧值不做数据迁移（避免动生产数据），历史合集展示走P2 创作者页「系列」分组。
 */
export const WORK_CATEGORIES = ['全部', '短片', '画布'] as const

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

// 30s 预埋 Seedance 2.5（4–30s）：滑轨 max 由模型 capabilities.maxDuration 收口，
// 上架 2.5 前该刻度会被 filter 掉，不产生假范围。
export const VIDEO_DURATION_MARKS = [4, 5, 10, 15, 30] as const

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
