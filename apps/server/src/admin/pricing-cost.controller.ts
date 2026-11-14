// apps/server/src/admin/pricing-cost.controller.ts
import { BadRequestException, Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common'
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

  /**
   * 一键导入成本（极简控制台消费）：只收 `modelKey / spec / costYuan` + 可选 `provisional / source`，
   * 由匹配到的 `PricingSubject` 自动推断 `unit / unitQuantity`（运维无需懂计量单位黑话）。
   * 同 (channel='platform', modelKey, spec) upsert；逐行返回成功 / 失败原因。
   */
  @Post('import')
  @UseGuards(AdminTokenGuard)
  async importCostRates(@Body() body: Record<string, unknown>) {
    const rows = body['rows']
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('rows 必须是非空数组')
    }
    const results: Array<{ modelKey: string; spec: string; ok: boolean; message?: string }> = []
    for (const raw of rows as Record<string, unknown>[]) {
      let rejected = false
      for (const k of FORBIDDEN_COST_FIELDS) {
        if (k in raw) {
          results.push({ modelKey: String(raw['modelKey'] ?? ''), spec: String(raw['spec'] ?? ''), ok: false, message: `拒绝字段 ${k}（一律人民币 D9）` })
          rejected = true
          break
        }
      }
      if (rejected) continue
      const modelKey = typeof raw['modelKey'] === 'string' ? raw['modelKey'].trim() : ''
      const spec = typeof raw['spec'] === 'string' ? raw['spec'].trim() : ''
      const costYuan = typeof raw['costYuan'] === 'number' ? raw['costYuan'] : Number(raw['costYuan'])
      if (!modelKey || !spec) {
        results.push({ modelKey, spec, ok: false, message: 'modelKey / spec 为必填' })
        continue
      }
      if (!Number.isFinite(costYuan) || costYuan < 0) {
        results.push({ modelKey, spec, ok: false, message: 'costYuan 必须是非负人民币元金额' })
        continue
      }
      try {
        const inferred = await this.inferCostUnit(modelKey, spec)
        const provisional = raw['provisional'] === true
        const source = (typeof raw['source'] === 'string' ? raw['source'] : 'official_list') as string
        if (!COST_SOURCES.includes(source as (typeof COST_SOURCES)[number])) {
          results.push({ modelKey, spec, ok: false, message: `source 取值不在 ${COST_SOURCES.join('/')}` })
          continue
        }
        await this.prisma.costRate.upsert({
          where: { channel_modelKey_spec: { channel: 'platform', modelKey, spec: inferred.spec } },
          create: { channel: 'platform', modelKey, spec: inferred.spec, unit: inferred.unit, costYuan, unitQuantity: inferred.unitQuantity, source, provisional },
          update: { unit: inferred.unit, costYuan, unitQuantity: inferred.unitQuantity, source, provisional },
        })
        results.push({ modelKey, spec, ok: true })
      } catch (err) {
        results.push({ modelKey, spec, ok: false, message: err instanceof Error ? err.message : '导入失败' })
      }
    }
    const imported = results.filter((r) => r.ok).length
    const failed = results.length - imported
    return { code: failed > 0 ? 1 : 0, message: `导入 ${imported} 条${failed > 0 ? `，${failed} 条失败` : ''}`, data: { imported, failed, results } }
  }

  /** 由匹配到的主体推断成本单位（极简导入：运维只填 模型+档位+金额）。 */
  private async inferCostUnit(modelKey: string, spec: string): Promise<{ unit: string; spec: string; unitQuantity: number }> {
    const subject = await this.prisma.pricingSubject.findFirst({ where: { modelKey, spec } })
    if (!subject) {
      throw new Error(`未找到定价主体 ${modelKey}/${spec}：请确认 modelKey 与档位与「定价主体」页一致`)
    }
    switch (subject.billableUnit) {
      case 'image_count': {
        const r = spec.split(':')[0]
        // image_edit / image_variant 主体 spec 为 "*"，落到 1K 锚点，与 resolveUnitCost 一致。
        return { unit: 'per_image', spec: r === '*' || r === '' ? '1K' : r, unitQuantity: 1 }
      }
      case 'video_call':
        return { unit: 'per_video', spec, unitQuantity: 1 }
      case 'video_second':
        return { unit: 'per_second', spec, unitQuantity: 1 }
      case 'chars_100':
        return { unit: 'per_call', spec: 'per_100_chars', unitQuantity: 100 }
      case 'song':
        return { unit: 'per_call', spec: 'per_song', unitQuantity: 1 }
      case 'token_in':
      case 'token_out':
      case 'token_cache':
        return { unit: 'per_1m_tokens', spec: `per_1m_tokens_${spec}`, unitQuantity: 1e6 }
      default:
        throw new Error(`未知计量单位 ${subject.billableUnit}（主体 ${modelKey}/${spec}）`)
    }
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
