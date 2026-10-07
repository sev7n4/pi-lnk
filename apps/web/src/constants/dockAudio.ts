import {
  audioKindOf,
  decodeChannelModel,
  defaultModelKey,
  getModelEntry,
  listModels,
  listModelsByAudioKind,
  type AudioKind,
  type StudioModelEntry,
} from '@lnkpi/shared'

export interface VoiceOption {
  id: string
  label: string
}

/**
 * 音频 Dock 音色列表。
 *
 * ⚠️ 2026-10-04 对齐：此前这里列的是 `female-1` / `male-1` / `narrator`，
 * 而 `DEFAULT_AUDIO_VOICE = 'female-shaonv'` 且 catalog
 * `studioModelCatalog.ts` 的 `minimax-speech-2.8-hd.voices` 也是
 * `female-shaonv` / `male-qingnian` / `presenter_female`
 * ⇒ **两套完全重叠为零**，用户在面板上看到的音色后端根本不认。
 * 现直接以 catalog 为 SSOT（`dockAudio.test.ts` 有对齐回归锁）。
 */
export const AUDIO_VOICE_OPTIONS: VoiceOption[] = listModels('audio')
  .flatMap((m) => m.voices ?? [])
  .map((v) => ({ id: v.id, label: v.label }))

export type AudioEmotion = 'neutral' | 'happy' | 'sad' | 'serious'

export const AUDIO_EMOTION_OPTIONS: Array<{ value: AudioEmotion; label: string }> = [
  { value: 'neutral', label: '中性' },
  { value: 'happy', label: '欢快' },
  { value: 'sad', label: '低沉' },
  { value: 'serious', label: '严肃' },
]

export type AudioLanguage = 'zh' | 'en' | 'ja'

export const AUDIO_LANGUAGE_OPTIONS: Array<{ value: AudioLanguage; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
]

/**
 * 默认音色。**从 catalog 的 `minimax-speech-2.8-hd.defaults.voice` 派生**，
 * 不再硬编码字面量——否则 catalog 改音色时这里会静默变成悬空值
 * （`dockAudio.test.ts` 有「默认值必须在选项里」的回归锁）。
 * ⚠️ `defaults` 是 `Record<string, string | number>`，故要断言成 string。
 */
const catalogDefaultVoice = getModelEntry(defaultModelKey('audio'))?.defaults?.voice
export const DEFAULT_AUDIO_VOICE: string =
  (typeof catalogDefaultVoice === 'string' ? catalogDefaultVoice : undefined) ??
  AUDIO_VOICE_OPTIONS[0]?.id ??
  'female-shaonv'
export const DEFAULT_AUDIO_EMOTION: AudioEmotion = 'neutral'
export const DEFAULT_AUDIO_LANGUAGE: AudioLanguage = 'zh'
export const DEFAULT_AUDIO_SPEED = 1
export const DEFAULT_AUDIO_VOLUME = 1
export const DEFAULT_AUDIO_PITCH = 0

export interface AudioVoiceSettings {
  emotion: AudioEmotion
  language: AudioLanguage
  speed: number
  volume: number
  pitch: number
}

export type ShotGenerateMode = 'auto' | 'image' | 'video'

export const SHOT_GENERATE_MODE_OPTIONS: Array<{ value: ShotGenerateMode; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'image', label: '生成图像' },
  { value: 'video', label: '生成视频' },
]

/**
 * 音频节点的二阶分类（画布顶层节点类型仍是 `audio`，不新增节点类型）。
 * 顺序即 UI chip 顺序，勿随意调整。
 */
export const AUDIO_KIND_OPTIONS: Array<{ value: AudioKind; label: string }> = [
  { value: 'voice', label: '配音' },
  { value: 'design', label: '综合音频' },
  { value: 'music', label: '音乐' },
]

export function modelsForAudioKind(kind: AudioKind): StudioModelEntry[] {
  return listModelsByAudioKind(kind)
}

/**
 * 分类各自的首选模型；voice 保持目录默认（存量节点零变化）。
 *
 * 🔴 返回值必须属于 `kind` 分类：服务端 `assertAudioKindMatchesModel` 对
 * 「声明 music 却拿着 TTS 模型」显式 400，切分类时用错模型就是必错组合。
 *
 * ⚠️ 只表示「目录里的首选」。用户在配置里停用过该模型时用它会指向已停用模型 ——
 * 切分类请走 {@link pickSelectableModelForKind}（与用户可选列表取交集）。
 */
export function defaultVoiceForKind(kind: AudioKind | undefined): string {
  const k: AudioKind = audioKindOf({ modality: 'audio', audioKind: kind })
  if (k === 'voice') return defaultModelKey('audio')
  return listModelsByAudioKind(k)[0]?.modelKey ?? defaultModelKey('audio')
}

/**
 * 一个模型**取值**（`channel::model` 或裸 modelKey）属于哪个分类。
 *
 * 与服务端 `assertAudioKindMatchesModel` 同源判定：目录外模型按缺省 `voice`。
 * `UniversalModelSelector` 的候选过滤也走它 ⇒ 下拉能选到的组合一定不撞 400。
 */
export function audioKindOfModelValue(value: string): AudioKind {
  const modelName = decodeChannelModel(value)?.modelName ?? value
  return audioKindOf(getModelEntry(modelName) ?? { modality: 'audio' })
}

/**
 * 切分类时的目标模型：在**用户可选列表**（`prefs.selectableAudioModels`）里
 * 找该分类的第一个模型，返回列表原值（保留渠道前缀）。
 *
 * 🔴 为什么要跟用户列表取交集（而不是直接用 {@link defaultVoiceForKind}）：
 * 用户可自定义可选模型列表，把 `stepaudio-3-music-preview` 移出音频桶是允许的。
 * 无条件用 `platform::<目录首条>` 会把 `audioModel` 指向一个用户已停用的模型 ——
 * 下拉显示「已停用」，而请求仍带着它发出去（可能落到用户没配的渠道/密钥上）。
 *
 * 交集为空时返回 `undefined`，调用方**不要改写** `audioModel`：此时 kind 仍然切换，
 * 下拉显示空列表（`暂无可选模型，请先在配置中设置`）—— 这比静默指向已停用模型更可判读。
 */
export function pickSelectableModelForKind(
  kind: AudioKind,
  selectableModelValues: readonly string[],
): string | undefined {
  return selectableModelValues.find((value) => audioKindOfModelValue(value) === kind)
}

/**
 * design 是否有可提交的内容：`scripts` / `roles` / `instruction` **任一非空**。
 *
 * 🔴 为什么单独判：design 的正文在 `scripts[]` 里（不在 `prompt`），而上游要的是
 * 这三者。refs **不能**替代内容 —— 挂了 ref 但三类全空就提交，等于把
 * `scripts: []` / `roles: []` / 无 instruction 原样发给上游，失败形态来自上游
 * 而不是清晰的客户端信号。
 *
 * 门槛刻意不收更严：只填 `instruction` 也是合法的 design 请求。
 */
export function hasDesignContent(input: {
  roles: ReadonlyArray<{ role: string; voice: string }>
  scripts: ReadonlyArray<{ role?: string; text: string }>
  instruction?: string
}): boolean {
  return (
    input.roles.some((r) => !!r.role?.trim()) ||
    input.scripts.some((s) => !!s.text?.trim()) ||
    !!input.instruction?.trim()
  )
}
