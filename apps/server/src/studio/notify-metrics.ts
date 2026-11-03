export type NotifyReason =
  | 'terminal-write'
  | 'notify-tick'
  | 'periodic'
  | 'startup'
  | 'manual'
  | 'orphan-reap'

/**
 * 简报通报计数器（进程级 in-memory）。G-1 度量口径：按「已通报记录数」累计（D-7），
 * 而非扫描调用次数——否则每次终态写都记一次 terminal-write 扫描，占比必虚高且无法证伪。
 */
export class NotifyMetrics {
  private readonly notified = new Map<NotifyReason, number>()
  private readonly scans = new Map<NotifyReason, number>()

  incrNotified(reason: NotifyReason, n: number): void {
    if (n <= 0) return
    this.notified.set(reason, (this.notified.get(reason) ?? 0) + n)
  }
  incrScan(reason: NotifyReason): void {
    this.scans.set(reason, (this.scans.get(reason) ?? 0) + 1)
  }
  snapshot(): { notified: Record<string, number>; scans: Record<string, number> } {
    return {
      notified: Object.fromEntries(this.notified),
      scans: Object.fromEntries(this.scans),
    }
  }
  reset(): void {
    this.notified.clear()
    this.scans.clear()
  }
}

export const notifyMetrics = new NotifyMetrics()
