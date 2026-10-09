import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { Request } from 'express'

/**
 * S1-1 admin 端点鉴权（Ruling B / spec 2026-10-09-mph-s11 §3.4 修订）：
 * 仓库没有 admin 角色/用户体系，实现为共享密钥 —— `Authorization: Bearer ${LNKPI_ADMIN_TOKEN}`。
 *
 * ⛔ fail-closed：`LNKPI_ADMIN_TOKEN` 未设置（或为空白）时**恒 401**，绝不放行——
 * 这比「无密钥 = 无鉴权」安全：运维忘了配 env 时端点是拒绝服务而不是裸奔。
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.LNKPI_ADMIN_TOKEN?.trim()
    if (!expected) throw new UnauthorizedException()

    const request = context.switchToHttp().getRequest<Request>()
    const [type, token] = request.headers.authorization?.split(' ') ?? []
    if (type !== 'Bearer' || !token || token !== expected) {
      throw new UnauthorizedException()
    }
    return true
  }
}
