import type { Session } from '@lnkpi/shared'

type CanvasNodeLike = {
  type?: string
  data?: { url?: string; coverUrl?: string }
}

const MEDIA_NODE_TYPES = new Set(['image', 'video'])

/**
 * 单 URL 的媒体类型判定（视频 / 图片）。服务端只回 URL，不回节点 type，
 * 故按扩展名判定；与下面节点路径的判定口径一致。
 */
function classifyUrl(url: string): { url: string; kind: 'image' | 'video' } | null {
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return { url, kind: 'video' }
  if (/\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(url)) return { url, kind: 'image' }
  return null
}

/**
 * 2026-10-25：优先用服务端算好的 `coverUrl`（列表不再下发整份 canvasData，
 * 165 项目实测从 589KB 降到几十 KB）；单条拉取仍可能带 canvasData，故保留兜底。
 */
export function extractSessionCover(session: Session): { url: string; kind: 'image' | 'video' } | null {
  const serverCover = String(session.coverUrl ?? '').trim()
  if (serverCover) {
    return classifyUrl(serverCover) ?? { url: serverCover, kind: 'image' }
  }
  const nodes = (session.canvasData?.nodes ?? []) as CanvasNodeLike[]
  for (const node of nodes) {
    const type = String(node.type ?? '')
    const url = String(node.data?.coverUrl ?? node.data?.url ?? '').trim()
    if (!url) continue
    if (type === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(url)) {
      return { url, kind: 'video' }
    }
    if (MEDIA_NODE_TYPES.has(type) || /\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(url)) {
      return { url, kind: 'image' }
    }
  }
  for (const node of nodes) {
    const url = String(node.data?.coverUrl ?? node.data?.url ?? '').trim()
    if (url) return { url, kind: 'image' }
  }
  return null
}
