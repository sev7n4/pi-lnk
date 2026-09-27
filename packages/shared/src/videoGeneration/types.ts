import type { CanvasAction } from '../agentContract'
import type { GenerationRefPayload } from '../nodeRefs'

// ⚠️ 此处原有一份本地 CanvasAction（payload: Record<string, unknown>），已删除：
// 它被 index.ts 的本地同名声明遮蔽、无人直接引用，属于第三份漂移副本。
// 统一改用 `./agentContract` 的 CanvasAction（由 index.ts 的 export * 透出）。

export type VideoGenerationMode =
  | 'text_to_video'
  | 'image_to_video'
  | 'first_last_frame'
  | 'reference_to_video'

export interface CanonicalVideoSettings {
  duration: number
  aspectRatio: string
  resolution: string
  crop: string
  generateAudio?: boolean
}

export interface VideoAccountDefaults {
  model?: string
  duration?: number
  aspectRatio?: string
  resolution?: string
  crop?: string
}

export interface CanonicalVideoGenerationRequest {
  prompt: string
  refs: GenerationRefPayload[]
  mentionedKeys?: string[]
  videoSettings: CanonicalVideoSettings
  videoMode: VideoGenerationMode
  model?: string
  /** Optional RNG seed for weak reproducibility when provider supports it. */
  seed?: number
  /** Optional negative prompt / exclusion hints when provider supports it. */
  negativePrompt?: string
  scope: { sessionId: string; nodeId: string }
}

export interface VideoGenerationStartResult {
  generationRecordId: string
  status: 'generating'
  generationStartedAt: string
  actions: CanvasAction[]
}

export interface VideoGenerationWaitResult {
  generationRecordId: string
  status: string
  url?: string
  actions: CanvasAction[]
}
