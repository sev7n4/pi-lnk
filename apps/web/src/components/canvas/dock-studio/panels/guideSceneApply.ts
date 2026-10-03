import { getGenerationScene, guideModality, type ParamContract } from '@lnkpi/shared'

export function applyGuideSceneToPrompt(input: {
  sceneId: string
  currentPrompt: string
}): { prompt: string; guideSceneId: string; didPrefill: boolean; label: string } {
  const scene = getGenerationScene(input.sceneId)
  const label = scene?.label ?? input.sceneId
  const guideSceneId = input.sceneId
  const empty = !input.currentPrompt.trim()

  if (empty && scene?.promptScaffold) {
    return {
      prompt: scene.promptScaffold,
      guideSceneId,
      didPrefill: true,
      label,
    }
  }

  return {
    prompt: input.currentPrompt,
    guideSceneId,
    didPrefill: false,
    label,
  }
}

export function clearGuideScene(): { guideSceneId: null } {
  return { guideSceneId: null }
}

/** ImageParamsSelector 的合法数量档（该组件是唯一权威，勿在此另立取值域）。 */
const IMAGE_COUNT_OPTIONS = [1, 2, 4] as const
export type ImageCountOption = (typeof IMAGE_COUNT_OPTIONS)[number]

/**
 * 把任意正整数吸附到最近的合法档位。
 *
 * 旧实现在 syncFromNode 里把非 1 的值强制写回 1 —— 那会连带清掉 agent 按平台惯例
 * 预填的数量（如小红书种草 x2对比图）。agent / API 可以给 1..4，UI 只能显示 1|2|4，
 * 故按就近档位吸附而非丢弃。
 */
export function nearestImageCount(value: unknown): ImageCountOption {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 1
  return IMAGE_COUNT_OPTIONS.reduce((best, opt) =>
    Math.abs(opt - n) < Math.abs(best - n) ? opt : best,
  )
}

export interface GuideSceneParamsPatch {
  patch: Record<string, unknown>
  applied: string[]
}

/**
 * 把场景的 preferredParams 转成 node.data patch（**按模态分派键位**）。
 *
 * 关键：三个 dock 面板消费的 node.data 形状并不一致——
 * - image: 扁平 imageAspect / imageResolution / imageCount
 * - video: 嵌套 videoSettings { aspectRatio, resolution, durationHint→duration, generateAudio }
 * - audio: 扁平 audioVoice / audioEmotion / audioLanguage / audioSpeed / audioVolume / audioPitch
 *
 * 写错键位 = 参数落库了但面板读不到（静默失效），故必须走这里而非散落各处。
 *
 * `modality` 缺省 image（向后兼容既有9 个场景）；`resolveDuration` 由调用方按当前
 * 视频模型能力把 durationHint 解析成具体秒数——场景不写死秒数（各模型 4~15s 不一）。
 */
export function guideSceneParamsPatch(input: {
  sceneId: string
  modality?: 'image' | 'video' | 'audio'
  resolveDuration?: (hint: 'short' | 'medium' | 'long') => number | undefined
}): GuideSceneParamsPatch {
  const scene = getGenerationScene(input.sceneId)
  if (!scene) return { patch: {}, applied: [] }
  const modality = input.modality ?? guideModality(scene)
  const p = scene.preferredParams as ParamContract

  if (modality === 'video') {
    const videoSettings: Record<string, unknown> = {}
    if (p.aspectRatio) videoSettings.aspectRatio = p.aspectRatio
    if (p.resolution) videoSettings.resolution = p.resolution
    if (p.generateAudio !== undefined) videoSettings.generateAudio = p.generateAudio
    if (p.duration !== undefined) {
      videoSettings.duration = p.duration
    } else if (p.durationHint && input.resolveDuration) {
      const d = input.resolveDuration(p.durationHint)
      if (d !== undefined) videoSettings.duration = d
    }
    const applied = Object.keys(videoSettings).length ? ['videoSettings'] : []
    return { patch: applied.length ? { videoSettings } : {}, applied }
  }

  if (modality === 'audio') {
    const patch: Record<string, unknown> = {}
    if (p.voice) patch.audioVoice = p.voice
    if (p.emotion) patch.audioEmotion = p.emotion
    if (p.language) patch.audioLanguage = p.language
    if (p.speed !== undefined) patch.audioSpeed = p.speed
    if (p.volume !== undefined) patch.audioVolume = p.volume
    if (p.pitch !== undefined) patch.audioPitch = p.pitch
    return { patch, applied: Object.keys(patch) }
  }

  // image（默认）
  const patch: Record<string, unknown> = {}
  if (p.aspectRatio) patch.imageAspect = p.aspectRatio
  if (p.resolution) patch.imageResolution = p.resolution
  if (p.count !== undefined) patch.imageCount = nearestImageCount(p.count)
  return { patch, applied: Object.keys(patch) }
}