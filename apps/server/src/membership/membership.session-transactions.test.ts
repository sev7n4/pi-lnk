import { describe, expect, it, vi } from 'vitest'
import { BadRequestException } from '@nestjs/common'
import { MembershipService } from './membership.service'
import { MembershipController } from './membership.controller'
import type { PrismaService } from '../prisma/prisma.service'

/**
 * Epic 4 Task 8（2026-11-04）：会话维度积分流水（跨会话聚合卡数据源）。
 * 钉住查询契约：sessionId 必过滤 / createdAt 升序 / take 200 / since 增量 / 无效 since 400。
 */

function makeService(findMany: ReturnType<typeof vi.fn>) {
  return new MembershipService({
    pointTransaction: { findMany },
  } as unknown as PrismaService)
}

const ROW = {
  id: 'tx-1',
  userId: 'u1',
  sessionId: 's1',
  amount: -10,
  kind: 'consume',
  category: 'text',
  reason: 'text_turn',
  createdAt: new Date('2026-11-04T00:00:00Z'),
}

describe('MembershipService.listSessionTransactions（Epic 4 Task 8）', () => {
  it('按 userId+sessionId 过滤、createdAt 升序、硬上限 200', async () => {
    const findMany = vi.fn().mockResolvedValue([ROW])
    const svc = makeService(findMany)
    const rows = await svc.listSessionTransactions('u1', 's1')
    expect(rows).toEqual([ROW])
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', sessionId: 's1' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 200,
      }),
    )
    // where 不携带 createdAt（未传 since 键不出现）
    const arg = findMany.mock.calls[0][0] as { where: Record<string, unknown> }
    expect('createdAt' in arg.where).toBe(false)
  })

  it('since 有效时增量过滤（createdAt gt）', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    const svc = makeService(findMany)
    await svc.listSessionTransactions('u1', 's1', '2026-11-03T00:00:00.000Z')
    const arg = findMany.mock.calls[0][0] as {
      where: { createdAt: { gt: Date } }
    }
    expect(arg.where.createdAt.gt.toISOString()).toBe('2026-11-03T00:00:00.000Z')
  })

  it('since 无效 → BadRequestException（不落查询）', async () => {
    const findMany = vi.fn()
    const svc = makeService(findMany)
    await expect(svc.listSessionTransactions('u1', 's1', 'not-a-date')).rejects.toThrow(
      BadRequestException,
    )
    expect(findMany).not.toHaveBeenCalled()
  })
})

describe('MembershipController.point-transactions（Epic 4 Task 8）', () => {
  function makeController(list: ReturnType<typeof vi.fn>) {
    return new MembershipController({
      listSessionTransactions: list,
    } as never)
  }

  it('sessionId 必填（缺失 400）', async () => {
    const controller = makeController(vi.fn())
    await expect(
      controller.pointTransactions({ user: { sub: 'u1' } }, undefined, undefined),
    ).rejects.toThrow(BadRequestException)
  })

  it('透传 sessionId/since 并返回 code=0 包装', async () => {
    const list = vi.fn().mockResolvedValue([ROW])
    const controller = makeController(list)
    const res = await controller.pointTransactions(
      { user: { sub: 'u1' } },
      's1',
      '2026-11-03T00:00:00.000Z',
    )
    expect(list).toHaveBeenCalledWith('u1', 's1', '2026-11-03T00:00:00.000Z')
    expect(res).toEqual({ code: 0, message: 'ok', data: [ROW] })
  })
})
