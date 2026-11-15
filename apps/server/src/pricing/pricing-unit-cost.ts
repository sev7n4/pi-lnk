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
 * source 五级优先级：manual(人工卡片改过，采集器不得覆盖) > channel_actual(实测) > negotiated(议价)
 * > official_list(官方牌价) > provisional(暂定)。
 * 取候选里 rank 最高者；同 rank 取 effectiveFrom 更晚（更近生效）；per_video 优先于 per_second（锚点倍乘禁用）。
 */
const SOURCE_RANK: Record<string, number> = {
  manual: 5,
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
 *  - provisional / costYuan<0 / 「costYuan=0 且来源非 official_list·channel_actual」（D1 显式 0 价）/
 *    unitsPerRequest=null / unitQuantity<=0 ⇒ 一律返回 null（调用方置 cost_missing）；
 *  - 视频 U6/D-2：成本行 modelKey 与售价键不同构，legacy per_video 行按 videoPriceFamily +
 *    (res, duration) 归一，禁止字符串直等；粗化 per_second 行（定价中心卡片写入）按
 *    模型 + 分辨率精确匹配后按 duration 展开。**无 5s 锚点线性外推分支**（缺整条行即 null）。
 */
export function resolveUnitCost(subject: SubjectInput, rates: UnitCostRateRow[], at: Date): UnitCost | null {
  const isToken = subject.billableUnit.startsWith('token_')
  const units = isToken ? 1e6 : subject.unitsPerRequest
  if (units === null || units <= 0) return null

  const family = videoPriceFamily(subject.modelKey)
  const [res, dur] = subject.spec.split(':')
  // 图像家族（image / image_edit / image_variant）一律按 per_image 锚点计价；
  // edit/variant 主体 spec 为 "*" 无分辨率，暂按 1K 锚点（与 image 共用真实成本，不编造）。
  const isImageFamily = subject.capability === 'image' || subject.capability === 'image_edit' || subject.capability === 'image_variant'
  const imageRes = subject.capability === 'image' ? res : '1K'
  const candidates = rates
    .filter((r) => {
      if (!affordable(r, at) || r.unitQuantity <= 0 || r.provisional) return false
      // D1 显式 0 价（免费模型）：仅 official_list / channel_actual 来源的 costYuan=0 视为合法免费价；
      // 负价恒拒；其余来源（negotiated/provisional）的 0 价视为数据残缺 ⇒ cost_missing，绝不猜。
      if (r.costYuan < 0) return false
      if (r.costYuan === 0 && r.source !== 'official_list' && r.source !== 'channel_actual') return false
      if (subject.capability === 'text') return r.unit === 'per_1m_tokens' && r.spec.endsWith(subject.spec)
      if (isImageFamily) return r.unit === 'per_image' && r.spec === imageRes
      if (subject.capability === 'video') {
        // D-2 粗化行（每分辨率·每秒，定价中心卡片写入）：严格按 模型 + 分辨率 精确匹配，
        // 禁止跨模型/跨分辨率误用（原实现仅按 family 匹配不看 spec，2k 会误用 480p 每秒成本）。
        if (r.unit === 'per_second') return r.modelKey === subject.modelKey && r.spec === res
        // U6：legacy per_video 行按 family + (res, duration) 归一，不直等 modelKey
        if (videoPriceFamily(r.modelKey) !== family) return false
        return r.unit === 'per_video' && r.spec === `${res}:${dur}`
      }
      // 音频（及任何 per_call 能力）：必须按模型精确匹配，禁止跨模型误用成本。
      // 例：stepaudio-3-gen-preview 不应套用 step-tts-mini 的字符成本。
      return r.unit === 'per_call' && r.modelKey === subject.modelKey
    })
    .sort((a, b) =>
      (SOURCE_RANK[b.source] ?? 0) - (SOURCE_RANK[a.source] ?? 0) ||
      (b.effectiveFrom?.getTime() ?? 0) - (a.effectiveFrom?.getTime() ?? 0) ||
      // 同档成本优先命中与主体同 modelKey 的行（让用户按模型导入的成本生效，而非误套锚点行）
      (a.modelKey === subject.modelKey ? 0 : 1) - (b.modelKey === subject.modelKey ? 0 : 1) ||
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
