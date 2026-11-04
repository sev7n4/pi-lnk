/**
 * E2-a 交付摘要埋点计数器（规格 2026-11-04-e2a-ghost-delivery-summary §6）。
 * 进程级 in-memory（notify-metrics 同模式）；E2-b 准入判据的数据源：
 * expand 率 / viewer_open 率决定原 delivery-card v1 富卡是否值得建。
 */
export const DELIVERY_EVENT_TYPES = ['impression', 'expand', 'viewer_open', 'locate'] as const
export type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[number]

export class DeliveryMetrics {
  private readonly counts = new Map<DeliveryEventType, number>()

  record(type: DeliveryEventType, n = 1): void {
    if (n <= 0) return
    this.counts.set(type, (this.counts.get(type) ?? 0) + n)
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts)
  }

  reset(): void {
    this.counts.clear()
  }
}

export const deliveryMetrics = new DeliveryMetrics()
