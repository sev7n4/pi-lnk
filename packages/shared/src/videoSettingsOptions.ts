import type { VideoModelCapabilities } from './videoModelCapabilities'
import type { VideoAspectRatio, VideoResolution, VideoSettings } from './index'

export interface VideoAspectRatioOption {
  value: VideoAspectRatio
  label: string
}

export interface VideoResolutionOption {
  value: VideoResolution
  label: string
}

/** Base labels aligned with VIDEO_ASPECT_RATIO_OPTIONS in index.ts */
const BASE_ASPECT_RATIO_OPTIONS: VideoAspectRatioOption[] = [
  { value: '16:9', label: '16:9 横屏' },
  { value: '9:16', label: '9:16 竖屏' },
  { value: '1:1', label: '1:1 方形' },
]

const EXTRA_ASPECT_RATIO_LABELS: Record<string, string> = {
  '4:3': '4:3',
  '3:4': '3:4',
  '21:9': '21:9 超宽',
  adaptive: '自适应',
}

/** Base labels aligned with VIDEO_RESOLUTION_OPTIONS in index.ts */
const BASE_RESOLUTION_OPTIONS: VideoResolutionOption[] = [
  { value: '480p', label: '480p' },
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
]

const EXTRA_RESOLUTION_OPTIONS: VideoResolutionOption[] = [
  { value: '768p', label: '768p' },
  { value: '2k', label: '2K' },
  { value: '4k', label: '4K' },
]

function aspectRatioLabel(value: VideoAspectRatio): string {
  const base = BASE_ASPECT_RATIO_OPTIONS.find((o) => o.value === value)
  if (base) return base.label
  return EXTRA_ASPECT_RATIO_LABELS[value] ?? value
}

function resolutionLabel(value: VideoResolution): string {
  const base = BASE_RESOLUTION_OPTIONS.find((o) => o.value === value)
  if (base) return base.label
  const extra = EXTRA_RESOLUTION_OPTIONS.find((o) => o.value === value)
  if (extra) return extra.label
  return value
}

export function videoAspectRatioOptionsForCapabilities(
  c: VideoModelCapabilities,
): VideoAspectRatioOption[] {
  const allowed = new Set(c.allowedAspectRatios)
  const fromBase = BASE_ASPECT_RATIO_OPTIONS.filter((o) => allowed.has(o.value))
  const extras = c.allowedAspectRatios
    .filter((ratio) => !BASE_ASPECT_RATIO_OPTIONS.some((o) => o.value === ratio))
    .map((value) => ({ value: value as VideoAspectRatio, label: aspectRatioLabel(value as VideoAspectRatio) }))
  return [...fromBase, ...extras]
}

export function videoResolutionOptionsForCapabilities(
  c: VideoModelCapabilities,
): VideoResolutionOption[] {
  const allowed = new Set(c.allowedResolutions)
  const fromBase = BASE_RESOLUTION_OPTIONS.filter((o) => allowed.has(o.value))
  const extras = c.allowedResolutions
    .filter((res) => !BASE_RESOLUTION_OPTIONS.some((o) => o.value === res))
    .map((value) => ({ value: value as VideoResolution, label: resolutionLabel(value as VideoResolution) }))
  return [...fromBase, ...extras]
}

// ---------------------------------------------------------------------------
// Seedance 基线全集（UI 常驻展示，不支持的能力置灰）
// ---------------------------------------------------------------------------

/** Seedance 宽高比基线（6 格示意矩形栅格）；`adaptive` 仅在模型支持时追加 */
export const VIDEO_BASELINE_ASPECT_RATIOS: VideoAspectRatio[] = [
  '16:9',
  '9:16',
  '1:1',
  '4:3',
  '3:4',
  '21:9',
]

/** Seedance 分辨率基线（480p–4K）；768p/2K 等模型特有档位以额外项追加 */
export const VIDEO_BASELINE_RESOLUTIONS: VideoResolution[] = ['480p', '720p', '1080p', '4k']

export interface VideoBaselineAspectOption {
  value: VideoAspectRatio
  label: string
  disabled: boolean
}

export interface VideoBaselineResolutionOption {
  value: VideoResolution
  label: string
  disabled: boolean
}

export function videoBaselineAspectOptionsForCapabilities(
  c?: VideoModelCapabilities,
): VideoBaselineAspectOption[] {
  const allowed = c ? new Set(c.allowedAspectRatios) : null
  const options: VideoBaselineAspectOption[] = VIDEO_BASELINE_ASPECT_RATIOS.map((value) => ({
    value,
    label: aspectRatioLabel(value),
    disabled: allowed ? !allowed.has(value) : false,
  }))
  if (allowed?.has('adaptive')) {
    options.push({ value: 'adaptive', label: aspectRatioLabel('adaptive'), disabled: false })
  }
  return options
}

export function videoBaselineResolutionOptionsForCapabilities(
  c?: VideoModelCapabilities,
): VideoBaselineResolutionOption[] {
  const allowed = c ? new Set(c.allowedResolutions) : null
  const options: VideoBaselineResolutionOption[] = VIDEO_BASELINE_RESOLUTIONS.map((value) => ({
    value,
    label: resolutionLabel(value),
    disabled: allowed ? !allowed.has(value) : false,
  }))
  if (c) {
    for (const value of c.allowedResolutions) {
      if (VIDEO_BASELINE_RESOLUTIONS.some((o) => o === value)) continue
      options.push({ value: value as VideoResolution, label: resolutionLabel(value as VideoResolution), disabled: false })
    }
  }
  return options
}

// ---------------------------------------------------------------------------
// 模型切换就近回落（snap）
// ---------------------------------------------------------------------------

export interface VideoSettingAdjustment {
  field: 'aspectRatio' | 'duration' | 'resolution'
  from: string | number
  to: string | number
  reason: string
}

const SNAP_ASPECT_ORDER: VideoAspectRatio[] = [
  '16:9',
  '9:16',
  '1:1',
  '4:3',
  '3:4',
  '21:9',
  'adaptive',
]

const RESOLUTION_RANK: Record<string, number> = {
  '480p': 1,
  '720p': 2,
  '768p': 3,
  '1080p': 4,
  '2k': 4,
  '4k': 5,
}

function nearestResolution(resolution: string, allowed: string[]): string {
  const currentRank = RESOLUTION_RANK[resolution] ?? 0
  let best = allowed[0] ?? resolution
  let bestDist = Number.POSITIVE_INFINITY
  let bestRank = RESOLUTION_RANK[best] ?? 0
  for (const candidate of allowed) {
    const rank = RESOLUTION_RANK[candidate] ?? 0
    const dist = Math.abs(rank - currentRank)
    if (dist < bestDist || (dist === bestDist && rank > bestRank)) {
      best = candidate
      bestDist = dist
      bestRank = rank
    }
  }
  return best
}

function nearestDuration(duration: number, tiers: number[]): number {
  let best = tiers[0] ?? duration
  let bestDist = Number.POSITIVE_INFINITY
  for (const candidate of tiers) {
    const dist = Math.abs(candidate - duration)
    if (dist < bestDist || (dist === bestDist && candidate > best)) {
      best = candidate
      bestDist = dist
    }
  }
  return best
}

/**
 * 把用户当前参数就 fix 到目标模型能力上。空集（模型自动处理，如 cogvideox 的比例/分辨率）
 * 不回落——值原样保留，由 UI 置灰表达「不可控」。adjusted 供交互层出一次性提示。
 */
export function snapVideoSettingsToCapabilities(
  settings: VideoSettings,
  c?: VideoModelCapabilities | null,
): { next: VideoSettings; adjusted: VideoSettingAdjustment[] } {
  const next: VideoSettings = { ...settings }
  const adjusted: VideoSettingAdjustment[] = []
  if (!c) return { next, adjusted }

  const allowedAr = c.allowedAspectRatios
  if (allowedAr.length > 0 && !allowedAr.includes(next.aspectRatio)) {
    const to = SNAP_ASPECT_ORDER.find((v) => allowedAr.includes(v)) ?? allowedAr[0]
    adjusted.push({
      field: 'aspectRatio',
      from: next.aspectRatio,
      to,
      reason: `当前模型不支持 ${next.aspectRatio}，已切换为 ${to}`,
    })
    next.aspectRatio = to as VideoAspectRatio
  }

  const allowedRes = c.allowedResolutions
  if (allowedRes.length > 0 && !allowedRes.includes(next.resolution)) {
    const to = nearestResolution(next.resolution, allowedRes)
    if (to !== next.resolution) {
      adjusted.push({
        field: 'resolution',
        from: next.resolution,
        to,
        reason: `当前模型不支持 ${next.resolution}，已切换为 ${to}`,
      })
      next.resolution = to as VideoResolution
    }
  }

  const min = c.minDuration ?? 4
  const max = c.maxDuration ?? 15
  const clamped = Math.min(max, Math.max(min, Math.round(next.duration)))
  if (clamped !== next.duration) {
    adjusted.push({
      field: 'duration',
      from: next.duration,
      to: clamped,
      reason: `当前模型支持 ${min}–${max}s，已调整为 ${clamped}s`,
    })
    next.duration = clamped
  }
  const discrete = c.allowedDurations
  if (discrete && discrete.length > 0 && !discrete.includes(next.duration)) {
    const to = nearestDuration(next.duration, discrete)
    adjusted.push({
      field: 'duration',
      from: next.duration,
      to,
      reason: `当前模型仅支持 ${discrete.join('/')}s，已调整为 ${to}s`,
    })
    next.duration = to
  }

  return { next, adjusted }
}
