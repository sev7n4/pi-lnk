/**
 * Epic 1（spec 2026-11-03-credit-consumption-display-design）：积分变动领域事件契约。
 *
 * 由 `PointsService` 在计费事务提交后统一发出，经 `SessionEventBus` 注入在飞会话 SSE
 * （复用 multi-device 规格 §5.3 通道，多端一致免费获得）。前端据此实时累计「本次使用」
 * 扣费并事件化刷新余额（Epic 2）。
 *
 * ⚠️ `PointKind` / `PointCategory` 与 `apps/server/src/points/point-tx.types.ts` 当前为
 * 同源副本（服务端是计费事实源）。为控制本期改动面，仅在 shared 侧定义供前后端共用；
 * 后续可把这两个联合类型上移到 shared 作为唯一真相，服务端改为再导出。
 */

export type PointKind = 'consume' | 'refund' | 'grant' | 'freeze' | 'release'
export type PointCategory = 'text' | 'image' | 'audio' | 'video' | 'other'

/** credit_tx：一笔积分变动，经会话级 SSE 下发。 */
export interface CreditTxEvent {
  type: 'credit_tx'
  data: {
    /** 幂等键 = pointTransaction.id（去重，C5） */
    txId: string
    userId: string
    /** 关联会话；缺省（如后台赠送）时走 user 广播（Epic 2） */
    sessionId?: string | null
    /** 有符号：扣费为负、退款为正、冻结/解冻为 0 */
    amount: number
    kind: PointKind
    category: PointCategory
    reason: string
    model?: string | null
    generationId?: string | null
    ruleVersion?: string | null
    /** 交易后全局余额（权威） */
    balanceAfter: number
    ts: number
  }
}
