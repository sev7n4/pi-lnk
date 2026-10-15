import 'reflect-metadata'
import { BadRequestException, ConflictException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { PointsService, InsufficientPointsError } from './points.service'
import { PrismaService } from '../prisma/prisma.service'

describe('PointsService', () => {
  it('decrements points and writes negative transaction when balance is enough', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }))
    const findUnique = vi.fn(async () => ({ points: 90 }))
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'pt1', ...args.data }))
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { updateMany, findUnique },
        pointTransaction: { create },
      }),
    )
    const moduleRef = await Test.createTestingModule({
      providers: [
        PointsService,
        { provide: PrismaService, useValue: { $transaction } },
      ],
    }).compile()
    const svc = moduleRef.get(PointsService)

    await svc.consume('u1', 10, '图像生成', {
      kind: 'consume',
      category: 'image',
      status: 'success',
      model: 'seedream',
    })

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', points: { gte: 10 } },
      data: { points: { decrement: 10 } },
    })
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        amount: -10,
        reason: '图像生成',
        kind: 'consume',
        category: 'image',
        status: 'success',
        model: 'seedream',
        generationId: null,
        balanceAfter: 90,
        ruleVersion: null,
      },
    })
  })

  it('throws 积分不足 when conditional update matches zero rows', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }))
    const create = vi.fn()
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { updateMany },
        pointTransaction: { create },
      }),
    )
    const moduleRef = await Test.createTestingModule({
      providers: [
        PointsService,
        { provide: PrismaService, useValue: { $transaction } },
      ],
    }).compile()

    await expect(moduleRef.get(PointsService).consume('u1', 10, '图像生成')).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('increments points and writes positive transaction on refund', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }))
    const findUnique = vi.fn(async () => ({ points: 95 }))
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'pt2', ...args.data }))
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ user: { updateMany, findUnique }, pointTransaction: { create } }),
    )
    const moduleRef = await Test.createTestingModule({
      providers: [
        PointsService,
        { provide: PrismaService, useValue: { $transaction } },
      ],
    }).compile()

    await moduleRef.get(PointsService).refund('u1', 5, '文本生成退款', {
      kind: 'refund',
      category: 'text',
      status: 'failed_refund',
      generationId: 'gen-1',
    })

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { points: { increment: 5 } },
    })
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        amount: 5,
        reason: '文本生成退款',
        kind: 'refund',
        category: 'text',
        status: 'failed_refund',
        model: null,
        generationId: 'gen-1',
        balanceAfter: 95,
        ruleVersion: null,
      },
    })
  })

  it('preserves an explicit null grant status', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }))
    const findUnique = vi.fn(async () => ({ points: 105 }))
    const create = vi.fn()
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ user: { updateMany, findUnique }, pointTransaction: { create } }),
    )
    const moduleRef = await Test.createTestingModule({
      providers: [
        PointsService,
        { provide: PrismaService, useValue: { $transaction } },
      ],
    }).compile()

    await moduleRef.get(PointsService).refund('u1', 5, '人工赠送', {
      kind: 'grant',
      category: 'other',
      status: null,
    })

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'grant', status: null }),
    })
  })

  it('derives structured fields from reason when consume meta is omitted', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }))
    const findUnique = vi.fn(async () => ({ points: 90 }))
    const create = vi.fn()
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ user: { updateMany, findUnique }, pointTransaction: { create } }),
    )
    const moduleRef = await Test.createTestingModule({
      providers: [
        PointsService,
        { provide: PrismaService, useValue: { $transaction } },
      ],
    }).compile()

    await moduleRef.get(PointsService).consume('u1', 10, '图像生成')

    expect(create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        amount: -10,
        reason: '图像生成',
        kind: 'consume',
        category: 'image',
        status: 'success',
        model: null,
        generationId: null,
        balanceAfter: 90,
        ruleVersion: null,
      },
    })
  })

  it('derives refund status from reason when meta is omitted', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }))
    const findUnique = vi.fn(async () => ({ points: 95 }))
    const create = vi.fn()
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ user: { updateMany, findUnique }, pointTransaction: { create } }),
    )
    const moduleRef = await Test.createTestingModule({
      providers: [
        PointsService,
        { provide: PrismaService, useValue: { $transaction } },
      ],
    }).compile()

    await moduleRef.get(PointsService).refund('u1', 5, '文本生成-失败退款')

    expect(create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        amount: 5,
        reason: '文本生成-失败退款',
        kind: 'refund',
        category: 'text',
        status: 'failed_refund',
        model: null,
        generationId: null,
        balanceAfter: 95,
        ruleVersion: null,
      },
    })
  })

  it('no-ops when refund amount <= 0', async () => {
    const $transaction = vi.fn()
    const moduleRef = await Test.createTestingModule({
      providers: [
        PointsService,
        { provide: PrismaService, useValue: { $transaction } },
      ],
    }).compile()
    await moduleRef.get(PointsService).refund('u1', 0, 'x')
    expect($transaction).not.toHaveBeenCalled()
  })

  it('persists ruleVersion from meta and defaults to null', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }))
    const findUnique = vi.fn(async () => ({ points: 90 }))
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'pt3', ...args.data }))
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ user: { updateMany, findUnique }, pointTransaction: { create } }),
    )
    const moduleRef = await Test.createTestingModule({
      providers: [PointsService, { provide: PrismaService, useValue: { $transaction } }],
    }).compile()
    const svc = moduleRef.get(PointsService)

    await svc.consume('u1', 10, '图像生成', {
      kind: 'consume',
      category: 'image',
      ruleVersion: 'v1-legacy-equivalent',
    })
    expect(create.mock.calls[0][0].data.ruleVersion).toBe('v1-legacy-equivalent')

    await svc.consume('u1', 10, '图像生成', { kind: 'consume', category: 'image' })
    expect(create.mock.calls[1][0].data.ruleVersion).toBeNull()
  })
})

describe('PointsService 冻结三原语（P2 T3）', () => {
  const compile = async (prisma: Record<string, unknown>) => {
    const moduleRef = await Test.createTestingModule({
      providers: [PointsService, { provide: PrismaService, useValue: prisma }],
    }).compile()
    return moduleRef.get(PointsService)
  }

  const makeHold = (args: { data: Record<string, unknown> }) => ({
    id: 'hold1',
    settledCredits: null,
    settledAt: null,
    createdAt: new Date(),
    ...args.data,
  })

  it('freeze 正常：条件守卫 increment pointsFrozen + 建 hold + kind=freeze 流水', async () => {
    const findUnique = vi.fn(async () => ({ points: 100, pointsFrozen: 20 }))
    const updateMany = vi.fn(async () => ({ count: 1 }))
    const createHold = vi.fn(makeHold)
    const createTx = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'pt1', ...args.data }))
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { findUnique, updateMany },
        pointHold: { create: createHold },
        pointTransaction: { create: createTx },
      }),
    )
    const svc = await compile({ $transaction })

    const hold = await svc.freeze('u1', 30, '文本回合预扣冻结')

    expect(hold).toMatchObject({ id: 'hold1', userId: 'u1', amount: 30, status: 'held' })
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { points: true, pointsFrozen: true },
    })
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', points: { gte: 50 } }, // 已冻结 20 + 本次 30
      data: { pointsFrozen: { increment: 30 } },
    })
    expect(createHold).toHaveBeenCalledWith({
      data: { userId: 'u1', amount: 30, status: 'held', reason: '文本回合预扣冻结' },
    })
    // points 余额未变（冻结只动 pointsFrozen），amount 恒等于余额增量 → 0
    expect(createTx).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        amount: 0,
        reason: '文本回合预扣冻结',
        kind: 'freeze',
        category: 'other',
        status: 'held',
        model: null,
        generationId: null,
        balanceAfter: 100,
        ruleVersion: null,
      },
    })
  })

  it('freeze 余额不足拒：可用 = points - pointsFrozen 不足 → 400 且不建 hold', async () => {
    const findUnique = vi.fn(async () => ({ points: 100, pointsFrozen: 90 }))
    const updateMany = vi.fn()
    const createHold = vi.fn()
    const createTx = vi.fn()
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { findUnique, updateMany },
        pointHold: { create: createHold },
        pointTransaction: { create: createTx },
      }),
    )
    const svc = await compile({ $transaction })

    await expect(svc.freeze('u1', 30, '文本回合预扣冻结')).rejects.toThrow('可用积分不足')
    await expect(svc.freeze('u1', 30, '文本回合预扣冻结')).rejects.toBeInstanceOf(BadRequestException)
    // F1（P2 T6 修复轮）：余额不足必须抛专用异常——agent 层以 instanceof 分类
    // （fail-open vs 402 拒绝），不得依赖 message 字符串匹配
    await expect(svc.freeze('u1', 30, '文本回合预扣冻结')).rejects.toBeInstanceOf(
      InsufficientPointsError,
    )
    expect(updateMany).not.toHaveBeenCalled()
    expect(createHold).not.toHaveBeenCalled()
    expect(createTx).not.toHaveBeenCalled()
  })

  it('freeze 非法金额（0/负数/小数）→ 400 且不开事务', async () => {
    const $transaction = vi.fn()
    const svc = await compile({ $transaction })

    await expect(svc.freeze('u1', 0, 'x')).rejects.toBeInstanceOf(BadRequestException)
    await expect(svc.freeze('u1', -5, 'x')).rejects.toBeInstanceOf(BadRequestException)
    await expect(svc.freeze('u1', 2.5, 'x')).rejects.toBeInstanceOf(BadRequestException)
    expect($transaction).not.toHaveBeenCalled()
  })

  it('settleFromHold：扣实际 + 冻结清零 + kind=consume 流水透传 meta + 返回 {settled, released:0}', async () => {
    const holdFindUnique = vi.fn(async () => ({
      id: 'h1',
      userId: 'u1',
      amount: 100,
      status: 'held',
      settledCredits: null,
    }))
    const holdUpdateMany = vi.fn(async () => ({ count: 1 }))
    const userFindUnique = vi.fn(async () => ({ points: 93 }))
    const userUpdateMany = vi.fn(async () => ({ count: 1 }))
    const createTx = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'pt1', ...args.data }))
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { findUnique: userFindUnique, updateMany: userUpdateMany },
        pointHold: { findUnique: holdFindUnique, updateMany: holdUpdateMany },
        pointTransaction: { create: createTx },
      }),
    )
    const svc = await compile({ $transaction })

    const result = await svc.settleFromHold('h1', 7, '文本回合结算', {
      kind: 'consume',
      category: 'text',
      status: 'success',
      model: 'step-3.5-flash',
    })

    expect(result).toEqual({ settled: 7, released: 0 })
    expect(holdUpdateMany).toHaveBeenCalledWith({
      where: { id: 'h1', status: 'held' },
      data: expect.objectContaining({ status: 'settled', settledCredits: 7 }),
    })
    expect(userUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'u1' },
      data: { pointsFrozen: { decrement: 100 } },
    })
    expect(userUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'u1', points: { gte: 7 } },
      data: { points: { decrement: 7 } },
    })
    expect(createTx).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        amount: -7,
        reason: '文本回合结算',
        kind: 'consume',
        category: 'text',
        status: 'success',
        model: 'step-3.5-flash',
        generationId: null,
        balanceAfter: 93,
        ruleVersion: null,
      },
    })
    // PointTransaction 无 holdId 列（Task 2 迁移未含）——键不出现，绝不写未知列
    expect(createTx.mock.calls[0][0].data).not.toHaveProperty('holdId')
  })

  it('settleFromHold 实际 < hold：只扣实际 7（hold 100），差额自然留在余额', async () => {
    const holdFindUnique = vi.fn(async () => ({
      id: 'h1',
      userId: 'u1',
      amount: 100,
      status: 'held',
      settledCredits: null,
    }))
    const holdUpdateMany = vi.fn(async () => ({ count: 1 }))
    const userFindUnique = vi.fn(async () => ({ points: 93 }))
    const userUpdateMany = vi.fn(async () => ({ count: 1 }))
    const createTx = vi.fn()
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { findUnique: userFindUnique, updateMany: userUpdateMany },
        pointHold: { findUnique: holdFindUnique, updateMany: holdUpdateMany },
        pointTransaction: { create: createTx },
      }),
    )
    const svc = await compile({ $transaction })

    const result = await svc.settleFromHold('h1', 7, '文本回合结算')

    expect(result).toEqual({ settled: 7, released: 0 })
    // 冻结只减 hold.amount，余额只扣实际 → 余额 = 原 - 7
    expect(userUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'u1', points: { gte: 7 } },
      data: { points: { decrement: 7 } },
    })
    expect(createTx).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'consume', amount: -7, balanceAfter: 93 }),
    })
  })

  it('settleFromHold 幂等：已 settled/released 直接返回既记录值，不再动账', async () => {
    const holdFindUnique = vi.fn(async (args: { where: { id: string } }) =>
      args.where.id === 'h-settled'
        ? { id: 'h-settled', userId: 'u1', amount: 100, status: 'settled', settledCredits: 7 }
        : { id: 'h-released', userId: 'u1', amount: 100, status: 'released', settledCredits: null },
    )
    const holdUpdateMany = vi.fn()
    const userUpdateMany = vi.fn()
    const createTx = vi.fn()
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { findUnique: vi.fn(), updateMany: userUpdateMany },
        pointHold: { findUnique: holdFindUnique, updateMany: holdUpdateMany },
        pointTransaction: { create: createTx },
      }),
    )
    const svc = await compile({ $transaction })

    expect(await svc.settleFromHold('h-settled', 999, 'x')).toEqual({ settled: 7, released: 0 })
    expect(await svc.settleFromHold('h-released', 999, 'x')).toEqual({ settled: 0, released: 0 })
    expect(holdUpdateMany).not.toHaveBeenCalled()
    expect(userUpdateMany).not.toHaveBeenCalled()
    expect(createTx).not.toHaveBeenCalled()
  })

  it('settleFromHold：hold 不存在 → 409；actualCredits 非法 → 400', async () => {
    const holdFindUnique = vi.fn(async () => null)
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { findUnique: vi.fn(), updateMany: vi.fn() },
        pointHold: { findUnique: holdFindUnique, updateMany: vi.fn() },
        pointTransaction: { create: vi.fn() },
      }),
    )
    const svc = await compile({ $transaction })

    await expect(svc.settleFromHold('h-none', 7, 'x')).rejects.toBeInstanceOf(ConflictException)
    await expect(svc.settleFromHold('h1', -1, 'x')).rejects.toBeInstanceOf(BadRequestException)
    await expect(svc.settleFromHold('h1', 1.5, 'x')).rejects.toBeInstanceOf(BadRequestException)
  })

  it('release：held → released + 冻结回退 + kind=release 流水', async () => {
    const holdFindUnique = vi.fn(async () => ({
      id: 'h1',
      userId: 'u1',
      amount: 30,
      status: 'held',
      settledCredits: null,
    }))
    const holdUpdateMany = vi.fn(async () => ({ count: 1 }))
    const userFindUnique = vi.fn(async () => ({ points: 100 }))
    const userUpdateMany = vi.fn(async () => ({ count: 1 }))
    const createTx = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'pt1', ...args.data }))
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { findUnique: userFindUnique, updateMany: userUpdateMany },
        pointHold: { findUnique: holdFindUnique, updateMany: holdUpdateMany },
        pointTransaction: { create: createTx },
      }),
    )
    const svc = await compile({ $transaction })

    await expect(svc.release('h1', '回合失败解冻')).resolves.toBeUndefined()

    expect(holdUpdateMany).toHaveBeenCalledWith({
      where: { id: 'h1', status: 'held' },
      data: { status: 'released' },
    })
    expect(userUpdateMany).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { pointsFrozen: { decrement: 30 } },
    })
    expect(createTx).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        amount: 0,
        reason: '回合失败解冻',
        kind: 'release',
        category: 'other',
        status: 'released',
        model: null,
        generationId: null,
        balanceAfter: 100,
        ruleVersion: null,
      },
    })
  })

  it('release 幂等：已终结 hold no-op 不动账；hold 不存在 → 409', async () => {
    const holdFindUnique = vi.fn(async (args: { where: { id: string } }) =>
      args.where.id === 'h-none'
        ? null
        : { id: 'h1', userId: 'u1', amount: 30, status: 'released', settledCredits: null },
    )
    const holdUpdateMany = vi.fn()
    const userUpdateMany = vi.fn()
    const createTx = vi.fn()
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { findUnique: vi.fn(), updateMany: userUpdateMany },
        pointHold: { findUnique: holdFindUnique, updateMany: holdUpdateMany },
        pointTransaction: { create: createTx },
      }),
    )
    const svc = await compile({ $transaction })

    await expect(svc.release('h1', 'x')).resolves.toBeUndefined()
    expect(holdUpdateMany).not.toHaveBeenCalled()
    expect(userUpdateMany).not.toHaveBeenCalled()
    expect(createTx).not.toHaveBeenCalled()
    await expect(svc.release('h-none', 'x')).rejects.toBeInstanceOf(ConflictException)
  })

  it('releaseExpiredHolds：两笔 hold 一笔超时 → release 1 笔并返回 1', async () => {
    const findMany = vi.fn(async () => [{ id: 'h-old', status: 'held' }])
    const holdFindUnique = vi.fn(async () => ({
      id: 'h-old',
      userId: 'u1',
      amount: 10,
      status: 'held',
      settledCredits: null,
    }))
    const holdUpdateMany = vi.fn(async () => ({ count: 1 }))
    const userUpdateMany = vi.fn(async () => ({ count: 1 }))
    const createTx = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'pt1', ...args.data }))
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { findUnique: vi.fn(), updateMany: userUpdateMany },
        pointHold: { findUnique: holdFindUnique, updateMany: holdUpdateMany },
        pointTransaction: { create: createTx },
      }),
    )
    const svc = await compile({ $transaction, pointHold: { findMany } })

    const count = await svc.releaseExpiredHolds(1000)

    expect(count).toBe(1)
    expect(findMany).toHaveBeenCalledWith({
      where: { status: 'held', createdAt: { lt: expect.any(Date) } },
      select: { id: true },
    })
    expect(createTx).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'release', status: 'released' }),
    })
  })

  it('releaseExpiredHolds 默认 30 分钟窗口且无过期时返回 0', async () => {
    const findMany = vi.fn(async () => [])
    const svc = await compile({ pointHold: { findMany } })

    const count = await svc.releaseExpiredHolds()

    expect(count).toBe(0)
    const cutoff = findMany.mock.calls[0][0].where.createdAt.lt as Date
    expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(30 * 60_000)
    expect(Date.now() - cutoff.getTime()).toBeLessThan(30 * 60_000 + 5_000)
  })

  it('并发守卫：可用 100，两笔并发 freeze 80+80 恰一笔成功（Promise.all 真实竞态）', async () => {
    // 状态化桩模拟 DB 行；$transaction 串行化闭包 = SQLite 单写者（事务内读可见前序提交）
    const state = { points: 100, pointsFrozen: 0 }
    const userUpdateMany = vi.fn(async (args: {
      where?: { points?: { gte?: number } }
      data: { pointsFrozen?: { increment?: number }; points?: { decrement?: number } }
    }) => {
      const need = args.where?.points?.gte
      if (need !== undefined && state.points < need) return { count: 0 }
      if (args.data.pointsFrozen?.increment) state.pointsFrozen += args.data.pointsFrozen.increment
      if (args.data.points?.decrement) state.points -= args.data.points.decrement
      return { count: 1 }
    })
    const tx = {
      user: {
        findUnique: vi.fn(async () => ({ points: state.points, pointsFrozen: state.pointsFrozen })),
        updateMany: userUpdateMany,
      },
      pointHold: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => makeHold(args)),
      },
      pointTransaction: { create: vi.fn(async () => ({ id: 'pt' })) },
    }
    let chain: Promise<unknown> = Promise.resolve()
    const $transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => {
      const run = chain.then(() => fn(tx))
      chain = run.catch(() => undefined)
      return run
    })
    const svc = await compile({ $transaction })

    const results = await Promise.allSettled([
      svc.freeze('u1', 80, '回合A预扣'),
      svc.freeze('u1', 80, '回合B预扣'),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(state.pointsFrozen).toBe(80) // 只冻了一笔
    expect(state.points).toBe(100) // points 余额不变
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException)
  })
})
