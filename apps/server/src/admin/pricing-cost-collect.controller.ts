// apps/server/src/admin/pricing-cost-collect.controller.ts
import { Body, Controller, Post, UseGuards } from '@nestjs/common'
import { AdminTokenGuard } from './admin-token.guard'
import { CostCollectService } from '../pricing/cost-collect.service'

/**
 * 成本自动采集端点（spec: docs/design/2026-11-15-cost-auto-collect-design.md §2/D4）：
 *
 * - POST run：`{dryRun?: boolean, upstreams?: string[]}`。
 *   dryRun=true（缺省）只回「将写入的行 + 来源 + 凭证」预览，不落库——
 *   定价中心「同步上游价目」按钮先预览，人工确认后再 dryRun=false 真正写入。
 * - fail-soft：单适配器失败在 report.adapters[].error 里，不影响其它上游。
 */
@Controller('admin/pricing/cost-collect')
export class PricingCostCollectController {
  constructor(private readonly collector: CostCollectService) {}

  @Post('run')
  @UseGuards(AdminTokenGuard)
  async run(@Body() body: Record<string, unknown>): Promise<{ code: number; message: string; data: unknown }> {
    const dryRun = body['dryRun'] === undefined ? true : body['dryRun'] === true
    const upstreams = Array.isArray(body['upstreams']) ? (body['upstreams'] as unknown[]).filter((u): u is string => typeof u === 'string') : undefined
    const report = await this.collector.run({ dryRun, upstreams })
    return { code: 0, message: 'ok', data: report }
  }
}
