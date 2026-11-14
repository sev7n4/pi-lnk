// apps/server/src/admin/pricing-cost.controller.ts
import { BadRequestException, Body, Controller, Get, Put, UseGuards } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { AdminTokenGuard } from './admin-token.guard'
import { optionalDate, optionalString, requireNonEmptyString, requireNumber } from './admin-body-parse'

/**
 * S1：成本层 `CostRate` 后台登记端点（ops-console 消费）。
 *
 * - 前缀 /api/admin/pricing/cost-rates，挂 AdminTokenGuard（fail-closed）。
 * - AC10（单一人民币 D9）：**拒绝任何币种 / 汇率字段**——成本一律人民币元录入，运行时零
 *   汇率列；若有人提交 currency/currencySrc/fxRate/fxUsdCny/costUsd/usdPerM 直接 400。
 * - 业务语义：upsert by `(channel, modelKey, spec)` 唯一（同渠道同模型同档位只一条价）。
 */

// AC10：成本登记永不接受这些字段（D9 折算已移到录入侧，绑 sourceRef 结算凭据）。
const FORBIDDEN_COST_FIELDS = ['currency', 'currencySrc', 'fxRate', 'fxUsdCny', 'costUsd', 'usdPerM']

const COST_SOURCES = ['official_list', 'negotiated', 'channel_actual', 'provisional'] as const
const COST_UNITS = ['per_image', 'per_video', 'per_call', 'per_1m_tokens', 'per_second'] as const

function parseCostRateBody(body: Record<string, unknown>) {
  for (const k of FORBIDDEN_COST_FIELDS) {
    if (k in body) {
      throw new BadRequestException(`成本登记不接受字段 ${k}：一律人民币（D9），折算已移到录入侧`)
    }
  }
  const channel = requireNonEmptyString(body['channel'], 'channel')
  const modelKey = requireNonEmptyString(body['modelKey'], 'modelKey')
  const spec = requireNonEmptyString(body['spec'], 'spec')
  const unit = requireNonEmptyString(body['unit'], 'unit')
  if (!COST_UNITS.includes(unit as (typeof COST_UNITS)[number])) {
    throw new BadRequestException(`unit 取值不在 ${COST_UNITS.join('/')}`)
  }
  const costYuan = requireNumber(body['costYuan'], 'costYuan')
  if (costYuan < 0) {
    throw new BadRequestException('costYuan 必须是非负人民币元金额')
  }
  const unitQuantity = body['unitQuantity'] === undefined ? 1 : requireNumber(body['unitQuantity'], 'unitQuantity')
  if (unitQuantity <= 0) {
    throw new BadRequestException('unitQuantity 必须为正数')
  }
  const source = body['source'] === undefined ? 'official_list' : requireNonEmptyString(body['source'], 'source')
  if (!COST_SOURCES.includes(source as (typeof COST_SOURCES)[number])) {
    throw new BadRequestException(`source 取值不在 D5 四级枚举内（${COST_SOURCES.join('/')}）`)
  }
  const provider = optionalString(body['provider'], 'provider')
  const upstream = optionalString(body['upstream'], 'upstream')
  const sourceRef = optionalString(body['sourceRef'], 'sourceRef')
  const provisional = body['provisional'] === undefined ? false : typeof body['provisional'] === 'boolean' ? body['provisional'] : false
  const effectiveFrom = optionalDate(body['effectiveFrom'], 'effectiveFrom')
  const effectiveTo = optionalDate(body['effectiveTo'], 'effectiveTo')
  return {
    channel,
    modelKey,
    spec,
    unit,
    costYuan,
    unitQuantity,
    source,
    provider,
    upstream,
    sourceRef,
    provisional,
    effectiveFrom,
    effectiveTo,
  }
}

@Controller('admin/pricing/cost-rates')
export class PricingCostController {
  constructor(private readonly prisma: PrismaService) {}

  @Put()
  @UseGuards(AdminTokenGuard)
  async upsert(@Body() body: Record<string, unknown>) {
    const c = parseCostRateBody(body)
    const { channel, modelKey, spec, ...mutable } = c
    await this.prisma.costRate.upsert({
      where: { channel_modelKey_spec: { channel, modelKey, spec } },
      create: { ...c },
      update: { ...mutable },
    })
    return { code: 0, message: 'ok', data: { channel, modelKey, spec } }
  }

  /** 供运维页展示：返回全部成本行（单一人民币，无币种/汇率字段）。 */
  @Get()
  @UseGuards(AdminTokenGuard)
  async list() {
    const rows = await this.prisma.costRate.findMany({ orderBy: [{ channel: 'asc' }, { modelKey: 'asc' }, { spec: 'asc' }] })
    return {
      code: 0,
      message: 'ok',
      data: rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        modelKey: r.modelKey,
        spec: r.spec,
        unit: r.unit,
        costYuan: r.costYuan,
        source: r.source,
        provider: r.provider,
        upstream: r.upstream,
        unitQuantity: r.unitQuantity,
        effectiveFrom: r.effectiveFrom ? r.effectiveFrom.toISOString() : null,
        effectiveTo: r.effectiveTo ? r.effectiveTo.toISOString() : null,
        sourceRef: r.sourceRef,
        provisional: r.provisional,
        createdAt: r.createdAt.toISOString(),
      })),
    }
  }
}
