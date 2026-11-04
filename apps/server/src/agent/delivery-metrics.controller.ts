import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { DELIVERY_EVENT_TYPES, deliveryMetrics, type DeliveryEventType } from './delivery-metrics'

/**
 * E2-a 交付摘要埋点端点（规格 §6）：POST /api/agent/metrics/delivery。
 * AuthGuard 门（用户态遥测，非公开元信息）；批量上限 50（超=客户端 bug，fail-closed）；
 * 非法 type 400 且不计数；进程内存计数经 GET /api/health/notify-metrics 的
 * deliveryCard 面暴露（health.controller 合并）。
 */
interface DeliveryEventBody {
  type?: string
  nodeId?: string
  kind?: string
  ts?: number
}

@Controller('agent/metrics/delivery')
@UseGuards(AuthGuard)
export class DeliveryMetricsController {
  @Post()
  record(@Body() body: { events?: DeliveryEventBody[] }): { ok: true; recorded: number } {
    const events = body?.events
    if (!Array.isArray(events) || events.length === 0) {
      throw new BadRequestException('events required')
    }
    if (events.length > 50) {
      throw new BadRequestException('events batch limit 50')
    }
    let recorded = 0
    for (const e of events) {
      const type = e?.type
      if (typeof type !== 'string' || !(DELIVERY_EVENT_TYPES as readonly string[]).includes(type)) {
        throw new BadRequestException(`unknown event type: ${String(type)}`)
      }
      deliveryMetrics.record(type as DeliveryEventType)
      recorded += 1
    }
    return { ok: true, recorded }
  }
}
