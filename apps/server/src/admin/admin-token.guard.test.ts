import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExecutionContext, UnauthorizedException } from '@nestjs/common'
import { AdminTokenGuard } from './admin-token.guard'

function contextWithAuthorization(header?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: header === undefined ? {} : { authorization: header },
      }),
    }),
  } as unknown as ExecutionContext
}

describe('AdminTokenGuard（Ruling B：Bearer LNKPI_ADMIN_TOKEN）', () => {
  const originalToken = process.env.LNKPI_ADMIN_TOKEN

  afterEach(() => {
    if (originalToken === undefined) delete process.env.LNKPI_ADMIN_TOKEN
    else process.env.LNKPI_ADMIN_TOKEN = originalToken
  })

  it('env 未设置时恒 401（fail-closed，即使带了任何 Bearer）', () => {
    delete process.env.LNKPI_ADMIN_TOKEN
    const guard = new AdminTokenGuard()
    expect(() => guard.canActivate(contextWithAuthorization('Bearer anything'))).toThrow(
      UnauthorizedException,
    )
    expect(() => guard.canActivate(contextWithAuthorization())).toThrow(UnauthorizedException)
  })

  it('env 为空白字符串同样 401（fail-closed）', () => {
    process.env.LNKPI_ADMIN_TOKEN = '   '
    const guard = new AdminTokenGuard()
    expect(() => guard.canActivate(contextWithAuthorization('Bearer '))).toThrow(
      UnauthorizedException,
    )
  })

  it('无 Authorization 头 → 401', () => {
    process.env.LNKPI_ADMIN_TOKEN = 'secret-token'
    const guard = new AdminTokenGuard()
    expect(() => guard.canActivate(contextWithAuthorization())).toThrow(UnauthorizedException)
  })

  it('Bearer 之外 的 scheme → 401', () => {
    process.env.LNKPI_ADMIN_TOKEN = 'secret-token'
    const guard = new AdminTokenGuard()
    expect(() => guard.canActivate(contextWithAuthorization('Basic secret-token'))).toThrow(
      UnauthorizedException,
    )
  })

  it('token 不匹配 → 401', () => {
    process.env.LNKPI_ADMIN_TOKEN = 'secret-token'
    const guard = new AdminTokenGuard()
    expect(() => guard.canActivate(contextWithAuthorization('Bearer wrong-token'))).toThrow(
      UnauthorizedException,
    )
  })

  it('正确的 Bearer token → 放行', () => {
    process.env.LNKPI_ADMIN_TOKEN = 'secret-token'
    const guard = new AdminTokenGuard()
    expect(guard.canActivate(contextWithAuthorization('Bearer secret-token'))).toBe(true)
  })
})
