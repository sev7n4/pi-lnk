/**
 * E2-a 交付摘要埋点——前端批量上报（规格 docs/superpowers/specs/2026-11-04-e2a-ghost-delivery-summary-design.md §6）。
 *
 * 纪律：失败静默丢弃、不重试、零阻塞（埋点永远不影响交付体验）；
 * 认证与 points-events 同源（localStorage token + Bearer）；
 * 批量 50 条或 5s flush（notify-metrics 端点批量上限 50 对齐）。
 */
import { apiUrl } from '@/services/api-base'

export type DeliveryMetricType = 'impression' | 'expand' | 'viewer_open' | 'locate'

interface DeliveryMetricEvent {
  type: DeliveryMetricType
  nodeId?: string
  ts: number
}

const FLUSH_AT = 50
const FLUSH_MS = 5_000

let buffer: DeliveryMetricEvent[] = []
let timer: ReturnType<typeof setTimeout> | null = null

export function observeDeliveryCard(type: DeliveryMetricType, meta: { nodeId?: string } = {}): void {
  if (typeof window === 'undefined') return
  buffer.push({ type, nodeId: meta.nodeId, ts: Date.now() })
  if (buffer.length >= FLUSH_AT) {
    void flushDeliveryMetrics()
    return
  }
  if (timer === null) {
    timer = setTimeout(() => {
      void flushDeliveryMetrics()
    }, FLUSH_MS)
  }
}

export async function flushDeliveryMetrics(): Promise<boolean> {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  if (buffer.length === 0) return false
  const events = buffer
  buffer = []
  try {
    const token = localStorage.getItem('token')
    const res = await fetch(apiUrl('/api/agent/metrics/delivery'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ events }),
    })
    return res.ok
  } catch {
    // 静默丢弃（规格 §6）：不重试、不抛、零阻塞
    return false
  }
}

/** 仅测试用：清空缓冲与挂起 flush。 */
export function resetDeliveryMetricsForTest(): void {
  buffer = []
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}
