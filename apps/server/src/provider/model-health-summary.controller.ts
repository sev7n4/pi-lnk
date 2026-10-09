import { BadRequestException, Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common'
import {
  buildHealthSql,
  isModelHealthWindowHours,
  MODEL_HEALTH_WINDOW_HOURS,
  rowsToHealth,
  toUserHealthRows,
} from '@lnkpi/shared/modelHealth'
import { AuthGuard } from '../auth/auth.guard'
import { PrismaService } from '../prisma/prisma.service'

/**
 * S1-3 用户健康投影端点（spec 2026-10-09-mph-s13 §3.1）：
 * `GET /api/model-health/summary?windowHours=24`。
 *
 * - 普通用户鉴权（AuthGuard，与 provider.controller 同 guard），⛔ 非 admin、
 *   不经 AdminTokenGuard，也绝不下发 admin 语义（alerts / errorCodeCounts /
 *   balance402Count 均不出现在响应里）。
 * - 复用 S1-2 聚合（buildHealthSql + rowsToHealth），再按当前用户投影：
 *   平台行全量 + 本人 BYOK 行（channelId=userId 前缀），绝不回他人 BYOK 行
 *   （toUserHealthRows，shared 纯函数）。
 * - 响应 `{code, message, data: {generatedAt, windowHours, rows}}`（同信封）。
 * - 缓存裁决（controller ruling，2026-10-10）：5 分钟缓存做在**前端客户端**
 *   （apps/web/src/composables/useModelHealth.ts 模块级时间戳缓存），服务端
 *   不做缓存（brief 4.1 原文的服务端内存 Map 缓存按裁决豁免）。
 * - 无任何记录时返回 200 + 空行（与 S1-2 admin 端点同初态语义）。
 */
@Controller('model-health')
export class ModelHealthSummaryController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get('summary')
  @UseGuards(AuthGuard)
  async summary(
    @Req() req: { user: { sub: string } },
    @Query('windowHours') windowHoursRaw?: string,
  ) {
    const windowHours =
      windowHoursRaw === undefined || windowHoursRaw === '' ? 24 : Number(windowHoursRaw)
    if (!isModelHealthWindowHours(windowHours)) {
      throw new BadRequestException(
        `windowHours 必须是白名单值 ${MODEL_HEALTH_WINDOW_HOURS.join('/')}，收到: ${String(windowHoursRaw)}`,
      )
    }
    const { sql, params } = buildHealthSql(windowHours)
    const rawRows = (await this.prisma.$queryRawUnsafe(sql, ...params)) as Parameters<
      typeof rowsToHealth
    >[0]
    const rows = toUserHealthRows(rowsToHealth(rawRows, windowHours), req.user.sub)
    return { code: 0, message: 'ok', data: { generatedAt: new Date().toISOString(), windowHours, rows } }
  }
}
