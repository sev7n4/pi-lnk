import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { PointsService } from '../points/points.service'
import { PrismaService } from '../prisma/prisma.service'
import { GenerationReaperService } from './generation-reaper.service'

function makeMeta(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ chargedPoints: 10, ...extra })
}

describe('GenerationReaperService 收尾机制', () => {
  let svc: GenerationReaperService
  let generationFindMany: ReturnType<typeof vi.fn>
  let generationUpdateMany: ReturnType<typeof vi.fn>
  let refundInTx: ReturnType<typeof vi.fn>
  let tx: Record<string, unknown>

  /** 模拟「status 守卫」：记录仍是 generating 才允许迁移。 */
  let stuckStatus: string

  beforeEach(async () => {
    vi.clearAllMocks()
    stuckStatus = 'generating'
    generationFindMany = vi.fn(async () => [])
    generationUpdateMany = vi.fn(
      async (args: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
        if (stuckStatus !== args.where.status) return { count: 0 }
        stuckStatus = String(args.data.status)
        return { count: 1 }
      },
    )
    refundInTx = vi.fn(async () => {})
    tx = {
      generationRecord: { updateMany: generationUpdateMany },
    }
    const prismaMock = {
      generationRecord: { findMany: generationFindMany },
      $transaction: vi.fn(async (fn: (t: unknown) => Promise<number>) => fn(tx)),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        GenerationReaperService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: PointsService, useValue: { refundInTx } },
      ],
    }).compile()
    svc = moduleRef.get(GenerationReaperService)
  })

  it('卡死记录：标记 failed(upstream_timeout) + 同事务退款，退款带 generationId', async () => {
    stuckStatus = 'generating'
    generationFindMany.mockResolvedValue([
      { id: 'r1', userId: 'u1', model: 'seedream-5.0-pro', metadata: makeMeta() },
    ])

    const n = await svc.reapOnce('manual')

    expect(n).toBe(1)
    const data = generationUpdateMany.mock.calls[0][0].data
    expect(data.status).toBe('failed')
    const meta = JSON.parse(String(data.metadata))
    expect(meta.errorCode).toBe('upstream_timeout')
    expect(meta.refundedPoints).toBe(10)
    expect(meta.refundReason).toBe('超时回收退款')
    // 退款在事务内且 generationId 指向该记录
    const refundArgs = refundInTx.mock.calls[0]
    expect(refundArgs[1]).toBe('u1')
    expect(refundArgs[2]).toBe(10)
    expect(refundArgs[4].generationId).toBe('r1')
    expect(refundArgs[4].status).toBe('failed_refund')
  })

  it('已退款但状态卡死的记录：只补状态迁移，不重复退款', async () => {
    generationFindMany.mockResolvedValue([
      {
        id: 'r2',
        userId: 'u1',
        model: null,
        metadata: makeMeta({ refundedPoints: 10, refundReason: '平台失败退款' }),
      },
    ])

    const n = await svc.reapOnce('manual')

    expect(n).toBe(1)
    expect(refundInTx).not.toHaveBeenCalled()
    const meta = JSON.parse(String(generationUpdateMany.mock.calls[0][0].data.metadata))
    expect(meta.refundedPoints).toBe(10) // 保留原退款标记
    expect(meta.errorCode).toBe('upstream_timeout')
  })

  it('用户已取消的记录：标记 failed 但不退款', async () => {
    generationFindMany.mockResolvedValue([
      { id: 'r3', userId: 'u1', model: null, metadata: makeMeta({ cancelled: true }) },
    ])

    const n = await svc.reapOnce('manual')

    expect(n).toBe(1)
    expect(refundInTx).not.toHaveBeenCalled()
  })

  it('无 chargedPoints 的记录：只迁移状态', async () => {
    generationFindMany.mockResolvedValue([
      { id: 'r4', userId: 'u1', model: null, metadata: JSON.stringify({ foo: 1 }) },
    ])

    const n = await svc.reapOnce('manual')

    expect(n).toBe(1)
    expect(refundInTx).not.toHaveBeenCalled()
    const meta = JSON.parse(String(generationUpdateMany.mock.calls[0][0].data.metadata))
    expect(meta.userMessage).toBe('生成超时')
  })

  it('状态守卫未命中（completeImage 已先行结算）：跳过且不退款', async () => {
    stuckStatus = 'completed' // 模拟 completeImage 恰好在 findMany 后结算完成
    generationFindMany.mockResolvedValue([
      { id: 'r5', userId: 'u1', model: null, metadata: makeMeta() },
    ])

    const n = await svc.reapOnce('manual')

    expect(n).toBe(0)
    expect(refundInTx).not.toHaveBeenCalled()
  })

  it('只回收 image 类型、按阈值过滤 createdAt', async () => {
    await svc.reapOnce('manual')

    const where = generationFindMany.mock.calls[0][0].where
    expect(where.type).toBe('image')
    expect(where.status).toBe('generating')
    expect(where.createdAt.lt).toBeInstanceOf(Date)
    // 默认 30 分钟阈值
    expect(Date.now() - where.createdAt.lt.getTime()).toBeGreaterThan(29 * 60_000)
  })
})
