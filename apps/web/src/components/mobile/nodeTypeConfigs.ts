export type PrimaryTap = 'preview' | 'play' | 'open-reader' | 'tts'

export type BadgeTone = 'idle' | 'busy' | 'warn' | 'error'

export interface NodeStatusBadge {
  label: string
  tone: BadgeTone
}

export interface NodeTypeConfig {
  type: 'image' | 'video' | 'audio' | 'text'
  primaryTap: PrimaryTap
  statusBadge: (status?: string) => NodeStatusBadge | null
}

export const nodeTypeConfigs: Record<string, NodeTypeConfig> = {
  image: {
    type: 'image',
    primaryTap: 'preview',
    statusBadge: (s) => (s === 'error' ? { label: '失败', tone: 'error' } : null),
  },
  video: {
    type: 'video',
    primaryTap: 'play',
    statusBadge: (s) => (s === 'pending' ? { label: '待确认', tone: 'warn' } : null),
  },
  audio: {
    type: 'audio',
    primaryTap: 'play',
    statusBadge: () => null,
  },
  text: {
    type: 'text',
    primaryTap: 'tts',
    statusBadge: () => null,
  },
}
