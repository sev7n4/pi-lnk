export type StudioModality = 'text' | 'image' | 'video' | 'audio'
/**
 * - `native`：作为原生字段直传上游。
 * - `promptPrefix`：拼进**待朗读正文**前缀（仅限会把整段文本当内容朗读、且无情感参数的上游）。
 * - `instruction`：翻译成上游的**自然语言指导字段**（StepFun 的 `instruction`，≤500 字符）。
 *   与 `promptPrefix` 的区别是**它不会进入朗读内容** —— 混用会让设定被念出来。
 * - `metadataOnly`：不发送（进 `droppedFields` 对调用方可见，不静默吞）。
 */
export type ParamDisposition = 'native' | 'promptPrefix' | 'metadataOnly' | 'instruction'

import { decodeChannelModel, encodeChannelModel, PLATFORM_CHANNEL_ID } from './providerChannels'

export interface StudioVoiceOption {
  id: string
  label: string
}

export interface StudioModelEntry {
  modelKey: string
  displayName: string
  gatewayModelId: string
  modality: StudioModality
  providerBinding: 'gateway-openai-compat' | 'fal-http' | 'minimax-http'
  voices?: StudioVoiceOption[]
  /** 字段名 → 处置；未列出的生成参数默认 metadataOnly */
  params: Record<string, ParamDisposition>
  defaults?: Record<string, string | number>
}

const TEXT_PARAMS: Record<string, ParamDisposition> = {
  model: 'native',
}

// I* multi-ref strategy (native / primary_image / prompt_url_tags) is resolved by the generation adapter.
const IMAGE_PARAMS: Record<string, ParamDisposition> = {
  model: 'native',
  size: 'native',
  n: 'native',
}

const VIDEO_PARAMS: Record<string, ParamDisposition> = {
  model: 'native',
  duration: 'native',
  aspectRatio: 'native',
  resolution: 'native',
  image: 'native',
  crop: 'metadataOnly',
}

const SEED_AUDIO_PARAMS: Record<string, ParamDisposition> = {
  model: 'native',
  voice: 'native',
  speed: 'native',
  // Conservative until gateway field mapping is verified.
  emotion: 'promptPrefix',
  language: 'promptPrefix',
  volume: 'metadataOnly',
  pitch: 'metadataOnly',
}

const MINIMAX_AUDIO_PARAMS: Record<string, ParamDisposition> = {
  model: 'native',
  voice: 'native',
  speed: 'native',
  volume: 'native',
  pitch: 'native',
  emotion: 'native',
  language: 'promptPrefix',
}

/**
 * StepFun（阶跃星辰）TTS 参数处置。**依据官方 API 参考逐字段核对**（2026-10-06），
 * 不是按 OpenAI 形状类推：
 *
 * - `model` / `input` / `voice`：原生必填（voice 必填，无默认值）。
 * - `speed`（0.5–2）/ `volume`（0.1–2）：原生。
 * - `pitch`：**官方无此参数** ⇒ metadataOnly（丢弃并在 droppedFields 可见，不静默吞）。
 * - `emotion`：官方**没有**顶层 emotion；情感只能走 `voice_label.emotion`（仅 2.5/2/mini）
 *   或 `instruction`（仅 2.5/3）⇒ 走 `instruction` 通道（见 adapter 的 disposition 分支）。
 * - `language`：官方 `voice_label.language` 只支持粤语/四川话/日语，且 3-tts 明确禁用
 *   `voice_label` ⇒ 一律 metadataOnly。
 *
 * ⚠️ 为什么不把 `emotion` 标成 `promptPrefix`（仓内既有机制）：那是把「情绪=欢快」拼进
 * **待朗读正文**，StepFun 会照字念出来 ⇒ 用 promptPrefix 会让情绪设定变成朗读内容。
 */
const STEPFUN_TTS_PARAMS: Record<string, ParamDisposition> = {
  model: 'native',
  voice: 'native',
  speed: 'native',
  volume: 'native',
  pitch: 'metadataOnly',
  emotion: 'instruction',
  language: 'metadataOnly',
}

export const STUDIO_MODEL_CATALOG: StudioModelEntry[] = [
  // Text (§3.1)
  {
    modelKey: 'agnes-2.0-flash',
    displayName: 'Agnes 2.0 Flash',
    gatewayModelId: 'agnes-2.0-flash',
    modality: 'text',
    providerBinding: 'gateway-openai-compat',
    params: TEXT_PARAMS,
  },
  {
    modelKey: 'gemini-3.1-flash',
    displayName: 'Gemini 3.1 Flash',
    gatewayModelId: 'gemini-3.1-flash',
    modality: 'text',
    providerBinding: 'gateway-openai-compat',
    params: TEXT_PARAMS,
  },
  {
    modelKey: 'deepseek-v4',
    displayName: 'DeepSeek V4',
    gatewayModelId: 'deepseek-v4',
    modality: 'text',
    providerBinding: 'gateway-openai-compat',
    params: TEXT_PARAMS,
  },
  {
    modelKey: 'gpt-5.5',
    displayName: 'GPT 5.5',
    gatewayModelId: 'gpt-5.5',
    modality: 'text',
    providerBinding: 'gateway-openai-compat',
    params: TEXT_PARAMS,
  },

  // Image (§3.2)
  {
    modelKey: 'agnes-image-2.0-flash',
    displayName: 'Agnes Image 2.0 Flash',
    gatewayModelId: 'agnes-image-2.0-flash',
    modality: 'image',
    providerBinding: 'gateway-openai-compat',
    params: IMAGE_PARAMS,
  },
  {
    modelKey: 'agnes-image-2.1-flash',
    displayName: 'Agnes Image 2.1 Flash',
    gatewayModelId: 'agnes-image-2.1-flash',
    modality: 'image',
    providerBinding: 'gateway-openai-compat',
    params: IMAGE_PARAMS,
  },
  {
    modelKey: 'agnes-image-2.5-flash',
    displayName: 'Agnes Image 2.5 Flash',
    gatewayModelId: 'agnes-image-2.5-flash',
    modality: 'image',
    providerBinding: 'gateway-openai-compat',
    params: IMAGE_PARAMS,
  },
  {
    modelKey: 'image2',
    displayName: 'Image2',
    gatewayModelId: 'gpt-image-2-official',
    modality: 'image',
    providerBinding: 'gateway-openai-compat',
    params: { ...IMAGE_PARAMS, resolution: 'native', quality: 'native', refImages: 'native' },
    defaults: { resolution: '2K', quality: 'high' },
  },
  {
    modelKey: 'navo-pro',
    displayName: 'Navo Pro',
    gatewayModelId: 'navo-pro',
    modality: 'image',
    providerBinding: 'gateway-openai-compat',
    params: IMAGE_PARAMS,
  },
  {
    modelKey: 'seedream-5.0-pro',
    displayName: 'Seedream 5.0 Pro',
    gatewayModelId: 'doubao-seedream-5-0-pro',
    modality: 'image',
    providerBinding: 'gateway-openai-compat',
    params: {
      ...IMAGE_PARAMS,
      resolution: 'native',
      refImages: 'native',
      n: 'metadataOnly',
      quality: 'metadataOnly',
    },
    defaults: { resolution: '2K' },
  },
  {
    modelKey: 'midjourney-8.1',
    displayName: 'Midjourney 8.1',
    gatewayModelId: 'midjourney-8.1',
    modality: 'image',
    providerBinding: 'gateway-openai-compat',
    params: IMAGE_PARAMS,
  },

  // Video (§3.3)
  {
    modelKey: 'agnes-video-v2.0',
    displayName: 'Agnes Video v2.0',
    gatewayModelId: 'agnes-video-v2.0',
    modality: 'video',
    providerBinding: 'gateway-openai-compat',
    params: {
      ...VIDEO_PARAMS,
      seed: 'native',
      negativePrompt: 'native',
    },
  },
  {
    modelKey: 'agnes-video-2.5-flash',
    displayName: 'Agnes Video 2.5 Flash',
    gatewayModelId: 'agnes-video-2.5-flash',
    modality: 'video',
    providerBinding: 'gateway-openai-compat',
    params: {
      ...VIDEO_PARAMS,
      seed: 'native',
    },
  },
  {
    modelKey: 'seedance-2.0-min',
    displayName: 'Seedance 2.0 Min',
    gatewayModelId: 'doubao-seedance-2.0-mini',
    modality: 'video',
    providerBinding: 'gateway-openai-compat',
    params: {
      ...VIDEO_PARAMS,
      generateAudio: 'native',
      seed: 'native',
      refImages: 'native',
      refVideos: 'native',
      refAudios: 'native',
    },
  },
  {
    modelKey: 'seedance-2.0',
    displayName: 'Seedance 2.0',
    gatewayModelId: 'doubao-seedance-2.0',
    modality: 'video',
    providerBinding: 'gateway-openai-compat',
    params: {
      ...VIDEO_PARAMS,
      generateAudio: 'native',
      seed: 'native',
      refImages: 'native',
      refVideos: 'native',
      refAudios: 'native',
    },
  },
  {
    modelKey: 'seedance-2.0-fast',
    displayName: 'Seedance 2.0 Fast',
    gatewayModelId: 'doubao-seedance-2.0-fast',
    modality: 'video',
    providerBinding: 'gateway-openai-compat',
    params: {
      ...VIDEO_PARAMS,
      generateAudio: 'native',
      seed: 'native',
      refImages: 'native',
      refVideos: 'native',
      refAudios: 'native',
    },
  },
  {
    modelKey: 'seedance-2.0-face',
    displayName: 'Seedance 2.0 Face',
    gatewayModelId: 'doubao-seedance-2.0-face',
    modality: 'video',
    providerBinding: 'gateway-openai-compat',
    params: {
      ...VIDEO_PARAMS,
      generateAudio: 'native',
      seed: 'native',
      refImages: 'native',
      refVideos: 'native',
      refAudios: 'native',
    },
  },
  {
    modelKey: 'happyhose-1.1',
    displayName: 'Happyhose 1.1',
    gatewayModelId: 'happyhose-1.1',
    modality: 'video',
    providerBinding: 'gateway-openai-compat',
    params: VIDEO_PARAMS,
  },
  {
    modelKey: 'wan-2.7',
    displayName: 'Wan 2.7',
    gatewayModelId: 'wan-2.7',
    modality: 'video',
    providerBinding: 'gateway-openai-compat',
    params: VIDEO_PARAMS,
  },
  {
    modelKey: 'h3-max-turbo',
    displayName: 'H3 Max Turbo (fal)',
    gatewayModelId: 'minimax/h3-max-turbo',
    modality: 'video',
    providerBinding: 'fal-http',
    params: VIDEO_PARAMS,
  },
  {
    modelKey: 'h3-max',
    displayName: 'H3 Max (fal)',
    gatewayModelId: 'minimax/h3-max',
    modality: 'video',
    providerBinding: 'fal-http',
    params: VIDEO_PARAMS,
  },
  {
    modelKey: 'minimax-h3',
    displayName: 'MiniMax H3',
    gatewayModelId: 'MiniMax-H3',
    modality: 'video',
    providerBinding: 'minimax-http',
    params: VIDEO_PARAMS,
  },

  // Audio (§3.4)
  {
    modelKey: 'seed-audio-1.0',
    displayName: 'Seed Audio 1.0',
    gatewayModelId: 'seed-audio-1.0',
    modality: 'audio',
    providerBinding: 'gateway-openai-compat',
    params: SEED_AUDIO_PARAMS,
    voices: [
      { id: 'seed-female-1', label: '女声 1' },
      { id: 'seed-male-1', label: '男声 1' },
      { id: 'seed-neutral-1', label: '中性 1' },
    ],
    defaults: { voice: 'seed-female-1', speed: 1.0 },
  },
  {
    modelKey: 'minimax-speech-2.8-hd',
    displayName: 'MiniMax Speech 2.8 HD',
    gatewayModelId: 'speech-2.8-hd',
    modality: 'audio',
    providerBinding: 'gateway-openai-compat',
    params: MINIMAX_AUDIO_PARAMS,
    voices: [
      { id: 'female-shaonv', label: '少女' },
      { id: 'male-qingnian', label: '青年男声' },
      { id: 'presenter_female', label: '女主播' },
    ],
    defaults: { voice: 'female-shaonv', speed: 1.0, volume: 1.0, pitch: 0 },
  },
  // ── StepFun（阶跃星辰）TTS ──
  // 生产实测（2026-10-06）：`POST {base}/audio/speech` 端点通、鉴权通过，仅余额不足（402）。
  // 单价 ¥0.9 / 万字符（全表最低）；音色 id 取自官方音色清单（**中文拼音风格**）。
  // ⚠️ 第三方聚合站文档给的是 `lively-girl` 这类英文 id，那是它自己的代理命名，
  // 直连 api.stepfun.com 用官方拼音 id，否则 400。
  {
    modelKey: 'step-tts-mini',
    displayName: 'Step TTS Mini（阶跃）',
    gatewayModelId: 'step-tts-mini',
    modality: 'audio',
    providerBinding: 'gateway-openai-compat',
    params: STEPFUN_TTS_PARAMS,
    voices: [
      { id: 'livelybreezy-female', label: '活力轻快' },
      { id: 'elegantgentle-female', label: '气质温婉' },
      { id: 'wenrounvsheng', label: '温柔女声' },
      { id: 'cixingnansheng', label: '磁性男声' },
      { id: 'yuanqinansheng', label: '元气男声' },
      { id: 'boyinnansheng', label: '播音男声' },
      { id: 'ruyananshi', label: '儒雅男士' },
      { id: 'linjiajiejie', label: '邻家姐姐' },
    ],
    defaults: { voice: 'livelybreezy-female', speed: 1.0, volume: 1.0 },
  },
  {
    modelKey: 'stepaudio-3-tts',
    displayName: 'StepAudio 3 TTS（阶跃·真人级）',
    gatewayModelId: 'stepaudio-3-tts',
    modality: 'audio',
    providerBinding: 'gateway-openai-compat',
    params: STEPFUN_TTS_PARAMS,
    // 音色 id 与 mini 同源（官方音色清单按「支持模型」列标注，3-tts 为最新代机型）。
    // 3-tts 独家能力：instruction 自然语言指导（≤500 字符）⇒ emotion 走该通道。
    voices: [
      { id: 'livelybreezy-female', label: '活力轻快' },
      { id: 'elegantgentle-female', label: '气质温婉' },
      { id: 'wenrounvsheng', label: '温柔女声' },
      { id: 'cixingnansheng', label: '磁性男声' },
      { id: 'yuanqinansheng', label: '元气男声' },
      { id: 'boyinnansheng', label: '播音男声' },
      { id: 'ruyananshi', label: '儒雅男士' },
      { id: 'linjiajiejie', label: '邻家姐姐' },
    ],
    defaults: { voice: 'livelybreezy-female', speed: 1.0, volume: 1.0 },
  },
]

const DEFAULT_MODEL_KEYS: Record<StudioModality, string> = {
  text: 'agnes-2.0-flash',
  image: 'agnes-image-2.1-flash',
  video: 'agnes-video-v2.0',
  audio: 'minimax-speech-2.8-hd',
}

export function listModels(modality: StudioModality): StudioModelEntry[] {
  return STUDIO_MODEL_CATALOG.filter((entry) => entry.modality === modality)
}

/**
 * 按 id 查目录条目。**同时接受 `modelKey` 与 `gatewayModelId` 两种形态**。
 *
 * ⚠️ 2026-10-04：此前只比较 `entry.modelKey`，而生产 `GenerationRecord.model`
 * 存的是 gatewayModelId（如 `doubao-seedance-2.0-mini`）⇒ 查不到 ⇒
 * `resolveModelKey` 静默回退到默认条目 `agnes-video-v2.0` ⇒ Seedance 明明声明
 * `generateAudio:'native'` 却被判不支持而丢弃（16 次）。
 * 见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.1
 *
 * 顺序：**modelKey 优先**。目录里`agnes-video-v2.0` 这类 id 同时出现在两个空间，
 * 必须靠优先级消歧（`studioModelCatalog.test.ts` 有对应回归锁）。
 */
export function getModelEntry(id: string): StudioModelEntry | undefined {
  const byModelKey = STUDIO_MODEL_CATALOG.find((entry) => entry.modelKey === id)
  if (byModelKey) return byModelKey
  return STUDIO_MODEL_CATALOG.find((entry) => entry.gatewayModelId === id)
}

export function defaultModelKey(modality: StudioModality): string {
  return DEFAULT_MODEL_KEYS[modality]
}

export function resolveModelKey(
  modality: StudioModality,
  requested?: string | null,
): { modelKey: string; entry: StudioModelEntry; fallback: boolean } {
  const fallbackKey = defaultModelKey(modality)
  const fallbackEntry = getModelEntry(fallbackKey)!
  if (!requested) {
    return { modelKey: fallbackKey, entry: fallbackEntry, fallback: false }
  }
  const entry = getModelEntry(requested)
  if (entry?.modality === modality) {
    // ⚠️ 返回目录里的规范 modelKey，而不是 `requested` 原文：
    // 调用方可能传的是 gatewayModelId，原样返回会让下游拿到非规范 id。
    return { modelKey: entry.modelKey, entry, fallback: false }
  }
  return { modelKey: fallbackKey, entry: fallbackEntry, fallback: true }
}

/**
 * 模型 ref 归一（SSOT）：把「裸模型名 / 已编码 ref / 空值」统一成一种可比较的形态。
 *
 * 调用方（agent 的 update_node、web 的 resolveGenerationModel）**必须**检查 `fallback`：
 * 它为 true 说明裸名不在目录中，此时返回的 ref 是**默认模型**而非用户要的那个——
 * 静默采用会把「设错了模型」伪装成「设置成功」。
 */
export function normalizeModelRef(
  modality: StudioModality,
  raw?: string | null,
): { ref: string; channelId: string; modelName: string; fallback: boolean } | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  const decoded = decodeChannelModel(trimmed)
  if (decoded) {
    return {
      ref: trimmed,
      channelId: decoded.channelId,
      modelName: decoded.modelName,
      fallback: false,
    }
  }
  const { modelKey, fallback } = resolveModelKey(modality, trimmed)
  return {
    ref: encodeChannelModel(PLATFORM_CHANNEL_ID, modelKey),
    channelId: PLATFORM_CHANNEL_ID,
    modelName: modelKey,
    fallback,
  }
}
