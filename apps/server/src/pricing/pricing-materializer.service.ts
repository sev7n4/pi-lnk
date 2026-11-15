// apps/server/src/pricing/pricing-materializer.service.ts
import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { resolveUnitCost, UnitCostRateRow } from './pricing-unit-cost'
import { resolveMargin, MarginRow } from './pricing-margin.service'
import { modelOptionName } from '@lnkpi/shared'
import { checkCostFloor, buildTextTokenMatchKey, TEXT_TOKEN_SPECS, FloorViolation } from './pricing.core'
import type { SubjectRow } from './pricing-subject.service'
import { incMaterialize, incCostSource, incUnitMismatch } from './pricing-metrics'

/**
 * 成本 × 利润 → 积分（价格行，spec §5.1）：credits = ceil(成本(元) × (1 + profitBp/10000) ÷ 积分锚(0.01元))。
 * 与 `computeCreditsFromCost(cost, 11000)` 当且仅当 profitBp=1000 时逐值相等（AC6 等价锚）。
 * 0 成本 ⇒ 0 分（2026-11-15 用户拍板：cogvideox 官方免费模型允许物化为 0 分，不再强制最低积分粒度 1 分；
 * 正成本 ceil ≥ 1 天然保底，无 0.5 分中间态）。
 */
export function creditsOf(costYuanPerRequest: number, profitBp: number): number {
  return Math.ceil((costYuanPerRequest * (10000 + profitBp)) / 10000 / 0.01)
}

/**
 * 反比率（文本 token 行）：r = floor(1e8 / (每1M token 成本 × (10000 + profitBp)))。
 * 与 `floor(1e6 / (cost × 110))` 当且仅当 profitBp=1000 时逐值相等（AC6 等价锚）。
 */
export function ratioOf(costYuanPer1MToken: number, profitBp: number): number {
  return Math.floor(1e8 / (costYuanPer1MToken * (10000 + profitBp)))
}

export interface MaterializeResult {
  added: number
  changed: number
  unchanged: number
  missingCost: string[]
  unitMismatch: string[]
  floorViolations: FloorViolation[]
  noCostCoverage: string[]
}

/**
 * 物化：以 PricingSubject 主体为遍历真源，逐主体算「成本 → 利润 → 积分/反比率」并落草案价目表。
 *
 * - resolveUnitCost：上游物理量 → 每次请求人民币成本（缺整条行 ⇒ missingCost，绝不外推）。
 * - resolveMargin：六档 scope 取生效利润率（缺省 global 1000/500）。
 * - 文本 token 行用 ratioOf（每 credit=r tokens）；其余用 creditsOf。
 * - 与草案现有条目 diff：只 upsert `basis !== 'ops-modified'`（运营手改行保护）；同输入二次运行 changed=0。
 *
 * ⚠️ 本函数由发布流（Task 8）/ 全链验收（Task 9）集成测，本任务只单测纯公式 + checkCostFloor。
 */
@Injectable()
export class PricingMaterializerService {
  constructor(private readonly prisma: PrismaService) {}

  async materialize(
    draftId: string,
    subjects: SubjectRow[],
    costRates: UnitCostRateRow[],
    marginRows: MarginRow[],
    at: Date,
  ): Promise<MaterializeResult> {
    const result: MaterializeResult = {
      added: 0,
      changed: 0,
      unchanged: 0,
      missingCost: [],
      unitMismatch: [],
      floorViolations: [],
      noCostCoverage: [],
    }

    const existing = await this.prisma.priceListEntry.findMany({ where: { versionId: draftId } })
    const bySubjectKey = new Map(existing.map((e) => [e.subjectKey ?? e.matchKey, e]))
    // T1：三段 text:<model>:<spec> 反比率行索引（文本扣费的真相源，见下方 upsert 块）。
    const textByKey = new Map(
      existing
        .filter((e) => e.matchKey.startsWith('text:') && !e.matchKey.includes('|'))
        .map((e) => [e.matchKey, e]),
    )

    for (const s of subjects) {
      const unit = resolveUnitCost(
        {
          capability: s.capability,
          modelKey: s.modelKey,
          spec: s.spec,
          upstream: s.upstream,
          billableUnit: s.billableUnit,
          unitsPerRequest: s.unitsPerRequest,
        },
        costRates,
        at,
      )
      if (!unit) {
        result.missingCost.push(s.subjectKey)
        result.noCostCoverage.push(s.subjectKey)
        incMaterialize('missingCost')
        incUnitMismatch(s.capability, 'missing_cost_row')
        continue
      }
      incCostSource(unit.costSource)
      const margin = resolveMargin(
        {
          capability: s.capability,
          modelKey: s.modelKey,
          spec: s.spec,
          provider: s.provider,
          upstream: s.upstream,
        },
        marginRows,
        at,
      )
      const isToken = s.billableUnit.startsWith('token_')
      const credits = isToken
        ? ratioOf(unit.costYuanPerRequest, margin.profitBp)
        : creditsOf(unit.costYuanPerRequest, margin.profitBp)

      const violation = checkCostFloor(
        { matchKey: s.subjectKey, credits, costRateId: unit.costRateId },
        unit.costYuanPerRequest,
        margin.priceFloorBp,
      )
      if (violation) {
        result.floorViolations.push(violation)
        incMaterialize('floorViolation')
      }

      // T1 文本扣费真相源（spec 2026-11-15-text-token-reprice-link-design §4.1）：
      // 物化同步刷三段 text:<model>:<spec> 反比率行。六段文本主体行是零消费副产物
      // （deprecated：禁止消费，退役计划见 spec §3.1）。三段行跟随门禁既有 token 行语义
      // （pricing-publishing.service.ts 豁免 unitSnapshot、地板判上限用 rate.costYuan）——
      // 不要求 subjectKey/快照，costRateId 必带供地板校验。
      // 模型键归一与 quoteTextTokens 同源（modelOptionName+trim+toLowerCase），
      // 生产带渠道前缀（platform::x）也剥净同形。计数不并入 added/changed/unchanged
      // （摘要是主体数视角，镜像行不重复计）。位置在六段 upsert 之前：六段 ops-modified
      // 的 continue 不得阻断三段刷新——三段的手改保护独立判断。
      if (isToken && (TEXT_TOKEN_SPECS as readonly string[]).includes(s.spec)) {
        const textKey = buildTextTokenMatchKey(
          modelOptionName(s.modelKey).trim().toLowerCase(),
          s.spec as Parameters<typeof buildTextTokenMatchKey>[1],
        )
        const prevText = textByKey.get(textKey)
        if (prevText?.basis !== 'ops-modified') {
          if (!prevText) {
            await this.prisma.priceListEntry.create({
              data: { versionId: draftId, capability: s.capability, matchKey: textKey, ...this.buildEntryData(s, unit, margin, credits), subjectKey: null },
            })
          } else if (prevText.credits !== credits) {
            await this.prisma.priceListEntry.update({
              where: { id: prevText.id },
              data: { ...this.buildEntryData(s, unit, margin, credits), subjectKey: null },
            })
          }
        }
      }

      const prev = bySubjectKey.get(s.subjectKey)
      if (prev) {
        if (prev.basis === 'ops-modified') continue // 运营手改行保护：不覆盖
        if (prev.credits === credits) {
          result.unchanged++
          incMaterialize('unchanged')
          continue
        }
        await this.prisma.priceListEntry.update({
          where: { id: prev.id },
          data: this.buildEntryData(s, unit, margin, credits),
        })
        result.changed++
        incMaterialize('changed')
      } else {
        await this.prisma.priceListEntry.create({
          data: { versionId: draftId, capability: s.capability, matchKey: s.subjectKey, ...this.buildEntryData(s, unit, margin, credits) },
        })
        result.added++
        incMaterialize('added')
      }
    }
    return result
  }

  /**
   * ⚠️ deprecated（T1，2026-11-15）：capability=text 的六段主体行是零消费副产物——
   * deriveSubjectSpec('text') 恒 undefined，扣费/卡片/公开端点全读三段 text: 行
   * （见 materialize 循环内三段 upsert 块）。禁止任何新代码消费六段文本行；退役计划见
   * spec 2026-11-15-text-token-reprice-link-design §3.1。
   */
  private buildEntryData(
    s: SubjectRow,
    unit: { costYuanPerRequest: number; costRateId: string },
    margin: { profitBp: number; marginPolicyId: string },
    credits: number,
  ) {
    return {
      subjectKey: s.subjectKey,
      credits,
      basis: 'auto-derived',
      reason: null,
      costSnapshotYuan: unit.costYuanPerRequest,
      unitSnapshot: JSON.stringify({ billableUnit: s.billableUnit, unitQuantity: s.unitsPerRequest ?? null, unitsPerRequest: s.unitsPerRequest ?? null }),
      profitBpSnapshot: margin.profitBp,
      costRateId: unit.costRateId,
      marginPolicyId: margin.marginPolicyId,
    }
  }
}
