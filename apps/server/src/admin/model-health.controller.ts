import { BadRequestException, Controller, Get, Inject, Query, UseGuards } from '@nestjs/common'
import {
  buildHealthSql,
  flagHealthAnomalies,
  isModelHealthWindowHours,
  MODEL_HEALTH_WINDOW_HOURS,
  rowsToHealth,
  type RawHealthRow,
} from '@lnkpi/shared/modelHealth'
import { PrismaService } from '../prisma/prisma.service'
import { AdminTokenGuard } from './admin-token.guard'

/**
 * S1-2 模型健康端点（spec §3.2）：`GET /api/admin/model-health?windowHours=24`。
 *
 * - AdminTokenGuard（fail-closed，与 S1-1 同一 guard）。
 * - windowHours ∈ {1,6,24,168} 白名单（spec §5 注入防线），缺失默认 24，越界 400；
 *   SQL 侧 buildHealthSql 再兜底抛错，参数（cutoff 整数毫秒）经 $queryRawUnsafe 绑定。
 * - 响应 `{code, message, data: {generatedAt, rows, alerts}}`（与 S1-1 同信封）。
 * - 告警首版落点：随端点返回 + `[MPH][health]` 结构化日志（spec §3.3；
 *   ⛔ B1 不做定时/尾巴调用——运维 curl 端点即可，runbook 记录）。
 * - 无任何记录时返回 200 + 空行/空告警（「还没有数据」是部署初态，不用 404）。
 */
@Controller('admin/model-health')
export class ModelHealthAdminController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  @UseGuards(AdminTokenGuard)
  async health(@Query('windowHours') windowHoursRaw?: string) {
    const windowHours = windowHoursRaw === undefined || windowHoursRaw === '' ? 24 : Number(windowHoursRaw)
    if (!isModelHealthWindowHours(windowHours)) {
      throw new BadRequestException(
        `windowHours 必须是白名单值 ${MODEL_HEALTH_WINDOW_HOURS.join('/')}，收到: ${String(windowHoursRaw)}`,
      )
    }
    const { sql, params } = buildHealthSql(windowHours)
    const rawRows = (await this.prisma.$queryRawUnsafe(sql, ...params)) as RawHealthRow[]
    const rows = rowsToHealth(rawRows, windowHours)
    const alerts = flagHealthAnomalies(rows)
    if (alerts.length > 0) {
      console.log(`[MPH][health] ${JSON.stringify(alerts)}`)
    }
    return { code: 0, message: 'ok', data: { generatedAt: new Date().toISOString(), rows, alerts } }
  }
}
