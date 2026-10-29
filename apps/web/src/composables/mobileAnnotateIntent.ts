/**
 * 移动端标注层：节点类型 → 标注底图来源（规格 §4.3 / §4.11 拍板项 L1；
 * 规格 v1.5 §4.12.8 拍板项 Q 修订：**指向形态随媒介**）。
 *
 * 图片 = 图（自由圈选）/ 视频 = 暂停后的当前帧（圈帧 + 「第 m:ss 帧」意见前缀）/
 * 文本 = 直接文字引用 / 音频 = **none（不圈选）**。
 *
 * ⭐ v1.5 Q：音频波形圈选是**判伪功能**——agent 消费的是「圈在波形哪一段」的截图，
 *   波形本身不是声音内容，agent 不能「听」图。音频的意见指向改走**时间戳**：
 *   点改词时自动带入 `at mm:ss`（audio.currentTime，见 MobileNodeViewer bottom-action
 *   meta.mediaTime → CanvasPage 编辑器意见预填）。
 */
export type AnnotateBaseSource = 'image' | 'video-frame' | 'text' | 'none'

export function resolveAnnotateIntent(node: {
  type: string
  data?: Record<string, unknown> | null
}): AnnotateBaseSource {
  switch (node.type) {
    case 'video':
      return 'video-frame'
    case 'audio':
      return 'none'
    case 'text':
      return 'text'
    default:
      return 'image'
  }
}
