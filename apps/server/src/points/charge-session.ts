import { BadRequestException } from '@nestjs/common'

export function createCancelFlag(req: {
  on(event: string, cb: () => void): void
  aborted?: boolean
}) {
  let cancelled = Boolean(req.aborted)
  req.on('close', () => {
    cancelled = true
  })
  return { isCancelled: () => cancelled }
}

export function applyChargeMeta(meta: Record<string, unknown>, chargedPoints: number) {
  return { ...meta, chargedPoints }
}

/**
 * 从 GenerationRecord.metadata 读实扣积分（applyChargeMeta 盖章的 chargedPoints）。
 *
 * 供画布节点写 `data.creditCost` 用（2026-11-03 积分单一真相源收尾：提议卡「C-later
 * 服务端权威位」——扣费时刻把实扣价锁在节点上，历史卡片不随价目表漂移）。
 * fail-soft：metadata 缺失/非 JSON/chargedPoints 非正有限数 → undefined（键不出现，
 * 调用方按「无权威值」处理，前端继续走价目表 quote 兜底）。
 */
export function chargedPointsFromRecord(record: { metadata?: string | null }): number | undefined {
  try {
    const meta = JSON.parse(record.metadata ?? '{}') as Record<string, unknown>
    const v = meta.chargedPoints
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  } catch {
    // metadata 损坏不炸生成链路——积分展示退回价目表 quote 路径
  }
  return undefined
}

export function alreadyRefunded(meta: Record<string, unknown>): boolean {
  return typeof meta.refundedPoints === 'number' && meta.refundedPoints > 0
}

export function isCancelledMeta(meta: Record<string, unknown>): boolean {
  return meta.cancelled === true
}

export function applyRefundMeta(
  meta: Record<string, unknown>,
  refundedPoints: number,
  refundReason: string,
) {
  return { ...meta, refundedPoints, refundReason }
}

export function throwCancelledException(refundedPoints: number): never {
  throw new BadRequestException({ message: '已取消', refundedPoints })
}

export function isCancelledException(err: unknown): boolean {
  if (!(err instanceof BadRequestException)) return false
  const response = err.getResponse()
  if (typeof response === 'string') return response === '已取消'
  if (response && typeof response === 'object') {
    return (response as { message?: unknown }).message === '已取消'
  }
  return false
}

export function rethrowWithRefundedPoints(err: unknown, refundedPoints: number): never {
  if (err instanceof BadRequestException) {
    const response = err.getResponse()
    if (typeof response === 'object' && response !== null && !Array.isArray(response)) {
      throw new BadRequestException({ ...(response as Record<string, unknown>), refundedPoints })
    }
    const message = typeof response === 'string' ? response : '请求失败'
    throw new BadRequestException({ message, refundedPoints })
  }
  const message = err instanceof Error ? err.message : '生成失败'
  throw new BadRequestException({ message, refundedPoints })
}
