import {
  resolveMobileNodeStateFromStatus,
  type MobileNodeStatusOnly,
} from '@/composables/mobileNodeState'

export type PrimaryTap = 'preview' | 'play' | 'open-reader' | 'tts'

export type BadgeTone = 'idle' | 'busy' | 'warn' | 'error'

export interface NodeStatusBadge {
  label: string
  tone: BadgeTone
}

export interface NodeTypeConfig {
  type: 'image' | 'video' | 'audio' | 'text'
  primaryTap: PrimaryTap
  /**
   * 状态徽标（R3-T2）。
   *
   * ⭐ 2026-10-23 改法：改为**统一按五态判**（原先是「按类型分别判 status」）——
   *   原表只覆盖 2/5 态（image 判 `error`、video 判 `pending`），而那个
   *   `pending` **不是** `pending_confirm`（桌面用的是后者，ADR-0011 阻塞态），
   *   导致「待确认」在移动端永远不出现。统一按五态判后，四类型天然一致。
   *
   * 判据来自纯函数 `resolveMobileNodeState`（R3-T1），与磁贴 / 壳层状态栏
   * 消费同一答案。
   */
  statusBadge: (status?: string) => NodeStatusBadge | null
}

/** 三态 → 徽标。空态与已确认态不渲染徽标（无多余噪音）。 */
const STATUS_BADGES: Record<MobileNodeStatusOnly, NodeStatusBadge> = {
  generating: { label: '生成中', tone: 'busy' },
  pending: { label: '待确认', tone: 'warn' },
  error: { label: '失败', tone: 'error' },
}

/**
 * 由 status 推徽标。
 *
 * ⚠️ 「有没有内容」不参与判据——徽标只反映**状态**，内容判定归
 * `resolveMobileNodeState` 的 empty/confirmed 二分。
 */
function badgeByStatus(status?: string): NodeStatusBadge | null {
  const state = resolveMobileNodeStateFromStatus(status)
  return state ? STATUS_BADGES[state] : null
}

export const nodeTypeConfigs: Record<string, NodeTypeConfig> = {
  image: {
    type: 'image',
    primaryTap: 'preview',
    statusBadge: badgeByStatus,
  },
  video: {
    type: 'video',
    primaryTap: 'play',
    statusBadge: badgeByStatus,
  },
  audio: {
    type: 'audio',
    primaryTap: 'play',
    statusBadge: badgeByStatus,
  },
  text: {
    type: 'text',
    primaryTap: 'tts',
    statusBadge: badgeByStatus,
  },
}
