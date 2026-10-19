export type NeoNodeStatus = 'idle' | 'running' | 'success' | 'error'

export interface NeoNodeMeta {
  label: string
  variant: string
  icon: 'prompt' | 'text' | 'image' | 'video' | 'audio'
  defaultWidth: number
  defaultHeight: number
}

export const NEO_NODE_META: Record<string, NeoNodeMeta> = {
  // 🔴 2026-10-17 prompt 节点下线：条目仅为存量渲染兜底保留（创建入口已删、生产数据已清空）。
  prompt: { label: '提示词', variant: 'node-prompt', icon: 'prompt', defaultWidth: 280, defaultHeight: 120 },
  text: { label: '文本', variant: 'node-text', icon: 'text', defaultWidth: 280, defaultHeight: 160 },
  image: { label: '图片', variant: 'node-image', icon: 'image', defaultWidth: 280, defaultHeight: 280 },
  /** 视频：默认 1:1 兜底 320×320（长边基准 320，尺寸随 videoSettings/mediaInfo 比例推导） */
  video: { label: '视频', variant: 'node-video', icon: 'video', defaultWidth: 320, defaultHeight: 320 },
  audio: { label: '音频', variant: 'node-audio', icon: 'audio', defaultWidth: 280, defaultHeight: 140 },
  // 2026-10-19 节点下线：mediaInput / shot / sceneComposer / videoComposition / worldModel / group
  // 已退出创建与编辑入口（存量节点仅走兜底渲染，见 getNeoNodeMeta 兜底分支）。
}

export function getNeoNodeMeta(type: string): NeoNodeMeta {
  return NEO_NODE_META[type] ?? {
    label: '节点',
    variant: 'node-generation',
    icon: 'text',
    defaultWidth: 280,
    defaultHeight: 280,
  }
}

export function resolveNeoNodeStatus(status?: string): NeoNodeStatus {
  const value = String(status ?? '').toLowerCase()
  if (['generating', 'pending', 'processing', 'running'].includes(value)) return 'running'
  if (['generated', 'success', 'done', 'completed'].includes(value)) return 'success'
  if (['failed', 'error'].includes(value)) return 'error'
  return 'idle'
}

export function resolveNeoNodeTitle(type: string, data?: Record<string, unknown>) {
  const meta = getNeoNodeMeta(type)
  const custom = String(data?.label ?? data?.title ?? '').trim()
  if (custom) return custom.length > 20 ? `${custom.slice(0, 20)}...` : custom
  return meta.label
}
