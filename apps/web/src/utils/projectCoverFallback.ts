import type { ProjectCard } from '@/composables/useProjectWorkspace'

/**
 * 创作首页行卡封面三态解析（规格 v2 §6.2，Task 5）。
 *
 * ⚠️ 兜底走组件层 `CanvasCoverFallback`（画布墨点纸纹语言）——**不做**首字符块：
 *    home-profile-p3 守卫裁定「紫底首字母 = 头像位语言」禁用于画布封面。
 * ⚠️ `coverNodeId` 不是封面字段：它的职责是 open 时的 focusNode 深链
 *    （CanvasPage 经 route.query.focusNode 消费），此处不参与渲染判定。
 */
export type ProjectCover =
  | { type: 'image'; value: string }
  | { type: 'fallback' }

/** 浏览器 <img> 无法解码的媒体类型（音频/视频）⇒ 走墨点兜底而非裂图。 */
const NON_IMAGE_URL_RE = /\.(mp4|webm|mov|m4v|avi|mkv|wav|mp3|m4a|aac|ogg|flac)(\?|#|$)/i

export function projectCoverFallback(p: Pick<ProjectCard, 'coverUrl'>): ProjectCover {
  const url = (p.coverUrl ?? '').trim()
  if (!url) return { type: 'fallback' }
  // v2.4（生产取证实证）：coverUrl 可能是音频/视频节点产物（历史数据里有
  // .wav / .mp4 封面），<img> 解码失败只剩裂图 ⇒ 统一落墨点兜底。
  if (NON_IMAGE_URL_RE.test(url)) return { type: 'fallback' }
  return { type: 'image', value: url }
}
