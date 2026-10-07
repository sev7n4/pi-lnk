import { containFitSize } from '@/utils/centerExpand'
import type { NodeMediaInfoSummary } from '@/composables/useMediaInspector'

/**
 * 媒体节点「尺寸跟随素材比例」（2026-10-07 拍板）：
 * 节点卡尺寸 = 素材宽高比等比 contain 进方形包络框（长边 = 包络边长），
 * 非 1:1 素材不再被 object-fit: cover 放大裁切。
 * 包络框仍是布局算法的包围盒 ⇒ 布局常量只需按包络边长对齐（video 320 / image 280）。
 */
export const IMAGE_NODE_ENVELOPE = 280
export const VIDEO_NODE_ENVELOPE = 320

export interface NodeDisplaySize {
  width: number
  height: number
}

/**
 * 解析 "W:H" 比例串（16:9 / 9:16 / 1:1 / 4:3 …）。
 * 'auto' / 'adaptive' / 非法串 / 非字符串 → null（调用方走兜底）。
 */
export function parseRatioString(value: unknown): { w: number; h: number } | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,5})\s*:\s*(\d{1,5})$/.exec(value.trim())
  if (!match) return null
  const w = Number(match[1])
  const h = Number(match[2])
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return null
  return { w, h }
}

function fitRatio(ratio: { w: number; h: number }, envelope: number): NodeDisplaySize {
  const size = containFitSize(
    { width: envelope, height: envelope },
    { width: ratio.w, height: ratio.h },
  )
  return { width: Math.max(1, size.width), height: Math.max(1, size.height) }
}

function readMediaInfo(data: Record<string, unknown>): NodeMediaInfoSummary | undefined {
  const mediaInfo = data.mediaInfo
  return mediaInfo && typeof mediaInfo === 'object' ? (mediaInfo as NodeMediaInfoSummary) : undefined
}

/** 显式 nodeSize（扩图/精修「应用到节点」链路写入）优先级最高，原样返回。 */
function explicitNodeSize(data: Record<string, unknown>): NodeDisplaySize | null {
  const nodeSize = data.nodeSize as { width?: unknown; height?: unknown } | undefined
  const width = nodeSize?.width
  const height = nodeSize?.height
  if (typeof width !== 'number' || typeof height !== 'number') return null
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null
  return { width, height }
}

function readProbedPixelSize(mediaInfo: NodeMediaInfoSummary): { w: number; h: number } | null {
  const width = mediaInfo.width
  const height = mediaInfo.height
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1
  ) {
    return null
  }
  return { w: width, h: height }
}

/**
 * 图片节点显示尺寸，优先级：
 * 显式 nodeSize（扩图应用）> probe 真实像素宽高 > probe 比例串 > 声明的 imageAspect（'auto' 跳过）> 1:1 兜底。
 */
export function resolveImageNodeDisplaySize(data: Record<string, unknown>): NodeDisplaySize {
  const envelope = IMAGE_NODE_ENVELOPE
  const explicit = explicitNodeSize(data)
  if (explicit) return explicit
  const mediaInfo = readMediaInfo(data)
  if (mediaInfo) {
    const probedPixels = readProbedPixelSize(mediaInfo)
    if (probedPixels) return fitRatio(probedPixels, envelope)
    const probedRatio = parseRatioString(mediaInfo.aspectRatio)
    if (probedRatio) return fitRatio(probedRatio, envelope)
  }
  const declared = parseRatioString(data.imageAspect)
  if (declared) return fitRatio(declared, envelope)
  return { width: envelope, height: envelope }
}

/**
 * 视频节点显示尺寸，优先级：
 * probe 真实比例（生成完成后 mediaInfo 校正）> 请求比例 videoSettings.aspectRatio（'adaptive' 跳过）> 1:1 兜底。
 */
export function resolveVideoNodeDisplaySize(data: Record<string, unknown>): NodeDisplaySize {
  const envelope = VIDEO_NODE_ENVELOPE
  const mediaInfo = readMediaInfo(data)
  const probedRatio = mediaInfo ? parseRatioString(mediaInfo.aspectRatio) : null
  if (probedRatio) return fitRatio(probedRatio, envelope)
  const settings = data.videoSettings as { aspectRatio?: unknown } | undefined
  const declared = settings ? parseRatioString(settings?.aspectRatio) : null
  if (declared) return fitRatio(declared, envelope)
  return { width: envelope, height: envelope }
}
