/**
 * v2 拉新期价目草案种子（P1-a T7 · spec §6/§7 拍板值 + §6.6 档位映射）。
 *
 * 与 P0 seed-pricing（v1 等价迁移）的关系：v1 已是 active 基线；本种子从库内
 * CostRate 现算出新价目条目，落成一个 status='draft' 的 PriceListVersion——
 * 发布走 §8.4 审批流（pricing-publishing.service.publish）+ §8.5 灰度，
 * 本种子只造草案，不碰任何版本状态。
 *
 * 映射规则（全部来自 spec 拍板值，实现不发明数值）：
 * ① image（模型无关档位，锚 Seedream 5.0 Pro；4K 取 gpt-image-2 成本保守上界）：
 *    credits = computeCreditsFromCost(costYuan, 11000) × count 从 CostRate 行现算
 *    （1K/2K→seedream-5.0-pro，4K→gpt-image-2），basis='launch-reprice'。
 * ② video：仅 minimax-h3 家族 768p/2k 改价（480p H3 官方无此档、default/h3-max/
 *    h3-max-turbo 成本未实测——均照抄 v1）：
 *    基础档：computeCreditsFromCost(perSec × d, 11000)，perSec 用 5s 锚点行现算；
 *    参考档：v2base + (v1ref − v1base)（加价项保留——spec §6.6）。
 * ③ 其余全部档位：逐字复制 v1 值（legacyPriceOf 同源，不从库读 v1），basis='legacy-equivalent'。
 *
 * costRateId 挂接规则：image 全挂；video 768p/2k 按时长挂对应 CostRate 行——
 * ≥5s 挂 5s 锚点行，4s 挂 4s 推算行（2026-10-15 收尾包补录：vendor 无 4s SKU，
 * 按 5s 锚点×4/5 线性推算，P2 渠道对账以真实账单校准；此前 4s 不挂行走
 * noCostCoverage 标注，补录后地板校验恢复：768p 4s 售价 252 ≥ ceil(2.288×105)=241、
 * 2k 4s 售价 410 ≥ ceil(3.72×105)=391）。
 */
import { BadRequestException } from '@nestjs/common'
import type { PrismaClient } from '@prisma/client'
import type { PrismaService } from '../prisma/prisma.service'
import {
  buildMatchKey,
  canonicalImageCount,
  canonicalImageResolution,
  canonicalVideoResolution,
  computeCreditsFromCost,
  legacyPriceOf,
  videoPriceFamily,
} from './pricing.core'
import type { PricingCapability } from './pricing.core'
import { enumeratePricingSpace } from './pricing.space'

export const PRICING_VERSION_V2_DRAFT = 'v2-launch'

export const V2_DRAFT_NOTE = 'P1 拉新期价目草案（spec §6/§7 拍板值，发布须走 §8.4 审批流 + §8.5 灰度）'

/** 拉新期毛利系数（spec §5.1：marginBp 11000 = ×1.10），与 MarginPolicy.launch 同源。 */
const LAUNCH_MARGIN_BP = 11000

/** 发布价格地板乘数（spec §10：成本 × 1.05，积分口径 = ×105）。与 pricing-publishing.service 同数。 */
const FLOOR_MULTIPLIER = 105

/** video 锚点行时长（CostRate spec '768p:5s' / '2k:5s'）。 */
const ANCHOR_DURATION_S = 5

interface PlannedEntry {
  matchKey: string
  capability: PricingCapability
  credits: number
  basis: 'launch-reprice' | 'legacy-equivalent'
  costRateId: string | null
}

/**
 * 地板自检（spec §10）：有 costRateId 者 credits ≥ ceil(costYuan×105)——不许带病草案进审批。
 * 导出为纯函数以便直测：当前映射下 credits 全部由同源 CostRate 现算
 * （ceil(cost×110) ≥ ceil(cost×105) 恒真），数据级探针无法触发违规，
 * 该防线防的是未来映射改动（折扣/封顶/换锚）把带病条目混进草案。
 */
export function assertLaunchFloor(
  entries: PlannedEntry[],
  rateCostById: Map<string, number>,
): void {
  for (const e of entries) {
    if (!e.costRateId) continue
    const costYuan = rateCostById.get(e.costRateId)
    if (costYuan === undefined) {
      throw new Error(`seedPricingV2Draft: 地板校验缺 CostRate 行 ${e.costRateId}（${e.matchKey}）`)
    }
    const floor = Math.ceil(costYuan * FLOOR_MULTIPLIER)
    if (e.credits < floor) {
      throw new Error(
        `seedPricingV2Draft: 地板校验失败 ${e.matchKey}=${e.credits} < ceil(${costYuan}×105)=${floor}——不许带病草案进审批`,
      )
    }
  }
}

/** 本种子消费的 CostRate 行（channel 固定 platform，P0 seed 落库）。 */
const REQUIRED_RATES = [
  { modelKey: 'seedream-5.0-pro', spec: '1K' },
  { modelKey: 'seedream-5.0-pro', spec: '2K' },
  { modelKey: 'gpt-image-2', spec: '4K' },
  { modelKey: 'minimax-h3', spec: '768p:5s' },
  { modelKey: 'minimax-h3', spec: '2k:5s' },
  { modelKey: 'minimax-h3', spec: '768p:4s' },
  { modelKey: 'minimax-h3', spec: '2k:4s' },
] as const

export async function seedPricingV2Draft(
  prisma: PrismaClient | PrismaService,
  opts?: { version?: string },
): Promise<{ version: string; changed: number; copied: number }> {
  const version = opts?.version ?? PRICING_VERSION_V2_DRAFT

  const space = enumeratePricingSpace()
  if (space.length === 0) throw new Error('seedPricingV2Draft: 枚举空间为空——拒绝写空价目表（空集假绿防线）')

  // 幂等语义：同名 draft → 重新 upsert 全部条目；同名非 draft → 400 拒绝
  const existing = await prisma.priceListVersion.findUnique({ where: { version } })
  if (existing && existing.status !== 'draft') {
    throw new BadRequestException(
      `价目表版本 ${version} 已存在且状态为 ${existing.status}：draft 种子只许覆盖 draft（不许偷改已发布版本）`,
    )
  }

  const rates = await prisma.costRate.findMany({
    where: { OR: REQUIRED_RATES.map((k) => ({ channel: 'platform', modelKey: k.modelKey, spec: k.spec })) },
  })
  const rateMap = new Map(rates.map((r) => [`${r.modelKey}:${r.spec}`, r]))
  for (const k of REQUIRED_RATES) {
    if (!rateMap.has(`${k.modelKey}:${k.spec}`)) {
      throw new Error(`seedPricingV2Draft: CostRate 行缺失 platform/${k.modelKey}/${k.spec}——先跑 db:seed:pricing`)
    }
  }

  // 全部映射与校验在写库前完成（违规即 throw ⇒ 零落库，不留半成品草案）
  const planned: PlannedEntry[] = []
  for (const q of space) {
    const matchKey = buildMatchKey(q)
    let credits: number
    let basis: PlannedEntry['basis']
    let costRateId: string | null = null

    if (q.capability === 'image') {
      // ① image：锚 CostRate 现算 × count（不硬编码单价）
      const res = canonicalImageResolution(q.resolution)
      const rate = rateMap.get(res === '4K' ? 'gpt-image-2:4K' : `seedream-5.0-pro:${res}`)!
      credits = computeCreditsFromCost(rate.costYuan, LAUNCH_MARGIN_BP) * canonicalImageCount(q.count)
      basis = 'launch-reprice'
      costRateId = rate.id
    } else if (
      q.capability === 'video' &&
      videoPriceFamily(q.modelKey) === 'minimax-h3' &&
      canonicalVideoResolution(q.resolution) !== '480p'
    ) {
      // ② video minimax-h3 768p/2k：perSec 用 5s 锚点行现算
      const res = canonicalVideoResolution(q.resolution)
      const rate = rateMap.get(`minimax-h3:${res}:5s`)!
      const perSec = rate.costYuan / ANCHOR_DURATION_S
      // 镜像 pricing.core 的 canonicalVideoDuration（私有未导出，不为此扩公共面）：
      // 表外时长（7/20…）不入枚举空间，此处恒为 4/5/10/15
      const d = Number.isFinite(q.duration) ? Number(q.duration) : ANCHOR_DURATION_S
      const v2base = computeCreditsFromCost(perSec * d, LAUNCH_MARGIN_BP)
      if (q.videoMode === 'reference_to_video') {
        const v1base = legacyPriceOf({
          capability: 'video',
          modelKey: 'minimax-h3',
          resolution: q.resolution,
          duration: d,
        })
        credits = v2base + (legacyPriceOf(q) - v1base) // 参考加价 delta 保留
      } else {
        credits = v2base
      }
      basis = 'launch-reprice'
      // 按时长挂对应 CostRate 行（见文件头 costRateId 挂接规则）：≥5s 挂 5s 锚点行，
      // 4s 挂 4s 推算行（成本=perSec×4，与售价同源 ⇒ 地板自检恒过）
      costRateId =
        d >= ANCHOR_DURATION_S ? rate.id : rateMap.get(`minimax-h3:${res}:4s`)!.id
    } else {
      // ③ 其余全部档位：逐字复制 v1 值（legacyPriceOf 同源，不从库读 v1——种子可在空库跑）
      credits = legacyPriceOf(q)
      basis = 'legacy-equivalent'
    }

    if (!Number.isInteger(credits) || credits <= 0) {
      throw new Error(`seedPricingV2Draft: 非法积分值 ${matchKey} → ${credits}`)
    }
    planned.push({ matchKey, capability: q.capability, credits, basis, costRateId })
  }

  // 地板自检：写库前完成全部映射与校验（违规即 throw ⇒ 零落库，不留半成品草案）
  assertLaunchFloor(planned, new Map(rates.map((r) => [r.id, r.costYuan])))

  const versionRow = await prisma.priceListVersion.upsert({
    where: { version },
    update: { note: V2_DRAFT_NOTE },
    create: { version, status: 'draft', note: V2_DRAFT_NOTE },
  })

  for (const e of planned) {
    await prisma.priceListEntry.upsert({
      where: { versionId_matchKey: { versionId: versionRow.id, matchKey: e.matchKey } },
      update: { credits: e.credits, basis: e.basis, costRateId: e.costRateId },
      create: {
        versionId: versionRow.id,
        capability: e.capability,
        matchKey: e.matchKey,
        credits: e.credits,
        basis: e.basis,
        costRateId: e.costRateId,
      },
    })
  }

  const changed = planned.filter((e) => e.basis === 'launch-reprice').length
  return { version, changed, copied: planned.length - changed }
}
