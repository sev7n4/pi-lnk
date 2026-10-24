export function formatMediaBytes(bytes?: number): string | null {
  if (bytes == null) return null
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}B`
}

export function formatMediaDimensions(width?: number, height?: number): string | null {
  if (width == null || height == null) return null
  return `${width}×${height}`
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a))
  let y = Math.abs(Math.round(b))
  while (y) {
    const t = y
    y = x % y
    x = t
  }
  return x || 1
}

export function formatMediaDuration(durationSec?: number): string | null {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec < 0) return null
  const total = Math.floor(durationSec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
  return `${m}:${pad(s)}`
}

const MIME_FORMAT: Record<string, string> = {
  'audio/mpeg': 'MP3',
  'audio/mp3': 'MP3',
  'audio/wav': 'WAV',
  'audio/x-wav': 'WAV',
  'audio/wave': 'WAV',
  'audio/mp4': 'M4A',
  'audio/aac': 'AAC',
  'audio/ogg': 'OGG',
  'audio/flac': 'FLAC',
  'audio/webm': 'WEBM',
}

export function formatMediaFormat(mimeOrExt?: string): string | null {
  const raw = mimeOrExt?.trim()
  if (!raw) return null
  const lower = raw.toLowerCase()
  if (MIME_FORMAT[lower]) return MIME_FORMAT[lower]
  if (!lower.includes('/')) return lower.replace(/^\./, '').toUpperCase()
  const sub = lower.split('/')[1]?.split(';')[0]?.trim()
  if (!sub) return null
  if (sub === 'mpeg' || sub === 'mp3') return 'MP3'
  return sub.toUpperCase()
}

export function aspectRatioLabel(width?: number, height?: number): string | null {
  if (width == null || height == null || width <= 0 || height <= 0) return null
  const g = gcd(width, height)
  return `${Math.round(width / g)}:${Math.round(height / g)}`
}

/** 媒体属性摘要的结构形状（与 `NodeMediaInfoSummary` 同构，刻意不 import 以防环） */
export interface MediaInfoLike {
  kind?: 'image' | 'video' | 'audio'
  width?: number
  height?: number
  bytes?: number
  aspectRatio?: string
  resolution?: string
  durationSec?: number
  format?: string
}

/**
 * 媒体属性一行的「分段」单一真源（2026-10-24 走查②：移动端瓦片要显示，
 * PC 的 `MediaInfoSummary` 也要显示 ⇒ 判据只能有一份）。
 *
 * 顺序即展示顺序（与 PC 既有逐字一致）：
 * - 音频：时长 · 格式 · 大小
 * - 视频：分辨率 · 比例 · 大小
 * - 图片：尺寸 · 比例 · 大小
 *
 * ⛔ 只取**实际有值**的项：缺字段不猜、不补占位（假造比不显示更糟）。
 */
export function mediaInfoParts(info: MediaInfoLike): string[] {
  const line: string[] = []
  const size = formatMediaBytes(info.bytes)
  if (info.kind === 'audio') {
    const dur = formatMediaDuration(info.durationSec)
    if (dur) line.push(dur)
    if (info.format?.trim()) line.push(info.format.trim())
    if (size) line.push(size)
    return line
  }
  if (info.kind === 'video') {
    if (info.resolution?.trim()) line.push(info.resolution.trim())
    if (info.aspectRatio?.trim()) line.push(info.aspectRatio.trim())
    if (size) line.push(size)
    return line
  }
  const dims = formatMediaDimensions(info.width, info.height)
  if (dims) line.push(dims)
  if (info.aspectRatio?.trim()) line.push(info.aspectRatio.trim())
  if (size) line.push(size)
  return line
}

/** 属性一行的拼接（无任何有效分段时返回空串 ⇒ 调用方不渲染） */
export function mediaInfoLine(info: MediaInfoLike | undefined | null): string {
  if (!info) return ''
  return mediaInfoParts(info).join(' · ')
}

export function truncateUrl(url: string, max = 48): string {
  if (url.length <= max) return url
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${url.slice(0, head)}…${url.slice(-tail)}`
}
