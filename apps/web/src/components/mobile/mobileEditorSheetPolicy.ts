/**
 * 移动端「改词」浮层策略纯函数（2026-11-01 规格 §8）。
 *
 * 为什么独立成文件：`MobileNodeEditorSheet.vue` 是 `<script setup>`，
 * 无法导出命名函数供直测；预填翻译与 fallback 文案是可判定的纯逻辑，
 * 按仓库惯例（mobileNodeActionPolicy 等）落策略文件。
 *
 * ⭐ 判据 J-1（翻译制）：参数 owner 永远是 agent —— 本文件只做「字段名 →
 *   意见前缀」的翻译，永不返回可写参数值；目标值由用户在意见框里补全。
 * ⭐ 判据 J-2（发送必有落点）：意见为空时 composer 兜底轻引用，永不为空。
 */

/** 产物上下文行副标题（四类节点共用；措辞避开「生成」二字——G-8 守卫扫组件模板） */
export const CONTEXT_SUBTITLE = '发送后 agent 将按新词重做并替换当前产物'

/** 节点类型 → 中文标签（未知类型回退「节点」） */
export function nodeTypeLabel(type: string): string {
  switch (type) {
    case 'image':
      return '图片'
    case 'video':
      return '视频'
    case 'audio':
      return '音频'
    case 'text':
      return '文本'
    default:
      return '节点'
  }
}

/** 产物上下文行标题：data.title 非空取之，否则降级为「{类型}节点」 */
export function contextTitle(
  data: Record<string, unknown> | null | undefined,
  type: string,
): string {
  const t = data && typeof data.title === 'string' ? data.title.trim() : ''
  return t || `${nodeTypeLabel(type)}节点`
}

/**
 * 参数 chip → 意见预填前缀（翻译制：点 chip 只翻译字段名，不改任何值）。
 * 未知字段返回 null（该 chip 不应渲染出可点行为）。
 */
export function paramChipToPrefill(field: string): string | null {
  switch (field) {
    case 'imageAspect':
      return '把画面比例改为'
    case 'imageResolution':
      return '把分辨率改为'
    case 'imageModel':
    case 'videoModel':
    case 'textModel':
    case 'audioModel':
      return '把模型改为'
    default:
      return null
  }
}

/**
 * 意见预填追加（幂等）：
 * - 意见已含同前缀行（整行相等或以该前缀开头）⇒ 原样返回（changed=false）
 * - 意见为空 ⇒ 置为前缀
 * - 意见非空 ⇒ 换行追加（保住既有内容，含音频 at mm:ss 预填）
 */
export function appendOpinionPrefill(
  current: string,
  prefix: string,
): { next: string; changed: boolean } {
  const lines = current.split('\n').map((l) => l.trim())
  if (lines.some((l) => l === prefix || l.startsWith(`${prefix} `) || l.startsWith(`${prefix}：`))) {
    return { next: current, changed: false }
  }
  const trimmed = current.trim()
  if (!trimmed) return { next: prefix, changed: true }
  return { next: `${trimmed}\n${prefix}`, changed: true }
}

/**
 * 毛边修复的兜底轻引用（规格 图 2 G 分支）：只改词未留意见时预填 composer，
 * 仍由用户自己按发送（扣扳机者永远是用户）。
 */
export function composeFallbackOpinion(title: string, type: string): string {
  const t = title.trim()
  const name = t || `${nodeTypeLabel(type)}节点`
  return `已更新「${name}」的提示词，请按新词重做并替换当前产物`
}
