/**
 * 移动端标注层：节点类型 → 标注底图来源（规格 §4.3 / §4.11 拍板项 L1）。
 *
 * ⭐ **四类节点收敛为「一张图 + 一句话」**（只有底图不同，工具与契约完全一致）：
 *   图片 = 图 / 视频 = 暂停后的当前帧 / 音频 = **波形图** / 文本 = 直接文字引用。
 *
 * ⭐ 音频的底图是**波形图**（不是「拖时间段」）—— 统一成一张图，才有一支笔
 *   （§4.3：⛔ 取消框选·套索·拖段·选段四套手势，只留手指自由圈选）。
 */
export type AnnotateBaseSource = 'image' | 'video-frame' | 'waveform' | 'text'

export function resolveAnnotateIntent(node: {
  type: string
  data?: Record<string, unknown> | null
}): AnnotateBaseSource {
  switch (node.type) {
    case 'video':
      return 'video-frame'
    case 'audio':
      return 'waveform'
    case 'text':
      return 'text'
    default:
      return 'image'
  }
}
