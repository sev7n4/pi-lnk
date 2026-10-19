import type { DockNodeType } from '@/components/canvas/NodePanelDock.vue'

export interface CanvasDockMenuItem {
  type: DockNodeType
  label: string
  desc?: string
  badge?: string
  tone: string
}

// 被删历史（2026-10-17 prompt 节点下线，PR feat/prompt-node-decommission）：
// 菜单首项 { type: 'prompt', label: '提示词', desc: '多模式提示词扩写', badge: 'Prompt' }
// 曾在此；提示词节点退出创建菜单（存量节点渲染见 Phase 3 冻结只读）。
export const CANVAS_DOCK_MENU_ITEMS: CanvasDockMenuItem[] = [
  { type: 'text', label: '文本', desc: '脚本、广告词、品牌文案', badge: 'Neo-G', tone: 'text-sky-300 bg-sky-500/15' },
  { type: 'image', label: '图片', desc: 'AI 图像生成', badge: 'Image', tone: 'text-emerald-300 bg-emerald-500/15' },
  { type: 'video', label: '视频', desc: '文生视频 / 图生视频', tone: 'text-violet-300 bg-violet-500/15' },
  { type: 'audio', label: '音频', desc: '配音与旁白', tone: 'text-cyan-300 bg-cyan-500/15' },
  // 2026-10-19 节点下线：导演台 / 媒体输入 / 视频合成 / 3D World / 分镜 / 分组 已退出创建菜单（存量节点渲染见兜底）。
]

/** 从源节点拖出连线时可创建的目标类型（简化规则，后续可按 Neo 细化） */
// 被删历史（2026-10-17 prompt 节点下线）：'prompt' 曾在本连线目标类型表中。
export const CONNECT_OUT_TARGET_TYPES: DockNodeType[] = [
  'text',
  'image',
  'video',
  'audio',
]
