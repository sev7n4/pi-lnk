// apps/web/src/services/announcement-api.ts
// 调价公告 API（2026-11-15-pricing-change-announcement-design §8）。
import { api } from './api'

export interface AnnouncementListItem {
  id: string
  type: string
  title: string
  summary: string | null
  publishedAt: string
  effectiveAt: string
  read: boolean
}

export interface AnnouncementChangeItem {
  capability: string
  modelKey: string
  displayName: string
  spec: string
  specLabel: string
  from: number
  to: number
  pct: number | null
  kind: 'increase' | 'decrease' | 'new'
}

export interface AnnouncementDetail extends Omit<AnnouncementListItem, 'read'> {
  payload: AnnouncementChangeItem[]
}

interface ListEnvelope {
  items: AnnouncementListItem[]
  unreadCount: number
}

export const announcementApi = {
  /** 未读列表（横幅/铃铛共用）；unreadOnly=false 时含已读历史（抽屉）。 */
  list: (unreadOnly = false) =>
    api.get<{ data: ListEnvelope }>('/announcements', { params: unreadOnly ? { unreadOnly: '1' } : {} }),
  detail: (id: string) =>
    api.get<{ data: AnnouncementDetail }>(`/announcements/${encodeURIComponent(id)}`),
  markRead: (id: string) =>
    api.post<{ data: { id: string; read: boolean } }>(`/announcements/${encodeURIComponent(id)}/read`),
}
