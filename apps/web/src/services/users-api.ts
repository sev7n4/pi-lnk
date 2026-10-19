import { api } from './api'
import type { Work } from '@lnkpi/shared'

export interface CreatorProfile {
  user: {
    id: string
    nickname: string
    avatar?: string
    points: number
    membership: string
    workCount: number
    createdAt: string
  }
  works: Work[]
}

export const usersApi = {
  getCreator: (id: string) => api.get<{ data: CreatorProfile }>(`/users/${id}`),
}

export interface MembershipPlan {
  id: string
  name: string
  points: number
  price: number
  features: string[]
  basic?: number
  bonus?: number
  recommended?: boolean
}

/// 会员档位中文标签（与后端 membership.service.ts PLANS 对齐 · 方案丙四档）。
export const MEMBERSHIP_LABELS: Record<string, string> = {
  free: '免费版',
  experience: '体验版',
  standard: '标准版',
  premium: '高级版',
  flagship: '旗舰版',
}

export function membershipLabel(id?: string | null): string {
  if (id && MEMBERSHIP_LABELS[id]) return MEMBERSHIP_LABELS[id]
  return MEMBERSHIP_LABELS.free
}

/**
 * 「订阅口径」档位文案：**免费版不是套餐**，未订阅时一律说「未订阅」。
 * 套餐页头部 / 我的订阅卡 / 我的页订阅行都用它，避免出现「当前套餐：免费版」这种
 * 把默认档当套餐说的错位措辞。
 */
export function subscriptionLabel(id?: string | null): string {
  return id && id !== 'free' && MEMBERSHIP_LABELS[id] ? MEMBERSHIP_LABELS[id] : '未订阅'
}

export type PointsRangeKey = '7d' | 'month' | 'all'
export type PointKind = 'consume' | 'refund' | 'grant'
export type PointCategory = 'text' | 'image' | 'audio' | 'video' | 'other'

export interface PointTransactionItem {
  id: string
  amount: number
  reason: string
  createdAt: string
  kind: PointKind
  category: PointCategory
  status: string | null
  model: string | null
  generationId: string | null
  balanceAfter: number | null
}

export interface PointsInsights {
  netConsumedTotal: number
  peakDayConsumed: number
  avgDailyConsumed: number
  activeDays: number
  longestStreakDays: number
}

export interface PointsSummary {
  range: PointsRangeKey
  from: string | null
  to: string
  byCategory: Record<'text' | 'image' | 'audio' | 'video', number>
  otherNetConsumed: number
  refundTotal: number
  grantTotal: number
  insights: PointsInsights
}

export type UsageDaysRangeKey = '7d' | '30d' | 'month' | 'all'
export type UsageTrendRangeKey = Exclude<UsageDaysRangeKey, 'all'>

export interface UsageCategoryBreakdown {
  text: number
  image: number
  audio: number
  video: number
}

export interface UsageDayPoint {
  date: string
  generationCount: number
  netConsumed: number
  byCategory: UsageCategoryBreakdown
  otherNetConsumed: number
}

export interface UsageHeatmapDay {
  date: string
  netConsumed: number
  generationCount: number
}

export interface UsageOverviewResponse {
  overview: {
    netConsumedTotal: number
    byCategory: UsageCategoryBreakdown
    otherNetConsumed: number
    generationCount: number
    activeDays: number
  }
  heatmap: {
    from: string
    to: string
    activeDays: number
    days: UsageHeatmapDay[]
  }
}

export interface UsageDaysResponse {
  range: UsageDaysRangeKey
  from: string
  to: string
  days: UsageDayPoint[]
}

export const membershipApi = {
  getPlans: () => api.get<{ data: MembershipPlan[] }>('/membership/plans'),
  getPoints: () =>
    api.get<{ data: { points: number; membership: string; claimedToday: boolean } }>('/membership/points'),
  claimDaily: () => api.post<{ data: { points: number; added: number } }>('/membership/claim-daily'),
  upgrade: (plan: string) => api.post<{ data: { membership: string; points: number } }>('/membership/upgrade', { plan }),
  /// 退订当前套餐（一个用户同时只持有一个套餐 → 换购前必须先退订）。
  cancelSubscription: () =>
    api.post<{ data: { membership: string; points: number; changed: boolean } }>('/membership/cancel-subscription'),
  transactions: (params?: {
    range?: PointsRangeKey
    kind?: PointKind
    category?: PointCategory
    cursor?: string
    limit?: number
    day?: string
  }) =>
    api.get<{
      data: { items: PointTransactionItem[]; nextCursor: string | null; from: string | null; to: string }
    }>('/membership/transactions', { params }),
  pointsSummary: (range?: PointsRangeKey) =>
    api.get<{ data: PointsSummary }>('/membership/points-summary', { params: { range } }),
  usage: () => api.get<{ data: UsageOverviewResponse }>('/membership/usage'),
  usageDays: (range?: UsageDaysRangeKey) =>
    api.get<{ data: UsageDaysResponse }>('/membership/usage-days', { params: { range } }),
}
