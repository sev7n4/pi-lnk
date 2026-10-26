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

export function projectCoverFallback(p: Pick<ProjectCard, 'coverUrl'>): ProjectCover {
  const url = (p.coverUrl ?? '').trim()
  return url ? { type: 'image', value: url } : { type: 'fallback' }
}
