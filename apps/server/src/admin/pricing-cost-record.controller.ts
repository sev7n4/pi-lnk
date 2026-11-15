// apps/server/src/admin/pricing-cost-record.controller.ts
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Put, UseGuards } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { AdminTokenGuard } from './admin-token.guard'
import { phaseOf } from '../pricing/pricing-margin.service'
import { resolveUnitCost } from '../pricing/pricing-unit-cost'
import { videoPriceFamily } from '../pricing/pricing.core'
import { ENUMERATED_IMAGE_RESOLUTIONS, ENUMERATED_VIDEO_RESOLUTIONS_CANONICAL } from '../pricing/pricing.space'
import { FORBIDDEN_COST_FIELDS } from './pricing-cost-shared'

/**
 * 定价中心聚合端点（spec: docs/design/2026-11-15-pricing-console-redesign.md §4）：
 *
 * - 一个 渠道×模型 = 一条成本记录（R1/R2）：GET 聚合每个**在售**目录条目为一条记录，
 *   下架模型天然不出现；PUT 只接受在售 modelKey —— 定价中心无增删入口，只改数值（R3）。
 * - 视频成本按 D-2 粗化：卡片填「元/秒」，落 per_second 行（spec=分辨率）；保存时顺带
 *   退役同族同分辨率的 legacy per_video 行（effectiveTo=now 留底不删）——逐次编辑即自迁移。
 * - 利润自持（D-1/R4）：每模型一条 `MarginPolicy(scope='model', scopeKey=modelKey)`；
 *   引擎 resolveMargin 不改（model 档优先于 global 是既有行为），UI 不暴露 global。
 * - AC10（单一人民币 D9）：拒绝 currency/fx 等字段，与 pricing-cost.controller 同一守卫。
 */

const NOW = () => new Date()

function effective(row: { effectiveFrom: Date | null; effectiveTo: null | Date }, at: Date): boolean {
  if (row.effectiveFrom && row.effectiveFrom > at) return false
  if (row.effectiveTo && row.effectiveTo <= at) return false
  return true
}

/** 成本行最小形状（GET 聚合 / 迁移共用）。 */
export interface CostRecordRateRow {
  id: string
  channel: string
  modelKey: string
  spec: string
  unit: string
  unitQuantity: number
  costYuan: number
  source: string
  provisional: boolean
  effectiveFrom: Date | null
  effectiveTo: Date | null
}

export interface CostRecordTier {
  spec: string
  label: string
  unit: string
  unitQuantity: number
  costYuan: number | null
  /** legacy per_video 行折算的每秒参考值（仅展示预填，不落存储）。 */
  perVideoDerived: number | null
  /**
   * 物化后扣费积分（P1.6 · spec 2026-11-15-pricing-subject-billing-takeover）：
   * 读 active 价目表（无则最新 draft）的主体行/文本反比率行 credits——物化了什么就
   * 显示什么，服务端不重算公式。无物化条目为 null（前端显示「—」）。
   * 口径：video=null（按秒无单一值，见 creditsByDuration）；audio voice/design=每百字符、
   * music=每首；image=每张；text=每百万 token（反比率行 = 实际结算口径）。
   */
  materializedCredits: number | null
  /** 仅视频档：按时长枚举的物化积分（spec=`<res>:<dur>s` 的主体行）。 */
  creditsByDuration: { duration: number; credits: number }[] | null
}

export interface CostRecordDto {
  modelKey: string
  displayName: string
  modality: string
  audioKind: string | null
  channel: string
  profitPct: number | null
  tiers: CostRecordTier[]
  subjectsTotal: number
  missingSpecs: string[]
  status: 'ready' | 'partial' | 'missing'
  /** 物化积分取数来源版本（active 优先，无 active 取最新 draft）；无任何版本为 null。 */
  materializedVersion: string | null
}

/** 音频档位 → 成本行 spec 映射（与 inferCostUnit 口径一致）。 */
const AUDIO_TIER_SPEC: Record<string, { rowSpec: string; unit: string; unitQuantity: number; label: string }> = {
  voice: { rowSpec: 'per_100_chars', unit: 'per_call', unitQuantity: 100, label: '语音（元/百字符）' },
  design: { rowSpec: 'per_100_chars', unit: 'per_call', unitQuantity: 100, label: '音频设计（元/百字符）' },
  music: { rowSpec: 'per_song', unit: 'per_call', unitQuantity: 1, label: '音乐（元/首）' },
}

const TEXT_TIERS: { spec: string; rowSpec: string; label: string }[] = [
  { spec: 'in', rowSpec: 'per_1m_tokens_in', label: '输入（元/百万 token）' },
  { spec: 'out', rowSpec: 'per_1m_tokens_out', label: '输出（元/百万 token）' },
  { spec: 'cache', rowSpec: 'per_1m_tokens_cache', label: '缓存（元/百万 token）' },
]

/** 档位行匹配：per_second / per_image / per_1m_tokens 均为 模型+spec 精确；音频 per_call 也按模型精确。
 *  D1：official_list / channel_actual 来源的显式 0 价（免费模型）视为已填。 */
function tierCostYuan(rows: CostRecordRateRow[], modelKey: string, rowSpec: string, at: Date): number | null {
  const hit = rows
    .filter((r) => {
      if (r.modelKey !== modelKey || r.spec !== rowSpec || r.provisional || !effective(r, at)) return false
      if (r.costYuan > 0) return true
      return r.costYuan === 0 && (r.source === 'official_list' || r.source === 'channel_actual')
    })
    .sort((a, b) => (b.effectiveFrom?.getTime() ?? 0) - (a.effectiveFrom?.getTime() ?? 0))[0]
  return hit ? hit.costYuan : null
}

@Controller('admin/pricing/cost-records')
export class PricingCostRecordController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @UseGuards(AdminTokenGuard)
  async list(): Promise<{ code: number; message: string; data: CostRecordDto[] }> {
    const at = NOW()
    const [entries, subjects, rates, margins] = await Promise.all([
      this.prisma.modelCatalogEntry.findMany({ where: { deletedAt: null }, orderBy: [{ modality: 'asc' }, { modelKey: 'asc' }] }),
      this.prisma.pricingSubject.findMany(),
      this.prisma.costRate.findMany(),
      this.prisma.marginPolicy.findMany({ where: { scope: 'model' } }),
    ])
    // P1.6 物化积分来源：active 优先（扣费真源），无 active 取最新 draft（发布前预览）。
    let priceVersion = await this.prisma.priceListVersion.findFirst({
      where: { status: 'active' },
      include: { entries: true },
    })
    if (!priceVersion) {
      priceVersion = await this.prisma.priceListVersion.findFirst({
        where: { status: 'draft' },
        orderBy: { createdAt: 'desc' },
        include: { entries: true },
      })
    }
    // 主体行索引：三段前缀（capability|modelKey|spec）→ credits——档位聚合不知道
    // provider/upstream（渠道绑定在目录层），按前缀取该模型该档第一行；video 的
    // creditsByDuration 与 image/audio 的 materializedCredits 同源消费此索引。
    // 文本反比率行（matchKey `text:<model>:<spec>`，实际结算口径）单独索引。
    const subjectCreditsByTier = new Map<string, number>()
    const textTokenCredits = new Map<string, number>()
    for (const e of priceVersion?.entries ?? []) {
      if (e.subjectKey) {
        const prefix = e.subjectKey.split('|').slice(0, 3).join('|')
        if (!subjectCreditsByTier.has(prefix)) subjectCreditsByTier.set(prefix, e.credits)
      } else if (e.matchKey.startsWith('text:') && !e.matchKey.includes('|')) {
        const rest = e.matchKey.slice('text:'.length)
        const sep = rest.lastIndexOf(':')
        if (sep > 0) textTokenCredits.set(`${rest.slice(0, sep)}|${rest.slice(sep + 1)}`, e.credits)
      }
    }
    const subjectsByModel = new Map<string, typeof subjects>()
    for (const s of subjects) {
      const list = subjectsByModel.get(s.modelKey) ?? []
      list.push(s)
      subjectsByModel.set(s.modelKey, list)
    }
    const marginByModel = new Map(margins.filter((m) => m.status === 'active').map((m) => [m.scopeKey, m]))
    const rows = rates as CostRecordRateRow[]
    const data: CostRecordDto[] = []
    for (const e of entries) {
      const tiers = this.tiersFor(e, rows, at, subjectCreditsByTier, textTokenCredits)
      const modelSubjects = subjectsByModel.get(e.modelKey) ?? []
      const missingSpecs: string[] = []
      for (const s of modelSubjects) {
        const c = resolveUnitCost(
          { capability: s.capability, modelKey: s.modelKey, spec: s.spec, upstream: s.upstream, billableUnit: s.billableUnit, unitsPerRequest: s.unitsPerRequest },
          rows,
          at,
        )
        if (!c) missingSpecs.push(s.spec)
      }
      const filled = tiers.filter((t) => t.costYuan !== null).length
      const status: CostRecordDto['status'] =
        modelSubjects.length > 0 ? (missingSpecs.length === 0 ? 'ready' : missingSpecs.length === modelSubjects.length ? 'missing' : 'partial') : filled === tiers.length ? 'ready' : 'missing'
      const margin = marginByModel.get(e.modelKey)
      const marginProfitBp = margin?.profitBp
      data.push({
        modelKey: e.modelKey,
        displayName: e.displayName,
        modality: e.modality,
        audioKind: e.audioKind,
        channel: e.providerBinding,
        profitPct: marginProfitBp != null ? marginProfitBp / 100 : null,
        tiers,
        subjectsTotal: modelSubjects.length,
        missingSpecs,
        status,
        materializedVersion: priceVersion?.version ?? null,
      })
    }
    return { code: 0, message: 'ok', data }
  }

  /** 按模态展开档位（与主体枚举同一常量源，零映射漂移）。 */
  private tiersFor(
    e: { modelKey: string; modality: string; audioKind: string | null },
    rows: CostRecordRateRow[],
    at: Date,
    subjectCreditsByTier: Map<string, number>,
    textTokenCredits: Map<string, number>,
  ): CostRecordTier[] {
    if (e.modality === 'image') {
      return ENUMERATED_IMAGE_RESOLUTIONS.map((res) => ({
        spec: res, label: `${res}（元/张）`, unit: 'per_image', unitQuantity: 1,
        costYuan: tierCostYuan(rows, e.modelKey, res, at), perVideoDerived: null,
        // 物化主体行 spec=`<res>:<count>`（逐张数结算真源）：档位卡显示单张基准价（count=1 行）；
        // 无 :1 行（历史数据）回落裸分辨率 key，再缺才 null。
        materializedCredits:
          subjectCreditsByTier.get(`image|${e.modelKey}|${res}:1`) ??
          subjectCreditsByTier.get(`image|${e.modelKey}|${res}`) ??
          null,
        creditsByDuration: null,
      }))
    }
    if (e.modality === 'video') {
      const family = videoPriceFamily(e.modelKey)
      return ENUMERATED_VIDEO_RESOLUTIONS_CANONICAL.map((res) => {
        const own = tierCostYuan(rows, e.modelKey, res, at)
        // P1.6 物化积分：按时长枚举该分辨率下的主体行（spec=`<res>:<dur>s`）。
        const byDuration: { duration: number; credits: number }[] = []
        for (const [key, credits] of subjectCreditsByTier) {
          // 三段前缀索引 key = capability|modelKey|spec（spec=`<res>:<dur>s`）
          const parts = key.split('|')
          if (parts.length !== 3 || parts[0] !== 'video' || parts[1] !== e.modelKey) continue
          const specParts = parts[2].split(':')
          if (specParts[0] !== res) continue
          const dur = Number(specParts[1]?.replace('s', ''))
          if (Number.isFinite(dur) && dur > 0) byDuration.push({ duration: dur, credits })
        }
        byDuration.sort((a, b) => a.duration - b.duration)
        if (own !== null) {
          return { spec: res, label: `${res}（元/秒）`, unit: 'per_second', unitQuantity: 1, costYuan: own, perVideoDerived: null, materializedCredits: null, creditsByDuration: byDuration.length > 0 ? byDuration : null }
        }
        // legacy per_video 行折算参考值（仅展示；保存后落 per_second 行并退役旧行）
        const legacy = rows
          .filter((r) => r.unit === 'per_video' && r.costYuan > 0 && !r.provisional && effective(r, at) && videoPriceFamily(r.modelKey) === family && r.spec.startsWith(`${res}:`))
          .sort((a, b) => (b.effectiveFrom?.getTime() ?? 0) - (a.effectiveFrom?.getTime() ?? 0))[0]
        const dur = legacy ? Number(legacy.spec.split(':')[1]?.replace('s', '')) : NaN
        const derived = legacy && Number.isFinite(dur) && dur > 0 ? legacy.costYuan / dur : null
        return { spec: res, label: `${res}（元/秒）`, unit: 'per_second', unitQuantity: 1, costYuan: null, perVideoDerived: derived, materializedCredits: null, creditsByDuration: byDuration.length > 0 ? byDuration : null }
      })
    }
    if (e.modality === 'audio') {
      const kinds = e.audioKind ? [e.audioKind] : ['voice', 'design', 'music']
      return kinds
        .filter((k) => k in AUDIO_TIER_SPEC)
        .map((k) => {
          const m = AUDIO_TIER_SPEC[k]
          return { spec: k, label: m.label, unit: m.unit, unitQuantity: m.unitQuantity, costYuan: tierCostYuan(rows, e.modelKey, m.rowSpec, at), perVideoDerived: null, materializedCredits: subjectCreditsByTier.get(`audio|${e.modelKey}|${k}`) ?? null, creditsByDuration: null }
        })
    }
    if (e.modality === 'text') {
      return TEXT_TIERS.map((t) => ({
        spec: t.spec, label: t.label, unit: 'per_1m_tokens', unitQuantity: 1e6,
        costYuan: tierCostYuan(rows, e.modelKey, t.rowSpec, at), perVideoDerived: null,
        // 文本实际结算走 token 反比率行（quoteTextTokens），非主体行——显示真实扣费口径。
        materializedCredits: textTokenCredits.get(`${e.modelKey}|${t.spec}`) ?? null,
        creditsByDuration: null,
      }))
    }
    return []
  }

  @Put(':modelKey')
  @UseGuards(AdminTokenGuard)
  async update(@Param('modelKey') modelKey: string, @Body() body: Record<string, unknown>): Promise<{ code: number; message: string; data: Record<string, unknown> }> {
    for (const k of FORBIDDEN_COST_FIELDS) {
      if (k in body) throw new BadRequestException(`成本登记不接受字段 ${k}：一律人民币（D9）`)
    }
    const entry = await this.prisma.modelCatalogEntry.findUnique({ where: { modelKey } })
    if (!entry || entry.deletedAt != null) {
      // R2：定价中心只改在售模型的数值；上下架（含恢复）在模型管理页
      throw new NotFoundException(`模型不在售（不存在或已下架）：${modelKey}。增删记录请走模型上下架。`)
    }
    const tiersRaw = body['tiers']
    if (!Array.isArray(tiersRaw)) throw new BadRequestException('tiers 必须是数组')
    const at = NOW()
    let savedTiers = 0
    for (const raw of tiersRaw as Record<string, unknown>[]) {
      const spec = typeof raw['spec'] === 'string' ? raw['spec'].trim() : ''
      const costYuan = typeof raw['costYuan'] === 'number' ? raw['costYuan'] : Number(raw['costYuan'])
      if (!spec) throw new BadRequestException('tiers[].spec 为必填')
      if (!Number.isFinite(costYuan) || costYuan < 0) throw new BadRequestException(`档位 ${spec} 的 costYuan 必须是非负人民币元金额`)
      const mapped = this.mapTierToCostRow(entry, spec)
      await this.prisma.costRate.upsert({
        where: { channel_modelKey_spec: { channel: 'platform', modelKey, spec: mapped.rowSpec } },
        create: { channel: 'platform', modelKey, spec: mapped.rowSpec, unit: mapped.unit, unitQuantity: mapped.unitQuantity, costYuan, source: 'manual', provisional: false },
        update: { unit: mapped.unit, unitQuantity: mapped.unitQuantity, costYuan, source: 'manual', provisional: false, effectiveTo: null },
      })
      if (entry.modality === 'video') await this.retireLegacyPerVideo(modelKey, spec, at)
      savedTiers += 1
    }
    let profitBp: number | null = null
    if (body['profitPct'] !== undefined) {
      const profitPct = typeof body['profitPct'] === 'number' ? body['profitPct'] : Number(body['profitPct'])
      if (!Number.isFinite(profitPct) || profitPct < 0 || profitPct > 100) {
        throw new BadRequestException('profitPct 必须是 0~100 的数值（记录自持利润率）')
      }
      profitBp = Math.round(profitPct * 100)
      await this.prisma.marginPolicy.upsert({
        where: { phase: phaseOf('model', modelKey) },
        create: { phase: phaseOf('model', modelKey), scope: 'model', scopeKey: modelKey, profitBp, priceFloorBp: Math.min(500, profitBp), status: 'active', effectiveFrom: null, effectiveTo: null },
        update: { profitBp, priceFloorBp: Math.min(500, profitBp), status: 'active' },
      })
    }
    return { code: 0, message: 'ok', data: { modelKey, savedTiers, profitBp } }
  }

  /** 档位 → 成本行映射（与 inferCostUnit 口径一致；spec 为卡片档位值）。 */
  private mapTierToCostRow(entry: { modality: string; audioKind: string | null }, spec: string): { rowSpec: string; unit: string; unitQuantity: number } {
    switch (entry.modality) {
      case 'image':
        return { rowSpec: spec, unit: 'per_image', unitQuantity: 1 }
      case 'video':
        return { rowSpec: spec, unit: 'per_second', unitQuantity: 1 }
      case 'audio': {
        const m = AUDIO_TIER_SPEC[spec]
        if (!m) throw new BadRequestException(`未知音频档位 ${spec}（voice/design/music）`)
        return { rowSpec: m.rowSpec, unit: m.unit, unitQuantity: m.unitQuantity }
      }
      case 'text': {
        if (!(spec === 'in' || spec === 'out' || spec === 'cache')) {
          throw new BadRequestException(`未知文本档位 ${spec}（in/out/cache）`)
        }
        return { rowSpec: `per_1m_tokens_${spec}`, unit: 'per_1m_tokens', unitQuantity: 1e6 }
      }
      default:
        throw new BadRequestException(`未知模态 ${entry.modality}`)
    }
  }

  /** D-2 自迁移：保存 per_second 档位时退役同族同分辨率的 legacy per_video 行（留底不删）。 */
  private async retireLegacyPerVideo(modelKey: string, res: string, at: Date): Promise<void> {
    const family = videoPriceFamily(modelKey)
    const legacy = await this.prisma.costRate.findMany({ where: { unit: 'per_video', effectiveTo: null } })
    const targets = legacy.filter((r) => videoPriceFamily(r.modelKey) === family && r.spec.startsWith(`${res}:`))
    for (const r of targets) {
      await this.prisma.costRate.update({ where: { id: r.id }, data: { effectiveTo: at } })
    }
  }

  /**
   * D-2 一次性迁移（幂等）：在售视频模型的生效 per_video 行 → per_second 行（spec=分辨率），
   * 原 per_video 行 effectiveTo 退役留底。同 (modelKey,res) 多档位线性不一致时**跳过不猜**
   * （报告 skipped，等价金标准要求逐元相等，非线性折算会改价）。
   */
  @Post('migrate-video-per-second')
  @UseGuards(AdminTokenGuard)
  async migrateVideoPerSecond(): Promise<{ code: number; message: string; data: Record<string, unknown> }> {
    const at = NOW()
    const rows = await this.prisma.costRate.findMany({ where: { unit: 'per_video', effectiveTo: null } })
    const groups = new Map<string, CostRecordRateRow[]>()
    for (const r of rows as CostRecordRateRow[]) {
      if (r.costYuan <= 0 || r.unitQuantity <= 0 || !r.spec.includes(':')) continue
      const res = r.spec.split(':')[0]
      const key = `${r.modelKey}|${res}`
      const list = groups.get(key) ?? []
      list.push(r)
      groups.set(key, list)
    }
    let converted = 0
    let retired = 0
    const skipped: { modelKey: string; res: string; reason: string }[] = []
    for (const [key, list] of groups) {
      const [modelKey, res] = key.split('|')
      const perSecond = list.map((r) => {
        const dur = Number(r.spec.split(':')[1]?.replace('s', ''))
        return { r, perSecond: Number.isFinite(dur) && dur > 0 ? r.costYuan / dur : NaN }
      })
      const valid = perSecond.filter((p) => Number.isFinite(p.perSecond))
      if (valid.length === 0) {
        skipped.push({ modelKey, res, reason: '档位时长无法解析' })
        continue
      }
      const base = valid[0].perSecond
      const linear = valid.every((p) => Math.abs(p.perSecond - base) <= Math.max(base, 1e-9) * 1e-6)
      if (!linear) {
        skipped.push({ modelKey, res, reason: `多档位非线性（${valid.map((p) => p.perSecond.toFixed(4)).join('/')} 元/秒），人工核对后用卡片逐档填` })
        continue
      }
      await this.prisma.$transaction([
        this.prisma.costRate.upsert({
          where: { channel_modelKey_spec: { channel: valid[0].r.channel, modelKey, spec: res } },
          create: { channel: valid[0].r.channel, modelKey, spec: res, unit: 'per_second', unitQuantity: 1, costYuan: base, source: valid[0].r.source, provisional: false },
          update: { unit: 'per_second', unitQuantity: 1, costYuan: base, effectiveTo: null },
        }),
        ...list.map((r) => this.prisma.costRate.update({ where: { id: r.id }, data: { effectiveTo: at } })),
      ])
      converted += 1
      retired += list.length
    }
    return { code: 0, message: `迁移 ${converted} 组 / 退役 ${retired} 行`, data: { converted, retired, skipped } }
  }
}
