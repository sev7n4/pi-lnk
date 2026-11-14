// apps/server/src/pricing/pricing-unit-cost.ts
import { videoPriceFamily } from './pricing.core'

/**
 * 成本行（与 CostRate schema 列对齐；纯函数不碰 DB，rates 由调用方按 subject 预筛后传入）。
 */
export interface UnitCostRateRow {
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

export interface UnitCost {
  costYuan: number
  costRateId: string
  costSource: string
  unit: string
  unitQuantity: number
  unitsPerRequest: number
  costYuanPerRequest: number
  provisional: boolean
}

export type SubjectInput = {
  capability: string
  modelKey: string
  spec: string
  upstream: string
  billableUnit: string
  unitsPerRequest: number | null
}

/**
 * source 四级优先级：channel_actual(实测) > negotiated(议价) > official_list(官方牌价) > provisional(暂定)。
 * 取候选里 rank 最高者；同 rank 取 effectiveFrom 更晚（更近生效）；per_video 优先于 per_second（锚点倍乘禁用）。
 */
const SOURCE_RANK: Record<string, number> = {
  channel_actual: 4,
  negotiated: 3,
  official_list: 2,
  provisional: 1,
}

function affordable(r: UnitCostRateRow, at: Date): boolean {
  if (r.effectiveFrom && r.effectiveFrom > at) return false
  if (r.effectiveTo && r.effectiveTo <= at) return false
  return true
}

/**
 * 四层单位归一：上游物理量（unit/unitQuantity）→ 「元 / 一次计价单元」→ credits → 账单。
 * 这里只做第二层：把匹配到的成本行折算成「每次请求（unitsPerRequest）的人民币成本」。
 *
 * 关键约束（§3.5.4）：
 *  - 文本 token 行 unit=per_1m_tokens、unitQuantity=1e6 ⇒ 令 units=1e6，costYuanPerRequest===costYuan（每 1M token 成本），
 *    正是反比率公式 r 的输入；
 *  - provisional / costYuan<=0 / unitsPerRequest=null / unitQuantity<=0 ⇒ 一律返回 null（调用方置 cost_missing）；
 *  - 视频 U6：成本行 modelKey 与售价键不同构，按 videoPriceFamily + (res, duration) 归一，禁止字符串直等；
 *    整条 per_video 行优先，per_second 行按 duration 展开，**无 5s 锚点线性外推分支**（缺整条行即 null）。
 */
export function resolveUnitCost(subject: SubjectInput, rates: UnitCostRateRow[], at: Date): UnitCost | null {
  const isToken = subject.billableUnit.startsWith('token_')
  const units = isToken ? 1e6 : subject.unitsPerRequest
  if (units === null || units <= 0) return null

  const family = videoPriceFamily(subject.modelKey)
  const [res, dur] = subject.spec.split(':')
  const candidates = rates
    .filter((r) => {
      if (!affordable(r, at) || r.unitQuantity <= 0 || r.costYuan <= 0 || r.provisional) return false
      if (subject.capability === 'text') return r.unit === 'per_1m_tokens' && r.spec.endsWith(subject.spec)
      if (subject.capability === 'image') return r.unit === 'per_image' && r.spec === res
      if (subject.capability === 'video') {
        // U6：按 family + (res, duration) 归一，不直等 modelKey
        if (videoPriceFamily(r.modelKey) !== family) return false
        return (r.unit === 'per_video' && r.spec === `${res}:${dur}`) || r.unit === 'per_second'
      }
      return r.unit === 'per_call'
    })
    .sort((a, b) =>
      (SOURCE_RANK[b.source] ?? 0) - (SOURCE_RANK[a.source] ?? 0) ||
      (b.effectiveFrom?.getTime() ?? 0) - (a.effectiveFrom?.getTime() ?? 0) ||
      (a.unit === 'per_second' ? 1 : 0) - (b.unit === 'per_second' ? 1 : 0),
    )

  const hit = candidates[0]
  if (!hit) return null // 缺整条行 / 单位不对齐 ⇒ cost_missing，绝不按 5s 锚点线性外推
  const unitsPerRequest = hit.unit === 'per_second' ? Number(dur.replace('s', '')) : units
  return {
    costYuan: hit.costYuan,
    costRateId: hit.id,
    costSource: hit.source, // 取 CostRate.source 列值，不新增列
    unit: hit.unit,
    unitQuantity: hit.unitQuantity,
    unitsPerRequest,
    costYuanPerRequest: (hit.costYuan * unitsPerRequest) / hit.unitQuantity,
    provisional: false,
  }
}
