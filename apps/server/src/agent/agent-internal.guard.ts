import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'

/**
 * `/agent/internal/*` 的服务间鉴权（pi-runtime → Nest 画布工具）。
 *
 * ⚠️ 这个 token **不是**老 LangGraph runtime 的专属配置：老 runtime 退役后，
 * `/agent/internal/*` 仍是 pi-runtime 工具（`tools/nest-client.ts`）调 Nest 的唯一通道，
 * 删掉 `AGENT_RUNTIME_SERVICE_TOKEN` 会让所有画布读写工具 401。
 * 变量名里的 AGENT_RUNTIME 只是历史命名，故新增中性名 `LNKPI_INTERNAL_SERVICE_TOKEN`
 * 并保留旧名兜底，便于后续无中断迁移。
 */
@Injectable()
export class AgentInternalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected =
      process.env.LNKPI_INTERNAL_SERVICE_TOKEN?.trim() ||
      process.env.AGENT_RUNTIME_SERVICE_TOKEN?.trim()
    if (!expected) {
      throw new UnauthorizedException(
        'LNKPI_INTERNAL_SERVICE_TOKEN (or AGENT_RUNTIME_SERVICE_TOKEN) is not configured',
      )
    }

    const request = context.switchToHttp().getRequest<Request>()
    const token = request.headers['x-lnkpi-service-token']
    const provided = Array.isArray(token) ? token[0] : token
    if (!provided || provided !== expected) {
      throw new UnauthorizedException('Invalid service token')
    }
    return true
  }
}
