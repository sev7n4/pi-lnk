/** Shared SVG path helpers for Dock Studio icon buttons. */

export type DockNodeIconKind =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'prompt'

export const DOCK_TYPE_LABELS: Record<string, string> = {
  text: '文本生成',
  image: '图片生成',
  video: '视频生成',
  audio: '音频生成',
  prompt: '提示词',
}

export function dockTypeToIcon(type: string): DockNodeIconKind {
  if (
    type === 'text' ||
    type === 'image' ||
    type === 'video' ||
    type === 'audio' ||
    type === 'prompt'
  ) {
    return type
  }
  return 'text'
}
