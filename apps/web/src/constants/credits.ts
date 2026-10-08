import { audioKindOf, imageGenerationCredits, type AudioKind } from '@lnkpi/shared'

export const BASE_GENERATION_CREDITS = {
  text: 5,
  image: 10,
  video: 30,
  audio: 5,
} as const

/** 音乐生成积分（`BASE_GENERATION_CREDITS.audio` 的三倍，对齐服务端 music 档）。 */
const MUSIC_AUDIO_CREDITS = 15

export type CreditGenerationType = keyof typeof BASE_GENERATION_CREDITS

export function estimateTextCredits(): number {
  return BASE_GENERATION_CREDITS.text
}

/**
 * 图片积分估算。🔴 分档必须与服务端一致——两者都取 `shared/imageGenerationCredits`
 * 单一真源（1K=10 / 2K=15 / 4K=20 每张），改档位请改 shared 的 FACTORS。
 */
export function estimateImageCredits(count = 1, resolution?: string): number {
  return imageGenerationCredits({ count, resolution })
}

export function estimateVideoCredits(durationSec = 5): number {
  const d = Number(durationSec)
  if (!Number.isFinite(d)) return BASE_GENERATION_CREDITS.video
  if (d >= 15) return 70
  if (d >= 10) return 50
  return 30
}

/**
 * 音频积分估算。`kind` 缺省视作 `voice`（判据统一走 `audioKindOf`，勿在别处再写 `?? 'voice'`）。
 * 🔴 分档必须与服务端 `studio.service.ts` 的 `kind === 'music' ? 15 : 5` 一致，
 * 否则面板显示的积分与实际扣分不符。
 */
export function estimateAudioCredits(kind?: AudioKind): number {
  return audioKindOf({ modality: 'audio', audioKind: kind }) === 'music'
    ? MUSIC_AUDIO_CREDITS
    : BASE_GENERATION_CREDITS.audio
}
