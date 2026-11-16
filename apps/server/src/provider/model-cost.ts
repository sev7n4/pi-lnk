/**
 * P1 · cost 费率解析（渠道 models[].pricing → pi 会话 override.cost）。
 *
 * 背景：SessionLlmOverride.cost 的 seam 早已留在 pi-runtime（model-assembly 把它
 * 填进 Model.cost，vendor calculateCost 响应时自动算 usage.cost），但 Nest 侧
 * 全平台没有任何费率来源，override.cost 从未下发 → 全链 cost=0，BYOK 用量无法
 * 按价归因。本模块补上「读」的一侧：
 *   写入面 = 渠道 models[].pricing（provider.controller 的 ModelPricingDto，
 *   随 ProviderChannel.models JSON 列落库，零迁移）；
 *   读取面 = 本文件，命中渠道 + 模型名 → 四元组费率。
 *
 * 解析纪律（对齐 provider-resolver 的「校验绝不比探活更激进」）：
 *   - JSON 畸形 / 非数组 / 模型未命中 / pricing 缺省或畸形 → undefined（不计费），
 *     绝不让坏数据阻断会话创建；
 *   - 单键非法（负数/非有限数）→ 整个 pricing 视为未声明（宁可少算不错算）；
 *   - 命中但某键缺省 → 该键补 0（vendor 消费完整四元组）。
 * 本文件不得打印 models 原文（渠道元数据不出 provider 模块边界）。
 */

export type OverrideModelCost = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * 渠道 models[].pricing 的存储形态（与 provider.controller 的 ModelPricingDto 同构，
 * 键带 PerM 后缀）。四键全部可选；解析/校验只在读取面 resolveChannelModelCost 做
 * —— 重建/保留路径不判好坏，原样透传（宁可少算不错算由读取面兜底）。
 */
export type ChannelModelPricing = {
  inputPerM?: number
  outputPerM?: number
  cacheReadPerM?: number
  cacheWritePerM?: number
}

const COST_KEYS = ['inputPerM', 'outputPerM', 'cacheReadPerM', 'cacheWritePerM'] as const

function isNonNegativeFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

export function resolveChannelModelCost(
  modelsJson: string | null | undefined,
  modelName: string,
): OverrideModelCost | undefined {
  const name = modelName?.trim().toLowerCase() ?? ''
  if (!name || !modelsJson) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(modelsJson)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const entry = parsed.find(
    (m) =>
      typeof m === 'object' &&
      m !== null &&
      (m as { name?: unknown }).name === name &&
      typeof (m as { pricing?: unknown }).pricing === 'object' &&
      (m as { pricing?: unknown }).pricing !== null,
  )
  if (!entry) return undefined
  const pricing = (entry as { pricing: Record<string, unknown> }).pricing
  const out: OverrideModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let seen = false
  for (const key of COST_KEYS) {
    const raw = pricing[key]
    if (raw === undefined) continue
    if (!isNonNegativeFinite(raw)) return undefined
    out[key.replace(/PerM$/, '') as keyof OverrideModelCost] = raw
    seen = true
  }
  return seen ? out : undefined
}

// ---------------------------------------------------------------------------
// P2a（spec 2026-11-15-p2-session-cost-cny-migration-design §4.1/§4.4）：
// CostRate（定价中心，CNY 权威源）→ 会话成本读取面。与 resolveChannelModelCost
// 同纪律：任一必需档（in/out）缺失/畸形/过期/provisional → undefined（宁可少算
// 不错算）；cache 档缺失是受支持形态补 0；cacheWrite 无对应维度恒 0（核对点 1）。
// channel 限定由调用方 where 传入、此处再防御（BYOK 成本不进平台 CostRate）。
// 期限过滤语义与 pricing-unit-cost 的 affordable 对齐（effectiveFrom<=at<effectiveTo；
// null=无限）。unitQuantity 非 1e6 时按「元/百万 token」归一。
// ---------------------------------------------------------------------------

export type CostRateRow = {
  channel: string
  modelKey: string
  spec: string
  unit: string
  unitQuantity: number | null
  costYuan: number
  provisional: boolean
  effectiveFrom: Date | null
  effectiveTo: Date | null
}

const CR_SPEC_KEYS = {
  per_1m_tokens_in: 'input',
  per_1m_tokens_out: 'output',
  per_1m_tokens_cache: 'cacheRead',
} as const satisfies Record<string, keyof OverrideModelCost>

export function resolveCostRateModelCost(
  rates: CostRateRow[],
  modelKey: string,
  at: Date,
): OverrideModelCost | undefined {
  const name = modelKey?.trim().toLowerCase() ?? ''
  if (!name) return undefined
  const out: OverrideModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const seen = new Set<keyof OverrideModelCost>()
  for (const r of rates) {
    if (r.provisional) continue
    if (r.channel !== 'platform') continue
    if (r.modelKey?.trim().toLowerCase() !== name) continue
    const key = CR_SPEC_KEYS[r.spec as keyof typeof CR_SPEC_KEYS]
    if (!key) continue
    if (r.unit !== 'per_1m_tokens') continue
    if (r.effectiveFrom && r.effectiveFrom > at) continue
    if (r.effectiveTo && r.effectiveTo <= at) continue
    if (!isNonNegativeFinite(r.costYuan)) return undefined
    const q = r.unitQuantity
    if (typeof q !== 'number' || !Number.isFinite(q) || q <= 0) return undefined
    out[key] = (r.costYuan * 1e6) / q
    seen.add(key)
  }
  if (!seen.has('input') || !seen.has('output')) return undefined
  return out
}

/**
 * 出口统一币种（核对点 5）：渠道源 USD/百万 → ×FX 折 CNY/百万。
 * FX 单点复用 resolveFxUsdCny（调用方取值），本函数不做任何汇率假设。
 */
export function withFxToCny(cost: OverrideModelCost, fxUsdCny: number): OverrideModelCost {
  return {
    input: cost.input * fxUsdCny,
    output: cost.output * fxUsdCny,
    cacheRead: cost.cacheRead * fxUsdCny,
    cacheWrite: cost.cacheWrite * fxUsdCny,
  }
}
