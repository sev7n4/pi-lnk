export type GuideKind = 'generation_scene' | 'edit_intent'

export type GuideGroupId =
  | 'photo_ad'
  | 'ecom_platform'
  | 'info_design'
  | 'brand_ui'
  | 'narrative'
  | 'local_edit'
  | 'identity_product'
  | 'ref_compose'

/** 模态：决定 preferredParams 的哪一组字段生效。 */
export type GuideModality = 'image' | 'video' | 'audio'

/** 视频时长意图——场景只表达意图，具体秒数由模型能力 clamp（duration 因模型而异 4~15s）。 */
export type DurationHint = 'short' | 'medium' | 'long'

/** 图片比例。取值域与 `imageParams.SUPPORTED_ASPECT_RATIOS` 对齐。 */
export type SceneAspectRatio =
  | '1:1'
  | '2:3'
  | '3:2'
  | '3:4'
  | '4:3'
  | '4:5'
  | '5:4'
  | '9:16'
  | '16:9'
  | '21:9'
  | 'auto'

/** 图片分辨率档。 */
export type SceneResolutionTier = '1K' | '2K' | '4K'

/** 基类字段：所有模态共有（`size` 保留是为向后兼容旧场景 + provider 直传）。 */
export interface BaseParamContract {
  /** 遗留像素串。与 aspectRatio+resolution 二选一；新场景优先写后两者。 */
  size?: string
  quality?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  background?: 'auto' | 'opaque' | 'transparent'
  outputFormat?: 'png' | 'webp' | 'jpeg'
}

export interface ImageParamContract extends BaseParamContract {
  aspectRatio?: SceneAspectRatio
  resolution?: SceneResolutionTier
  count?: number
}

export interface VideoParamContract extends BaseParamContract {
  aspectRatio?: SceneAspectRatio
  resolution?: SceneResolutionTier
  durationHint?: DurationHint
  /** 绝对秒数。仅当场景已确定目标模型能力时使用，否则写 durationHint。 */
  duration?: number
  crop?: boolean
  generateAudio?: boolean
}

export interface AudioParamContract extends BaseParamContract {
  voice?: string
  emotion?: string
  language?: string
  speed?: number
  volume?: number
  pitch?: number
}

/** 联合类型：按模态收窄。 */
export type ParamContract = ImageParamContract & VideoParamContract & AudioParamContract

export interface CapabilityGate {
  requiresTransparentBackground?: boolean
  minRefImages?: number
  maxRefImages?: number
  requiresSubjectRef?: boolean
}

export interface GuideCapabilities {
  transparentBackground: boolean
  qualityParam: boolean
  maxRefImages: number
}

export interface GenerationScene {
  id: string
  kind: 'generation_scene'
  label: string
  description: string
  /** 缺省 'image'（旧场景向后兼容）。 */
  modality?: GuideModality
  groupId?: GuideGroupId
  groupLabel?: string
  fundamentalsRefs: string[]
  promptScaffold: string
  systemOverlay?: string
  fewShot?: { user: string; assistant: string }
  preferredParams: ParamContract
  capability: CapabilityGate
  expandViaPromptMode?: string | null
}

export interface EditIntent {
  id: string
  kind: 'edit_intent'
  label: string
  description: string
  /** 缺省 'image'（旧场景向后兼容）。 */
  modality?: GuideModality
  groupId?: GuideGroupId
  groupLabel?: string
  fundamentalsRefs: string[]
  changePreserveTemplate: string
  refRoles: Array<{ role: string; required: boolean; hint: string }>
  preferredParams: ParamContract
  capability: CapabilityGate
}
