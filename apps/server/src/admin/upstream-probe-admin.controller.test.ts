import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { UnauthorizedException } from '@nestjs/common'
import { AdminTokenGuard } from './admin-token.guard'
import { UpstreamProbeAdminController } from './upstream-probe-admin.controller'
import { PrismaService } from '../prisma/prisma.service'

interface StoredRun {
  id: string
  ranAt: Date
  upstream: string
  httpStatus: number | null
  modelCount: number | null
  ghosts: string | null
  missing: string | null
  error: string | null
  reason: string | null
}

/**
 * 内存桩：findFirst 必须忠实执行 where（upstream 精确匹配）并按 ranAt desc 取最新
 * （对账纪律：桩不执行 where 的话，「端点漏掉 upstream 过滤」这类变异杀不掉）。
 */
function createMemoryPrisma(runs: StoredRun[]) {
  return {
    upstreamProbeRun: {
      findFirst: async ({
        where,
      }: {
        where: { upstream: string }
        orderBy?: unknown
      }) => {
        const matched = runs
          .filter((r) => r.upstream === where.upstream)
          .sort((a, b) => b.ranAt.getTime() - a.ranAt.getTime())
        return matched[0] ?? null
      },
    },
  }
}

describe('UpstreamProbeAdminController（A6：GET /api/admin/upstream-probe/latest）', () => {
  const originalToken = process.env.LNKPI_ADMIN_TOKEN
  let runs: StoredRun[]
  let prisma: ReturnType<typeof createMemoryPrisma>
  let controller: UpstreamProbeAdminController

  beforeEach(async () => {
    process.env.LNKPI_ADMIN_TOKEN = 'secret-token'
    runs = []
    prisma = createMemoryPrisma(runs)
    const moduleRef = await Test.createTestingModule({
      controllers: [UpstreamProbeAdminController],
      providers: [AdminTokenGuard, { provide: PrismaService, useValue: prisma }],
    }).compile()
    controller = moduleRef.get(UpstreamProbeAdminController)
  })

  afterEach(() => {
    if (originalToken === undefined) delete process.env.LNKPI_ADMIN_TOKEN
    else process.env.LNKPI_ADMIN_TOKEN = originalToken
  })

  it('无 run 时返回 200 语义：{code:0, data:{runs:[]}}（不用 404）', async () => {
    const res = await controller.latest()
    expect(res.code).toBe(0)
    expect(res.data.runs).toEqual([])
  })

  it('返回每个上游最近一帧 run，ghosts/missing 解析为数组', async () => {
    const older = new Date('2026-10-09T01:00:00Z')
    const newer = new Date('2026-10-09T07:00:00Z')
    runs.push(
      {
        id: 'run-old',
        ranAt: older,
        upstream: 'agnes',
        httpStatus: 200,
        modelCount: 9,
        ghosts: '["agnes-image-2.0-flash"]',
        missing: '[]',
        error: null,
        reason: null, // B3 前的旧行：reason 列为 NULL
      },
      {
        id: 'run-new',
        ranAt: newer,
        upstream: 'agnes',
        httpStatus: 200,
        modelCount: 10,
        ghosts: '[]',
        missing: '["brand-new-model"]',
        error: null,
        reason: 'startup',
      },
      {
        id: 'run-fail',
        ranAt: newer,
        upstream: 'apimart',
        httpStatus: 402,
        modelCount: null,
        ghosts: null,
        missing: null,
        error: 'HTTP 402（余额不足）',
        reason: null, // B3 前的旧行：reason 列为 NULL
      },
    )

    const res = await controller.latest()

    expect(res.code).toBe(0)
    const byUpstream = Object.fromEntries(res.data.runs.map((r) => [r.upstream, r]))
    // agnes 取最新一帧（不是最早那帧）
    expect(byUpstream['agnes']).toMatchObject({
      id: 'run-new',
      ranAt: newer,
      httpStatus: 200,
      modelCount: 10,
      ghosts: [],
      missing: ['brand-new-model'],
      error: null,
      // B3 新字段：触发来源透出
      reason: 'startup',
    })
    // 旧行 reason=null 不破坏既有消费：latest 响应字段可空、原样透出 null
    expect(byUpstream['apimart']).toMatchObject({ error: 'HTTP 402（余额不足）', httpStatus: 402, reason: null })
    // 其余上游无 run ⇒ 不出现
    expect(res.data.runs).toHaveLength(2)
  })

  it('guard 集成：env 未设置时控制器请求被拒（fail-closed）', async () => {
    delete process.env.LNKPI_ADMIN_TOKEN
    const moduleRef = await Test.createTestingModule({
      controllers: [UpstreamProbeAdminController],
      providers: [AdminTokenGuard, { provide: PrismaService, useValue: prisma }],
    }).compile()
    const guard = moduleRef.get(AdminTokenGuard)
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer secret-token' } }) }),
    } as never
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
    expect(vi.isMockFunction(guard.canActivate)).toBe(false)
  })
})
