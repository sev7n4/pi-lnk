/** I9：数据门口径常量，禁止取数时改。 */
export const NEAR_CONCURRENT_MS = 2000

export interface CanvasPatchSample {
  sessionId: string
  clientId: string
  ts: number
  targetKeys: string[]
}

/** 从 sanitize 后的 ops 提取目标键（node:id / edge:id），用于键相交判定。 */
export function targetKeysOf(ops: unknown[]): string[] {
  const out: string[] = []
  for (const raw of ops) {
    const op = raw as { type?: string; payload?: { id?: unknown } }
    if (typeof op?.type !== 'string' || typeof op.payload?.id !== 'string') continue
    if (op.type.includes('node')) out.push(`node:${op.payload.id}`)
    else if (op.type.includes('edge')) out.push(`edge:${op.payload.id}`)
  }
  return out
}

export class CanvasPatchMetrics {
  private patches = 0
  private ops = 0
  private applied = 0
  private skipped = 0
  private skippedByType = new Map<string, number>()
  private clients = new Set<string>()
  private lastBySession = new Map<string, CanvasPatchSample>()
  private nearConcurrentPairs = 0
  private keyOverlapPairs = 0

  record(s: CanvasPatchSample, opCount: number, applied: number, skips: Array<{ type: string }>): void {
    this.patches += 1
    this.ops += opCount
    this.applied += applied
    this.skipped += skips.length
    for (const sk of skips) this.skippedByType.set(sk.type, (this.skippedByType.get(sk.type) ?? 0) + 1)
    this.clients.add(s.clientId)
    // I9 / R12：「相邻」= 该 session 时间上紧邻的前一次 PATCH；非紧邻对不参与 stale_conflict 计数。
    // lastBySession 只保留每 session 最近一条，故仅与紧邻前驱比较，不做 2s 窗口内的任意两两配对。
    const last = this.lastBySession.get(s.sessionId)
    if (last && last.clientId !== s.clientId && s.ts - last.ts <= NEAR_CONCURRENT_MS && s.ts >= last.ts) {
      this.nearConcurrentPairs += 1
      if (s.targetKeys.some((k) => last.targetKeys.includes(k))) this.keyOverlapPairs += 1
    }
    this.lastBySession.set(s.sessionId, s)
  }

  snapshot() {
    return {
      patches: this.patches,
      ops: this.ops,
      applied: this.applied,
      skipped: this.skipped,
      skippedByType: Object.fromEntries(this.skippedByType),
      distinctClients: this.clients.size,
      nearConcurrentPairs: this.nearConcurrentPairs,
      keyOverlapPairs: this.keyOverlapPairs,
      staleConflict: this.keyOverlapPairs,
    }
  }

  reset(): void {
    this.patches = this.ops = this.applied = this.skipped = 0
    this.skippedByType.clear()
    this.clients.clear()
    this.lastBySession.clear()
    this.nearConcurrentPairs = this.keyOverlapPairs = 0
  }
}

export const canvasPatchMetrics = new CanvasPatchMetrics()
