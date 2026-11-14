// apps/server/src/admin/pricing-materialize.controller.ts
import { BadRequestException, Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { AdminTokenGuard } from './admin-token.guard'
import { PricingMaterializerService } from '../pricing/pricing-materializer.service'
import { PricingPublishingService } from '../pricing/pricing-publishing.service'
import type { SubjectRow } from '../pricing/pricing-subject.service'
import type { UnitCostRateRow } from '../pricing/pricing-unit-cost'
import type { MarginRow } from '../pricing/pricing-margin.service'

/**
 * S1：物化与就绪度端点（ops-console 消费）。
 *
 * - 前缀 /api/admin/pricing/versions，与发布流同前缀（PricingPublishingController 已占该前缀，
 *   本控制器以更具体的路由挂在同前缀下，Nest 按路径匹配，不冲突）。
 * - `POST /:id/materialize`：以 PricingSubject 主体为遍历真源，拉成本行 + 利润行后调
 *   PricingMaterializerService.materialize，落草案价目表（指标在该服务内接线）。
 * - `GET /:id/readiness`：返回 validatePublish 的结构化 verdict（发布门禁七条硬拒预览），
 *   供前端发布前展示缺成本主体 / 计量未对齐 / 地板违规等清单。
 */

@Controller('admin/pricing/versions')
export class PricingMaterializeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly materializer: PricingMaterializerService,
    private readonly publishing: PricingPublishingService,
  ) {}

  @Post(':id/materialize')
  @UseGuards(AdminTokenGuard)
  async materialize(@Param('id') id: string) {
    const draft = await this.prisma.priceListVersion.findUnique({ where: { id } })
    if (!draft) throw new NotFoundException(`价目表版本不存在: ${id}`)
    if (draft.status !== 'draft') {
      throw new BadRequestException(`仅 draft 版本可物化（当前 ${draft.status}）`)
    }
    const subjects = await this.prisma.pricingSubject.findMany()
    const costRates = await this.prisma.costRate.findMany()
    const marginRows = await this.prisma.marginPolicy.findMany()

    const subjRows: SubjectRow[] = subjects.map((s) => ({
      subjectKey: s.subjectKey,
      capability: s.capability,
      modelKey: s.modelKey,
      spec: s.spec,
      provider: s.provider,
      upstream: s.upstream,
      channelId: s.channelId,
      status: s.status,
      billableUnit: s.billableUnit,
      unitsPerRequest: s.unitsPerRequest,
      source: s.source,
    }))
    const costRows: UnitCostRateRow[] = costRates.map((r) => ({
      id: r.id,
      channel: r.channel,
      modelKey: r.modelKey,
      spec: r.spec,
      unit: r.unit,
      unitQuantity: r.unitQuantity,
      costYuan: r.costYuan,
      source: r.source,
      provisional: r.provisional,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
    }))
    const mRows: MarginRow[] = marginRows.map((m) => ({
      id: m.id,
      scope: m.scope ?? 'global',
      scopeKey: m.scopeKey,
      profitBp: m.profitBp ?? 1000,
      priceFloorBp: m.priceFloorBp ?? 500,
      effectiveFrom: m.effectiveFrom,
      effectiveTo: m.effectiveTo,
      status: m.status ?? 'active',
    }))

    const result = await this.materializer.materialize(id, subjRows, costRows, mRows, new Date())
    return { code: 0, message: 'ok', data: result }
  }

  @Get(':id/readiness')
  @UseGuards(AdminTokenGuard)
  async readiness(@Param('id') id: string) {
    const verdict = await this.publishing.validatePublish(id)
    return { code: 0, message: 'ok', data: verdict }
  }
}
