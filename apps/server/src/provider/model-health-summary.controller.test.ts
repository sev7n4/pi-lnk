import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { BadRequestException, UnauthorizedException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { JwtService } from '@nestjs/jwt'
import { AuthGuard } from '../auth/auth.guard'
import { ModelHealthSummaryController } from './model-health-summary.controller'
import { PrismaService } from '../prisma/prisma.service'
import type { RawHealthRow } from '@lnkpi/shared/modelHealth'

/**
 * S1-3 用户健康投影端点测试（A2）：
 * 401 未鉴权拒绝 / 200 信封形状 / BYOK 行只含本人 / admin 语义不泄露。
 */

describe('ModelHealthSummaryController（A2：GET /api/model-health/summary）', () => {
  function rawRow(overrides: Partial<RawHealthRow> & { model: string; status: string }): RawHealthRow {
    return { errorCode: null, balance402: 0, cnt: 1n, refunded: 0n, ...overrides }
  }

  async function setup(rawRows: RawHealthRow[]) {
    const prisma = {
      $queryRawUnsafe: async () => rawRows,
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [ModelHealthSummaryController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    })
      .useMocker((token) => {
        if (token === JwtService) return { verifyAsync: vi.fn() }
        return undefined
      })
      .compile()
    return moduleRef.get(ModelHealthSummaryController)
  }

  it('200 信封 {code:0, data:{generatedAt, windowHours, rows}}；空库 → 空行（初态）', async () => {
    const controller = await setup([])
    const res = await controller.summary({ user: { sub: 'u-me' } })
    expect(res.code).toBe(0)
    expect(res.message).toBe('ok')
    expect(new Date(res.data.generatedAt).toString()).not.toBe('Invalid Date')
    expect(res.data.windowHours).toBe(24)
    expect(res.data.rows).toEqual([])
  })

  it('BYOK 行只含本人：平台行 + u-me 行返回，u-other 行绝不出现', async () => {
    const controller = await setup([
      rawRow({ model: 'agnes-image-2.0-flash', status: 'completed', cnt: 3n }),
      rawRow({ model: 'u-me::deepseek-v4-pro', status: 'completed', cnt: 2n }),
      rawRow({ model: 'u-other::kling-v3', status: 'failed', errorCode: 'upstream_error', cnt: 5n }),
    ])
    const res = await controller.summary({ user: { sub: 'u-me' } })
    const keys = res.data.rows.map((r: { model: string; channelId: string }) => `${r.model}@${r.channelId}`)
    expect(keys.sort()).toEqual(['agnes-image-2.0-flash@platform', 'deepseek-v4-pro@u-me'])
    expect(JSON.stringify(res.data)).not.toContain('u-other')
  })

  it('admin 语义不泄露：无 alerts 字段，行内无 errorCodeCounts / balance402Count', async () => {
    const controller = await setup([
      rawRow({ model: 'm', status: 'failed', errorCode: 'model_unavailable', balance402: 1, cnt: 6n }),
    ])
    const res = await controller.summary({ user: { sub: 'u-me' } })
    expect(res.data).not.toHaveProperty('alerts')
    expect(res.data.rows[0]).not.toHaveProperty('errorCodeCounts')
    expect(res.data.rows[0]).not.toHaveProperty('balance402Count')
    expect(res.data.rows[0].successRate).toBe(0)
  })

  it('windowHours 白名单透传；越界（999/abc）→ 400', async () => {
    const controller = await setup([])
    const wide = await controller.summary({ user: { sub: 'u-me' } }, '168')
    expect(wide.data.windowHours).toBe(168)
    for (const bad of ['999', 'abc', '0', '1.5']) {
      await expect(controller.summary({ user: { sub: 'u-me' } }, bad)).rejects.toBeInstanceOf(
        BadRequestException,
      )
    }
  })

  it('AuthGuard：无 token / 非法 token → 401（UnauthorizedException）；合法 token 注入 user 并放行', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [AuthGuard, { provide: JwtService, useValue: { verifyAsync: vi.fn() } }],
    }).compile()
    const guard = moduleRef.get(AuthGuard)
    const jwt = moduleRef.get(JwtService)

    const ctxFor = (headers: Record<string, string>) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as never

    // 无 token → 401
    jwt.verifyAsync.mockReset()
    await expect(guard.canActivate(ctxFor({}))).rejects.toBeInstanceOf(UnauthorizedException)
    expect(jwt.verifyAsync).not.toHaveBeenCalled()

    // 非法 token → 401
    jwt.verifyAsync.mockReset()
    jwt.verifyAsync.mockRejectedValueOnce(new Error('jwt expired'))
    await expect(
      guard.canActivate(ctxFor({ authorization: 'Bearer bad-token' })),
    ).rejects.toBeInstanceOf(UnauthorizedException)

    // 合法 token → 放行并注入 user.sub（控制器据此过滤 BYOK 行）
    jwt.verifyAsync.mockReset()
    jwt.verifyAsync.mockResolvedValueOnce({ sub: 'u-me', phone: '17200000000' })
    await expect(
      guard.canActivate(ctxFor({ authorization: 'Bearer good-token' })),
    ).resolves.toBe(true)
  })
})
