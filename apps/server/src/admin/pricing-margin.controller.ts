// apps/server/src/admin/pricing-margin.controller.ts
import { BadRequestException, Body, Controller, Get, Put, UseGuards } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { AdminTokenGuard } from './admin-token.guard'
import { phaseOf } from '../pricing/pricing-margin.service'
import { optionalDate, optionalString, requireNonEmptyString, requireNumber } from './admin-body-parse'

/**
 * S1：利润层 `MarginPolicy` 后台登记端点（ops-console 消费）。
 *
 * - 前缀 /api/admin/pricing/margin-policies，挂 AdminTokenGuard（fail-closed）。
 * - `phase` 由服务端 `phaseOf(scope, scopeKey)` 生成（global 恒 'launch'，其余
 *   `scope:${scope}:${scopeKey}`），是唯一键——同 scope+scopeKey 只一条策略，upsert 复用。
 * - 守卫：priceFloorBp 不得高于 profitBp（利润率不可击穿地板）。
 */

const MARGIN_STATUSES = ['active', 'draft', 'disabled'] as const

function parseMarginBody(body: Record<string, unknown>) {
  const scope = requireNonEmptyString(body['scope'], 'scope')
  const scopeKey = optionalString(body['scopeKey'], 'scopeKey')
  const profitBp = requireNumber(body['profitBp'], 'profitBp')
  const priceFloorBp = body['priceFloorBp'] === undefined ? 500 : requireNumber(body['priceFloorBp'], 'priceFloorBp')
  if (priceFloorBp > profitBp) {
    throw new BadRequestException(`priceFloorBp(${priceFloorBp}) 不得超过 profitBp(${profitBp})：利润率不可击穿地板`)
  }
  const status = body['status'] === undefined ? 'active' : requireNonEmptyString(body['status'], 'status')
  if (!MARGIN_STATUSES.includes(status as (typeof MARGIN_STATUSES)[number])) {
    throw new BadRequestException(`status 取值不在 ${MARGIN_STATUSES.join('/')}`)
  }
  const effectiveFrom = optionalDate(body['effectiveFrom'], 'effectiveFrom')
  const effectiveTo = optionalDate(body['effectiveTo'], 'effectiveTo')
  const phase = phaseOf(scope, scopeKey)
  return {
    phase,
    scope,
    scopeKey,
    profitBp,
    priceFloorBp,
    status,
    effectiveFrom,
    effectiveTo,
  }
}

@Controller('admin/pricing/margin-policies')
export class PricingMarginController {
  constructor(private readonly prisma: PrismaService) {}

  @Put()
  @UseGuards(AdminTokenGuard)
  async upsert(@Body() body: Record<string, unknown>) {
    const m = parseMarginBody(body)
    const { phase, ...mutable } = m
    await this.prisma.marginPolicy.upsert({
      where: { phase },
      create: { ...m },
      update: { ...mutable },
    })
    return { code: 0, message: 'ok', data: { phase: m.phase } }
  }

  /** 供验收/调试：返回当前全部策略行（不含 costRate，纯利润配置）。 */
  @Get()
  @UseGuards(AdminTokenGuard)
  async list() {
    const rows = (await this.prisma.marginPolicy.findMany()).map((r) => ({
      id: r.id,
      scope: r.scope ?? 'global',
      scopeKey: r.scopeKey,
      profitBp: r.profitBp ?? 1000,
      priceFloorBp: r.priceFloorBp ?? 500,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      status: r.status ?? 'active',
    }))
    return { code: 0, message: 'ok', data: rows }
  }
}
