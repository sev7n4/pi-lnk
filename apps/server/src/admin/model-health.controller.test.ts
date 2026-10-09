import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BadRequestException, UnauthorizedException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { AdminTokenGuard } from './admin-token.guard'
import { ModelHealthAdminController } from './model-health.controller'
import { PrismaService } from '../prisma/prisma.service'
import type { RawHealthRow } from '@lnkpi/shared/modelHealth'

describe('ModelHealthAdminController（A5：GET /api/admin/model-health）', () => {
  const originalToken = process.env.LNKPI_ADMIN_TOKEN
  let rawRows: RawHealthRow[]
  let captured: { sql: string; params: unknown[] } | null
  let controller: ModelHealthAdminController

  beforeEach(async () => {
    process.env.LNKPI_ADMIN_TOKEN = 'secret-token'
    rawRows = []
    captured = null
    const prisma = {
      $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
        captured = { sql, params }
        return rawRows
      },
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [ModelHealthAdminController],
      providers: [AdminTokenGuard, { provide: PrismaService, useValue: prisma }],
    }).compile()
    controller = moduleRef.get(ModelHealthAdminController)
  })

  afterEach(() => {
    if (originalToken === undefined) delete process.env.LNKPI_ADMIN_TOKEN
    else process.env.LNKPI_ADMIN_TOKEN = originalToken
  })

  it('admin 调用返回 200 信封 {code:0, data:{generatedAt, rows, alerts}}（空库 → 空行空告警）', async () => {
    const res = await controller.health()
    expect(res.code).toBe(0)
    expect(res.message).toBe('ok')
    expect(new Date(res.data.generatedAt).toString()).not.toBe('Invalid Date')
    expect(res.data.rows).toEqual([])
    expect(res.data.alerts).toEqual([])
  })

  it('默认 windowHours=24：SQL 参数为整数毫秒 cutoff；白名单窗口原样透传', async () => {
    await controller.health()
    expect(captured).not.toBeNull()
    expect(captured!.params).toHaveLength(1)
    expect(Number.isInteger(captured!.params[0])).toBe(true)
    expect(captured!.sql).toContain('WHERE createdAt >= CAST(? AS INTEGER)')

    captured = null
    await controller.health('168')
    expect(captured!.params[0]).toBeLessThan(Date.now() - 167 * 3_600_000)
  })

  it('windowHours 越界（999 / abc / 0）→ 400', async () => {
    for (const bad of ['999', 'abc', '0', '1.5', '-24']) {
      await expect(controller.health(bad)).rejects.toBeInstanceOf(BadRequestException)
    }
    expect(captured).toBeNull()
  })

  it('聚合桩行：rows 归一 + alerts 计算 + 告警打 [MPH][health] 日志', async () => {
    rawRows.push(
      { model: 'gemini-3.1-flash-like', status: 'failed', errorCode: 'upstream_error', balance402: 0, cnt: 6n, refunded: 6n },
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const res = await controller.health('24')
      expect(res.data.rows).toHaveLength(1)
      expect(res.data.rows[0]).toMatchObject({
        model: 'gemini-3.1-flash-like',
        channelId: 'platform',
        total: 6,
        completed: 0,
        failed: 6,
        refunded: 6,
      })
      expect(res.data.alerts.map((a: { rule: string }) => a.rule)).toContain('degraded')
      const healthLogs = logSpy.mock.calls.filter((args) => args.some((a) => String(a).includes('[MPH][health]')))
      expect(healthLogs).toHaveLength(1)
    } finally {
      logSpy.mockRestore()
    }
  })

  it('guard 集成：env 未设置时被拒（fail-closed，与 S1-1 同 guard）', async () => {
    delete process.env.LNKPI_ADMIN_TOKEN
    const moduleRef = await Test.createTestingModule({
      controllers: [ModelHealthAdminController],
      providers: [AdminTokenGuard, { provide: PrismaService, useValue: { $queryRawUnsafe: async () => [] } }],
    }).compile()
    const guard = moduleRef.get(AdminTokenGuard)
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer secret-token' } }) }),
    } as never
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
    expect(vi.isMockFunction(guard.canActivate)).toBe(false)
  })
})
