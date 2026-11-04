import { Controller, Get } from '@nestjs/common'
import { deliveryMetrics } from '../agent/delivery-metrics'
import { notifyMetrics } from '../studio/notify-metrics'
import { isTerminalWriteTapEnabled } from '../prisma/prisma.module'

@Controller('health')
export class HealthController {
  @Get()
  getHealth() {
    return {
      ok: true,
      service: 'lnkpi-api',
      timestamp: new Date().toISOString(),
    }
  }

  /**
   * E1 度量端点（G-1）：暴露「已通报记录数」口径的终态通报计数。
   * 与 generation-reaper 的 notifyMetrics 同实例（模块级单例）。
   * terminalWriteTap 关闭时 intercepted 事件不注入 ⇒ notified 恒为 0。
   */
  @Get('notify-metrics')
  getNotifyMetrics() {
    return {
      ok: true,
      terminalWriteTapEnabled: isTerminalWriteTapEnabled(),
      metrics: notifyMetrics.snapshot(),
      deliveryCard: deliveryMetrics.snapshot(),
      timestamp: new Date().toISOString(),
    }
  }
}
