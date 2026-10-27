import type { ProbedMediaFile } from '@lnkpi/shared'
import type { NodeMediaInfoSummary } from '@/composables/useMediaInspector'
import { aspectRatioLabel, formatMediaDimensions, formatMediaFormat } from '@/utils/mediaInfoFormat'

export function hasSummaryPayload(summary?: NodeMediaInfoSummary): boolean {
  if (!summary) return false
  const { kind: _k, refWarning: _r, ...rest } = summary
  return Object.values(rest).some((v) => v != null && v !== '')
}

/**
 * ⭐ 2026-10-27 三轮走查修订：判据从「有任意 payload」收紧为「该 kind 的
 * **展示要素集**完整」——节点创建管道只落 bytes ⇒ hasSummaryPayload 为 true
 * ⇒ probe 被短路 ⇒ 磁贴底部永远只见「媒体大小」一段（真机现象）。
 * 要素集与 `mediaInfoParts` 展示分段一一对应：
 *   图片 = width+height · 视频 = resolution+aspectRatio · 音频 = durationSec+format
 * （bytes 由 probe 一并补齐；已完整的 summary 不再打 probe。）
 */
function hasCompleteElementSet(
  kind: 'image' | 'video' | 'audio',
  summary: NodeMediaInfoSummary | undefined,
): boolean {
  if (!summary) return false
  if (kind === 'image') return summary.width != null && summary.height != null
  if (kind === 'video') {
    return Boolean(summary.resolution?.trim() && summary.aspectRatio?.trim())
  }
  return summary.durationSec != null && Number.isFinite(summary.durationSec) && Boolean(summary.format?.trim())
}

export function needsMediaInfoEnsure(
  kind: 'image' | 'video' | 'audio',
  summary: NodeMediaInfoSummary | undefined,
  url: string | undefined,
): boolean {
  if (!url?.trim()) return false
  if (!hasCompleteElementSet(kind, summary)) return true
  return false
}

export function summaryFromProbed(
  kind: 'image' | 'video' | 'audio',
  probed: ProbedMediaFile,
): NodeMediaInfoSummary | undefined {
  const summary: NodeMediaInfoSummary = { kind }
  if (probed.bytes != null) summary.bytes = probed.bytes
  if (kind === 'audio') {
    const fmt = formatMediaFormat(probed.mimeType)
    if (fmt) summary.format = fmt
    if (probed.durationSec != null) summary.durationSec = probed.durationSec
  } else if (kind === 'video') {
    const dims = formatMediaDimensions(probed.width, probed.height)
    if (dims) summary.resolution = dims
    const ar = aspectRatioLabel(probed.width, probed.height)
    if (ar) summary.aspectRatio = ar
  } else {
    if (probed.width != null) summary.width = probed.width
    if (probed.height != null) summary.height = probed.height
    const ar = aspectRatioLabel(probed.width, probed.height)
    if (ar) summary.aspectRatio = ar
  }
  return hasSummaryPayload(summary) ? summary : undefined
}

export function mergeNodeMediaInfo(
  prev: NodeMediaInfoSummary | undefined,
  next: NodeMediaInfoSummary,
): NodeMediaInfoSummary {
  const out: NodeMediaInfoSummary = { ...(prev ?? {}), ...next, kind: next.kind ?? prev?.kind }
  const keys = [
    'width',
    'height',
    'bytes',
    'aspectRatio',
    'resolution',
    'durationSec',
    'format',
    'refWarning',
  ] as const
  for (const k of keys) {
    const v = next[k]
    if (v == null || v === '') {
      if (prev?.[k] != null && prev[k] !== '') (out as Record<string, unknown>)[k] = prev[k]
    }
  }
  return out
}
